import AVATARS from "../data/avatars.json";
import LANGUAGES from "../data/languages.json";
import PRODUCTS from "../data/products.json";

const PURCHASE_SOURCES = [
  { id: "tienda", name: "Tienda" },
  { id: "wallapop", name: "Wallapop" },
  { id: "cardmarket", name: "Cardmarket" },
  { id: "otro", name: "Otro" },
];

// Copias por idioma guardadas en collection.langs (JSON) o null si están todas en un idioma
function parseLangs(raw: string | null): Record<string, number> | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  IMAGES: R2Bucket;
  APP_NAME: string;
  SYNC_EXTRA_SETS: string;
}

interface User {
  id: string;
  name: string;
  color: string | null;
  avatar: number | null;
  is_admin: number;
  price_metric: string;
  hide_prices: number;
}

const SESSION_COOKIE = "p30_sid";
const SESSION_DAYS = 60;
const TCGDEX = "https://api.tcgdex.net/v2/es";
const COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#f97316", "#14b8a6", "#ec4899", "#64748b", "#84cc16"];

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/auth/")) return await handleAuth(req, env, url);
      if (url.pathname.startsWith("/img/")) return await serveImage(env, decodeURIComponent(url.pathname.slice(5)), ctx);
      if (url.pathname.startsWith("/api/")) return await handleApi(req, env, url, ctx);
      return env.ASSETS.fetch(req);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Error interno" }, 500);
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron.startsWith("17 6")) {
      ctx.waitUntil(syncFromTcgdex(env).then((r) => console.log("sync", JSON.stringify(r))));
    } else {
      ctx.waitUntil(warmImages(env).then((r) => console.log("images", JSON.stringify(r))));
      ctx.waitUntil(refreshPrices(env).then((r) => console.log("prices", JSON.stringify(r))));
    }
  },
} satisfies ExportedHandler<Env>;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const [k, ...v] = part.split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function randomId(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------- auth (usuario y contraseña)

const PBKDF2_ITERATIONS = 100_000;

async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleAuth(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/auth/login" && req.method === "POST") {
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) throw new HttpError(403, "Origen no permitido");
    const { username, password } = (await req.json()) as { username?: string; password?: string };
    const id = String(username || "").trim().toLowerCase();
    const row = await env.DB.prepare("SELECT id, pass_salt, pass_hash FROM users WHERE id = ?")
      .bind(id)
      .first<{ id: string; pass_salt: string; pass_hash: string }>();
    // Se calcula el hash aunque el usuario no exista para no revelar qué usuarios hay
    const hash = await hashPassword(String(password || ""), row?.pass_salt ?? "x");
    if (!row || !timingSafeEqual(hash, row.pass_hash)) throw new HttpError(401, "Usuario o contraseña incorrectos");
    return startSession(env, row.id);
  }

  if (url.pathname === "/auth/logout" && req.method === "POST") {
    const sid = getCookie(req, SESSION_COOKIE);
    if (sid) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
    return json({ ok: true }, 200, { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
  }

  throw new HttpError(404, "No encontrado");
}

async function startSession(env: Env, userId: string): Promise<Response> {
  const sid = randomId();
  const expires = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").bind(sid, userId, expires),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < unixepoch()"),
  ]);
  return json({ ok: true }, 200, { "set-cookie": cookie(SESSION_COOKIE, sid, SESSION_DAYS * 86400) });
}

async function currentUser(req: Request, env: Env): Promise<User | null> {
  const sid = getCookie(req, SESSION_COOKIE);
  if (!sid) return null;
  return env.DB.prepare(
    `SELECT u.id, u.name, u.color, u.avatar, u.is_admin, u.price_metric, u.hide_prices FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > unixepoch()`,
  )
    .bind(sid)
    .first<User>();
}

// ---------------------------------------------------------------- api

