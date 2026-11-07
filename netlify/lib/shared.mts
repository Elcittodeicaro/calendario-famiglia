// Codice condiviso dalle funzioni (non è una funzione: sta fuori da netlify/functions).
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import webpush from "web-push";

export const store = () => getStore({ name: "calendario", consistency: "strong" });

export async function readPrefix(prefix: string): Promise<any[]> {
  const s = store();
  const { blobs } = await s.list({ prefix });
  const items = await Promise.all(
    blobs.map(async (b) => {
      const v = await s.get(b.key, { type: "json" });
      return v ? { ...(v as object), _key: b.key } : null;
    }),
  );
  return items.filter(Boolean);
}

// ---------- date ----------
const MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
const GIORNI = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
const REPEAT_LABEL: Record<string, string> = { daily: "ogni giorno", weekly: "ogni settimana", monthly: "ogni mese", yearly: "ogni anno" };

const parse = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
};

export function shortDate(s: string) {
  const d = parse(s);
  return `${GIORNI[d.getUTCDay()]} ${d.getUTCDate()} ${MESI[d.getUTCMonth()]}`;
}
export function whenLabel(ev: any) {
  let t = shortDate(ev.date);
  if (!ev.allDay && ev.start) t += ` alle ${ev.start}`;
  if (REPEAT_LABEL[ev.repeat]) t += ` (${REPEAT_LABEL[ev.repeat]})`;
  return t;
}

// Ripetizioni: stessa logica dell'app.
export function expand(ev: any, from: string, to: string): string[] {
  const out: string[] = [];
  const start = ev.date as string;
  if (!ev.repeat || ev.repeat === "none") return start >= from && start <= to ? [start] : [];
  const until = ev.until && ev.until < to ? ev.until : to;
  if (start > until) return out;
  const skip = new Set(ev.skip || []);
  const push = (d: string) => {
    if (d >= from && d <= until && d >= start && !skip.has(d)) out.push(d);
  };
  const sd = parse(start);
  if (ev.repeat === "daily" || ev.repeat === "weekly") {
    const step = ev.repeat === "daily" ? 1 : 7;
    let first = start;
    if (from > start) {
      const diff = Math.round((parse(from).getTime() - sd.getTime()) / 864e5);
      first = addDays(start, Math.ceil(diff / step) * step);
    }
    for (let d = first; d <= until; d = addDays(d, step)) push(d);
  } else if (ev.repeat === "monthly") {
    const a = parse(start > from ? start : from);
    const b = parse(until);
    for (let y = a.getUTCFullYear(), m = a.getUTCMonth(); y < b.getUTCFullYear() || (y === b.getUTCFullYear() && m <= b.getUTCMonth()); m === 11 ? (y++, (m = 0)) : m++) {
      const d = new Date(Date.UTC(y, m, sd.getUTCDate()));
      if (d.getUTCMonth() === m) push(fmt(d));
    }
  } else if (ev.repeat === "yearly") {
    const a = parse(start > from ? start : from);
    const b = parse(until);
    for (let y = a.getUTCFullYear(); y <= b.getUTCFullYear(); y++) {
      const d = new Date(Date.UTC(y, sd.getUTCMonth(), sd.getUTCDate()));
      if (d.getUTCMonth() === sd.getUTCMonth()) push(fmt(d));
    }
  }
  return out;
}

// ---------- fusi orari ----------
function tzOffset(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(ms / 1000) * 1000;
}
// "2026-11-10" + "16:30" nel fuso tz -> istante UTC (ms)
export function zoned(date: string, time: string, tz: string) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = tzOffset(guess, tz);
  let t = guess - off1;
  const off2 = tzOffset(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}
export function localDate(ms: number, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

// Quando deve suonare il promemoria di un'occorrenza (null = nessun avviso)
export function fireAt(ev: any, occ: string, tz: string): number | null {
  const allDay = ev.allDay || !ev.start;
  const alert = ev.alert || (allDay ? "morning" : "60");
  if (alert === "none") return null;
  if (allDay) return alert === "1440" ? zoned(addDays(occ, -1), "09:00", tz) : zoned(occ, "08:00", tz);
  const mins = alert === "morning" ? 60 : Number(alert) || 0;
  return zoned(occ, ev.start, tz) - mins * 60000;
}

// ---------- notifiche push ----------
export const subKey = (endpoint: string) => "push/" + createHash("sha256").update(endpoint).digest("hex").slice(0, 32);

let vapidReady = false;
export function vapidPublicKey(): string {
  const pub = Netlify.env.get("VAPID_PUBLIC_KEY") || "";
  const priv = Netlify.env.get("VAPID_PRIVATE_KEY") || "";
  if (!pub || !priv) return "";
  if (!vapidReady) {
    webpush.setVapidDetails(Netlify.env.get("VAPID_SUBJECT") || "https://calendario-famiglia-cheli.netlify.app", pub, priv);
    vapidReady = true;
  }
  return pub;
}

export const listSubs = () => readPrefix("push/");

export async function sendPush(sub: any, payload: Record<string, unknown>): Promise<boolean> {
  if (!vapidPublicKey()) return false;
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "high" });
    return true;
  } catch (err: any) {
    console.log("push non inviata", err?.statusCode, err?.body || err?.message);
    if (err?.statusCode === 404 || err?.statusCode === 410) await store().delete(sub._key); // iscrizione scaduta
    return false;
  }
}
