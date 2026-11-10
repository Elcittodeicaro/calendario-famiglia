import type { Config } from "@netlify/functions";
import { store, readPrefix, listSubs, sendPush, expand, fireAt, localDate, addDays, zoned } from "../lib/shared.mts";

// Gira ogni 5 minuti e manda i promemoria degli impegni ai telefoni che li hanno attivati.
// Per consumare poco, ricalcola i promemoria in arrivo al massimo una volta l'ora
// (o subito dopo una modifica: l'API cancella "remcache").

const LOOKBACK = 15 * 60000; // recupera promemoria persi da un giro in ritardo
const AHEAD = 75 * 60000;

type Due = { id: string; at: number; title: string; body: string; occ: string };

function describe(ev: any, occ: string, tz: string, at: number): string {
  const day = localDate(at, tz) === occ ? "Oggi" : addDays(localDate(at, tz), 1) === occ ? "Domani" : occ.split("-").reverse().join("/");
  const parts = [ev.allDay || !ev.start ? day : `${day} alle ${ev.start}`];
  if (ev.note) parts.push(String(ev.note).split("\n")[0].slice(0, 80));
  return parts.join(" · ");
}

async function compute(now: number, tz: string): Promise<Due[]> {
  const today = localDate(now, tz);
  const from = addDays(today, -1);
  const to = addDays(today, 2);
  const months = [...new Set([from, today, to].map((d) => d.slice(0, 7)))];
  const spanKeys = (await store().list({ prefix: "span/" })).blobs.map((b) => b.key).filter((k) => {
    const st = k.slice(5, 15);
    return st >= from && st <= to; // il promemoria è sul primo giorno
  });
  const [single, rec, spans, items, lists] = await Promise.all([
    Promise.all(months.map((m) => readPrefix(`ev/${m}/`))),
    readPrefix("rec/"),
    Promise.all(spanKeys.map((k) => store().get(k, { type: "json" }))),
    readPrefix("li/"),
    store().get("lists", { type: "json" }) as Promise<any[] | null>,
  ]);
  const events = [...single.flat(), ...rec, ...spans.filter(Boolean)];
  const due: Due[] = [];
  // Voci delle liste con scadenza: alle 9 del giorno, o un'ora prima dell'orario indicato
  const listName = new Map((lists || [{ id: "spesa", name: "Spesa" }, { id: "dafare", name: "Da fare" }]).map((l: any) => [l.id, l.name]));
  for (const it of items) {
    if (it.done || !it.due || it.due < from || it.due > to) continue;
    const at = it.dueTime ? zoned(it.due, it.dueTime, tz) - 60 * 60000 : zoned(it.due, "09:00", tz);
    if (at < now - LOOKBACK || at > now + AHEAD) continue;
    const day = localDate(at, tz) === it.due ? "oggi" : "domani";
    due.push({
      id: `li|${it.id}|${it.due}|${it.dueTime || ""}`, at, occ: it.due,
      title: `Da fare: ${it.text}`,
      body: [`Entro ${day}${it.dueTime ? " alle " + it.dueTime : ""}`, listName.get(it.list)].filter(Boolean).join(" · "),
    });
  }
  for (const ev of events) {
    for (const occ of expand(ev, from, to)) {
      const at = fireAt(ev, occ, tz);
      if (at === null || at < now - LOOKBACK || at > now + AHEAD) continue;
      due.push({ id: `${ev.id}|${occ}|${ev.alert || ""}|${ev.start || ""}`, at, title: ev.title, body: describe(ev, occ, tz, at), occ });
    }
  }
  return due;
}