async function handleApi(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, "Inicia sesión");

  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) throw new HttpError(403, "Origen no permitido");
  }

  const path = url.pathname;

  if (path === "/api/me" && req.method === "GET") return json({ user });

  // Toda la colaboración en una sola respuesta: cartas + miembros + quién tiene qué
  if (path === "/api/data" && req.method === "GET") {
    const [sets, cards, users, owned] = await env.DB.batch([
      env.DB.prepare("SELECT id, name, kind, release_date, official, logo FROM sets ORDER BY sort_order, release_date, name"),
      env.DB.prepare(
        "SELECT id, set_id, number, name, rarity, note, source, image_status, coalesce(image_checked_at, 0) AS img_v, cm_trend, cm_mid, cm_updated, cm_manual FROM cards ORDER BY set_id, sort_key, number",
      ),
      env.DB.prepare("SELECT id, name, color, avatar, is_admin FROM users ORDER BY is_admin DESC, created_at"),
      env.DB.prepare("SELECT c.user_id, c.card_id, c.qty, c.lang, c.langs FROM collection c JOIN users u ON u.id = c.user_id WHERE u.is_admin = 0"),
    ]);
    return json({
      me: user,
      avatars: AVATARS,
      languages: LANGUAGES,
      sets: sets.results,
      cards: cards.results,
      users: users.results,
      // [usuario, carta, total, copias por idioma]
      owned: (owned.results as { user_id: string; card_id: string; qty: number; lang: string; langs: string | null }[]).map((r) => [
        r.user_id,
        r.card_id,
        r.qty,
        parseLangs(r.langs) ?? { [r.lang]: r.qty },
      ]),
    });
  }

  const m = path.match(/^\/api\/collection\/([^/]+)$/);
  if (m && req.method === "PUT") {
    if (user.is_admin) throw new HttpError(403, "El administrador no tiene colección");
    const cardId = decodeURIComponent(m[1]);
    const body = (await req.json()) as { langs?: Record<string, number>; qty?: number; lang?: string };
    const card = await env.DB.prepare("SELECT id FROM cards WHERE id = ?").bind(cardId).first();
    if (!card) throw new HttpError(404, "Carta no encontrada");
    const int = (v: unknown) => Math.max(0, Math.min(99, Math.floor(Number(v) || 0)));
    let counts: Record<string, number>;
    if (body.langs && typeof body.langs === "object") {
      // Formato actual: copias por idioma, p. ej. { es: 2, en: 1 }
      counts = {};
      for (const [code, v] of Object.entries(body.langs)) {
        if (!LANGUAGES.some((l) => l.code === code)) throw new HttpError(400, "Idioma no válido");
        if (int(v)) counts[code] = int(v);
      }
    } else {
      // Formato antiguo: { qty, lang? } → todas las copias en un idioma
      if (body.lang !== undefined && !LANGUAGES.some((l) => l.code === body.lang)) throw new HttpError(400, "Idioma no válido");
      let lang = body.lang;
      if (!lang) lang = ((await env.DB.prepare("SELECT lang FROM collection WHERE user_id = ? AND card_id = ?").bind(user.id, cardId).first("lang")) as string | null) ?? "es";
      counts = int(body.qty) ? { [lang]: int(body.qty) } : {};
    }
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    if (n > 99) throw new HttpError(400, "Máximo 99 copias por carta");
    if (n === 0) {
      await env.DB.prepare("DELETE FROM collection WHERE user_id = ? AND card_id = ?").bind(user.id, cardId).run();
    } else {
      // Idioma principal: el que más copias tiene (en empate, el primero de la lista: español)
      const main = LANGUAGES.map((l) => l.code).reduce((best, code) => ((counts[code] || 0) > (counts[best] || 0) ? code : best), LANGUAGES[0].code);
      const langs = Object.keys(counts).length > 1 ? JSON.stringify(counts) : null;
      await env.DB.prepare(
        `INSERT INTO collection (user_id, card_id, qty, lang, langs) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(user_id, card_id) DO UPDATE SET qty = excluded.qty, lang = excluded.lang, langs = excluded.langs, updated_at = unixepoch()`,
      )
        .bind(user.id, cardId, n, main, langs)
        .run();
    }
    return json({ ok: true, qty: n, langs: counts });
  }

  // Precio de Cardmarket a mano para cartas sin precio automático. { trend: null, mid: null } lo quita.
  const pm = path.match(/^\/api\/cards\/(.+)\/price$/);
  if (pm && req.method === "PUT") {
    if (user.is_admin) throw new HttpError(403, "El administrador no gestiona precios");
    const cardId = decodeURIComponent(pm[1]);
    const body = (await req.json()) as { trend?: unknown; mid?: unknown };
    const money = (v: unknown) => {
      if (v === null || v === undefined || v === "") return null;
      const n = Math.round(Number(String(v).replace(",", ".")) * 100) / 100;
      if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) throw new HttpError(400, "Precio no válido");
      return n;
    };
    const trend = money(body.trend);
    const mid = money(body.mid);
    const card = await env.DB.prepare("SELECT id FROM cards WHERE id = ?").bind(cardId).first();
    if (!card) throw new HttpError(404, "Carta no encontrada");
    if (trend === null && mid === null) {
      // Se quita el precio a mano; si la carta tiene fuente automática, el cron la vuelve a rellenar
      await env.DB.prepare("UPDATE cards SET cm_trend = NULL, cm_mid = NULL, cm_updated = NULL, cm_manual = 0, cm_checked_at = NULL WHERE id = ?").bind(cardId).run();
    } else {
      await env.DB.prepare("UPDATE cards SET cm_trend = ?, cm_mid = ?, cm_updated = ?, cm_manual = 1 WHERE id = ?")
        .bind(trend, mid, new Date().toISOString(), cardId)
        .run();
    }
    return json({ ok: true, cm_trend: trend, cm_mid: mid });
  }

  // Cualquiera del grupo puede dar de alta cartas nuevas (promos, productos futuros...).
  // La imagen es obligatoria: archivo subido o URL, y se guarda una copia en R2.
  if (path === "/api/cards" && req.method === "POST") {
    const form = await req.formData();
    const field = (k: string, max: number) => String(form.get(k) ?? "").trim().slice(0, max);
    const setId = field("set_id", 80);
    const number = field("number", 20);
    const name = field("name", 80);
    if (!setId || !number || !name) throw new HttpError(400, "Faltan colección, número o nombre");
    const set = await env.DB.prepare("SELECT id FROM sets WHERE id = ?").bind(setId).first();
    if (!set) throw new HttpError(400, "Colección desconocida");
    const id = `${setId}-${number}`;
    if (await env.DB.prepare("SELECT id FROM cards WHERE id = ?").bind(id).first()) throw new HttpError(409, "Ya existe esa carta");

    const file = form.get("file");
    const imageUrl = field("image", 500);
    let img: Img | null = null;
    if (file instanceof File && file.size > 0) img = await readUpload(file);
    else if (/^https:\/\//.test(imageUrl)) img = await fetchImage(imageUrl);
    if (!img) throw new HttpError(400, "La imagen es obligatoria: sube un archivo o pega una URL de imagen válida");

    await env.DB.prepare(
      `INSERT INTO cards (id, set_id, number, sort_key, name, rarity, note, image_alt, source, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
    )
      .bind(id, setId, number, sortKey(number), name, field("rarity", 40) || null, field("note", 120) || null, imageUrl || null, user.id)
      .run();
    await storeImage(env, id, img);
    return json({ ok: true, id });
  }

  // Subir / sustituir la imagen de cualquier carta
  const mi = path.match(/^\/api\/cards\/([^/]+)\/image$/);
  if (mi && req.method === "PUT") {
    const cardId = decodeURIComponent(mi[1]);
    if (!(await env.DB.prepare("SELECT id FROM cards WHERE id = ?").bind(cardId).first())) throw new HttpError(404, "Carta no encontrada");
    const type = req.headers.get("content-type") ?? "";
    const body = await req.arrayBuffer();
    const img = validImage(body, type);
    if (!img) throw new HttpError(400, "Sube una imagen JPG, PNG o WebP de menos de 8 MB");
    await storeImage(env, cardId, img);
    return json({ ok: true });
  }

  if (path === "/api/sets" && req.method === "POST") {
    const body = (await req.json()) as { name?: string; kind?: string; release_date?: string; official?: number };
    const name = String(body.name || "").trim().slice(0, 80);
    if (!name) throw new HttpError(400, "Falta el nombre");
    const id = slugify(name);
    const kind = ["expansion", "subset", "promo", "other"].includes(String(body.kind)) ? body.kind : "promo";
    await env.DB.prepare(
      "INSERT INTO sets (id, name, kind, release_date, official, sort_order) VALUES (?, ?, ?, ?, ?, 200) ON CONFLICT(id) DO NOTHING",
    )
      .bind(id, name, kind, body.release_date || null, body.official || null)
      .run();
    return json({ ok: true, id });
  }

  // Gestión de miembros: el admin crea y quita usuarios; cada uno cambia su contraseña
  if (path === "/api/users" && req.method === "POST") {
    if (!user.is_admin) throw new HttpError(403, "Solo el administrador puede crear usuarios");
    const body = (await req.json()) as { username?: string; name?: string; password?: string };
    const id = String(body.username || "").trim().toLowerCase();
    if (!/^[a-z0-9_.-]{2,30}$/.test(id)) throw new HttpError(400, "El usuario solo puede tener letras sin acentos, números, punto, guion o guion bajo");
    const password = String(body.password || "");
    if (password.length < 4) throw new HttpError(400, "La contraseña necesita al menos 4 caracteres");
    const { n } = (await env.DB.prepare("SELECT count(*) AS n FROM users").first<{ n: number }>())!;
    const salt = randomId(16);
    const res = await env.DB.prepare(
      "INSERT INTO users (id, name, pass_salt, pass_hash, color) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    )
      .bind(id, capitalizeName(String(body.name || id)).slice(0, 40), salt, await hashPassword(password, salt), COLORS[n % COLORS.length])
      .run();
    if (!res.meta.changes) throw new HttpError(409, "Ese usuario ya existe");
    return json({ ok: true, id });
  }

  // Gastos: lo que ha pagado cada uno por producto. Lo ve todo el grupo; cada uno edita lo suyo.
  if (path === "/api/purchases" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.user_id, p.product, p.name, p.qty, p.unit_price, p.source, p.bought_on FROM purchases p
       JOIN users u ON u.id = p.user_id WHERE u.is_admin = 0 ORDER BY p.bought_on IS NULL, p.bought_on, p.id`,
    ).all();
    return json({ products: PRODUCTS, sources: PURCHASE_SOURCES, purchases: results });
  }
  if (path === "/api/purchases" && req.method === "POST") {
    if (user.is_admin) throw new HttpError(403, "El administrador no tiene compras");
    const b = (await req.json()) as Record<string, unknown>;
    const product = PRODUCTS.find((x) => x.id === b.product);
    if (!product) throw new HttpError(400, "Producto no válido");
    const name = String(b.name ?? "").trim().slice(0, 80) || null;
    if ((product as { custom?: boolean }).custom && !name) throw new HttpError(400, "Escribe qué carta o producto es");
    const qty = Math.floor(Number(b.qty));
    if (!(qty >= 1 && qty <= 999)) throw new HttpError(400, "Cantidad no válida");
    const price = Math.round(Number(String(b.unit_price ?? "").replace(",", ".")) * 100) / 100;
    if (!Number.isFinite(price) || price < 0 || price > 100000) throw new HttpError(400, "Precio no válido");
    const source = PURCHASE_SOURCES.some((x) => x.id === b.source) ? String(b.source) : null;
    const boughtOn = /^\d{4}-\d{2}-\d{2}$/.test(String(b.bought_on ?? "")) ? String(b.bought_on) : null;
    const res = await env.DB.prepare("INSERT INTO purchases (user_id, product, name, qty, unit_price, source, bought_on) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(user.id, product.id, (product as { custom?: boolean }).custom ? name : null, qty, price, source, boughtOn)
      .run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  const pu = path.match(/^\/api\/purchases\/(\d+)$/);
  if (pu && req.method === "DELETE") {
    const res = await env.DB.prepare("DELETE FROM purchases WHERE id = ? AND user_id = ?").bind(Number(pu[1]), user.id).run();
    if (!res.meta.changes) throw new HttpError(404, "Esa compra no es tuya o ya no existe");
    return json({ ok: true });
  }

  const mu = path.match(/^\/api\/users\/([^/]+)$/);
  if (mu && req.method === "DELETE") {
    if (!user.is_admin) throw new HttpError(403, "Solo el administrador puede quitar usuarios");
    const id = decodeURIComponent(mu[1]);
    if (id === user.id) throw new HttpError(400, "No puedes quitarte a ti mismo");
    await env.DB.prepare("DELETE FROM users WHERE id = ? AND is_admin = 0").bind(id).run();
    return json({ ok: true });
  }

  if (path === "/api/me/password" && req.method === "PUT") {
    const { current, password } = (await req.json()) as { current?: string; password?: string };
    const row = (await env.DB.prepare("SELECT pass_salt, pass_hash FROM users WHERE id = ?").bind(user.id).first<{ pass_salt: string; pass_hash: string }>())!;
    if (!timingSafeEqual(await hashPassword(String(current || ""), row.pass_salt), row.pass_hash)) throw new HttpError(400, "La contraseña actual no es correcta");
    if (String(password || "").length < 4) throw new HttpError(400, "La contraseña nueva necesita al menos 4 caracteres");
    const salt = randomId(16);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?").bind(salt, await hashPassword(String(password), salt), user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(user.id, getCookie(req, SESSION_COOKIE)),
    ]);
    return json({ ok: true });
  }

  // Avatar propio: solo de la lista cerrada, o null para volver a la inicial del nombre
  if (path === "/api/me/avatar" && req.method === "PUT") {
    const { avatar } = (await req.json()) as { avatar?: number | null };
    if (avatar != null && !AVATARS.some((a) => a.id === avatar)) throw new HttpError(400, "Ese avatar no está en la lista");
    await env.DB.prepare("UPDATE users SET avatar = ? WHERE id = ?").bind(avatar ?? null, user.id).run();
    return json({ ok: true, avatar: avatar ?? null });
  }

  if (path === "/api/me/prefs" && req.method === "PUT") {
    const { price_metric, hide_prices } = (await req.json()) as { price_metric?: string; hide_prices?: boolean };
    if (price_metric !== "cm_trend" && price_metric !== "cm_mid") throw new HttpError(400, "Precio predeterminado no válido");
    await env.DB.prepare("UPDATE users SET price_metric = ?, hide_prices = ? WHERE id = ?").bind(price_metric, hide_prices ? 1 : 0, user.id).run();
    return json({ ok: true });
  }

  if (path === "/api/sync" && req.method === "POST") {
    return json(await syncFromTcgdex(env));
  }

  throw new HttpError(404, "No encontrado");
}

