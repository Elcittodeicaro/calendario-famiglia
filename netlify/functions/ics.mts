import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";
import { timingSafeEqual } from "node:crypto";

// Feed in sola lettura per il Calendario dell'iPhone (iscrizione webcal).
// Il calendario non può inviare intestazioni, quindi il codice arriva nel link (?k=...).

const store = () => getStore({ name: "calendario", consistency: "strong" });
const DEFAULT_PEOPLE = [
  { id: "papa", name: "Papà" },
  { id: "mamma", name: "Mamma" },
  { id: "bimbi", name: "Bimbi" },
  { id: "famiglia", name: "Famiglia" },
];
const FREQ: Record<string, string> = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" };

function authorized(code: string): boolean {
  const expected = (Netlify.env.get("FAMILY_CODE") || "").trim().toLowerCase();
  const got = code.trim().toLowerCase();
  if (!expected || !got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- formattazione iCalendar (RFC 5545) ---
const text = (s: string) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const l = Buffer.byteLength(ch);
    if (len + l > 75) {
      parts.push(cur);
      cur = " " + ch;
      len = 1 + l;
    } else {
      cur += ch;
      len += l;
    }
  }
  parts.push(cur);
  return parts.join("\r\n");
}
const d8 = (date: string) => date.replace(/-/g, "");
const localDT = (date: string, time: string) => `${d8(date)}T${time.replace(":", "")}00`;
const nextDay = (date: string) => {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const utc = (ms: number) => new Date(ms || Date.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const plusHour = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return h >= 23 ? "23:59" : `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};
const joinNames = (names: string[]) => (names.length < 2 ? names.join("") : names.slice(0, -1).join(", ") + " e " + names[names.length - 1]);

function vevent(ev: any, names: Map<string, string>): string[] {
  const who = (ev.who || []).map((id: string) => names.get(id)).filter(Boolean);
  const care = (ev.care || []).map((id: string) => names.get(id)).filter(Boolean);
  const desc = [
    who.length ? `Per: ${who.join(", ")}` : "",
    care.length ? `Ci pensa: ${joinNames(care)}` : "",
    ev.note || "",
    ev.by ? `Aggiunto da ${ev.by}` : "",
  ].filter(Boolean).join("\n");
  const summary = who.length ? `${ev.title} · ${who.join(", ")}` : ev.title;
  const allDay = ev.allDay || !ev.start;

  const L: string[] = ["BEGIN:VEVENT", `UID:${ev.id}@calendario-famiglia`, `DTSTAMP:${utc(ev.updatedAt)}`, `SUMMARY:${text(summary)}`];
  if (allDay) {
    L.push(`DTSTART;VALUE=DATE:${d8(ev.date)}`, `DTEND;VALUE=DATE:${d8(nextDay(ev.date))}`);
  } else {
    const end = ev.end && ev.end > ev.start ? ev.end : plusHour(ev.start);
    L.push(`DTSTART:${localDT(ev.date, ev.start)}`, `DTEND:${localDT(ev.date, end)}`);
  }
  if (desc) L.push(`DESCRIPTION:${text(desc)}`);

  if (FREQ[ev.repeat]) {
    let rule = `RRULE:FREQ=${FREQ[ev.repeat]}`;
    if (ev.until) rule += `;UNTIL=${allDay ? d8(ev.until) : d8(ev.until) + "T235959"}`;
    L.push(rule);
    const skip: string[] = (ev.skip || []).filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (skip.length) {
      L.push(allDay ? `EXDATE;VALUE=DATE:${skip.map(d8).join(",")}` : `EXDATE:${skip.map((d) => localDT(d, ev.start)).join(",")}`);
    }
  }

  const alert = ev.alert || (allDay ? "morning" : "60");
  if (alert !== "none") {
    let trigger: string;
    if (allDay) trigger = alert === "1440" ? "-PT15H" : "PT8H"; // giorno prima alle 9 / quel giorno alle 8
    else trigger = alert === "morning" ? "-PT60M" : `-PT${Number(alert) || 0}M`;
    L.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${text(ev.title)}`, `TRIGGER:${trigger}`, "END:VALARM");
  }
  L.push("END:VEVENT");
  return L;
}

async function readPrefix(prefix: string) {
  const s = store();
  const { blobs } = await s.list({ prefix });
  const items = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return items.filter(Boolean) as any[];
}

export default async (req: Request) => {
  const url = new URL(req.url);
  if (!authorized(url.searchParams.get("k") || "")) return new Response("Codice non valido", { status: 401 });

  // Impegni singoli: da 3 mesi fa a 18 mesi avanti. Ripetuti: tutti.
  const now = new Date();
  const months: string[] = [];
  for (let i = -3; i <= 18; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  const [lists, rec, settings] = await Promise.all([
    Promise.all(months.map((m) => readPrefix(`ev/${m}/`))),
    readPrefix("rec/"),
    store().get("settings", { type: "json" }) as Promise<any>,
  ]);
  const people: { id: string; name: string }[] = settings?.people || DEFAULT_PEOPLE;
  const names = new Map(people.map((p) => [p.id, p.name]));

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Calendario di famiglia//IT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Famiglia",
    "X-APPLE-CALENDAR-COLOR:#E8590C",
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
    ...[...lists.flat(), ...rec].flatMap((ev) => vevent(ev, names)),
    "END:VCALENDAR",
  ];
  return new Response(lines.map(fold).join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="famiglia.ics"',
      "cache-control": "no-store",
    },
  });
};

export const config: Config = { path: "/calendario.ics" };
