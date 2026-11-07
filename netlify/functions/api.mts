import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import { randomUUID, timingSafeEqual } from "node:crypto";

// Tutti i dati stanno in un unico store privato del sito.
// Chiavi:
//   ev/AAAA-MM/<id>   eventi singoli, divisi per mese
//   rec/<id>          eventi ricorrenti (ogni giorno / settimana / mese / anno)
//   settings          persone e colori
const store = () => getStore({ name: "calendario", consistency: "strong" });

const DEFAULT_SETTINGS = {
  people: [
    { id: "papa", name: "Papà", color: "#2f6fde" },
    { id: "mamma", name: "Mamma", color: "#d6336c" },
    { id: "bimbi", name: "Bimbi", color: "#2b9a66" },
    { id: "famiglia", name: "Famiglia", color: "#e8590c" },
  ],
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const ID_RE = /^[a-z0-9-]{6,40}$/;
const KEY_RE = /^(ev\/\d{4}-\d{2}|rec)\/[a-z0-9-]{6,40}$/;
const REPEATS = ["none", "daily", "weekly", "monthly", "yearly"];
const ALERTS = ["none", "0", "15", "30", "60", "120", "1440", "morning"];
const ids = (v: unknown) =>
  Array.isArray(v) ? v.filter((w): w is string => typeof w === "string").slice(0, 12).map((w) => w.slice(0, 40)) : [];

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function authorized(req: Request): boolean {
  const expected = (Netlify.env.get("FAMILY_CODE") || "").trim().toLowerCase();
  const got = (req.headers.get("x-codice") || "").trim().toLowerCase();
  if (!expected || !got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const validDate = (v: unknown) => typeof v === "string" && DATE_RE.test(v) && !isNaN(Date.parse(v + "T00:00:00Z"));

function cleanEvent(body: any) {
  const title = str(body.title, 120);
  if (!title) throw new Error("Manca il titolo");
  if (!validDate(body.date)) throw new Error("Data non valida");
  const repeat = REPEATS.includes(body.repeat) ? body.repeat : "none";
  const allDay = !!body.allDay;
  const start = !allDay && TIME_RE.test(body.start) ? body.start : "";
  const end = !allDay && start && TIME_RE.test(body.end) ? body.end : "";
  return {
    id: typeof body.id === "string" && ID_RE.test(body.id) ? body.id : randomUUID(),
    title,
    date: body.date as string,
    allDay: allDay || !start,
    start,
    end,
    who: ids(body.who),
    care: ids(body.care),
    alert: ALERTS.includes(body.alert) ? body.alert : allDay || !start ? "morning" : "60",
    note: str(body.note, 2000),
    repeat,
    until: repeat !== "none" && validDate(body.until) ? body.until : "",
    skip: repeat !== "none" && Array.isArray(body.skip) ? body.skip.filter(validDate).slice(0, 1000) : [],
    by: str(body.by, 40),
    createdAt: typeof body.createdAt === "number" ? body.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
}

const keyFor = (ev: { id: string; date: string; repeat: string }) =>
  ev.repeat === "none" ? `ev/${ev.date.slice(0, 7)}/${ev.id}` : `rec/${ev.id}`;

async function readPrefix(prefix: string) {
  const s = store();
  const { blobs } = await s.list({ prefix });
  const items = await Promise.all(
    blobs.map(async (b) => {
      const v = await s.get(b.key, { type: "json" });
      return v ? { ...v, _key: b.key } : null;
    }),
  );
  return items.filter(Boolean);
}

export default async (req: Request, context: Context) => {
  if (!authorized(req)) return json({ error: "Codice non valido" }, 401);

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const s = store();

  try {
    if (route === "ping" && req.method === "GET") {
      return json({ ok: true });
    }

    if (route === "data" && req.method === "GET") {
      const months = (url.searchParams.get("months") || "")
        .split(",")
        .filter((m) => MONTH_RE.test(m))
        .slice(0, 24);
      const [monthLists, rec, settings] = await Promise.all([
        Promise.all(months.map((m) => readPrefix(`ev/${m}/`))),
        readPrefix("rec/"),
        s.get("settings", { type: "json" }),
      ]);
      const byMonth: Record<string, unknown[]> = {};
      months.forEach((m, i) => (byMonth[m] = monthLists[i]));
      return json({ months: byMonth, rec, settings: settings || DEFAULT_SETTINGS });
    }

    if (route === "events" && req.method === "POST") {
      const body = await req.json();
      const ev = cleanEvent(body);
      const key = keyFor(ev);
      await s.setJSON(key, ev);
      const oldKey = typeof body._key === "string" ? body._key : "";
      if (oldKey && oldKey !== key && KEY_RE.test(oldKey)) await s.delete(oldKey);
      return json({ ...ev, _key: key });
    }

    if (route === "events" && req.method === "DELETE") {
      const key = url.searchParams.get("key") || "";
      if (!KEY_RE.test(key)) return json({ error: "Chiave non valida" }, 400);
      await s.delete(key);
      return json({ ok: true });
    }

    if (route === "settings" && req.method === "PUT") {
      const body = await req.json();
      const people = (Array.isArray(body.people) ? body.people : [])
        .slice(0, 20)
        .map((p: any) => ({
          id: typeof p.id === "string" && /^[a-z0-9-]{1,40}$/.test(p.id) ? p.id : randomUUID().slice(0, 8),
          name: str(p.name, 30) || "Senza nome",
          color: typeof p.color === "string" && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : "#868e96",
        }));
      const settings = { people: people.length ? people : DEFAULT_SETTINGS.people };
      await s.setJSON("settings", settings);
      return json(settings);
    }

    return json({ error: "Non trovato" }, 404);
  } catch (err: any) {
    return json({ error: err?.message || "Errore" }, 400);
  }
};

export const config: Config = { path: "/api/*" };