function capitalizeName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toLocaleUpperCase("es"));
}

function sortKey(number: string): number {
  const digits = number.match(/\d+/);
  return digits ? parseInt(digits[0], 10) : 9999;
}

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// ---------------------------------------------------------------- sync TCGdex

interface TcgdexSetBrief {
  id: string;
  name: string;
  logo?: string;
}
interface TcgdexSet extends TcgdexSetBrief {
  releaseDate?: string;
  cardCount?: { official?: number };
  cards: { id: string; localId: string; name: string; image?: string }[];
}

const ANNIVERSARY = /(30|treinta).*aniversario|aniversario.*30|30th/i;

/**
 * Trae de TCGdex (base de datos abierta con cartas en español) todas las expansiones
 * cuyo nombre sea del 30.º aniversario, más las indicadas en SYNC_EXTRA_SETS, y da de
 * alta las cartas que falten o completa sus imágenes. Se ejecuta a diario por cron.
 */
async function syncFromTcgdex(env: Env) {
  const res = await fetch(`${TCGDEX}/sets`);
  if (!res.ok) throw new HttpError(502, `TCGdex respondió ${res.status}`);
  const all = (await res.json()) as TcgdexSetBrief[];
  const extra = (env.SYNC_EXTRA_SETS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const targets = all.filter((s) => ANNIVERSARY.test(s.name) || extra.includes(s.id));

  const ours = (await env.DB.prepare("SELECT id, name, tcgdex_id FROM sets").all<{ id: string; name: string; tcgdex_id: string | null }>()).results;
  const norm = (s: string) => slugify(s);
  let added = 0;

  for (const brief of targets.slice(0, 20)) {
    const r = await fetch(`${TCGDEX}/sets/${encodeURIComponent(brief.id)}`);
    if (!r.ok) continue;
    const set = (await r.json()) as TcgdexSet;
    const local = ours.find((o) => o.tcgdex_id === set.id) ?? ours.find((o) => !o.tcgdex_id && norm(o.name) === norm(set.name));
    const setId = local?.id ?? `tcgdex-${set.id}`;
    const stmts: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO sets (id, name, kind, release_date, official, logo, tcgdex_id, sort_order)
         VALUES (?, ?, 'expansion', ?, ?, ?, ?, 150)
         ON CONFLICT(id) DO UPDATE SET tcgdex_id = excluded.tcgdex_id,
           logo = coalesce(sets.logo, excluded.logo), release_date = coalesce(sets.release_date, excluded.release_date)`,
      ).bind(setId, set.name, set.releaseDate ?? null, set.cardCount?.official ?? null, set.logo ? `${set.logo}.webp` : null, set.id),
    ];
    for (const c of set.cards) {
      // Los Mew secretos de YOSHIROTTEN vienen como R, G y B; aquí se guardan como "R/RGB"…
      const number = /^[RGB]$/.test(c.localId) ? `${c.localId}/RGB` : c.localId;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO cards (id, set_id, number, sort_key, name, image, source) VALUES (?, ?, ?, ?, ?, ?, 'tcgdex')
           ON CONFLICT(set_id, number) DO UPDATE SET image = coalesce(cards.image, excluded.image)`,
        ).bind(`${setId}-${number}`, setId, number, sortKey(number), c.name, c.image ?? null),
      );
    }
    const before = await env.DB.prepare("SELECT count(*) AS n FROM cards WHERE set_id = ?").bind(setId).first<{ n: number }>();
    await env.DB.batch(stmts);
    const after = await env.DB.prepare("SELECT count(*) AS n FROM cards WHERE set_id = ?").bind(setId).first<{ n: number }>();
    added += (after?.n ?? 0) - (before?.n ?? 0);
  }
  return { ok: true, sets: targets.map((t) => t.name), added };
}

