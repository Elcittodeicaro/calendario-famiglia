import type { Config } from "@netlify/functions";
import { store, readPrefix, listSubs, sendPush, expand, fireAt, localDate, addDays } from "../lib/shared.mts";

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
  const events = [...(await Promise.all(months.map((m) => readPrefix(`ev/${m}/`)))).flat(), ...(await readPrefix("rec/"))];
  const due: Due[] = [];
  for (const ev of events) {
    for (const occ of expand(ev, from, to)) {
      const at = fireAt(ev, occ, tz);
      if (at === null || at < now - LOOKBACK || at > now + AHEAD) continue;
      due.push({ id: `${ev.id}|${occ}|${ev.alert || ""}|${ev.start || ""}`, at, title: ev.title, body: describe(ev, occ, tz, at), occ });
    }
  }
  return due;
}

export default async () => {
  const s = store();
  const subs = (await listSubs()).filter((x: any) => x.reminders);
  if (!subs.length) return;
  const tz = subs[0].tz || "Europe/Madrid";
  const now = Date.now();

  let cache = (await s.get("remcache", { type: "json" })) as { at: number; tz: string; due: Due[] } | null;
  if (!cache || now - cache.at > 60 * 60000 || cache.tz !== tz) {
    cache = { at: now, tz, due: await compute(now, tz) };
    await s.setJSON("remcache", cache);
  }

  const ready = cache.due.filter((d) => d.at <= now && d.at > now - LOOKBACK);
  if (!ready.length) return;

  const sent = ((await s.get("remsent", { type: "json" })) as Record<string, number>) || {};
  for (const k of Object.keys(sent)) if (now - sent[k] > 3 * 864e5) delete sent[k];
  let changed = false;
  for (const d of ready) {
    if (sent[d.id]) continue;
    await Promise.all(subs.map((sub: any) => sendPush(sub, { title: d.title, body: d.body, url: `/?d=${d.occ}`, tag: `rem-${d.id}` })));
    sent[d.id] = now;
    changed = true;
  }
  if (changed) await s.setJSON("remsent", sent);
};

// Ogni 5 minuti (UTC; l'orario dei promemoria segue il fuso del telefono iscritto)
export const config: Config = { schedule: "*/5 * * * *" };
