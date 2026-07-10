import type { APIRoute } from "astro";
import { readFileSync } from "node:fs";
import { google } from "googleapis";
import { Resend } from "resend";
// Liest Secrets zur Laufzeit (Produktion: echte Env-Vars, Dev: .env)
const env = (k: string): string =>
  (process.env[k] ?? (import.meta.env as Record<string, string>)[k] ?? "").trim();

const TZ = "Europe/Vienna";
const MIN_DUR = 90; // Mindestdauer in Minuten

// Wandelt lokale Wandzeit (Europe/Vienna) DST-sicher in einen UTC-ISO-Zeitpunkt
function zonedToUtcISO(dateStr: string, timeStr: string, timeZone: string): string {
  const asUtc = new Date(`${dateStr}T${timeStr}:00Z`);
  const inTz = new Date(asUtc.toLocaleString("en-US", { timeZone }));
  const inUtc = new Date(asUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  const offset = inTz.getTime() - inUtc.getTime();
  return new Date(asUtc.getTime() - offset).toISOString();
}

function fmtHuman(iso: string): string {
  return new Date(iso).toLocaleString("de-AT", {
    timeZone: TZ, weekday: "long", day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }) + " Uhr";
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));

function getCalendar() {
  // Schlüssel entweder aus Datei (GOOGLE_SERVICE_ACCOUNT_FILE) oder inline (GOOGLE_SERVICE_ACCOUNT_JSON)
  const file = env("GOOGLE_SERVICE_ACCOUNT_FILE");
  const raw = file ? readFileSync(file, "utf8") : env("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("missing_service_account");
  const creds = JSON.parse(raw);
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const POST: APIRoute = async ({ request }) => {
  let data: Record<string, string>;
  try { data = await request.json(); }
  catch { return json(400, { ok: false, error: "Ungültige Anfrage." }); }

  const name = String(data.name ?? "").trim();
  const telefon = String(data.telefon ?? "").trim();
  const email = String(data.email ?? "").trim();
  const adresse = String(data.adresse ?? "").trim();
  const notiz = String(data.notiz ?? "").trim();
  const date = String(data.date ?? "").trim();
  const time = String(data.time ?? "").trim();

  if (!name || !date || !time) {
    return json(400, { ok: false, error: "Bitte Name, Datum und Uhrzeit angeben." });
  }

  const startISO = zonedToUtcISO(date, time, TZ);
  if (isNaN(Date.parse(startISO))) return json(400, { ok: false, error: "Ungültiges Datum oder Uhrzeit." });
  const endISO = new Date(new Date(startISO).getTime() + MIN_DUR * 60000).toISOString();

  const CALENDAR_ID = env("CALENDAR_ID");
  const MAIL_TO = env("MAIL_TO");
  const MAIL_FROM = env("MAIL_FROM");
  const RESEND_API_KEY = env("RESEND_API_KEY");

  // 1) Kalender: Doppelbuchung prüfen + Termin anlegen
  let htmlLink = "";
  try {
    const calendar = getCalendar();
    const fb = await calendar.freebusy.query({
      requestBody: { timeMin: startISO, timeMax: endISO, items: [{ id: CALENDAR_ID }] },
    });
    const busy = fb.data.calendars?.[CALENDAR_ID]?.busy ?? [];
    if (busy.length > 0) {
      return json(409, { ok: false, error: "Dieser Zeitraum ist leider schon vergeben. Bitte wählen Sie einen anderen Termin." });
    }
    const ev = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `Hufbeschlag — ${name}`,
        location: adresse || undefined,
        description: [
          telefon && `Telefon: ${telefon}`,
          email && `E-Mail: ${email}`,
          notiz && `Notiz: ${notiz}`,
        ].filter(Boolean).join("\n") || undefined,
        start: { dateTime: startISO, timeZone: TZ },
        end: { dateTime: endISO, timeZone: TZ },
      },
    });
    htmlLink = ev.data.htmlLink ?? "";
  } catch (err) {
    console.error("[anfrage] Kalenderfehler:", (err as Error)?.message || err);
    return json(500, { ok: false, error: "Der Termin konnte nicht eingetragen werden. Bitte später erneut versuchen oder telefonisch melden." });
  }

  // 2) E-Mails via Resend — Fehler hier sollen die bereits erfolgte Buchung nicht scheitern lassen
  if (RESEND_API_KEY && MAIL_FROM) {
    try {
      const resend = new Resend(RESEND_API_KEY);
      const when = fmtHuman(startISO);

      if (MAIL_TO) {
        await resend.emails.send({
          from: MAIL_FROM,
          to: MAIL_TO,
          replyTo: email || undefined,
          subject: `Neue Terminanfrage — ${name} (${when})`,
          html: ownerHtml({ name, telefon, email, adresse, notiz, when, htmlLink }),
        });
      }
      if (email) {
        await resend.emails.send({
          from: MAIL_FROM,
          to: email,
          subject: "Ihre Terminbestätigung — Hufschmiede Weinberger",
          html: customerHtml({ name, when, adresse }),
        });
      }
    } catch (err) {
      console.error("[anfrage] Mailfehler:", (err as Error)?.message || err);
      return json(200, { ok: true, mail: false, message: "Termin eingetragen. Die Bestätigungsmail konnte nicht versendet werden." });
    }
  }

  return json(200, { ok: true, mail: true, message: "Vielen Dank! Ihr Termin ist eingetragen — Sie erhalten eine Bestätigung per E-Mail." });
};