// ---------------------------------------------------------------- precios Cardmarket

const PRICES_PER_RUN = 25;
const PRICE_MAX_AGE = 6 * 3600;

/** ".../es/me/30th/001" → "30th-001", el id de la carta en la API de TCGdex. */
function tcgdexCardId(image: string): string | null {
  const m = image.match(/assets\.tcgdex\.net\/[^/]+\/[^/]+\/([^/]+)\/([^/.]+)$/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** Las cartas que solo existen en versión holo traen el precio en los campos "-holo". */
function pickPrice(cm: Record<string, unknown>, field: string): number | null {
  for (const key of [field, `${field}-holo`]) {
    const v = cm[key];
    if (typeof v === "number" && v > 0) return v;
  }
  return null;
}

/** Cron: actualiza por tandas los precios más antiguos (Cardmarket los renueva una vez al día). */
async function refreshPrices(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id, image FROM cards WHERE image LIKE '%assets.tcgdex.net%' AND cm_manual = 0 AND coalesce(cm_checked_at, 0) < unixepoch() - ?
     ORDER BY coalesce(cm_checked_at, 0) LIMIT ?`,
  )
    .bind(PRICE_MAX_AGE, PRICES_PER_RUN)
    .all<{ id: string; image: string }>();
  let updated = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const card of results) {
    const tcgdexId = tcgdexCardId(card.image);
    let cm: Record<string, unknown> | null = null;
    if (tcgdexId) {
      const res = await fetch(`${TCGDEX}/cards/${encodeURIComponent(tcgdexId)}`).catch(() => null);
      // Un fallo puntual de TCGdex se reintenta en la siguiente tanda
      if (!res || res.status >= 500) continue;
      if (res.ok) cm = ((await res.json()) as { pricing?: { cardmarket?: Record<string, unknown> | null } }).pricing?.cardmarket ?? null;
    }
    if (cm) updated++;
    stmts.push(
      env.DB.prepare(
        `UPDATE cards SET cm_trend = coalesce(?, cm_trend), cm_mid = coalesce(?, cm_mid), cm_updated = coalesce(?, cm_updated), cm_checked_at = unixepoch() WHERE id = ?`,
      ).bind(cm && pickPrice(cm, "trend"), cm && pickPrice(cm, "avg"), cm && typeof cm.updated === "string" ? cm.updated : null, card.id),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { checked: results.length, updated };
}

// ---------------------------------------------------------------- imágenes

interface Img {
  body: ArrayBuffer;
  type: string;
}

const MAX_IMAGE = 8 * 1024 * 1024;
const RETRY_MISSING_AFTER = 6 * 3600;

function validImage(body: ArrayBuffer, type: string): Img | null {
  type = type.split(";")[0].trim().toLowerCase();
  if (!/^image\/(jpeg|png|webp|avif)$/.test(type)) return null;
  if (body.byteLength < 2048 || body.byteLength > MAX_IMAGE) return null;
  return { body, type };
}

async function readUpload(file: File): Promise<Img | null> {
  return validImage(await file.arrayBuffer(), file.type);
}

async function fetchImage(url: string): Promise<Img | null> {
  try {
    const res = await fetch(url, { headers: { accept: "image/webp,image/png,image/jpeg,*/*;q=0.5" }, cf: { cacheTtl: 86400 } });
    if (!res.ok) return null;
    return validImage(await res.arrayBuffer(), res.headers.get("content-type") ?? "");
  } catch {
    return null;
  }
}

/** Orden de búsqueda: TCGdex en español → TCGdex en inglés → URL alternativa (Scrydex/manual). */
function imageCandidates(card: { image: string | null; image_alt: string | null }): string[] {
  const out: string[] = [];
  if (card.image) {
    if (/\.(webp|png|jpe?g)$/i.test(card.image)) out.push(card.image);
    else {
      out.push(`${card.image}/high.webp`);
      if (card.image.includes("tcgdex.net/es/")) out.push(`${card.image.replace("tcgdex.net/es/", "tcgdex.net/en/")}/high.webp`);
    }
  }
  if (card.image_alt) out.push(card.image_alt);
  return out;
}

async function storeImage(env: Env, cardId: string, img: Img) {
  const key = `cards/${cardId}`;
  await env.IMAGES.put(key, img.body, { httpMetadata: { contentType: img.type } });
  await env.DB.prepare("UPDATE cards SET image_key = ?, image_status = 'ok', image_checked_at = unixepoch() WHERE id = ?")
    .bind(key, cardId)
    .run();
}

type CardImageRow = { id: string; image: string | null; image_alt: string | null; image_key: string | null; image_status: string | null; image_checked_at: number | null };

/** Busca la imagen en las fuentes externas y guarda una copia propia en R2. */
async function resolveImage(env: Env, card: CardImageRow): Promise<Img | null> {
  for (const url of imageCandidates(card)) {
    const img = await fetchImage(url);
    if (img) {
      await storeImage(env, card.id, img);
      return img;
    }
  }
  await env.DB.prepare("UPDATE cards SET image_status = 'missing', image_checked_at = unixepoch() WHERE id = ?").bind(card.id).run();
  return null;
}

async function serveImage(env: Env, cardId: string, ctx: ExecutionContext): Promise<Response> {
  const stored = await env.IMAGES.get(`cards/${cardId}`);
  if (stored) {
    return new Response(stored.body, {
      headers: {
        "content-type": stored.httpMetadata?.contentType ?? "image/webp",
        "cache-control": "public, max-age=604800",
        etag: stored.httpEtag,
      },
    });
  }
  const card = await env.DB.prepare("SELECT id, image, image_alt, image_key, image_status, image_checked_at FROM cards WHERE id = ?")
    .bind(cardId)
    .first<CardImageRow>();
  if (!card) return new Response("No encontrada", { status: 404 });
  const recentlyMissing = card.image_status === "missing" && (card.image_checked_at ?? 0) > Date.now() / 1000 - RETRY_MISSING_AFTER;
  const img = recentlyMissing ? null : await resolveImage(env, card);
  if (!img) return new Response("Sin imagen", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(img.body, { headers: { "content-type": img.type, "cache-control": "public, max-age=604800" } });
}

/** Cron: comprueba y copia a R2 las imágenes que aún no estén guardadas (en tandas pequeñas). */
async function warmImages(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id, image, image_alt, image_key, image_status, image_checked_at FROM cards
     WHERE image_status IS NULL OR (image_status = 'missing' AND image_checked_at < unixepoch() - ?)
     ORDER BY image_status IS NOT NULL, sort_key LIMIT 8`,
  )
    .bind(RETRY_MISSING_AFTER)
    .all<CardImageRow>();
  let ok = 0;
  for (const card of results) if (await resolveImage(env, card)) ok++;
  const { pending } = (await env.DB.prepare("SELECT count(*) AS pending FROM cards WHERE image_status IS NOT 'ok'").first<{ pending: number }>())!;
  return { checked: results.length, ok, pending };
}