// ---------- riepilogo della giornata (alle 8, nel fuso di ciascun telefono) ----------
const localHM = (ms: number, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

async function buildDigest(today: string) {
  const s = store();
  const spanKeys = (await s.list({ prefix: "span/" })).blobs.map((b) => b.key)
    .filter((k) => k.slice(5, 15) <= today && k.slice(16, 26) >= today);
  const [single, rec, spans, items, settings] = await Promise.all([
    readPrefix(`ev/${today.slice(0, 7)}/`),
    readPrefix("rec/"),
    Promise.all(spanKeys.map((k) => s.get(k, { type: "json" }))),
    readPrefix("li/"),
    s.get("settings", { type: "json" }) as Promise<any>,
  ]);
  const names = new Map(((settings && settings.people) || []).map((p: any) => [p.id, p.name]));
  const careOf = (x: any) => {
    const n = (x.care || []).map((id: string) => names.get(id)).filter(Boolean);
    return n.length ? ` (ci ${n.length > 1 ? "pensano" : "pensa"} ${n.join(" e ")})` : "";
  };
  const events = [
    ...single.filter((e: any) => e.date === today),
    ...rec.filter((e: any) => expand(e, today, today).length),
    ...(spans.filter(Boolean) as any[]),
  ].sort((a: any, b: any) => {
    const ta = a.allDay || !a.start || (a.endDate && a.date !== today) ? "" : a.start;
    const tb = b.allDay || !b.start || (b.endDate && b.date !== today) ? "" : b.start;
    return ta.localeCompare(tb);
  });
  const tasks = items.filter((it: any) => !it.done && it.due && it.due <= today)
    .sort((a: any, b: any) => (a.due + (a.dueTime || "99")).localeCompare(b.due + (b.dueTime || "99")));

  const lines: string[] = [];
  for (const e of events) {
    const timed = !e.allDay && e.start && (!e.endDate || e.date === today);
    lines.push(`• ${timed ? e.start + " " : ""}${e.title}${careOf(e)}`);
  }
  for (const t of tasks) {
    const late = t.due < today ? " (in ritardo)" : t.dueTime ? ` (entro le ${t.dueTime})` : "";
    lines.push(`☐ ${t.text}${late}${careOf(t)}`);
  }
  if (!lines.length) return null;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [events.length ? plural(events.length, "impegno", "impegni") : "", tasks.length ? plural(tasks.length, "cosa da fare", "cose da fare") : ""].filter(Boolean);
  const shown = lines.slice(0, 8);
  if (lines.length > 8) shown.push(`…e altre ${lines.length - 8}`);
  return { title: `☀️ Buongiorno! Oggi: ${parts.join(" e ")}`, body: shown.join("\n"), url: `/?d=${today}`, tag: `daily-${today}` };
}

export default async () => {
  const s = store();
  const all = await listSubs();
  const remSubs = all.filter((x: any) => x.reminders);
  const dailySubs = all.filter((x: any) => x.daily);
  if (!remSubs.length && !dailySubs.length) return;
  const now = Date.now();
  const sent = ((await s.get("remsent", { type: "json" })) as Record<string, number>) || {};
  for (const k of Object.keys(sent)) if (now - sent[k] > 3 * 864e5) delete sent[k];
  let changed = false;

  // Promemoria degli impegni e delle cose da fare
  if (remSubs.length) {
    const tz = remSubs[0].tz || "Europe/Madrid";
    let cache = (await s.get("remcache", { type: "json" })) as { at: number; tz: string; due: Due[] } | null;
    if (!cache || now - cache.at > 60 * 60000 || cache.tz !== tz) {
      cache = { at: now, tz, due: await compute(now, tz) };
      await s.setJSON("remcache", cache);
    }
    for (const d of cache.due.filter((x) => x.at <= now && x.at > now - LOOKBACK)) {
      if (sent[d.id]) continue;
      await Promise.all(remSubs.map((sub: any) => sendPush(sub, { title: d.title, body: d.body, url: `/?d=${d.occ}`, tag: `rem-${d.id}` })));
      sent[d.id] = now;
      changed = true;
    }
  }

  // Riepilogo delle 8 (finestra 8:00–8:29 per tollerare ritardi; una volta al giorno per telefono)
  const digests = new Map<string, Awaited<ReturnType<typeof buildDigest>>>();
  for (const sub of dailySubs) {
    const tz = sub.tz || "Europe/Madrid";
    const hm = localHM(now, tz);
    if (hm < "08:00" || hm >= "08:30") continue;
    const today = localDate(now, tz);
    const mark = `daily|${sub._key}|${today}`;
    if (sent[mark]) continue;
    if (!digests.has(today)) digests.set(today, await buildDigest(today));
    const dg = digests.get(today);
    if (dg) await sendPush(sub, dg);
    sent[mark] = now; // segnato anche se la giornata è vuota: niente notifica, niente secondo tentativo
    changed = true;
  }

  if (changed) await s.setJSON("remsent", sent);
};

// Ogni 5 minuti (UTC; l'orario dei promemoria segue il fuso del telefono iscritto)
export const config: Config = { schedule: "*/5 * * * *" };