function ownerHtml(d: { name: string; telefon: string; email: string; adresse: string; notiz: string; when: string; htmlLink: string }): string {
  const row = (label: string, val: string) =>
    val ? `<tr><td style="padding:6px 14px 6px 0;color:#6d6355;font:600 12px/1.4 Arial,sans-serif;text-transform:uppercase;letter-spacing:.08em;vertical-align:top">${esc(label)}</td><td style="padding:6px 0;color:#16110c;font:400 15px/1.5 Arial,sans-serif">${esc(val)}</td></tr>` : "";
  return `
  <div style="max-width:560px;margin:0 auto;background:#f5f0e7;padding:28px 26px;border-radius:6px">
    <p style="margin:0 0 4px;color:#a98a54;font:600 12px/1 Arial,sans-serif;letter-spacing:.2em;text-transform:uppercase">Neue Terminanfrage</p>
    <h2 style="margin:0 0 18px;color:#16110c;font:600 24px/1.2 Georgia,serif">${esc(d.name)}</h2>
    <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:4px;padding:8px">
      ${row("Termin", d.when)}
      ${row("Telefon", d.telefon)}
      ${row("E-Mail", d.email)}
      ${row("Adresse / Stall", d.adresse)}
      ${row("Notiz", d.notiz)}
    </table>
    ${d.htmlLink ? `<p style="margin:18px 0 0"><a href="${esc(d.htmlLink)}" style="color:#a98a54;font:600 14px Arial,sans-serif">↗ Im Google Kalender öffnen</a></p>` : ""}
  </div>`;
}

function customerHtml(d: { name: string; when: string; adresse: string }): string {
  return `
  <div style="max-width:560px;margin:0 auto;background:#f5f0e7;padding:28px 26px;border-radius:6px">
    <p style="margin:0 0 4px;color:#a98a54;font:600 12px/1 Arial,sans-serif;letter-spacing:.2em;text-transform:uppercase">Terminbestätigung</p>
    <h2 style="margin:0 0 14px;color:#16110c;font:600 24px/1.2 Georgia,serif">Vielen Dank, ${esc(d.name)}!</h2>
    <p style="margin:0 0 16px;color:#16110c;font:400 15px/1.6 Arial,sans-serif">Ihr Termin ist vorgemerkt:</p>
    <p style="margin:0 0 6px;color:#16110c;font:600 18px/1.4 Georgia,serif">${esc(d.when)}</p>
    ${d.adresse ? `<p style="margin:0 0 16px;color:#6d6355;font:400 14px/1.5 Arial,sans-serif">Ort: ${esc(d.adresse)}</p>` : ""}
    <p style="margin:18px 0 0;color:#6d6355;font:400 13px/1.6 Arial,sans-serif">Sollten Sie den Termin nicht wahrnehmen können, melden Sie sich bitte kurz. Herzliche Grüße — Hufschmiede Weinberger</p>
  </div>`;
}
