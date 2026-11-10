import type { Config, Context } from "@netlify/functions";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { store, readPrefix, whenLabel, subKey, vapidPublicKey, listSubs, sendPush, expand, addDays } from "../lib/shared.mts";

// Tutti i dati stanno in un unico store privato del sito.
// Chiavi:
//   ev/AAAA-MM/<id>   eventi singoli, divisi per mese
//   rec/<id>          eventi ricorrenti (ogni giorno / settimana / mese / anno)
//   settings          persone e colori
//   li/<lista>/<id>   voci delle liste condivise, lists = elenco liste
//   push/<hash>       iscrizioni alle notifiche (una per telefono)
//   remcache, remsent promemoria in arrivo / già inviati

const DEFAULT_SETTINGS = {
  people: [
    { id: "papa", name: "Papà", color: "#2f6fde" },
    { id: "mamma", name: "Mamma", color: "#d6336c" },
    { id: "bimbi", name: "Bimbi", color: "#2b9a66" },
    { id: "famiglia", name: "Famiglia", color: "#e8590c" },
  ],
};

const DEFAULT_LISTS = [
  { id: "spesa", name: "Spesa" },
  { id: "dafare", name: "Da fare" },
];
const LIST_ID_RE = /^[a-z0-9-]{1,40}$/;
const ITEM_KEY_RE = /^li\/[a-z0-9-]{1,40}\/[a-z0-9-]{6,40}$/;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const ID_RE = /^[a-z0-9-]{6,40}$/;
const KEY_RE = /^(ev\/\d{4}-\d{2}|rec|span\/\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2})\/[a-z0-9-]{6,40}$/;
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
  // Più giorni (solo se non si ripete), al massimo un anno
  const endDate =
    repeat === "none" && validDate(body.endDate) && body.endDate > body.date &&
    Date.parse(body.endDate) - Date.parse(body.date) <= 366 * 864e5 ? (body.endDate as string) : "";
  return {
    id: typeof body.id === "string" && ID_RE.test(body.id) ? body.id : randomUUID(),
    title,
    date: body.date as string,
    endDate,
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

const keyFor = (ev: { id: string; date: string; endDate?: string; repeat: string }) =>
  ev.repeat !== "none" ? `rec/${ev.id}` : ev.endDate ? `span/${ev.date}_${ev.endDate}/${ev.id}` : `ev/${ev.date.slice(0, 7)}/${ev.id}`;

// Impegni su più giorni che toccano l'intervallo [from, to] (le date sono nella chiave)
async function readSpans(from: string, to: string) {
  const s = store();
  const { blobs } = await s.list({ prefix: "span/" });
  const keys = blobs.map((b) => b.key).filter((k) => {
    const m = /^span\/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\//.exec(k);
    return m && m[1] <= to && m[2] >= from;
  });
  const items = await Promise.all(keys.map(async (k) => {
    const v = await s.get(k, { type: "json" });
    return v ? { ...(v as object), _key: k } : null;
  }));
  return items.filter(Boolean);
}

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Avvisa gli altri telefoni quando un impegno viene aggiunto, cambiato o eliminato.
async function notifyChange(req: Request, action: "add" | "edit" | "del", ev: any) {
  const device = req.headers.get("x-device") || "";
  let name = "";
  try { name = decodeURIComponent(req.headers.get("x-nome") || "").slice(0, 40); } catch {}
  const subs = (await listSubs()).filter((x: any) => x.changes && x.deviceId !== device);
  if (!subs.length) return;
  const verb = { add: "ha aggiunto", edit: "ha modificato", del: "ha eliminato" }[action];
  // Per gli impegni che si ripetono usa la prossima data, non quella d'inizio della serie.
  let date = ev.date;
  if (ev.repeat && ev.repeat !== "none") {
    const today = new Date().toISOString().slice(0, 10);
    date = expand(ev, today, addDays(today, 400))[0] || ev.date;
  }
  await Promise.all(
    subs.map((sub: any) =>
      sendPush(sub, {
        title: `${name || "Qualcuno"} ${verb}`,
        body: `${ev.title} · ${whenLabel({ ...ev, date })}`,
        url: action === "del" ? "/" : `/?d=${date}`,
        tag: `chg-${ev.id}`,
      }),
    ),
  );
}
const later = (context: Context, p: Promise<unknown>) => {
  const safe = p.catch((e) => console.log("errore notifica", e));
  if (context && typeof context.waitUntil === "function") context.waitUntil(safe);
  else return safe;
};

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
      const sorted = [...months].sort();
      const [monthLists, rec, settings, spans, lists, items] = await Promise.all([
        Promise.all(months.map((m) => readPrefix(`ev/${m}/`))),
        readPrefix("rec/"),
        s.get("settings", { type: "json" }),
        sorted.length ? readSpans(`${sorted[0]}-01`, `${sorted[sorted.length - 1]}-31`) : Promise.resolve([]),
        s.get("lists", { type: "json" }),
        readPrefix("li/"),
      ]);
      const byMonth: Record<string, unknown[]> = {};
      months.forEach((m, i) => (byMonth[m] = monthLists[i]));
      return json({ months: byMonth, rec, spans, settings: settings || DEFAULT_SETTINGS, lists: lists || DEFAULT_LISTS, items });
    }

    if (route === "events" && req.method === "POST") {
      const body = await req.json();
      const ev = cleanEvent(body);
      const key = keyFor(ev);
      await s.setJSON(key, ev);
      const oldKey = typeof body._key === "string" ? body._key : "";
      if (oldKey && oldKey !== key && KEY_RE.test(oldKey)) await s.delete(oldKey);
      await s.delete("remcache");
      await later(context, notifyChange(req, oldKey ? "edit" : "add", ev));
      return json({ ...ev, _key: key });
    }

    if (route === "events" && req.method === "DELETE") {
      const key = url.searchParams.get("key") || "";
      if (!KEY_RE.test(key)) return json({ error: "Chiave non valida" }, 400);
      const old = await s.get(key, { type: "json" });
      await s.delete(key);
      await s.delete("remcache");
      if (old) await later(context, notifyChange(req, "del", old));
      return json({ ok: true });
    }

    // ---------- ricerca in tutti gli impegni ----------
    if (route === "search" && req.method === "GET") {
      const q = norm(str(url.searchParams.get("q"), 60));
      if (q.length < 2) return json({ results: [] });
      const all = [...(await readPrefix("ev/")), ...(await readPrefix("rec/")), ...(await readPrefix("span/"))];
      const results = all.filter((e: any) => norm(`${e.title} ${e.note || ""}`).includes(q)).slice(0, 200);
      return json({ results });
    }

    // ---------- messaggi: msg/<istante>-<id> ----------
    if (route === "messages" && req.method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      const { blobs } = await s.list({ prefix: "msg/" });
      let keys = blobs.map((b) => b.key).sort();
      keys = since ? keys.filter((k) => Number(k.slice(4, 18)) > since) : keys.slice(-200);
      const messages = (await Promise.all(keys.map(async (k) => {
        const v = await s.get(k, { type: "json" });
        return v ? { ...(v as object), _key: k } : null;
      }))).filter(Boolean);
      return json({ messages });
    }

    if (route === "messages" && req.method === "POST") {
      const body = await req.json();
      const text = str(body.text, 2000);
      const r = body.ref;
      const ref = r && r.type === "item" && typeof r.key === "string" && ITEM_KEY_RE.test(r.key)
        ? { type: "item", key: r.key, text: str(r.text, 200) } : null;
      if (!text && !ref) return json({ error: "Messaggio vuoto" }, 400);
      let by = "";
      try { by = decodeURIComponent(req.headers.get("x-nome") || "").slice(0, 40); } catch {}
      const at = Date.now();
      const msg = {
        id: typeof body.id === "string" && ID_RE.test(body.id) ? body.id : randomUUID(),
        text, ref, by: by || str(body.by, 40), deviceId: str(req.headers.get("x-device"), 40), at,
      };
      const key = `msg/${String(at).padStart(14, "0")}-${msg.id}`;
      await s.setJSON(key, msg);
      await later(context, (async () => {
        const subs = (await listSubs()).filter((x: any) => x.messages && x.deviceId !== msg.deviceId);
        await Promise.all(subs.map((sub: any) => sendPush(sub, {
          title: `💬 ${msg.by || "Nuovo messaggio"}`,
          body: [text, ref ? `☐ ${ref.text}` : ""].filter(Boolean).join("\n").slice(0, 300),
          url: "/?v=chat",
          tag: "chat",
        })));
      })());
      return json({ ...msg, _key: key });
    }

    if (route === "messages" && req.method === "DELETE") {
      const key = url.searchParams.get("key") || "";
      if (!/^msg\/\d{14}-[a-z0-9-]{6,40}$/.test(key)) return json({ error: "Messaggio non valido" }, 400);
      const msg = (await s.get(key, { type: "json" })) as any;
      if (msg && msg.deviceId && msg.deviceId !== req.headers.get("x-device")) return json({ error: "Puoi eliminare solo i tuoi messaggi" }, 403);
      await s.delete(key);
      return json({ ok: true });
    }

    // ---------- notifiche ----------
    if (route === "push/key" && req.method === "GET") {
      return json({ key: vapidPublicKey() });
    }

    if (route === "push/subscribe" && req.method === "POST") {
      const body = await req.json();
      const sub = body.subscription || {};
      const endpoint = typeof sub.endpoint === "string" && /^https:\/\//.test(sub.endpoint) ? sub.endpoint.slice(0, 1000) : "";
      const keys = sub.keys && typeof sub.keys.p256dh === "string" && typeof sub.keys.auth === "string" ? { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) } : null;
      if (!endpoint || !keys) return json({ error: "Iscrizione non valida" }, 400);
      let tz = str(body.tz, 60) || "Europe/Madrid";
      try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = "Europe/Madrid"; }
      await s.setJSON(subKey(endpoint), {
        endpoint, keys, tz,
        deviceId: str(body.deviceId, 40),
        name: str(body.name, 40),
        changes: !!body.changes,
        reminders: !!body.reminders,
        messages: !!body.messages,
        daily: !!body.daily,
        updatedAt: Date.now(),
      });
      await s.delete("remcache");
      return json({ ok: true });
    }

    if (route === "push/unsubscribe" && req.method === "POST") {
      const body = await req.json();
      if (typeof body.endpoint === "string") await s.delete(subKey(body.endpoint));
      return json({ ok: true });
    }

    if (route === "push/test" && req.method === "POST") {
      const body = await req.json();
      const sub = typeof body.endpoint === "string" ? await s.get(subKey(body.endpoint), { type: "json" }) : null;
      if (!sub) return json({ error: "Questo telefono non è iscritto alle notifiche" }, 400);
      const ok = await sendPush({ ...(sub as object), _key: subKey(body.endpoint) }, {
        title: "Notifiche attive ✓", body: "Da ora il calendario di famiglia ti avvisa qui.", url: "/", tag: "test",
      });
      return ok ? json({ ok: true }) : json({ error: "Invio non riuscito, riprova più tardi" }, 502);
    }

    // ---------- liste condivise: una chiave per voce (li/<lista>/<voce>) ----------
    if (route === "lists" && req.method === "GET") {
      const [lists, items] = await Promise.all([s.get("lists", { type: "json" }), readPrefix("li/")]);
      return json({ lists: lists || DEFAULT_LISTS, items });
    }

    if (route === "lists" && req.method === "PUT") {
      const body = await req.json();
      const lists = (Array.isArray(body.lists) ? body.lists : []).slice(0, 30).map((l: any) => ({
        id: typeof l.id === "string" && LIST_ID_RE.test(l.id) ? l.id : randomUUID().slice(0, 8),
        name: str(l.name, 40) || "Lista",
      }));
      await s.setJSON("lists", lists);
      return json({ lists });
    }

    if (route === "lists" && req.method === "DELETE") {
      const id = url.searchParams.get("id") || "";
      if (!LIST_ID_RE.test(id)) return json({ error: "Lista non valida" }, 400);
      const current = ((await s.get("lists", { type: "json" })) as any[]) || DEFAULT_LISTS;
      const lists = current.filter((l) => l.id !== id);
      await s.setJSON("lists", lists);
      const { blobs } = await s.list({ prefix: `li/${id}/` });
      await Promise.all(blobs.map((b) => s.delete(b.key)));
      await s.delete("remcache");
      return json({ lists });
    }

    if (route === "items" && req.method === "POST") {
      const body = await req.json();
      const list = typeof body.list === "string" && LIST_ID_RE.test(body.list) ? body.list : "";
      const text = str(body.text, 200);
      if (!list) return json({ error: "Lista non valida" }, 400);
      if (!text) return json({ error: "Scrivi qualcosa" }, 400);
      const done = !!body.done;
      const item = {
        id: typeof body.id === "string" && ID_RE.test(body.id) ? body.id : randomUUID(),
        list,
        text,
        done,
        by: str(body.by, 40),
        createdAt: typeof body.createdAt === "number" ? body.createdAt : Date.now(),
        doneAt: done ? (typeof body.doneAt === "number" && body.doneAt ? body.doneAt : Date.now()) : 0,
        due: validDate(body.due) ? (body.due as string) : "",
        dueTime: validDate(body.due) && TIME_RE.test(body.dueTime) ? (body.dueTime as string) : "",
        care: ids(body.care),
        updatedAt: Date.now(),
      };
      const key = `li/${list}/${item.id}`;
      await s.setJSON(key, item);
      if (item.due || body.hadDue) await s.delete("remcache");
      return json({ ...item, _key: key });
    }

    if (route === "items" && req.method === "DELETE") {
      const key = url.searchParams.get("key") || "";
      if (!ITEM_KEY_RE.test(key)) return json({ error: "Voce non valida" }, 400);
      await s.delete(key);
      await s.delete("remcache");
      return json({ ok: true });
    }

    if (route === "items/clear" && req.method === "POST") {
      const list = url.searchParams.get("list") || "";
      if (!LIST_ID_RE.test(list)) return json({ error: "Lista non valida" }, 400);
      const items = (await readPrefix(`li/${list}/`)) as any[];
      const done = items.filter((i) => i.done);
      await Promise.all(done.map((i) => s.delete(i._key)));
      return json({ deleted: done.length });
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
