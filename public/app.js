const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = {
  me: null,
  sets: [],
  cards: [],
  users: [],
  avatars: [],
  languages: [],
  copies: new Map(), // cardId -> Map(userId -> { es: 2, en: 1 }) copias por idioma
  owned: new Map(), // cardId -> Map(userId -> qty)
  view: localGet("view") || "grid",
  set: "all", // al recargar se empieza siempre sin filtros
  q: "",
  rarity: "",
  owner: "all",
  priceMetric: "cm_trend",
  priceMin: "",
  grade: "", // "" = sin gradear | "8" | "9" | "10" (no se recuerda al recargar)
  gradeOnly: false,
  priceMax: "",
};

const RARITY_ORDER = ["Común", "Poco común", "Rara", "Rara doble", "Rara Pikachu", "Rara ilustración", "Rara ilustración especial", "Rara futurista", "Rara RGB", "Clásica", "Promo"];

function localGet(k) {
  try { return localStorage.getItem(`p30:${k}`); } catch { return null; }
}
function localSet(k, v) {
  try { localStorage.setItem(`p30:${k}`, v); } catch {}
}

// ------------------------------------------------------------- red
// Reintentos automáticos, aviso de "sin conexión" y cola de cambios pendientes

const RETRY_DELAYS = [700, 1800, 4000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const offlineError = () => Object.assign(new Error("Sin conexión"), { offline: true });

async function api(path, opts = {}) {
  const { retry, ...init } = opts;
  const method = (init.method || "GET").toUpperCase();
  // Los POST (crear usuario, subir carta…) no se repiten solos para no duplicar nada
  const retryable = retry ?? method !== "POST";
  const headers = typeof init.body === "string" ? { "content-type": "application/json" } : {};
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    } catch {
      if (retryable && navigator.onLine && i < RETRY_DELAYS.length) {
        net.retrying(true);
        await sleep(RETRY_DELAYS[i]);
        continue;
      }
      net.retrying(false);
      net.setOnline(false);
      throw offlineError();
    }
    if (retryable && res.status >= 500 && i < RETRY_DELAYS.length) {
      net.retrying(true);
      await sleep(RETRY_DELAYS[i]);
      continue;
    }
    net.retrying(false);
    net.setOnline(true);
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw Object.assign(new Error("auth"), { status: 401 });
    if (!res.ok) throw Object.assign(new Error(body.error || `Error ${res.status}`), { status: res.status });
    return body;
  }
}

// Aviso fijo arriba: sin conexión / reintentando / conexión recuperada
const net = {
  online: navigator.onLine,
  slow: false,
  flash: null,
  setOnline(v) {
    if (v === this.online) return;
    this.online = v;
    if (v) {
      flushPending().then(() => {
        this.flash = pending.size ? null : "Conexión recuperada";
        this.render();
        setTimeout(() => { this.flash = null; this.render(); }, 2500);
        refresh();
      });
    }
    this.render();
  },
  retrying(v) {
    if (v === this.slow) return;
    this.slow = v;
    this.render();
  },
  render() {
    const el = $("#net");
    if (!el) return;
    const n = pending.size;
    const cambios = `${n} ${n === 1 ? "cambio pendiente" : "cambios pendientes"}`;
    let msg = "", cls = "";
    if (!this.online) {
      msg = n ? `Sin conexión · ${cambios}. Se guardarán solos al volver.` : "Sin conexión · lo que veas puede no estar al día";
      cls = "off";
    } else if (this.slow) {
      msg = "Conexión inestable · reintentando…";
      cls = "slow";
    } else if (n) {
      msg = `Guardando ${cambios}…`;
      cls = "slow";
    } else if (this.flash) {
      msg = this.flash;
      cls = "ok";
    }
    el.hidden = !msg || $("#app").hidden;
    el.className = `net ${cls}`;
    el.textContent = msg;
  },
};

// Cambios de colección hechos sin conexión: cardId -> { langs: { es: 2, en: 1 } } (lo último que ve el usuario)
const pending = new Map();
let pendingKey = null;
function loadPending() {
  pendingKey = `pending:${state.me.id}`;
  try {
    for (const [k, v] of Object.entries(JSON.parse(localGet(pendingKey) || "{}"))) {
      // Cola guardada por una versión anterior: { qty, lang }
      pending.set(k, v.langs ? v : { langs: v.qty ? { [v.lang || "es"]: v.qty } : {} });
    }
  } catch {}
}
function savePending() {
  if (pendingKey) localSet(pendingKey, JSON.stringify(Object.fromEntries(pending)));
  net.render();
}
function queueCard(cardId) {
  const me = state.me.id;
  pending.set(cardId, { langs: { ...copies(cardId, me) } });
  savePending();
}
// Vuelve a poner encima de los datos del servidor lo que aún no se ha podido guardar
function applyPending() {
  const me = state.me.id;
  for (const [cardId, snap] of pending) setCopies(cardId, me, snap.langs);
}
let flushing = null;
function flushPending() {
  if (!pending.size || !net.online) return Promise.resolve();
  return (flushing ||= (async () => {
    try {
      for (const [cardId, snap] of [...pending]) {
        try {
          await api(`/api/collection/${encodeURIComponent(cardId)}`, { method: "PUT", body: JSON.stringify(snap) });
        } catch (e) {
          if (e.offline) return; // seguimos sin red: se queda en la cola
          toast(`No se pudo guardar un cambio: ${e.message}`);
        }
        if (pending.get(cardId) === snap) pending.delete(cardId); // si cambió entretanto, se manda en otra vuelta
        savePending();
      }
    } finally {
      flushing = null;
    }
    if (pending.size && net.online) return flushPending();
  })());
}

async function refresh() {
  if (!state.me || pending.size) return;
  try { await load(); render(); } catch {}
  loadTrades();
}

addEventListener("online", () => net.setOnline(true));
addEventListener("offline", () => net.setOnline(false));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && pending.size) flushPending().then(refresh);
});

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

// ------------------------------------------------------------- carga

async function load(retry = true) {
  const started = Date.now();
  const data = await api("/api/data", { retry });
  state.me = data.me;
  state.sets = data.sets;
  state.cards = data.cards;
  state.users = data.users;
  state.avatars = data.avatars;
  state.languages = data.languages;
  state.usdEur = data.usd_eur || 0.87;
  state.owned = new Map();
  state.copies = new Map();
  for (const [u, c, q, l] of data.owned) setCopies(c, u, typeof l === "object" && l ? l : { [l || "es"]: q });
  if (state.set !== "all" && !state.sets.some((s) => s.id === state.set)) state.set = "all";
  if (!pendingKey) loadPending();
  applyPending();
  applyRecentWrites(started);
}

let bootRetry = null;
let booting = false;
async function boot() {
  if (booting) return;
  booting = true;
  try {
    await load(false); // al arrancar no esperamos: la pantalla de espera ya reintenta sola
  } catch (e) {
    if (e.status === 401) {
      $("#down").hidden = true;
      $("#login").hidden = false;
      $("#form-login").addEventListener("submit", login);
      return;
    }
    // Sin red o servidor caído: pantalla de espera que reintenta sola
    $("#down-msg").textContent = e.offline
      ? "No hay conexión con el servidor. En cuanto vuelva, la colección se cargará sola."
      : `El servidor no responde ahora mismo (${e.message}). Lo seguimos intentando.`;
    $("#down").hidden = false;
    clearTimeout(bootRetry);
    bootRetry = setTimeout(boot, 15000);
    return;
  } finally {
    booting = false;
  }
  clearTimeout(bootRetry);
  $("#down").hidden = true;
  $("#login").hidden = true;
  $("#app").hidden = false;
  setupUI();
  render();
  net.render();
  flushPending().then(refresh);
  // Refresco periódico para ver los cambios de los demás
  setInterval(async () => {
    if (document.hidden || $("dialog[open]")) return;
    await flushPending();
    refresh();
  }, 20000);
}
$("#down-retry").addEventListener("click", () => { $("#down-msg").textContent = "Reintentando…"; boot(); });
addEventListener("online", () => { if (!$("#down").hidden) boot(); });

async function login(e) {
  e.preventDefault();
  const err = $("#login-error");
  err.hidden = true;
  let res;
  try {
    res = await fetch("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: $("#login-user").value, password: $("#login-pass").value }),
    });
  } catch {
    err.textContent = "Sin conexión. Comprueba tu red e inténtalo de nuevo.";
    err.hidden = false;
    return;
  }
  if (!res.ok) {
    err.textContent = (await res.json().catch(() => ({}))).error || "No se pudo entrar";
    err.hidden = false;
    return;
  }
  location.reload();
}

// ------------------------------------------------------------- helpers

function avatar(u, cls = "") {
  const inner = u.avatar ? `<img src="/avatars/${Number(u.avatar)}.png" alt="">` : esc((u.name || "?").trim().charAt(0).toUpperCase());
  return `<span class="avatar ${cls}" style="--c:${esc(u.color)}" title="${esc(u.name)}">${inner}</span>`;
}

// El administrador solo gestiona: no colecciona ni cuenta en las estadísticas
function collectors() {
  return state.users.filter((u) => !u.is_admin);
}

// Todas las imágenes salen de la copia propia en R2 (el Worker la busca y guarda la primera vez)
function imgUrl(card) {
  return `/img/${encodeURIComponent(card.id)}?v=${card.img_v || 0}`;
}

const brokenImages = new Set();
window.p30ImgError = (el) => {
  const id = el.dataset.id;
  brokenImages.add(id);
  const card = state.cards.find((c) => c.id === id);
  if (card) card.image_status = "missing";
  el.closest(".art")?.classList.add("noimg");
  el.closest(".ghost")?.classList.remove("ghost");
  el.remove();
  renderImageWarning();
};

function setById(id) {
  return state.sets.find((s) => s.id === id);
}

function displayNumber(card) {
  const set = setById(card.set_id);
  if (/^\d+$/.test(card.number) && set?.official && set.kind !== "subset") return `${card.number}/${String(set.official).padStart(3, "0")}`;
  return card.number;
}

function qty(cardId, userId) {
  return state.owned.get(cardId)?.get(userId) || 0;
}

const euros = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const price = (v) => (v == null ? "—" : euros.format(v));

const langInfo = (code) => state.languages.find((l) => l.code === code) || { code, name: code, factor: 1 };

// Copias de una carta por idioma, p. ej. { es: 2, en: 1 } ({} si no la tiene)
const copies = (cardId, userId) => state.copies.get(cardId)?.get(userId) || {};

// Guarda las copias por idioma de un usuario y mantiene el total en state.owned
function setCopies(cardId, userId, bd = {}) {
  const clean = {};
  let n = 0;
  for (const l of state.languages) {
    const v = Math.max(0, Math.floor(Number(bd[l.code]) || 0));
    if (v) { clean[l.code] = v; n += v; }
  }
  for (const m of [state.owned, state.copies]) if (!m.has(cardId)) m.set(cardId, new Map());
  if (n) {
    state.owned.get(cardId).set(userId, n);
    state.copies.get(cardId).set(userId, clean);
  } else {
    state.owned.get(cardId).delete(userId);
    state.copies.get(cardId).delete(userId);
  }
}

// Idiomas que no son solo español (para avisos de precio estimado)
const hasForeign = (cardId, userId) => Object.keys(copies(cardId, userId)).some((k) => k !== "es");

// "2 Español, 1 Inglés" o solo "Japonés" si están todas en uno
function copiesText(cardId, userId) {
  const e = Object.entries(copies(cardId, userId));
  if (e.length === 1) return langInfo(e[0][0]).name;
  return e.map(([k, n]) => `${n} ${langInfo(k).name}`).join(", ");
}

// Precio de una copia según su idioma (data/languages.json):
// - español → Cardmarket (lo que usan las tiendas en España)
// - inglés → TCGplayer (el que usa Collectr), en $ pasado a €
// - japonés, chino… → no hay precio específico: Cardmarket como aproximado
// Si una copia en inglés aún no tiene precio de TCGplayer, también se usa Cardmarket como aproximado.
function langPrice(c, metric, lang) {
  const info = langInfo(lang);
  if (info.source === "tcgplayer") {
    const usd = metric === "cm_mid" ? c.tp_mid ?? c.tp_market : c.tp_market ?? c.tp_mid;
    if (usd != null) return { v: usd * state.usdEur, src: "tcgplayer", usd };
  }
  if (c[metric] == null) return { v: null, src: null };
  return { v: c[metric], src: info.source === "cardmarket" ? "cardmarket" : "approx" };
}

// Precio por copia de la carta de un usuario (media si tiene copias en varios idiomas: total = copias × precio).
// Sin usuario o sin copias: el de una copia en español.
function cardPrice(c, metric, userId) {
  const n = userId ? qty(c.id, userId) : 0;
  if (!n) return c[metric] ?? null;
  // Media de las copias que tienen precio (las que no tienen, no cuentan)
  let sum = 0;
  let priced = 0;
  for (const [k, q] of Object.entries(copies(c.id, userId))) {
    const { v } = langPrice(c, metric, k);
    if (v != null) { sum += q * v; priced += q; }
  }
  return priced ? sum / priced : null;
}

// ¿Alguna copia usa Cardmarket como aproximado? (japonés, chino, o inglés aún sin precio de TCGplayer)
const priceIsApprox = (c, metric, userId) =>
  !!userId && Object.keys(copies(c.id, userId)).some((k) => langPrice(c, metric, k).src === "approx");

// «Inglés: 3,20 US$ en TCGplayer ≈ 2,78 €» para la ficha
function foreignPriceText(c, lang) {
  const info = langInfo(lang);
  const p = langPrice(c, state.me.price_metric, lang);
  if (p.src === "tcgplayer") return `${esc(info.name)}: ${p.usd.toLocaleString("es-ES", { style: "currency", currency: "USD" })} en TCGplayer ≈ ${price(p.v)}`;
  const why = info.source === "tcgplayer" ? "aún sin precio en TCGplayer" : `no hay precio específico en ${info.name.toLowerCase()}`;
  return p.v == null ? `${esc(info.name)}: ${esc(why)} ni en Cardmarket` : `${esc(info.name)}: ${esc(why)}; aproximado con Cardmarket ≈ ${price(p.v)}`;
}

// Etiqueta de idioma: "EN", o "ES·EN" si hay copias en varios idiomas; nada si todo es español
function langTag(c, userId) {
  if (!userId || !qty(c.id, userId) || !hasForeign(c.id, userId)) return "";
  const codes = Object.keys(copies(c.id, userId)).map((k) => k.toUpperCase()).join("·");
  return `<span class="langtag" title="${esc(copiesText(c.id, userId))}">${esc(codes)}</span>`;
}

const metricName = (m) => (m === "cm_mid" ? "Mid" : "Trend");

// Filas PSA 8/9/10 de la ficha
function psaRowsHtml(c) {
  if (!c.psa_updated) return "";
  return ["10", "9", "8"]
    .map((g) => {
      const d = gradedPrice(c, g);
      return `<dt><img src="/psa.png" alt="PSA" class="psa-mini"> ${g}</dt><dd>${d ? `≈ ${price(d.v)} <small>(${d.usd.toLocaleString("es-ES", { style: "currency", currency: "USD" })} · ${d.n} venta${d.n === 1 ? "" : "s"} en eBay${d.d ? `, última ${new Date(d.d).toLocaleDateString("es-ES")}` : ""})</small>` : `<span style="color:var(--muted)">sin ventas recientes</span>`}</dd>`;
    })
    .join("");
}

// Precio aproximado en PSA 8/9/10: ventas recientes en eBay (cartas en inglés), en $ pasado a €
function psaData(c) {
  if (!c.psa) return {};
  if (typeof c.psa === "string") {
    try { c.psa = JSON.parse(c.psa); } catch { c.psa = {}; }
  }
  return c.psa || {};
}
function gradedPrice(c, grade) {
  const g = psaData(c)[grade];
  return g ? { v: g.p * state.usdEur, n: g.n, d: g.d, usd: g.p } : null;
}

// Precio elegido por cada usuario, en una esquina de la carta (o el de PSA si está activado)
function priceTag(c, userId = state.me.id) {
  if (state.grade && !state.me.hide_prices) {
    const g = gradedPrice(c, state.grade);
    if (!g) return c.psa_updated ? `<span class="pricetag psa none" title="Sin ventas recientes en PSA ${state.grade}">sin PSA ${state.grade}</span>` : "";
    return `<span class="pricetag psa" title="PSA ${state.grade} · ${g.n} venta${g.n === 1 ? "" : "s"} en eBay${g.d ? `, la última el ${new Date(g.d).toLocaleDateString("es-ES")}` : ""} (cartas en inglés). Aproximado."><b>PSA ${state.grade}</b> ≈ ${price(g.v)}</span>`;
  }
  const v = cardPrice(c, state.me.price_metric, userId);
  if (state.me.hide_prices || v == null) return "";
  const metric = state.me.price_metric;
  const foreign = userId && qty(c.id, userId) && hasForeign(c.id, userId);
  const approx = foreign && priceIsApprox(c, metric, userId);
  const src = foreign ? "Cardmarket (español) y TCGplayer (inglés)" : "Cardmarket";
  return `<span class="pricetag" title="${metricName(metric)} en ${src}${approx ? ". Aproximado: alguna copia no tiene precio específico de su idioma y se usa Cardmarket" : ""}">${approx ? "≈ " : ""}${price(v)}</span>`;
}

// Vitrina de los Mew RGB: brillan los que tiene alguien, apagados los que no
function renderVault() {
  const el = $("#vault");
  const rgb = state.cards.filter(isSpecial).sort((a, b) => "RGB".indexOf(a.number[0]) - "RGB".indexOf(b.number[0]));
  el.hidden = !rgb.length;
  if (!rgb.length) return;
  const metric = state.me.price_metric;
  const total = rgb.reduce((a, c) => a + (c[metric] ?? c.cm_trend ?? 0), 0);
  const owned = rgb.filter((c) => state.owned.get(c.id)?.size).length;
  const tone = { R: "#ff3b3b", G: "#2bd96b", B: "#3b8bff" };
  el.innerHTML = `<div class="vault-head">
      <span class="vault-title">✨ Los Mew RGB <small>· El santo grial</small></span>
      <span class="vault-sub">${owned ? `${owned} de 3 en el grupo` : "Nadie los tiene… todavía 👀"} · juntos valen <b>${price(total)}</b></span>
      <span class="vault-hint" aria-hidden="true">${matchMedia("(hover: hover)").matches ? "Pasa el ratón para verlos" : "Mantén pulsado para verlos"} <i>👆</i></span>
    </div>
    <div class="vault-cards">${rgb
      .map((c) => {
        const owners = collectors().filter((u) => qty(c.id, u.id));
        const v = c[metric] ?? c.cm_trend;
        const psa = gradedPrice(c, "10");
        const img = c.image_status === "missing" || brokenImages.has(c.id) ? "" : `<img src="${esc(imgUrl(c))}" alt="" loading="lazy" onerror="this.remove()">`;
        return `<button type="button" class="vault-card ${owners.length ? "got" : "nope"}" style="--tone:${tone[c.number[0]] || "#fff"}" data-open="${esc(c.id)}" aria-label="${esc(c.name)}">
          <span class="vault-art">${img}<span class="vault-letter">${esc(c.number[0])}</span></span>
          <span class="vault-info">
            <b>${esc(c.name)}</b>
            <span class="vault-price">${v != null ? price(v) : "—"}</span>
            ${psa ? `<small><img src="/psa.png" alt="PSA" class="psa-mini"> 10 ≈ ${price(psa.v)}</small>` : ""}
            <span class="vault-own">${owners.length ? `🏆 ${owners.map((u) => `${avatar(u)} ${esc(u.name)}`).join(" ")}` : "Nadie… todavía 👀"}</span>
          </span>
        </button>`;
      })
      .join("")}</div>`;
}

// La vitrina está plegada: se abre con fundido mientras el ratón está encima o el dedo/clic se mantiene pulsado
function setupVault() {
  const el = $("#vault");
  el.classList.add("closed");
  let pressed = false;
  const open = () => el.classList.remove("closed");
  const close = () => el.classList.add("closed");
  el.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") open(); });
  el.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !pressed) close(); });
  el.addEventListener("pointerdown", () => { pressed = true; open(); });
  const release = (e) => {
    if (!pressed) return;
    pressed = false;
    // Con el ratón sigue abierta mientras esté encima; con el dedo se cierra al soltar
    if (e.pointerType !== "mouse" || !el.matches(":hover")) close();
  };
  addEventListener("pointerup", release);
  addEventListener("pointercancel", release);
  el.addEventListener("contextmenu", (e) => e.preventDefault()); // sin menú al mantener pulsado en el móvil
  // Teclado: con el foco dentro se ve
  el.tabIndex = 0;
  el.addEventListener("focusin", open);
  el.addEventListener("focusout", () => { if (!el.matches(":hover")) close(); });
}

// Los 3 Mew RGB son especiales: fuera de la colección (ni total, ni porcentaje, ni álbum, ni lista),
// con su propia vitrina. Su valor sí cuenta para quien los tenga.
const isSpecial = (c) => c.rarity === "Rara RGB";
const regularCards = () => state.cards.filter((c) => !isSpecial(c));

function cardsInScope() {
  return state.set === "all" ? regularCards() : regularCards().filter((c) => c.set_id === state.set);
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  const me = state.me.id;
  return cardsInScope().filter((c) => {
    if (state.rarity && c.rarity !== state.rarity) return false;
    if (q && !`${c.name} ${c.number} ${c.note || ""} ${c.rarity || ""}`.toLowerCase().includes(q)) return false;
    if (state.grade && state.gradeOnly && !gradedPrice(c, state.grade)) return false;
    if (!state.me.hide_prices && (state.priceMin !== "" || state.priceMax !== "")) {
      // Con PSA activado, el filtro de precio usa el precio en ese grado
      const p = state.grade ? gradedPrice(c, state.grade)?.v ?? null : cardPrice(c, state.priceMetric, me);
      if (p == null) return false;
      if (state.priceMin !== "" && p < Number(state.priceMin)) return false;
      if (state.priceMax !== "" && p > Number(state.priceMax)) return false;
    }
    const owners = state.owned.get(c.id);
    const mine = qty(c.id, me);
    switch (state.owner) {
      case "missing": return !mine;
      case "have": return mine > 0;
      case "dupes": return mine > 1;
      case "nobody": return !owners || owners.size === 0;
    case "noimage": return c.image_status === "missing" || brokenImages.has(c.id);
      case "trade": return !mine && owners && owners.size > 0;
      default:
        if (state.owner.startsWith("has:")) return qty(c.id, state.owner.slice(4)) > 0;
        if (state.owner.startsWith("lacks:")) return !qty(c.id, state.owner.slice(6));
        return true;
    }
  });
}

// ------------------------------------------------------------- render

function render() {
  renderMe();
  renderSummary();
  renderImageWarning();
  renderSets();
  renderFilters();
  const list = filtered();
  $("#result-count").textContent = `${list.length} carta${list.length === 1 ? "" : "s"}`;
  $("#grid").hidden = state.view !== "grid";
  $("#table-wrap").hidden = state.view !== "table";
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
  if (state.view === "grid") renderGrid(list);
  else renderTable(list);
  if ($("#dlg-album").open) refreshAlbum();
}

function renderImageWarning() {
  const n = state.cards.filter((c) => c.image_status === "missing" || brokenImages.has(c.id)).length;
  const el = $("#img-warning");
  el.hidden = n === 0;
  el.textContent = `⚠ ${n} carta${n === 1 ? "" : "s"} sin imagen · ayuda a completarlas`;
}

function renderMe() {
  $("#me-avatar").innerHTML = avatar(state.me);
}

const isPromoSet = (setId) => setById(setId)?.kind === "promo";
// Grupos aparte («Otros · para gradear»): no cuentan en la colección base ni tienen ranking
const isOtherSet = (setId) => setById(setId)?.kind === "other";

// Bloque de progreso: total entre todos + una tarjeta por coleccionista
// jump: al pulsar en una persona se salta a esa colección / rareza (o se filtra en la vista actual si no hay jump)
function summaryBlock(cards, ids, { sort = false, jump = null } = {}) {
  const total = cards.length;
  const anyone = cards.filter((c) => state.owned.get(c.id)?.size).length;
  const people = collectors();
  $(`#${ids.count}`).textContent = `${anyone} / ${total}`;
  $(`#${ids.bar}`).style.width = total ? `${(anyone / total) * 100}%` : "0";
  $(`#${ids.sub}`).textContent = `${total ? Math.round((anyone / total) * 100) : 0}% conseguido por al menos uno · ${people.length} coleccionista${people.length === 1 ? "" : "s"}`;
  const rows = people.map((u) => {
    let have = 0;
    let copies = 0;
    for (const c of cards) {
      const n = qty(c.id, u.id);
      if (n) { have++; copies += n; }
    }
    return { u, have, copies };
  });
  if (sort) rows.sort((a, b) => b.have - a.have || b.copies - a.copies);
  const best = rows.reduce((m, r) => Math.max(m, r.have), 0);
  // Al pulsar en las promos se filtra por esa colección; en la base, por la colección que ya está elegida
  const filtering = !jump || ((!jump.set || state.set === jump.set) && (jump.rarity || "") === state.rarity);
  $(`#${ids.members}`).innerHTML = rows
    .map(({ u, have, copies }) => {
      const pct = total ? Math.round((have / total) * 100) : 0;
      const active = filtering && (state.owner === `has:${u.id}` || state.owner === `lacks:${u.id}` || (u.id === state.me.id && ["have", "missing"].includes(state.owner)));
      const top = sort && best > 0 && have === best;
      return `<button class="member ${active ? "active" : ""}" data-user="${esc(u.id)}" ${jump?.set ? `data-user-set="${esc(jump.set)}"` : ""} ${jump ? `data-user-rarity="${esc(jump.rarity || "")}"` : ""} style="--c:${esc(u.color)}" title="Ver lo que tiene ${esc(u.name)}">
        ${top ? `<span class="crown" title="Quien más tiene">🏆</span>` : ""}${avatar(u, "lg")}
        <div class="name"><span>${esc(u.name)}${u.id === state.me.id ? " (tú)" : ""}</span><small>${pct}%</small></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="stats"><span>${have} / ${total} distintas</span><span>${copies - have > 0 ? `${copies - have} repe${copies - have === 1 ? "" : "s"}` : ""}</span></div>
      </button>`;
    })
    .join("");
}

function renderSummary() {
  // Con «Todas», arriba va solo la colección base y las promos tienen su propio bloque debajo
  const all = state.set === "all";
  const base = all ? regularCards().filter((c) => !isPromoSet(c.set_id) && !isOtherSet(c.set_id)) : cardsInScope();
  renderVault();
  $("#group-label").textContent = all ? "Colección base · entre todos" : isPromoSet(state.set) ? "Promos · entre todos" : "Entre todos";
  summaryBlock(base, { count: "group-count", bar: "group-bar", sub: "group-sub", members: "members" }, { sort: true });

  const promoSets = state.sets.filter((s) => s.kind === "promo");
  const promos = state.cards.filter((c) => isPromoSet(c.set_id));
  // Las promos van al final del bloque plegable «Ver progreso por tipo»
  const showPromos = typesOpen && promos.length > 0 && !isPromoSet(state.set);
  $("#promo-summary").hidden = !showPromos;
  if (showPromos) {
    summaryBlock(promos, { count: "promo-count", bar: "promo-bar", sub: "promo-sub", members: "promo-members" }, { sort: true, jump: { set: promoSets.length === 1 ? promoSets[0].id : "all", rarity: "" } });
  }
  renderTypeSummaries();
}

// Tipos de carta destacados: botones rápidos de filtro y su propio ranking (plegado por defecto)
const CARD_TYPES = [
  { id: "ir", rarity: "Rara ilustración", label: "Full Art", stars: "★" },
  { id: "sir", rarity: "Rara ilustración especial", label: "SIR", stars: "★★" },
  { id: "fut", rarity: "Rara futurista", label: "Futurista", stars: "" },
  // Las Clásicas ya tienen su pestaña de colección: solo se añaden al progreso por tipo
  { id: "cla", rarity: "Clásica", label: "Clásica", stars: "✦", summaryOnly: true },
];
const cardTypes = () => CARD_TYPES.filter((t) => state.cards.some((c) => c.rarity === t.rarity));
const chipTypes = () => cardTypes().filter((t) => !t.summaryOnly);

// Icono propio de «para gradear»: una carta dentro de una funda rígida con etiqueta
const SLAB_ICON = `<svg class="slab" viewBox="0 0 16 20" width="12" height="15" aria-hidden="true"><rect x="1" y="1" width="14" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="3" width="10" height="3.5" rx=".8" fill="#e3350d"/><rect x="4" y="8.5" width="8" height="8.5" rx=".8" fill="currentColor" opacity=".55"/></svg>`;
let typesOpen = false; // el progreso por tipo empieza siempre plegado

function renderTypeSummaries() {
  const types = cardTypes();
  const btn = $("#btn-types");
  const hasPromos = state.cards.some((c) => isPromoSet(c.set_id));
  btn.hidden = !types.length && !hasPromos;
  btn.setAttribute("aria-expanded", typesOpen);
  btn.innerHTML = `${typesOpen ? "▴ Ocultar" : "▾ Ver"} progreso por tipo <small>${[...types.map((t) => t.label), ...(hasPromos ? ["Promos"] : [])].map(esc).join(" · ")}</small>`;
  const box = $("#type-summaries");
  box.hidden = !typesOpen || !types.length;
  if (box.hidden) return;
  if (box.dataset.types !== types.map((t) => t.id).join()) {
    box.dataset.types = types.map((t) => t.id).join();
    box.innerHTML = types
      .map((t) => `<section class="summary type-summary">
        <div class="group-stat" data-r="${esc(t.rarity)}">
          <span class="label">${t.stars ? `<span class="stars">${t.stars}</span> ` : ""}${esc(t.label)} · entre todos</span>
          <strong id="t-${t.id}-count">0 / 0</strong>
          <div class="bar"><i id="t-${t.id}-bar"></i></div>
          <span class="sub" id="t-${t.id}-sub"></span>
        </div>
        <div class="members" id="t-${t.id}-members"></div>
      </section>`)
      .join("");
  }
  for (const t of types) {
    const ids = { count: `t-${t.id}-count`, bar: `t-${t.id}-bar`, sub: `t-${t.id}-sub`, members: `t-${t.id}-members` };
    summaryBlock(state.cards.filter((c) => c.rarity === t.rarity), ids, { sort: true, jump: { set: "all", rarity: t.rarity } });
  }
}

function renderSets() {
  const chip = (s) => ({ id: s.id, name: s.name, kind: s.kind, n: regularCards().filter((c) => c.set_id === s.id).length });
  const chips = [{ id: "all", name: "Todas", n: regularCards().length }].concat(state.sets.filter((s) => s.kind !== "other").map(chip));
  const setChip = (s) =>
    `<button class="chip ${s.kind === "other" ? "other" : ""} ${state.set === s.id ? "on" : ""}" data-set="${esc(s.id)}" role="tab">${s.kind === "other" ? SLAB_ICON : ""}${esc(s.name)}<b>${s.n}</b></button>`;
  $("#sets").innerHTML = chips.map(setChip).join("") +
    // Atajos por tipo: filtran por rareza sin cambiar cómo se dividen las colecciones
    chipTypes()
      .map((t) => `<button class="chip type ${state.rarity === t.rarity ? "on" : ""}" data-rar="${esc(t.rarity)}" data-r="${esc(t.rarity)}" title="Ver solo ${esc(t.rarity)}">${t.stars ? `<span class="stars">${t.stars}</span>` : ""}${esc(t.label)}<b>${state.cards.filter((c) => c.rarity === t.rarity).length}</b></button>`)
      .join("") +
    // Grupos aparte («Otros · Para Gradear») al final, después de los tipos
    state.sets.filter((s) => s.kind === "other").map(chip).map(setChip).join("");
}

function renderFilters() {
  const rarities = [...new Set(cardsInScope().map((c) => c.rarity).filter(Boolean))].sort(
    (a, b) => (RARITY_ORDER.indexOf(a) + 99) % 99 - (RARITY_ORDER.indexOf(b) + 99) % 99,
  );
  if (state.rarity && !rarities.includes(state.rarity)) state.rarity = "";
  $("#f-rarity").innerHTML = `<option value="">Todas las rarezas</option>` + rarities.map((r) => `<option ${r === state.rarity ? "selected" : ""}>${esc(r)}</option>`).join("");

  const opts = [
    ["all", "Todas las cartas"],
    ...(state.me.is_admin ? [] : [
      ["missing", "Me faltan"],
      ["have", "Las tengo"],
      ["dupes", "Mis repetidas"],
      ["trade", "Las tiene alguien y yo no"],
    ]),
    ["nobody", "No las tiene nadie"],
    ["noimage", "Sin imagen (súbela)"],
  ];
  for (const u of collectors()) {
    if (u.id === state.me.id) continue;
    opts.push([`has:${u.id}`, `Las tiene ${u.name}`], [`lacks:${u.id}`, `Le faltan a ${u.name}`]);
  }
  $("#f-owner").innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}" ${v === state.owner ? "selected" : ""}>${esc(l)}</option>`).join("");
}

function artHtml(c) {
  const ph = `<div class="ph" data-r="${esc(c.rarity)}"><span class="no"></span><span class="nm">${esc(c.name)}</span><span class="rr">${esc(c.rarity || "")}</span></div>`;
  const missing = `<span class="upload" data-upload="${esc(c.id)}" role="button" tabindex="0">📷 Falta la imagen · Subir</span>`;
  if (c.image_status === "missing" || brokenImages.has(c.id)) return ph + missing;
  // Mientras carga (o si falla) se ve el placeholder de debajo
  return `${ph}${missing}<img src="${esc(imgUrl(c))}" alt="${esc(c.name)}" loading="lazy" data-id="${esc(c.id)}" onerror="p30ImgError(this)">`;
}

function ownersHtml(c) {
  const owners = state.owned.get(c.id);
  if (!owners?.size) return `<span class="none">Nadie la tiene aún</span>`;
  return state.users
    .filter((u) => owners.has(u.id))
    .map((u) => {
      const n = owners.get(u.id);
      return avatar(u).replace("</span>", `${n > 1 ? `<sup>×${n}</sup>` : ""}</span>`).replace(`title="${esc(u.name)}"`, `title="${esc(u.name)}: ${n}"`);
    })
    .join("");
}

function renderGrid(list) {
  const me = state.me;
  $("#grid").innerHTML = list
    .map((c) => {
      const mine = qty(c.id, me.id);
      return `<article class="card ${mine ? "mine" : ""}" style="--c:${esc(me.color)}" data-card="${esc(c.id)}">
        <button class="art ${c.image_status === "missing" || brokenImages.has(c.id) ? "noimg" : ""}" data-open="${esc(c.id)}" aria-label="Ver ${esc(c.name)}">${artHtml(c)}<span class="numtag">${esc(displayNumber(c))}</span>${langTag(c, me.id)}${priceTag(c)}</button>
        <div class="meta"><strong>${esc(c.name)}</strong><span class="rar" data-r="${esc(c.rarity)}">${esc(c.rarity || "—")}</span></div>
        <div class="owners">${ownersHtml(c)}</div>
        ${me.is_admin ? "" : `<div class="stepper">
          <button data-dec="${esc(c.id)}" aria-label="Quitar una" ${mine ? "" : "disabled style=visibility:hidden"}>−</button>
          <span>${mine ? `Tengo <b>${mine}</b>` : "No la tengo"}</span>
          <button class="add" data-inc="${esc(c.id)}" aria-label="Añadir una">+</button>
        </div>`}
      </article>`;
    })
    .join("");
}

function renderTable(list) {
  const users = collectors();
  const showPrices = !state.me.hide_prices;
  const head = `<thead><tr><th>Nº</th><th>Carta</th><th>Rareza</th>${showPrices ? "<th>Trend</th><th>Mid</th>" : ""}${users
    .map((u) => `<th class="u">${avatar(u)}${esc(u.name.split(" ")[0])}</th>`)
    .join("")}</tr></thead>`;
  const body = list
    .map((c) => {
      const cells = users
        .map((u) => {
          const n = qty(c.id, u.id);
          const isMe = u.id === state.me.id;
          return `<td class="q ${isMe ? "meq" : ""}" ${isMe ? `data-toggle="${esc(c.id)}" title="Clic para marcar / desmarcar"` : ""}>${
            n ? `<span class="dot" style="--c:${esc(u.color)}">${n > 1 ? n : "✓"}</span>` : `<span class="no">·</span>`
          }</td>`;
        })
        .join("");
      return `<tr><td class="n">${esc(displayNumber(c))}</td><td><a href="#" data-open="${esc(c.id)}">${esc(c.name)}</a></td><td><span class="rar" data-r="${esc(c.rarity)}">${esc(c.rarity || "—")}</span></td>${showPrices ? `<td class="price">${price(cardPrice(c, "cm_trend", state.me.id))}</td><td class="price">${price(cardPrice(c, "cm_mid", state.me.id))}</td>` : ""}${cells}</tr>`;
    })
    .join("");
  const foot = `<tfoot><tr><td colspan="${showPrices ? 5 : 3}" style="text-align:left">Total en esta vista</td>${users
    .map((u) => `<td>${list.filter((c) => qty(c.id, u.id)).length}</td>`)
    .join("")}</tr></tfoot>`;
  $("#table").innerHTML = head + `<tbody>${body}</tbody>` + foot;
}

function openCard(id) {
  const c = state.cards.find((x) => x.id === id);
  if (!c) return;
  const set = setById(c.set_id);
  const owners = state.owned.get(c.id);
  const mine = copies(c.id, state.me.id);
  const foreign = Object.keys(mine).filter((k) => k !== "es");
  const dlg = $("#dlg-card");
  dlg.innerHTML = `<button class="btn ghost small close" data-close>✕</button>
    <div class="cd">
      <div class="art ${c.image_status === "missing" || brokenImages.has(c.id) ? "noimg" : ""}">${artHtml(c)}${langTag(c, state.me.id)}${priceTag(c)}</div>
      <div>
        <h2>${esc(c.name)}</h2>
        <span class="rar" data-r="${esc(c.rarity)}">${esc(c.rarity || "—")}</span>
        <dl>
          <dt>Colección</dt><dd>${esc(set?.name)}</dd>
          <dt>Número</dt><dd>${esc(displayNumber(c))}</dd>
          ${c.note ? `<dt>Detalles</dt><dd>${esc(c.note)}</dd>` : ""}
          ${c.source === "manual" ? `<dt>Origen</dt><dd>Añadida por el grupo</dd>` : ""}
          ${state.me.hide_prices ? "" : `<dt>Trend</dt><dd>${price(cardPrice(c, "cm_trend", state.me.id))}</dd>
          <dt>Mid</dt><dd>${price(cardPrice(c, "cm_mid", state.me.id))}</dd>
          ${foreign.length ? `<dt>Otros idiomas</dt><dd>${foreign.map((k) => foreignPriceText(c, k)).join("<br>")}${Object.keys(mine).length > 1 ? "<br><small>El precio de arriba de la carta es la media por copia.</small>" : ""}</dd>` : ""}
          ${c.cm_updated ? `<dt>Cardmarket</dt><dd>${c.cm_manual ? "Apuntado a mano" : "Actualizado"} el ${esc(new Date(c.cm_updated).toLocaleDateString("es-ES"))}</dd>` : ""}
          ${psaRowsHtml(c)}`}
        </dl>
        <strong>Quién la tiene</strong>
        <div class="who">${
          owners?.size
            ? state.users.filter((u) => owners.has(u.id)).map((u) => `<div>${avatar(u)} <span class="who-txt">${esc(u.name)} · ${owners.get(u.id)} copia${owners.get(u.id) > 1 ? "s" : ""} · ${esc(copiesText(c.id, u.id))}</span>${!state.me.is_admin && u.id !== state.me.id ? `<button type="button" class="btn ghost small who-trade" data-trade-card="${esc(c.id)}" data-trade-user="${esc(u.id)}" title="Pedirle esta carta a ${esc(u.name)}">Pedir</button>` : ""}</div>`).join("")
            : `<span class="none" style="color:var(--muted)">Nadie todavía</span>`
        }</div>
        ${tradeButtonHtml(c)}
        ${state.me.is_admin ? "" : `<div class="stepper" style="max-width:220px">
          <button data-dec="${esc(c.id)}">−</button><span>Tengo <b>${qty(c.id, state.me.id)}</b></span><button class="add" data-inc="${esc(c.id)}">+</button>
        </div>`}
        ${qty(c.id, state.me.id) ? `<div class="lang-pick"><span>Mis copias por idioma</span><div class="lang-rows">${state.languages
          .map((l) => `<div class="lang-row ${mine[l.code] ? "on" : ""}"><span>${esc(l.name)}</span><div class="stepper mini"><button type="button" data-lang-dec="${esc(l.code)}" data-lang-card="${esc(c.id)}" ${mine[l.code] ? "" : "disabled"} aria-label="Quitar una en ${esc(l.name)}">−</button><b>${mine[l.code] || 0}</b><button type="button" class="add" data-lang-inc="${esc(l.code)}" data-lang-card="${esc(c.id)}" aria-label="Añadir una en ${esc(l.name)}">+</button></div></div>`)
          .join("")}</div></div>` : ""}
        ${!state.me.is_admin && !state.me.hide_prices && (c.cm_manual || (c.cm_trend == null && c.cm_mid == null)) ? manualPriceHtml(c) : ""}
        <button class="btn ghost small" data-upload="${esc(c.id)}" style="margin-top:14px">📷 Cambiar imagen</button>
      </div>
    </div>`;
  if (!dlg.open) dlg.showModal();
}

// Precio de Cardmarket a mano (solo cartas sin precio automático, p. ej. Ancient Mew)
function manualPriceHtml(c) {
  const v = (x) => (x == null ? "" : String(x).replace(".", ","));
  return `<details class="manual-price">
    <summary>✏️ ${c.cm_manual ? "Cambiar precio apuntado a mano" : "Apuntar precio de Cardmarket a mano"}</summary>
    <form data-price-form="${esc(c.id)}">
      <p>Esta carta no tiene precio automático. Míralo en Cardmarket y apúntalo aquí; lo verá todo el grupo.</p>
      <div class="row">
        <label>Trend € <input name="trend" inputmode="decimal" placeholder="0,00" value="${esc(v(c.cm_trend))}"></label>
        <label>Mid € <input name="mid" inputmode="decimal" placeholder="0,00" value="${esc(v(c.cm_mid))}"></label>
      </div>
      <div class="row">
        <button class="btn primary small">Guardar</button>
        ${c.cm_manual ? `<button type="button" class="btn ghost small" data-price-clear="${esc(c.id)}">Quitar precio</button>` : ""}
      </div>
    </form>
  </details>`;
}

async function saveManualPrice(cardId, trend, mid) {
  try {
    const r = await api(`/api/cards/${encodeURIComponent(cardId)}/price`, { method: "PUT", body: JSON.stringify({ trend, mid }) });
    const c = state.cards.find((x) => x.id === cardId);
    if (c) Object.assign(c, { cm_trend: r.cm_trend, cm_mid: r.cm_mid, cm_manual: r.cm_trend != null || r.cm_mid != null ? 1 : 0, cm_updated: r.cm_trend != null || r.cm_mid != null ? new Date().toISOString() : null });
    render();
    if ($("#dlg-card").open) openCard(cardId);
    toast(trend == null && mid == null ? "Precio quitado" : "Precio guardado para todos");
  } catch (e) {
    toast(`No se pudo guardar: ${e.message}`);
  }
}

// ------------------------------------------------------------- acciones

// Guarda las copias por idioma de una carta: se ve al momento y se envía (o va a la cola sin red)
// Cambios de colección enviándose o recién guardados: cardId -> { snap, dirty, sending, doneAt }.
// Sirven para que un refresco que salió ANTES del cambio no lo pise al llegar (la cuenta «volvía atrás»).
const writes = new Map();

function applyRecentWrites(loadStarted) {
  const me = state.me.id;
  for (const [cardId, w] of writes) {
    // Enviándose, o guardado después de pedir estos datos: manda lo local
    if (w.sending || w.doneAt === null || w.doneAt > loadStarted) setCopies(cardId, me, w.snap);
    else writes.delete(cardId); // los datos ya incluyen el cambio
  }
}

// Guarda las copias por idioma de una carta: se ve al momento y se envía (o va a la cola sin red).
// Los envíos de una misma carta van en fila y siempre con lo último que ve el usuario,
// así varios «+» seguidos no pueden llegar desordenados al servidor.
async function saveCopies(cardId, next) {
  const me = state.me.id;
  setCopies(cardId, me, next);
  render();
  if ($("#dlg-card").open) openCard(cardId);
  // Si ya había cambios de esta carta en cola (o no hay red), va a la cola para respetar el orden
  if (pending.has(cardId) || !net.online) {
    writes.delete(cardId);
    queueCard(cardId);
    return flushPending();
  }
  let w = writes.get(cardId);
  if (!w) writes.set(cardId, (w = { snap: null, dirty: false, sending: false, doneAt: null }));
  w.snap = { ...copies(cardId, me) };
  w.dirty = true;
  w.doneAt = null;
  if (w.sending) return; // el envío en curso mandará también esto al terminar
  w.sending = true;
  try {
    while (w.dirty) {
      w.dirty = false;
      await api(`/api/collection/${encodeURIComponent(cardId)}`, { method: "PUT", body: JSON.stringify({ langs: w.snap }) });
    }
    w.doneAt = Date.now();
  } catch (e) {
    writes.delete(cardId);
    if (e.offline) return queueCard(cardId);
    toast(`No se pudo guardar: ${e.message}`);
    // Lo que diga el servidor manda
    try { await load(); render(); if ($("#dlg-card").open) openCard(cardId); } catch {}
  } finally {
    w.sending = false;
  }
}

// Cambia el total: las nuevas copias entran en español; al quitar, primero las españolas y luego el resto
function setQty(cardId, n) {
  n = Math.max(0, Math.min(99, n));
  const bd = { ...copies(cardId, state.me.id) };
  let diff = n - qty(cardId, state.me.id);
  if (diff > 0) bd.es = (bd.es || 0) + diff;
  for (const l of ["es", ...state.languages.map((x) => x.code).filter((k) => k !== "es").reverse()]) {
    if (diff >= 0) break;
    const take = Math.min(bd[l] || 0, -diff);
    bd[l] = (bd[l] || 0) - take;
    diff += take;
  }
  return saveCopies(cardId, bd);
}

// +1 / −1 copia en un idioma concreto
function changeLang(cardId, lang, delta) {
  const bd = { ...copies(cardId, state.me.id) };
  if (delta > 0 && qty(cardId, state.me.id) >= 99) return toast("Máximo 99 copias por carta");
  bd[lang] = Math.max(0, (bd[lang] || 0) + delta);
  return saveCopies(cardId, bd);
}

let uploadTarget = null;
function pickImage(cardId) {
  uploadTarget = cardId;
  $("#file-pick").value = "";
  $("#file-pick").click();
}

async function uploadImage(cardId, file) {
  if (!/^image\/(jpeg|png|webp|avif)$/.test(file.type)) return toast("Tiene que ser una imagen JPG, PNG o WebP");
  if (file.size > 8 * 1024 * 1024) return toast("La imagen pesa más de 8 MB");
  toast("Subiendo imagen…");
  try {
    await api(`/api/cards/${encodeURIComponent(cardId)}/image`, { method: "PUT", body: file, headers: { "content-type": file.type } });
    brokenImages.delete(cardId);
    await load();
    render();
    if ($("#dlg-card").open) openCard(cardId);
    toast("Imagen guardada para todos");
  } catch (e) {
    toast(e.message);
  }
}

// ------------------------------------------------------------- álbum 3D

const ALBUM_POCKETS = 9;
const albumNarrow = window.matchMedia("(max-width: 760px)");
const album = { owner: "", set: "all", pages: [], leaves: 0, flipped: 0, drag: null, curl: null, intro: null };

function albumQty(cardId) {
  return album.owner === "__group" ? state.owned.get(cardId)?.size || 0 : qty(cardId, album.owner);
}

function albumCards() {
  return state.sets.filter((s) => album.set === "all" || s.id === album.set).flatMap((s) => regularCards().filter((c) => c.set_id === s.id));
}

// Portada, interior, una hoja de fundas por cada 9 cartas en orden, guarda y contraportada
function albumPages() {
  const pages = [{ kind: "cover" }, { kind: "inside" }];
  let number = 0;
  for (const set of state.sets) {
    if (album.set !== "all" && set.id !== album.set) continue;
    const cards = regularCards().filter((c) => c.set_id === set.id);
    for (let i = 0; i < cards.length; i += ALBUM_POCKETS) pages.push({ kind: "pockets", set, cards: cards.slice(i, i + ALBUM_POCKETS), number: ++number });
  }
  if (pages.length % 2) pages.push({ kind: "blank" });
  pages.push({ kind: "blank" }, { kind: "back" });
  return pages;
}

function albumOwnerName() {
  if (album.owner === "__group") return "Entre todos";
  return state.users.find((u) => u.id === album.owner)?.name || "";
}

function pocketHtml(c) {
  const n = albumQty(c.id);
  const open = `data-open="${esc(c.id)}"`;
  const albumUser = album.owner === "__group" ? null : album.owner;
  const img = c.image_status === "missing" || brokenImages.has(c.id) ? "" : `<img src="${esc(imgUrl(c))}" alt="" data-id="${esc(c.id)}" onerror="p30ImgError(this)">`;
  // Las que faltan se ven en gris (si hay imagen); si no, el hueco con número y nombre
  if (!n) return `<button type="button" class="slot empty${img ? " ghost" : ""}" ${open} aria-label="Falta ${esc(c.name)}"><span class="no">${esc(displayNumber(c))}</span><span class="nm">${esc(c.name)}</span>${img}${priceTag(c, null)}</button>`;
  const copies = n > 1 && album.owner !== "__group" ? `<sup>×${n}</sup>` : "";
  return `<button type="button" class="slot has" ${open} aria-label="${esc(c.name)}"><span class="nm">${esc(c.name)}</span>${img}${copies}${langTag(c, albumUser)}${priceTag(c, albumUser)}</button>`;
}

function albumPageHtml(page) {
  const cards = albumCards();
  const have = cards.filter((c) => albumQty(c.id)).length;
  const pct = cards.length ? Math.round((have / cards.length) * 100) : 0;
  const setName = album.set === "all" ? "Todas las colecciones" : setById(album.set)?.name;
  switch (page.kind) {
    case "cover":
      return "";
    case "inside":
      return `<p>Álbum de ${esc(albumOwnerName())}</p><p>${esc(setName)}</p><strong>${have} / ${cards.length}</strong><div class="bar"><i style="width:${pct}%"></i></div><p>${pct}% completado · faltan ${cards.length - have}</p>`;
    case "pockets":
      return `<div class="album-pockets">${page.cards.map(pocketHtml).join("")}</div><div class="album-foot"><span>${esc(page.set.name)}</span><span>${page.number}</span></div>`;
    case "back":
      return "";
    default:
      return "";
  }
}

function fillAlbumFace(face) {
  const page = album.pages[Number(face.dataset.page)];
  face.dataset.filled = "1";
  if (!page) return; // en móvil el dorso de cada hoja va en blanco
  face.classList.toggle("album-cover", page.kind === "cover");
  face.classList.toggle("album-backcover", page.kind === "back");
  face.classList.toggle("album-inside", page.kind === "inside");
  face.innerHTML = albumPageHtml(page);
}

// En móvil cabe una sola página: cada hoja lleva una por delante y pasar siempre es girar una hoja
const albumPerLeaf = () => (albumNarrow.matches ? 1 : 2);
const albumMaxFlipped = () => (albumNarrow.matches ? album.leaves - 1 : album.leaves);

function buildAlbum() {
  finishCurl();
  const per = albumPerLeaf();
  album.pages = albumPages();
  album.leaves = album.pages.length / per;
  album.flipped = Math.min(album.flipped, albumMaxFlipped());
  let html = `<div class="album-block left"></div><div class="album-block right"></div><div class="album-cast"></div>`;
  for (let i = 0; i < album.leaves; i++) {
    const back = per === 2 ? `data-page="${i * 2 + 1}"` : "";
    html += `<div class="album-leaf" data-leaf="${i}"><div class="album-face front" data-page="${i * per}"></div><div class="album-face back" ${back}></div></div>`;
  }
  $("#album-book").innerHTML = html;
  $("#album-range").max = albumMaxFlipped();
  updateAlbum();
}

function refreshAlbum() {
  const count = albumPages().length;
  if (count !== album.pages.length) return buildAlbum();
  album.pages = albumPages();
  document.querySelectorAll('#album-book .album-face[data-filled="1"]').forEach(fillAlbumFace);
}

function albumLeafTransform(i) {
  // Las hojas apiladas se separan un poco en Z para que no parpadeen al coincidir en el mismo plano
  return i < album.flipped ? `rotateY(-180deg) translateZ(${(album.flipped - 1 - i) * 0.5}px)` : `rotateY(0deg) translateZ(${-(i - album.flipped) * 0.5}px)`;
}

function updateAlbumBook(flipped = album.flipped) {
  const narrow = albumNarrow.matches;
  let x = 0;
  if (narrow || flipped === 0) x = -25; // lomo a la izquierda: se ve la página derecha
  else if (flipped === album.leaves) x = 25;
  $("#album-book").style.transform = `translateX(${x}%) rotateX(${narrow ? 0 : 5}deg)`;
  $("#album-book .album-block.left").style.display = flipped > 0 ? "" : "none";
  $("#album-book .album-block.right").style.display = flipped < album.leaves ? "" : "none";
}

function updateAlbum() {
  const { flipped } = album;
  document.querySelectorAll("#album-book .album-leaf").forEach((leaf) => {
    const i = Number(leaf.dataset.leaf);
    leaf.style.transform = albumLeafTransform(i);
    // Solo se pintan las hojas cercanas: así no se piden las 209 imágenes de golpe
    const near = i >= flipped - 2 && i <= flipped + 1;
    leaf.style.display = near ? "" : "none";
    if (near) leaf.querySelectorAll('.album-face:not([data-filled="1"])').forEach(fillAlbumFace);
  });
  updateAlbumBook();
  const max = albumMaxFlipped();
  $("#album-range").value = flipped;
  $("#album-prev").disabled = flipped === 0;
  $("#album-next").disabled = flipped === max;
  const shown = albumNarrow.matches ? [album.pages[flipped]] : [album.pages[flipped * 2 - 1], album.pages[flipped * 2]];
  const numbers = shown.filter((p) => p?.kind === "pockets").map((p) => p.number);
  const total = album.pages.filter((p) => p.kind === "pockets").length;
  $("#album-pos").textContent = numbers.length ? `Pág. ${numbers.join("–")} de ${total}` : flipped === 0 ? "Portada" : flipped === max ? "Contraportada" : "Interior";
}

// ------------------------------------------------------------- paso de hoja ondulado

// La hoja que gira se parte en tiras verticales anidadas. Cada tira gira un poco respecto a la
// anterior, y así el papel se curva de verdad en 3D en vez de girar como una tabla rígida.
const CURL_MAX_BEND = 75; // grados entre el lomo y el borde a mitad de giro
const CURL_WAVE = 16; // grados de la onda que recorre el papel
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function curlFaceHtml(face, offset, strips) {
  // decoding=sync: las imágenes ya están en caché y así la copia no parpadea en el primer fotograma
  const inner = face.innerHTML.replace(/<img /g, '<img decoding="sync" ');
  return `<div class="${esc(face.className)} curl-page" style="width:${strips * 100}%;left:${-offset * 100}%">${inner}</div><i class="curl-shade"></i>`;
}

function startCurl(dir) {
  finishCurl();
  const i = dir > 0 ? album.flipped : album.flipped - 1;
  if (i < 0 || i >= album.leaves || (dir > 0 && album.flipped >= albumMaxFlipped())) return null;
  const leaf = $(`#album-book .album-leaf[data-leaf="${i}"]`);
  const front = leaf.querySelector(".album-face.front");
  const back = leaf.querySelector(".album-face.back");
  const strips = 8;
  let html = "";
  for (let s = strips - 1; s >= 0; s--) {
    html = `<div class="curl-strip" ${s === 0 ? `style="width:${100 / strips}%"` : ""}>
      <div class="curl-face front">${curlFaceHtml(front, s, strips)}</div>
      <div class="curl-face back">${curlFaceHtml(back, strips - 1 - s, strips)}</div>${html}</div>`;
  }
  const root = document.createElement("div");
  root.className = "album-curl";
  root.innerHTML = html;
  root.inert = true;
  leaf.append(root);
  leaf.classList.add("curling");
  leaf.style.transform = "none";
  const curl = {
    leaf, root, dir, t: dir > 0 ? 0 : 1, commit: false, raf: 0,
    strips: [...root.querySelectorAll(".curl-strip")],
    shades: [...root.querySelectorAll(".curl-strip")].map((el) => [...el.children].filter((c) => c.classList.contains("curl-face")).map((f) => f.querySelector(".curl-shade"))),
    // Las tapas del binder son rígidas: giran sin doblarse
    stiff: album.pages[i * albumPerLeaf()].kind === "cover" || album.pages[i * albumPerLeaf() + 1]?.kind === "back",
  };
  album.curl = curl;
  setCurl(curl, curl.t);
  return curl;
}

function setCurl(curl, t) {
  curl.t = t;
  const bend = curl.stiff ? 0 : Math.sin(Math.PI * t);
  const n = curl.strips.length;
  const light = [];
  let prev = 0;
  curl.strips.forEach((strip, i) => {
    const s = (i + 0.5) / n;
    // El borde exterior va por delante del lomo y una onda recorre el papel mientras gira
    const raw = -180 * t - bend * (CURL_MAX_BEND * (s - 0.5) + CURL_WAVE * Math.sin(2 * Math.PI * (s * 1.2 - t)));
    // Limitado a [-180, 0]: el papel nunca atraviesa el plano de las otras páginas
    const angle = Math.min(0, Math.max(-180, raw));
    strip.style.transform = `rotateY(${angle - prev}deg)`;
    prev = angle;
    // Luz desde un lado: un brillo donde el papel la refleja y sombra en el resto marcan la curva
    const shine = Math.max(0, 1 - Math.abs(angle + 50) / 30) * 0.16;
    light.push(shine > 0 ? shine : -0.5 * Math.abs(Math.sin((angle * Math.PI) / 180)));
  });
  // Cada tira funde su luz con la de las vecinas para que la curva se vea continua y no a bandas
  const tone = (v) => (v > 0 ? `rgba(255, 255, 255, ${v})` : `rgba(0, 0, 0, ${-v})`);
  curl.shades.forEach(([front, back], i) => {
    const left = tone((light[i] + light[Math.max(0, i - 1)]) / 2);
    const right = tone((light[i] + light[Math.min(n - 1, i + 1)]) / 2);
    front.style.background = `linear-gradient(90deg, ${left}, ${right})`;
    back.style.background = `linear-gradient(90deg, ${right}, ${left})`;
  });
  $("#album-book .album-cast").style.opacity = Math.sin(Math.PI * t) * 0.8;
}

// Lleva la hoja a su sitio: al otro lado si se confirma el paso o de vuelta si no
function settleCurl(curl, commit, fromDrag) {
  curl.commit = commit;
  if (commit) updateAlbumBook(album.flipped + curl.dir);
  const from = curl.t;
  const to = commit === curl.dir > 0 ? 1 : 0;
  const ms = reduceMotion.matches ? 0 : (fromDrag ? 200 : 350) + (fromDrag ? 450 : 600) * Math.abs(to - from);
  const ease = fromDrag ? (x) => 1 - (1 - x) * (1 - x) : (x) => 0.5 - 0.5 * Math.cos(Math.PI * x);
  const started = performance.now();
  const frame = (now) => {
    const x = ms ? Math.min(1, (now - started) / ms) : 1;
    setCurl(curl, from + (to - from) * ease(x));
    if (x < 1) curl.raf = requestAnimationFrame(frame);
    else finishCurl();
  };
  curl.raf = requestAnimationFrame(frame);
}

function finishCurl() {
  const curl = album.curl;
  if (!curl) return;
  album.curl = null;
  cancelAnimationFrame(curl.raf);
  curl.root.remove();
  curl.leaf.classList.remove("curling");
  $("#album-book .album-cast").style.opacity = 0;
  if (curl.commit) album.flipped += curl.dir;
  updateAlbum();
}

function albumTurn(dir) {
  const curl = startCurl(dir);
  if (curl) settleCurl(curl, true, false);
}

// ------------------------------------------------------------- entrada del álbum

// El icono sale del botón, vuela al centro y se transforma en la portada del binder justo
// donde aparece el álbum; al terminar se quita la copia y queda la vista de siempre.
const ALBUM_INTRO_MS = 1150;

function playAlbumIntro() {
  const dlg = $("#dlg-album");
  const book = $("#album-book");
  const from = $("#btn-album").getBoundingClientRect();
  dlg.classList.add("intro");
  book.classList.add("still");
  book.style.transform = "translateX(-25%) rotateX(0deg)"; // cerrado y de frente: la portada queda centrada
  const stage = $("#album-stage").getBoundingClientRect();
  const w = book.offsetWidth / 2;
  const h = book.offsetHeight;
  const to = { left: stage.left + stage.width / 2 - w / 2, top: stage.top + stage.height / 2 - h / 2, width: w, height: h };
  const mid = Math.min(140, window.innerWidth * 0.32);
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const frame = (r, radius, turn, tilt, offset, easing) => ({
    left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
    borderRadius: radius, transform: `perspective(900px) rotate(${turn}deg) rotateY(${tilt}deg)`, offset, easing,
  });
  const ball = (size) => ({ left: cx - size / 2, top: cy - size / 2, width: size, height: size });

  const fx = document.createElement("div");
  fx.className = "album-fx";
  fx.innerHTML = '<img src="/album/icon.webp" alt=""><i class="album-fx-cover"></i>';
  dlg.append(fx);
  const opts = { duration: ALBUM_INTRO_MS, fill: "forwards" };
  const anims = [
    fx.animate([
      frame(from, "50%", 0, 0, 0, "cubic-bezier(.4, 0, .2, 1)"),
      frame(ball(mid), "50%", 360, 0, 0.36, "ease-out"),
      frame(ball(mid * 1.12), "50%", 360, 0, 0.45, "ease-in"),
      frame(ball(mid), "50%", 360, -35, 0.52, "cubic-bezier(.3, 0, .2, 1)"),
      frame(to, "4px", 360, 0, 1),
    ], opts),
    fx.querySelector("img").animate([{ opacity: 1 }, { opacity: 1, offset: 0.52 }, { opacity: 0, offset: 0.8 }, { opacity: 0 }], opts),
    fx.querySelector(".album-fx-cover").animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 0.82 }, { opacity: 1 }], opts),
  ];
  album.intro = { fx, anims };
  anims[0].finished.then(endAlbumIntro, () => {});
}

function endAlbumIntro() {
  const intro = album.intro;
  if (!intro) return;
  album.intro = null;
  intro.anims.forEach((a) => a.cancel());
  intro.fx.remove();
  $("#dlg-album").classList.remove("intro");
  $("#album-book").classList.remove("still");
  updateAlbumBook(); // vuelve suavemente a la inclinación de siempre
}

function setupAlbum() {
  const stage = $("#album-stage");
  const openAlbum = () => {
    if (album.intro) return;
    finishCurl();
    album.owner = state.me.is_admin ? "__group" : state.me.id;
    album.set = state.set;
    album.flipped = 0;
    $("#album-owner").innerHTML =
      (state.me.is_admin ? "" : `<option value="${esc(state.me.id)}">Mi álbum</option>`) +
      `<option value="__group">Entre todos</option>` +
      collectors().filter((u) => u.id !== state.me.id).map((u) => `<option value="${esc(u.id)}">Álbum de ${esc(u.name)}</option>`).join("");
    $("#album-set").innerHTML = `<option value="all">Todas las colecciones</option>` + state.sets.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
    $("#album-owner").value = album.owner;
    $("#album-set").value = album.set;
    $("#dlg-album").showModal();
    buildAlbum();
    if (!reduceMotion.matches) playAlbumIntro();
  };
  $("#btn-album").addEventListener("click", openAlbum);
  $("#dlg-album").addEventListener("close", () => {
    endAlbumIntro();
    finishCurl();
  });
  $("#album-owner").addEventListener("change", (e) => { album.owner = e.target.value; buildAlbum(); });
  $("#album-set").addEventListener("change", (e) => { album.set = e.target.value; album.flipped = 0; buildAlbum(); });
  $("#album-prev").addEventListener("click", () => albumTurn(-1));
  $("#album-next").addEventListener("click", () => albumTurn(1));
  $("#album-range").addEventListener("input", (e) => {
    finishCurl();
    album.flipped = Number(e.target.value);
    updateAlbum();
  });
  $("#dlg-album").addEventListener("keydown", (e) => {
    if (/^(SELECT|INPUT)$/.test(e.target.tagName) || $("#dlg-card").open) return;
    if (e.key === "ArrowRight") albumTurn(1);
    else if (e.key === "ArrowLeft") albumTurn(-1);
  });
  // Al girar el móvil cambia de una a dos páginas por hoja: se conserva la página que se estaba viendo
  albumNarrow.addEventListener("change", (e) => {
    if (!$("#dlg-album").open) return;
    finishCurl();
    album.flipped = e.matches ? Math.max(0, album.flipped * 2 - 1) : Math.ceil(album.flipped / 2);
    buildAlbum();
  });

  // Deslizar solo pasa páginas: el álbum no se mueve ni gira con el dedo
  stage.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    album.drag = { x: e.clientX, y: e.clientY, at: performance.now(), mode: null, curl: null };
  });
  stage.addEventListener("pointermove", (e) => {
    const d = album.drag;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.mode) {
      if (Math.hypot(dx, dy) < 8) return; // por debajo de esto es un toque en la carta
      d.mode = Math.abs(dx) > Math.abs(dy) ? "flip" : "none";
      if (d.mode === "none") return;
      d.dir = dx < 0 ? 1 : -1;
      d.curl = startCurl(d.dir);
      if (!d.curl) { d.mode = "none"; return; }
      try { stage.setPointerCapture(e.pointerId); } catch {}
      stage.classList.add("grabbing");
    }
    if (d.mode !== "flip") return;
    const width = ($("#album-book").offsetWidth / 2) * (albumNarrow.matches ? 0.9 : 1.5);
    const p = Math.max(0, Math.min(1, (-dx * d.dir) / width));
    d.progress = p;
    d.dx = dx;
    setCurl(d.curl, d.dir > 0 ? p : 1 - p);
  });
  const endDrag = (e) => {
    const d = album.drag;
    album.drag = null;
    stage.classList.remove("grabbing");
    if (d?.mode !== "flip" || album.curl !== d.curl) return;
    // Un gesto rápido y corto también cuenta: en el móvil el dedo no suele recorrer media pantalla
    const flick = performance.now() - d.at < 300 && Math.abs(d.dx) > 30 && Math.sign(d.dx) === -d.dir;
    settleCurl(d.curl, e.type !== "pointercancel" && (d.progress > 0.25 || flick), true);
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
}

function openAvatarPicker() {
  const current = state.me.avatar;
  const initial = esc(state.me.name.trim().charAt(0).toUpperCase());
  $("#avatar-grid").innerHTML =
    `<button type="button" class="${current ? "" : "on"}" data-avatar=""><span class="none-avatar">${initial}</span>Sin avatar</button>` +
    state.avatars
      .map((a) => `<button type="button" class="${a.id === current ? "on" : ""}" data-avatar="${a.id}"><img src="/avatars/${a.id}.png" alt="" loading="lazy">${esc(a.name)}</button>`)
      .join("");
  $("#dlg-avatar").showModal();
}

async function chooseAvatar(value) {
  try {
    const { avatar } = await api("/api/me/avatar", { method: "PUT", body: JSON.stringify({ avatar: value ? Number(value) : null }) });
    await load();
    render();
    if ($("#dlg-members").open) renderMemberList();
    $("#dlg-avatar").close();
    toast(avatar ? "Avatar cambiado" : "Avatar quitado");
  } catch (e) {
    toast(e.message);
  }
}

// ------------------------------------------------------------- intercambios
// Pides cartas a otro miembro, la app propone qué dar a cambio (tus repes que le faltan, con valor parecido),
// lo ajustas y lo envías. El otro acepta, rechaza o contraoferta. Al marcar un acuerdo como realizado,
// las cartas pasan de una colección a otra (lo hace el servidor).

const trade = { list: [], tab: "list", with: null, want: [], give: [], parent: null, message: "", pick: "theirs", pickAll: false, q: "", showHistory: false };
const TRADE_STATUS = {
  proposed: "Pendiente",
  accepted: "Acuerdo",
  doing: "Acuerdo",
  done: "Realizado",
  rejected: "Rechazado",
  cancelled: "Cancelado",
  countered: "Contraofertado",
};
const userById = (id) => state.users.find((u) => u.id === id) || { id, name: id };
const cardById = (id) => state.cards.find((c) => c.id === id);

async function loadTrades() {
  if (!state.me || state.me.is_admin) return;
  try {
    trade.list = (await api("/api/trades", { retry: false })).trades;
  } catch {
    return;
  }
  renderTradeBadge();
  if ($("#dlg-trade").open && trade.tab === "list") renderTrades();
}

// Lo que te toca mirar: propuestas que te han hecho y acuerdos por completar
function tradeTodo() {
  const me = state.me.id;
  return trade.list.filter((t) => (t.status === "proposed" && t.to_user === me) || t.status === "accepted" || t.status === "doing").length;
}

function renderTradeBadge() {
  const n = tradeTodo();
  $("#trade-badge").hidden = !n;
  $("#trade-badge").textContent = n;
  $("#trade-tab-n").textContent = n || "";
}

// Mediana de precio por rareza: estimación para cartas sin precio en Cardmarket
let rarityMedianCache = null;
function rarityMedian(rarity, metric) {
  if (!rarityMedianCache || rarityMedianCache.cards !== state.cards || rarityMedianCache.metric !== metric) {
    const by = {};
    for (const c of state.cards) if (c[metric] != null && c.rarity) (by[c.rarity] ||= []).push(c[metric]);
    const med = {};
    for (const [r, vs] of Object.entries(by)) {
      vs.sort((a, b) => a - b);
      med[r] = vs[Math.floor(vs.length / 2)];
    }
    rarityMedianCache = { cards: state.cards, metric, med };
  }
  return rarityMedianCache.med[rarity] ?? null;
}

// Valor de una copia en un idioma (Cardmarket en español, TCGplayer en el resto).
// Sin precio: estimación con la mediana de su rareza en la misma fuente.
function unitValue(c, lang) {
  const metric = state.me.price_metric;
  const p = langPrice(c, metric, lang);
  if (p.v != null) return { v: p.v, est: p.src === "approx" };
  const alt = langPrice(c, metric === "cm_mid" ? "cm_trend" : "cm_mid", lang);
  if (alt.v != null) return { v: alt.v, est: true };
  return { v: rarityMedian(c.rarity, metric) || 0, est: true };
}

// Qué copia se daría: una que sobre, mejor la que no es en español si así se queda la española
function spareLang(cardId, userId) {
  const bd = copies(cardId, userId);
  const total = Object.values(bd).reduce((a, b) => a + b, 0);
  if ((bd.es || 0) >= 2) return "es";
  if (total >= 2) {
    const other = Object.keys(bd).find((k) => k !== "es");
    if (other) return other;
  }
  return Object.entries(bd).sort((a, b) => b[1] - a[1])[0]?.[0] || "es";
}

const itemValue = (i) => {
  const c = cardById(i.card_id);
  return c ? unitValue(c, i.lang) : { v: 0, est: true };
};
const sumValue = (items) => items.reduce((a, i) => a + itemValue(i).v, 0);

// Mis repes que al otro le faltan (lo sensato para dar), sin las que ya van en la propuesta
function givePool(me, other, exclude) {
  return regularCards()
    .filter((c) => qty(c.id, me) >= 2 && !qty(c.id, other) && !exclude.has(c.id) && !isOtherSet(c.set_id))
    .map((c) => {
      const lang = spareLang(c.id, me);
      return { card_id: c.id, lang, v: unitValue(c, lang).v, rarity: c.rarity };
    });
}

// Hasta 3 propuestas distintas de qué dar a cambio de lo que pides
function suggestGive(me, other, want) {
  if (!want.length) return [];
  const target = sumValue(want);
  const pool = givePool(me, other, new Set(want.map((i) => i.card_id)));
  const out = [];
  const add = (label, desc, items) => {
    if (!items.length) return;
    const key = items.map((i) => i.card_id).sort().join();
    if (out.some((s) => s.key === key)) return;
    out.push({ label, desc, key, items: items.map(({ card_id, lang }) => ({ card_id, lang })) });
  };
  if (!pool.length) return out;

  // 1. Valor más parecido con el menor número de cartas (mochila en pasos de 10 céntimos, máx. 6 cartas)
  const unit = 0.1;
  const cap = Math.max(1, Math.round((target * 1.5 + 1) / unit));
  const cands = [...pool].sort((a, b) => Math.abs(a.v - target) - Math.abs(b.v - target)).slice(0, 60);
  const best = new Array(cap + 1).fill(null);
  best[0] = [];
  for (const it of cands) {
    const w = Math.max(1, Math.round(it.v / unit));
    for (let s = cap; s >= w; s--) {
      const prev = best[s - w];
      if (prev && prev.length < 6 && (!best[s] || best[s].length > prev.length + 1)) best[s] = [...prev, it];
    }
  }
  let pick = null;
  let pickDiff = Infinity;
  const goal = Math.round(target / unit);
  for (let s = 1; s <= cap; s++) {
    if (!best[s]) continue;
    const d = Math.abs(s - goal) * unit + best[s].length * 0.15; // un poco de penalización por carta
    if (d < pickDiff) { pickDiff = d; pick = best[s]; }
  }
  if (pick) add("⚖️ Valor equilibrado", "La combinación de tus repes que más se acerca al valor de lo que pides.", pick);

  // 2. Carta por carta: por cada carta que pides, una de tus repes de valor parecido
  const used = new Set();
  const oneByOne = [];
  for (const w of [...want].sort((a, b) => itemValue(b).v - itemValue(a).v)) {
    const wv = itemValue(w).v;
    const m = pool.filter((p) => !used.has(p.card_id)).sort((a, b) => Math.abs(a.v - wv) - Math.abs(b.v - wv))[0];
    if (m) { used.add(m.card_id); oneByOne.push(m); }
  }
  add("🔁 Carta por carta", "Una de tus repes por cada carta que pides, de valor parecido.", oneByOne);

  // 3. Misma rareza: SIR por SIR, Full Art por Full Art... solo si hay pareja para todas
  const usedR = new Set();
  const sameRarity = [];
  for (const w of want) {
    const c = cardById(w.card_id);
    const wv = itemValue(w).v;
    const m = pool.filter((p) => !usedR.has(p.card_id) && p.rarity === c?.rarity).sort((a, b) => Math.abs(a.v - wv) - Math.abs(b.v - wv))[0];
    if (!m) { sameRarity.length = 0; break; }
    usedR.add(m.card_id);
    sameRarity.push(m);
  }
  add("✨ Misma rareza", "Por cada carta que pides, una de tus repes de la misma rareza.", sameRarity);
  return out;
}

// Botón «Tradear con …» en la ficha: a quien más copias tiene (y más le sobran)
function bestOwnerFor(cardId) {
  const me = state.me.id;
  return collectors()
    .filter((u) => u.id !== me && qty(cardId, u.id) > 0)
    .sort((a, b) => qty(cardId, b.id) - qty(cardId, a.id))[0];
}
function tradeButtonHtml(c) {
  if (state.me.is_admin || isOtherSet(c.set_id)) return "";
  const u = bestOwnerFor(c.id);
  if (!u) return "";
  const n = qty(c.id, u.id);
  return `<button type="button" class="btn trade-cta" data-trade-card="${esc(c.id)}" data-trade-user="${esc(u.id)}"><img src="/trade.svg" alt="" width="22" height="22"> Tradear con ${esc(u.name)}${n > 1 ? ` <small>(tiene ${n})</small>` : ""}</button>`;
}

// Abre Intercambios con esa persona y la carta ya pedida (las propuestas de la app salen solas)
function tradeForCard(cardId, userId) {
  $("#dlg-card").close();
  trade.tab = "new";
  $("#dlg-trade").showModal();
  startTrade(userId, { want: [{ card_id: cardId, lang: spareLang(cardId, userId) }] });
  loadTrades();
}

function openTrade(tab) {
  if (tab) trade.tab = tab;
  $("#dlg-trade").showModal();
  renderTrades();
  loadTrades();
}

function startTrade(otherId, { want = [], give = [], parent = null } = {}) {
  Object.assign(trade, { tab: "new", with: otherId, want, give, parent, message: "", pick: "theirs", pickAll: false, q: "" });
  renderTrades();
}

function tradeThumb(c) {
  if (!c) return `<span class="tthumb"></span>`;
  const img = c.image_status === "missing" || brokenImages.has(c.id) ? "" : `<img src="${esc(imgUrl(c))}" alt="" loading="lazy" onerror="this.remove()">`;
  return `<span class="tthumb" data-r="${esc(c.rarity)}">${img}</span>`;
}

function tradeItemRow(i, removable) {
  const c = cardById(i.card_id);
  const { v, est } = itemValue(i);
  return `<li class="titem">${tradeThumb(c)}<span class="tname"><b>${esc(c?.name || i.card_id)}</b><small>${esc(c ? displayNumber(c) : "")} · ${esc(c?.rarity || "")}${i.lang !== "es" ? ` · <span class="langtag-inline">${esc(i.lang.toUpperCase())}</span>` : ""}</small></span>
    <span class="tval">${est ? "≈ " : ""}${euros.format(v)}</span>${removable ? `<button type="button" class="del" data-tremove="${esc(removable)}:${esc(i.card_id)}" aria-label="Quitar">✕</button>` : ""}</li>`;
}

// Resumen de valor de un intercambio desde mi punto de vista
function balanceHtml(give, get, otherName) {
  const g = sumValue(give);
  const r = sumValue(get);
  const diff = r - g;
  // Equilibrado si la diferencia es pequeña en proporción (15 %) o de unos céntimos
  const fair = Math.abs(diff) <= Math.max(0.3, 0.15 * Math.max(g, r));
  const txt = fair ? "Bastante equilibrado" : diff > 0 ? `Sales ganando ${euros.format(diff)}` : `${esc(otherName)} sale ganando ${euros.format(-diff)}`;
  return `<div class="tbalance ${fair ? "fair" : diff > 0 ? "up" : "down"}"><span>Das <b>${euros.format(g)}</b></span><span>Recibes <b>${euros.format(r)}</b></span><span class="verdict">${txt}</span></div>`;
}

function renderTrades() {
  document.querySelectorAll("[data-ttab]").forEach((b) => b.classList.toggle("on", b.dataset.ttab === trade.tab));
  renderTradeBadge();
  $("#trade-body").innerHTML = trade.tab === "new" ? newTradeHtml() : tradeListHtml();
}

function tradeListHtml() {
  const me = state.me.id;
  const card = (t) => {
    const mine = t.from_user === me;
    const other = userById(mine ? t.to_user : t.from_user);
    const give = t.items.filter((i) => i.giver === me);
    const get = t.items.filter((i) => i.giver !== me);
    const status = t.status;
    const actions = [];
    if (status === "proposed" && !mine) {
      actions.push(`<button type="button" class="btn primary small" data-taction="accept:${t.id}">✅ Aceptar</button>`);
      actions.push(`<button type="button" class="btn ghost small" data-tcounter="${t.id}">🔁 Contraoferta</button>`);
      actions.push(`<button type="button" class="btn ghost small" data-taction="reject:${t.id}">Rechazar</button>`);
    }
    if (status === "proposed" && mine) actions.push(`<button type="button" class="btn ghost small" data-taction="cancel:${t.id}">Cancelar propuesta</button>`);
    if (status === "accepted" || status === "doing") {
      actions.push(`<button type="button" class="btn primary small" data-taction="done:${t.id}">🤝 Marcar como realizado</button>`);
      actions.push(`<button type="button" class="btn ghost small" data-taction="cancel:${t.id}">Anular acuerdo</button>`);
    }
    const who = mine ? `Propuesta tuya a ${esc(other.name)}` : `${esc(other.name)} te propone`;
    const when = new Date(t.updated_at * 1000).toLocaleDateString("es-ES");
    return `<article class="tcard st-${esc(status)}">
      <header>${avatar(other)}<span class="twho">${who}<small>${when}${t.parent_id ? " · contraoferta" : ""}</small></span><span class="tstatus">${TRADE_STATUS[status] || status}</span></header>
      ${t.message ? `<p class="tmsg">“${esc(t.message)}”</p>` : ""}
      <div class="tsides">
        <div><h5>Das</h5><ul>${give.map((i) => tradeItemRow(i)).join("")}</ul></div>
        <div><h5>Recibes</h5><ul>${get.map((i) => tradeItemRow(i)).join("")}</ul></div>
      </div>
      ${balanceHtml(give, get, other.name)}
      ${actions.length ? `<div class="tactions">${actions.join("")}</div>` : ""}
    </article>`;
  };
  const open = (t) => ["proposed", "accepted", "doing"].includes(t.status);
  const incoming = trade.list.filter((t) => t.status === "proposed" && t.to_user === me);
  const deals = trade.list.filter((t) => t.status === "accepted" || t.status === "doing");
  const outgoing = trade.list.filter((t) => t.status === "proposed" && t.from_user === me);
  const history = trade.list.filter((t) => !open(t));
  const section = (title, list, hint) => (list.length ? `<h3>${title} <small>${list.length}</small></h3>${hint ? `<p class="hint">${hint}</p>` : ""}${list.map(card).join("")}` : "");
  const body =
    section("Te proponen", incoming, "Acepta, rechaza o propón otra cosa con una contraoferta.") +
    section("Acuerdos", deals, "Cuando os veáis y hagáis el cambio, márcalo como realizado: las cartas pasarán de una colección a otra.") +
    section("Has propuesto", outgoing) +
    (history.length
      ? `<details class="thistory" ${trade.showHistory ? "open" : ""}><summary>Historial (${history.length})</summary>${history.map(card).join("")}</details>`
      : "");
  return body || `<div class="tempty"><img src="/trade.svg" alt="" width="64" height="64"><p>Aún no tienes intercambios.</p><button type="button" class="btn primary" data-ttab="new">Proponer un intercambio</button></div>`;
}

function newTradeHtml() {
  const me = state.me.id;
  const others = collectors().filter((u) => u.id !== me);
  if (!trade.with) {
    return `<p class="hint">¿Con quién quieres intercambiar? Entre paréntesis, cuántas repes suyas te faltan y cuántas tuyas le faltan.</p>
      <div class="tpeople">${others
        .map((u) => {
          const theirs = state.cards.filter((c) => qty(c.id, u.id) >= 2 && !qty(c.id, me)).length;
          const mine = state.cards.filter((c) => qty(c.id, me) >= 2 && !qty(c.id, u.id)).length;
          return `<button type="button" class="tperson" data-twith="${esc(u.id)}">${avatar(u, "lg")}<span><b>${esc(u.name)}</b><small>Le sobran ${theirs} que te faltan · te sobran ${mine} que le faltan</small></span></button>`;
        })
        .join("")}</div>`;
  }
  const other = userById(trade.with);
  const sugg = suggestGive(me, other.id, trade.want);
  const ownerId = trade.pick === "theirs" ? other.id : me;
  const lackerId = trade.pick === "theirs" ? me : other.id;
  const chosen = new Set((trade.pick === "theirs" ? trade.want : trade.give).map((i) => i.card_id));
  const q = trade.q.trim().toLowerCase();
  const pickList = state.cards
    .filter((c) => qty(c.id, ownerId) > 0)
    .filter((c) => trade.pickAll || (qty(c.id, ownerId) >= 2 && !qty(c.id, lackerId)))
    .filter((c) => !q || `${c.name} ${c.number} ${c.rarity || ""}`.toLowerCase().includes(q));
  const tile = (c) => {
    const n = qty(c.id, ownerId);
    const lang = spareLang(c.id, ownerId);
    const { v, est } = unitValue(c, lang);
    const lacks = !qty(c.id, lackerId);
    return `<button type="button" class="ttile ${chosen.has(c.id) ? "on" : ""}" data-tpick="${esc(c.id)}">${tradeThumb(c)}<span class="tn">${esc(c.name)}</span>
      <small>${esc(displayNumber(c))} · ×${n}${lang !== "es" ? ` · ${esc(lang.toUpperCase())}` : ""}</small><small class="tv">${est ? "≈ " : ""}${euros.format(v)}${lacks ? "" : " · ya la tiene"}</small></button>`;
  };
  const sideHtml = (side, items, title, empty) => `<div class="tside"><h4>${title} <small>${items.length ? euros.format(sumValue(items)) : ""}</small></h4>
    ${items.length ? `<ul>${items.map((i) => tradeItemRow(i, side)).join("")}</ul>` : `<p class="hint">${empty}</p>`}</div>`;
  const ready = trade.want.length && trade.give.length;
  const warnSingles = trade.give.filter((i) => qty(i.card_id, me) < 2).map((i) => cardById(i.card_id)?.name);
  return `<div class="twith">${avatar(other)} <span>Intercambio con <b>${esc(other.name)}</b>${trade.parent ? " · <i>contraoferta</i>" : ""}</span>
      ${trade.parent ? "" : `<button type="button" class="btn ghost small" data-twith="">Cambiar persona</button>`}</div>
    <div class="tsides edit">
      ${sideHtml("want", trade.want, `Pides a ${esc(other.name)}`, "Elige abajo las cartas que quieres.")}
      ${sideHtml("give", trade.give, "Das tú", trade.want.length ? "Usa una propuesta de la app o elige abajo tus cartas." : "Primero elige lo que quieres.")}
    </div>
    ${trade.want.length || trade.give.length ? balanceHtml(trade.give, trade.want, other.name) : ""}
    ${warnSingles.length ? `<p class="twarn">⚠️ Te quedarías sin: ${warnSingles.map(esc).join(", ")}</p>` : ""}
    ${trade.want.length ? `<div class="tsugg"><h4>💡 Propuestas de la app</h4>${
      sugg.length
        ? sugg
            .map(
              (s, k) => `<div class="ts"><div class="tsh"><b>${s.label}</b><span>${euros.format(sumValue(s.items))} por ${euros.format(sumValue(trade.want))}</span><button type="button" class="btn ${k ? "ghost" : "primary"} small" data-tsugg="${k}">Usar esta</button></div>
              <p class="hint">${s.desc}</p><div class="tmini">${s.items.map((i) => { const c = cardById(i.card_id); return `<span>${tradeThumb(c)}<small>${esc(c?.name || "")}</small></span>`; }).join("")}</div></div>`,
            )
            .join("")
        : `<p class="hint">No tienes repes que a ${esc(other.name)} le falten. Elige abajo qué darías de lo tuyo.</p>`
    }</div>` : ""}
    <div class="tpick">
      <div class="seg"><button type="button" class="${trade.pick === "theirs" ? "on" : ""}" data-tpickside="theirs">Cartas de ${esc(other.name)}</button><button type="button" class="${trade.pick === "mine" ? "on" : ""}" data-tpickside="mine">Mis cartas</button></div>
      <label class="pref-check"><input type="checkbox" data-tpickall ${trade.pickAll ? "checked" : ""}> Ver todas (no solo ${trade.pick === "theirs" ? "sus repes que te faltan" : "tus repes que le faltan"})</label>
      <input type="search" class="tsearch" placeholder="Buscar carta…" value="${esc(trade.q)}" data-tq>
      <div class="ttiles">${pickList.length ? pickList.map(tile).join("") : `<p class="hint">No hay cartas con este filtro. Marca «Ver todas».</p>`}</div>
    </div>
    <div class="tsend">
      <textarea placeholder="Mensaje (opcional): «Te lo cambio el sábado»…" maxlength="300" data-tmsg>${esc(trade.message)}</textarea>
      <button type="button" class="btn primary" data-tsend ${ready ? "" : "disabled"}>${trade.parent ? "Enviar contraoferta" : "Enviar propuesta"}</button>
    </div>`;
}

function togglePick(cardId) {
  const me = state.me.id;
  const side = trade.pick === "theirs" ? "want" : "give";
  const owner = trade.pick === "theirs" ? trade.with : me;
  const list = trade[side];
  const at = list.findIndex((i) => i.card_id === cardId);
  if (at >= 0) list.splice(at, 1);
  else list.push({ card_id: cardId, lang: spareLang(cardId, owner) });
  renderTradesKeepScroll();
}

// Re-pinta sin perder la posición ni el foco del buscador
function renderTradesKeepScroll() {
  const dlg = $("#dlg-trade");
  const top = dlg.scrollTop;
  const focusQ = document.activeElement?.matches?.("[data-tq]");
  renderTrades();
  dlg.scrollTop = top;
  if (focusQ) {
    const i = $("[data-tq]");
    i.focus();
    i.setSelectionRange(i.value.length, i.value.length);
  }
}

async function sendTrade() {
  const me = state.me.id;
  const items = [
    ...trade.want.map((i) => ({ ...i, giver: trade.with })),
    ...trade.give.map((i) => ({ ...i, giver: me })),
  ];
  try {
    await api("/api/trades", { method: "POST", retry: false, body: JSON.stringify({ to: trade.with, items, message: trade.message, parent_id: trade.parent }) });
    toast(trade.parent ? "Contraoferta enviada" : `Propuesta enviada a ${userById(trade.with).name}`);
    Object.assign(trade, { tab: "list", with: null, want: [], give: [], parent: null, message: "" });
    await loadTrades();
    renderTrades();
  } catch (e) {
    toast(e.offline ? "Sin conexión: no se ha enviado" : `No se pudo enviar: ${e.message}`);
  }
}

async function tradeAction(action, id) {
  const confirmText = {
    accept: "¿Aceptar este intercambio? Quedará como acuerdo para los dos hasta que lo marquéis como realizado.",
    reject: "¿Rechazar esta propuesta?",
    cancel: "¿Cancelar este intercambio?",
    done: "¿Ya habéis hecho el cambio? Las cartas pasarán de una colección a otra.",
  }[action];
  if (!confirm(confirmText)) return;
  try {
    await api(`/api/trades/${id}/${action}`, { method: "POST", retry: false });
    toast({ accept: "¡Acuerdo cerrado! 🤝", reject: "Propuesta rechazada", cancel: "Intercambio cancelado", done: "¡Intercambio realizado! Colecciones actualizadas" }[action]);
    if (action === "done") { await load(); render(); }
    await loadTrades();
    renderTrades();
  } catch (e) {
    toast(e.offline ? "Sin conexión" : e.message);
    loadTrades();
  }
}

function counterTrade(id) {
  const t = trade.list.find((x) => x.id === id);
  if (!t) return;
  const me = state.me.id;
  startTrade(t.from_user, {
    want: t.items.filter((i) => i.giver !== me).map(({ card_id, lang }) => ({ card_id, lang })),
    give: t.items.filter((i) => i.giver === me).map(({ card_id, lang }) => ({ card_id, lang })),
    parent: t.id,
  });
}

function setupTrades() {
  if (state.me.is_admin) return;
  $("#btn-trade").hidden = false;
  $("#btn-trade").addEventListener("click", () => openTrade(tradeTodo() ? "list" : trade.list.length ? "list" : "new"));
  const dlg = $("#dlg-trade");
  dlg.addEventListener("click", (e) => {
    const t = e.target.closest("[data-ttab],[data-twith],[data-tpick],[data-tpickside],[data-tremove],[data-tsugg],[data-tsend],[data-taction],[data-tcounter]");
    if (!t) return;
    const d = t.dataset;
    if (d.ttab) { trade.tab = d.ttab; renderTrades(); }
    else if (d.twith !== undefined) { if (d.twith) startTrade(d.twith); else { trade.with = null; trade.want = []; trade.give = []; renderTrades(); } }
    else if (d.tpick) togglePick(d.tpick);
    else if (d.tpickside) { trade.pick = d.tpickside; renderTradesKeepScroll(); }
    else if (d.tremove) { const [side, id] = d.tremove.split(/:(.+)/); trade[side] = trade[side].filter((i) => i.card_id !== id); renderTradesKeepScroll(); }
    else if (d.tsugg !== undefined) { trade.give = suggestGive(state.me.id, trade.with, trade.want)[Number(d.tsugg)].items; renderTradesKeepScroll(); }
    else if (d.tsend !== undefined) sendTrade();
    else if (d.taction) { const [a, id] = d.taction.split(":"); tradeAction(a, Number(id)); }
    else if (d.tcounter) counterTrade(Number(d.tcounter));
  });
  dlg.addEventListener("input", (e) => {
    if (e.target.matches("[data-tq]")) { trade.q = e.target.value; renderTradesKeepScroll(); }
    else if (e.target.matches("[data-tmsg]")) trade.message = e.target.value;
  });
  dlg.addEventListener("change", (e) => {
    if (e.target.matches("[data-tpickall]")) { trade.pickAll = e.target.checked; renderTradesKeepScroll(); }
  });
  dlg.addEventListener("toggle", (e) => { if (e.target.matches(".thistory")) trade.showHistory = e.target.open; }, true);
  loadTrades();
}

// ------------------------------------------------------------- gastos

const spend = { products: [], sources: [], purchases: [], open: null, loaded: false };
const lineTotal = (p) => p.qty * p.unit_price;
const signed = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${euros.format(Math.abs(v))}`;

async function openSpend() {
  $("#dlg-members").close();
  if (!spend.loaded) $("#spend-body").innerHTML = `<p class="hint">Cargando…</p>`;
  $("#dlg-spend").showModal();
  await loadSpend();
}

async function loadSpend() {
  try {
    Object.assign(spend, await api("/api/purchases"), { loaded: true });
    renderSpend();
  } catch (e) {
    $("#spend-body").innerHTML = `<p class="form-error">No se pudieron cargar los gastos: ${esc(e.message)}</p>`;
  }
}

function productName(p) {
  const prod = spend.products.find((x) => x.id === p.product);
  return p.name ? `${prod?.name || "Producto"}: ${p.name}` : prod?.name || p.product;
}

const sealedValue = (p) => (p.sealed ? p.qty * (p.value || 0) : 0);

function purchaseLine(p, mine) {
  const src = spend.sources.find((x) => x.id === p.source)?.name;
  const prod = spend.products.find((x) => x.id === p.product);
  const badges = prod?.sealable
    ? `<span class="lang-badge">${p.lang === "en" ? "EN" : "ES"}</span>${p.sealed ? `<span class="sealed-badge" title="Guardada sellada">📦 Sellada${p.value != null ? ` · vale ${euros.format(p.value)}` : " · sin valor"}</span>` : ""}`
    : "";
  const when = p.bought_on ? new Date(`${p.bought_on}T12:00`).toLocaleDateString("es-ES") : "";
  const who = mine ? "" : `${avatar(state.users.find((u) => u.id === p.user_id) || { name: "?" })} `;
  return `<li class="buy ${mine ? "mine" : ""}">${who}<span class="what">${badges}<span>${p.name ? `<b>${esc(p.name)}</b> · ` : ""}${p.qty} × ${euros.format(p.unit_price)}${src ? ` · ${esc(src)}` : ""}${when ? ` · ${esc(when)}` : ""}</span></span>
    <span class="sum">${euros.format(lineTotal(p))}</span>${mine && prod?.sealable ? `<button type="button" class="del" data-edit-sealed="${p.id}" title="${p.sealed ? "Cambiar el valor actual" : "Marcar como guardada sellada"}" aria-label="Editar sellado">✏️</button>` : ""}${mine ? `<button type="button" class="del" data-del-purchase="${p.id}" title="Borrar esta compra" aria-label="Borrar esta compra">✕</button>` : ""}</li>`;
}

function renderSpend() {
  const me = state.me;
  const people = collectors();
  const metric = metricName(me.price_metric);
  const rows = people
    .map((u) => {
      const own = spend.purchases.filter((p) => p.user_id === u.id);
      const spent = own.reduce((a, p) => a + lineTotal(p), 0);
      const cards = memberValue(u);
      const sealed = own.reduce((a, p) => a + sealedValue(p), 0);
      const value = cards + sealed;
      return { u, spent, cards, sealed, value, profit: value - spent };
    })
    .sort((a, b) => b.spent - a.spent || b.value - a.value);
  const spent = rows.reduce((a, r) => a + r.spent, 0);
  const value = rows.reduce((a, r) => a + r.value, 0);
  const cardsTotal = rows.reduce((a, r) => a + r.cards, 0);
  const sealedTotal = rows.reduce((a, r) => a + r.sealed, 0);
  const anySealed = spend.purchases.some((p) => p.sealed);
  const profit = value - spent;

  const groups = [...new Set(spend.products.map((p) => p.group))];
  const productsHtml = groups
    .map((g) => `<h4>${esc(g)}</h4>` + spend.products
      .filter((p) => p.group === g)
      .map((prod) => {
        const all = spend.purchases.filter((p) => p.product === prod.id);
        const mine = all.filter((p) => p.user_id === me.id);
        const others = all.filter((p) => p.user_id !== me.id);
        const myQty = mine.reduce((a, p) => a + p.qty, 0);
        const mySum = mine.reduce((a, p) => a + lineTotal(p), 0);
        const otherQty = others.reduce((a, p) => a + p.qty, 0);
        return `<details class="prod ${myQty ? "has" : ""}" data-prod="${esc(prod.id)}" ${spend.open === prod.id ? "open" : ""}>
          <summary><span class="pn">${esc(prod.name)}</span><span class="pq">${myQty ? `<b>${myQty} × · ${euros.format(mySum)}</b>` : ""}${otherQty ? `<small>${otherQty} del grupo</small>` : ""}</span></summary>
          ${mine.length ? `<ul class="buys">${mine.map((p) => purchaseLine(p, true)).join("")}</ul>` : ""}
          ${me.is_admin ? "" : `<form class="buy-form" data-buy-form="${esc(prod.id)}">
            ${prod.custom ? `<label class="wide">${prod.id === "single" ? "¿Qué carta?" : "¿Qué producto?"} <input name="name" maxlength="80" required placeholder="${prod.id === "single" ? "Pikachu ex SIR 150/128" : "Lote de sobres"}"></label>` : ""}
            <label>Cantidad <input name="qty" type="number" min="1" max="999" value="1" required></label>
            <label>€ por unidad <input name="unit_price" inputmode="decimal" placeholder="0,00" required></label>
            <label>Dónde <select name="source"><option value="">—</option>${spend.sources.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select></label>
            <label>Fecha <input name="bought_on" type="date"></label>
            ${prod.sealable ? `<div class="sealed-row">
              <label>Idioma <select name="lang"><option value="es">Español</option><option value="en">Inglés</option></select></label>
              <label class="check"><input type="checkbox" name="sealed"> 📦 La guardo sellada</label>
              <label>Valor actual €/ud <input name="value" inputmode="decimal" placeholder="Ej. 200"></label>
            </div>` : ""}
            <button class="btn primary small">Añadir compra</button>
          </form>`}
          ${others.length ? `<p class="others-title">Del resto del grupo</p><ul class="buys">${others.map((p) => purchaseLine(p, false)).join("")}</ul>` : ""}
        </details>`;
      })
      .join(""))
    .join("");

  $("#spend-body").innerHTML = `
    <div class="spend-tiles">
      <div><span>Gastado entre todos</span><strong>${euros.format(spent)}</strong></div>
      <div><span>${anySealed ? "Valor de cartas + sellado" : `Valor de las cartas (${metric})`}</span><strong>${euros.format(value)}</strong>${anySealed ? `<small>Cartas ${euros.format(cardsTotal)} · sellado ${euros.format(sealedTotal)}</small>` : ""}</div>
      <div class="${profit >= 0 ? "pos" : "neg"}"><span>Beneficio si se vendiera todo</span><strong>${signed(profit)}</strong></div>
    </div>
    <table class="spend-table">
      <thead><tr><th>Persona</th><th>Gastado</th><th>Valor cartas</th>${anySealed ? "<th>Sellado</th>" : ""}<th>Beneficio</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.u.id === me.id ? "self" : ""}"><td>${avatar(r.u)} ${esc(r.u.name)}${r.u.id === me.id ? " (tú)" : ""}</td><td>${euros.format(r.spent)}</td><td>${euros.format(r.cards)}</td>${anySealed ? `<td>${r.sealed ? euros.format(r.sealed) : "—"}</td>` : ""}<td class="${r.profit >= 0 ? "pos" : "neg"}">${signed(r.profit)}</td></tr>`).join("")}</tbody>
    </table>
    <p class="hint">El valor de las cartas es el de Cardmarket (${metric}) para las copias en español, el de TCGplayer (el que usa Collectr) para las inglesas y Cardmarket como aproximado para japonés y chino, más el valor que cada uno ha puesto a lo que guarda sellado (ETB y UPC). Es una estimación: vender tiene comisiones y envíos.</p>
    <h3>${me.is_admin ? "Compras del grupo" : "Mis compras"}</h3>
    <p class="hint">${me.is_admin ? "Toca un producto para ver lo que ha pagado cada uno." : "Toca un producto y añade lo que pagaste. Si compraste varios a precios distintos, añade una compra por cada precio."}</p>
    <div class="prods">${productsHtml}</div>`;
}

async function addPurchase(form) {
  const f = form.elements;
  const body = {
    product: form.dataset.buyForm,
    name: f.name?.value,
    qty: f.qty.value,
    unit_price: f.unit_price.value,
    source: f.source.value,
    bought_on: f.bought_on.value,
    lang: f.lang?.value,
    sealed: !!f.sealed?.checked,
    value: f.value?.value,
  };
  try {
    await api("/api/purchases", { method: "POST", body: JSON.stringify(body), retry: false });
    spend.open = body.product;
    await loadSpend();
    toast("Compra añadida");
  } catch (e) {
    toast(e.offline ? "Sin conexión: no se ha guardado la compra" : `No se pudo guardar: ${e.message}`);
  }
}

// Marcar/desmarcar como sellada y cambiar su valor actual (los precios del sellado se mueven)
async function editSealed(id) {
  const p = spend.purchases.find((x) => x.id === id);
  if (!p) return;
  const cur = p.value != null ? String(p.value).replace(".", ",") : "";
  const answer = prompt(
    `Valor actual por unidad en € de lo que guardas sellado (p. ej. 200).\nDéjalo vacío si ya no la guardas sellada.`,
    p.sealed ? cur : "",
  );
  if (answer === null) return;
  const sealed = answer.trim() !== "";
  try {
    await api(`/api/purchases/${id}`, { method: "PUT", body: JSON.stringify({ sealed, lang: p.lang || "es", value: sealed ? answer : null }) });
    await loadSpend();
    toast(sealed ? "Valor del sellado guardado" : "Ya no cuenta como sellada");
  } catch (e) {
    toast(`No se pudo guardar: ${e.message}`);
  }
}

async function deletePurchase(id) {
  if (!confirm("¿Borrar esta compra?")) return;
  try {
    await api(`/api/purchases/${id}`, { method: "DELETE" });
    await loadSpend();
    toast("Compra borrada");
  } catch (e) {
    toast(`No se pudo borrar: ${e.message}`);
  }
}

// Copias × precio actual; las cartas sin precio no suman
function memberValue(u) {
  const metric = state.me.price_metric;
  return state.cards.reduce((sum, c) => sum + qty(c.id, u.id) * (cardPrice(c, metric, u.id) || 0), 0);
}

// Valor oculto por defecto, con un ojo como en los campos de contraseña. Al volver a abrir el menú, todos ocultos otra vez.
const revealedValues = new Set();
const EYE = '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>';
const EYE_OFF = '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.5 6.6A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>';

function memberValueHtml(u) {
  const shown = revealedValues.has(u.id);
  const label = `${shown ? "Ocultar" : "Ver"} el valor de ${esc(u.name)}`;
  return `<span class="member-value"><span>${shown ? euros.format(memberValue(u)) : "•••• €"}</span><button type="button" class="eye" data-reveal="${esc(u.id)}" aria-pressed="${shown}" aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shown ? EYE_OFF : EYE}</svg></button></span>`;
}

function renderMemberList() {
  const admin = !!state.me.is_admin;
  $("#new-member").hidden = !admin;
  $("#menu-title").textContent = `Menú de ${state.me.name}`;
  $("#members-legend").textContent = `Miembros · valor de sus cartas (${metricName(state.me.price_metric)})`;
  $("#pref-hide").checked = !!state.me.hide_prices;
  $("#pref-metric-row").classList.toggle("off", !!state.me.hide_prices);
  document.querySelectorAll("[data-metric]").forEach((b) => b.classList.toggle("on", b.dataset.metric === state.me.price_metric));
  $("#member-list").innerHTML = state.users
    .map((u) => `<li>${avatar(u)} <span><b>${esc(u.name)}</b> <small>@${esc(u.id)}${u.is_admin ? " · admin" : ""}</small></span>
      ${u.is_admin ? "" : memberValueHtml(u)}
      ${admin && !u.is_admin ? `<button type="button" class="btn ghost small" data-del-user="${esc(u.id)}">Quitar</button>` : ""}</li>`)
    .join("");
}

async function memberAction(e) {
  const action = e.submitter?.value;
  if (action !== "create" && action !== "password") return;
  e.preventDefault();
  const err = $("#m-error");
  err.hidden = true;
  try {
    if (action === "create") {
      await api("/api/users", { method: "POST", body: JSON.stringify({ username: $("#m-user").value, name: $("#m-name").value, password: $("#m-pass").value }) });
      toast(`Usuario ${$("#m-user").value.trim().toLowerCase()} creado`);
      $("#m-user").value = $("#m-name").value = $("#m-pass").value = "";
      await load();
      render();
    } else {
      await api("/api/me/password", { method: "PUT", body: JSON.stringify({ current: $("#p-cur").value, password: $("#p-new").value }) });
      $("#p-cur").value = $("#p-new").value = "";
      toast("Contraseña cambiada");
    }
    renderMemberList();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
}

function applyPricePrefs() {
  state.priceMetric = state.me.price_metric;
  $("#f-price-metric").value = state.priceMetric;
  $(".price-filter").hidden = !!state.me.hide_prices;
}

// La pokéball sale despedida al centro, se tambalea como al capturar, abre la tapa en 3D
// y de la luz que sale de dentro se despliega el menú.
let menuOpening = false;
const BALL_FLY_MS = 420;
const BALL_WOBBLE_MS = 380;
const BALL_OPEN_MS = 260;

function openMenu() {
  if (menuOpening) return;
  const dlg = $("#dlg-members");
  const show = () => {
    revealedValues.clear();
    renderMemberList();
    $("#m-error").hidden = true;
    dlg.showModal();
  };
  if (reduceMotion.matches) return show();
  menuOpening = true;

  const r = $("#btn-members").getBoundingClientRect();
  const size = Math.round(Math.min(130, window.innerWidth * 0.32));
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const fx = document.createElement("div");
  fx.className = "pb-fx";
  fx.style.setProperty("--s", `${size}px`);
  fx.innerHTML = `<i class="pb-shadow"></i><div class="pb-body"><i class="pb-glow"></i><i class="pb-rays"></i><i class="pb-bottom"></i><i class="pb-mouth"></i>
    <div class="pb-top"><i class="out"></i><i class="in"></i></div><i class="pb-button"></i>${'<i class="pb-spark"></i>'.repeat(10)}</div>`;
  document.body.append(fx);

  const at = (x, y, scale, turn) => `translate(${x - size / 2}px, ${y - size / 2}px) rotate(${turn}deg) scale(${scale})`;
  const startScale = r.width / size;
  const opened = BALL_FLY_MS + BALL_WOBBLE_MS;
  const total = opened + BALL_OPEN_MS + 520;
  const timed = (delay, duration, easing = "ease-out") => ({ delay, duration, easing, fill: "both" });

  // 1. Vuelo en arco hasta el centro girando, y un pequeño rebote al llegar
  fx.animate([
    { transform: at(r.left + r.width / 2, r.top + r.height / 2, startScale, 0) },
    { transform: at((r.left + cx) / 2, Math.min(r.top, cy) - size * 0.4, 0.75, 400), offset: 0.45 },
    { transform: at(cx, cy, 1.08, 720), offset: 0.85 },
    { transform: at(cx, cy, 1, 720) },
  ], timed(0, BALL_FLY_MS, "cubic-bezier(.3, .1, .3, 1)"));
  // 2. Se tambalea dos veces, como cuando atrapa a un Pokémon
  fx.querySelector(".pb-body").animate([
    { rotate: "0deg" }, { rotate: "-16deg", offset: 0.2 }, { rotate: "12deg", offset: 0.5 }, { rotate: "-6deg", offset: 0.75 }, { rotate: "0deg" },
  ], timed(BALL_FLY_MS, BALL_WOBBLE_MS, "ease-in-out"));
  fx.querySelector(".pb-shadow").animate([{ opacity: 0 }, { opacity: 1 }], timed(BALL_FLY_MS * 0.6, 200));
  // El botón se ilumina justo antes de abrirse
  fx.querySelector(".pb-button").animate([
    { boxShadow: "inset 0 0 0 calc(var(--s) * .025) #fff, 0 0 0 0 rgba(255,255,255,0)" },
    { boxShadow: "inset 0 0 0 calc(var(--s) * .025) #fff, 0 0 calc(var(--s) * .18) calc(var(--s) * .06) rgba(255,255,255,.95)" },
  ], timed(opened - 160, 160));
  // 3. La tapa se levanta sobre su bisagra trasera y por la abertura sale la luz de dentro
  fx.querySelector(".pb-top").animate([
    { transform: "translateY(0) rotateX(0deg)" },
    { transform: "translateY(-30%) rotateX(40deg)", offset: 0.7 },
    { transform: "translateY(-24%) rotateX(34deg)" },
  ], timed(opened, BALL_OPEN_MS + 140, "cubic-bezier(.2, .8, .3, 1)"));
  fx.querySelector(".pb-rays").animate([
    { opacity: 0, transform: "scaleY(.2) rotate(-6deg)" },
    { opacity: 0.95, transform: "scaleY(1) rotate(0deg)", offset: 0.4 },
    { opacity: 0, transform: "scaleY(1.25) rotate(5deg)" },
  ], timed(opened + 40, 760));
  fx.querySelector(".pb-mouth").animate([
    { transform: "translateZ(1px) scaleY(0)" }, { transform: "translateZ(1px) scaleY(1)" },
  ], timed(opened, BALL_OPEN_MS, "cubic-bezier(.2, .8, .3, 1)"));
  fx.querySelector(".pb-glow").animate([
    { opacity: 0, transform: "translateZ(-2px) scale(.4)" },
    { opacity: 1, transform: "translateZ(-2px) scale(1.4)", offset: 0.45 },
    { opacity: 0, transform: "translateZ(-2px) scale(3.2)" },
  ], timed(opened + 60, 700));
  // Chispas que salen de la abertura
  fx.querySelectorAll(".pb-spark").forEach((spark, i) => {
    const angle = Math.PI + (Math.PI * (i + 0.5)) / 10; // abanico hacia arriba
    const dist = size * (0.9 + (i % 3) * 0.35);
    spark.animate([
      { opacity: 0, transform: "translateZ(3px) translate(0, 0) scale(.6)" },
      { opacity: 1, transform: `translateZ(3px) translate(${Math.cos(angle) * dist * 0.45}px, ${Math.sin(angle) * dist * 0.45}px) scale(1)`, offset: 0.3 },
      { opacity: 0, transform: `translateZ(3px) translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px) scale(.3)` },
    ], timed(opened + 80 + (i % 4) * 25, 520));
  });

  // 4. El menú se despliega desde la luz: crece en círculo desde la boca de la bola
  setTimeout(() => {
    show();
    dlg.classList.add("emerging");
    const box = dlg.getBoundingClientRect();
    const ox = cx - box.left;
    const oy = cy - box.top;
    const reach = Math.hypot(Math.max(ox, box.width - ox), Math.max(oy, box.height - oy));
    const emerge = dlg.animate([
      { clipPath: `circle(${size * 0.12}px at ${ox}px ${oy}px)`, transform: "scale(.92)", opacity: 0.6 },
      { clipPath: `circle(${reach}px at ${ox}px ${oy}px)`, transform: "scale(1)", opacity: 1 },
    ], { duration: 460, easing: "cubic-bezier(.2, .8, .2, 1)", transformOrigin: `${ox}px ${oy}px` });
    dlg.style.transformOrigin = `${ox}px ${oy}px`;
    emerge.finished.catch(() => {}).finally(() => {
      dlg.classList.remove("emerging");
      dlg.style.transformOrigin = "";
    });
  }, opened + BALL_OPEN_MS * 0.55);

  setTimeout(() => {
    fx.remove();
    menuOpening = false;
  }, total);
}

async function savePricePrefs(change) {
  const before = { price_metric: state.me.price_metric, hide_prices: state.me.hide_prices };
  const apply = (prefs) => {
    Object.assign(state.me, prefs);
    applyPricePrefs();
    render();
    renderMemberList();
  };
  apply({ ...change, hide_prices: change.hide_prices === undefined ? before.hide_prices : change.hide_prices ? 1 : 0 });
  try {
    await api("/api/me/prefs", { method: "PUT", body: JSON.stringify({ price_metric: state.me.price_metric, hide_prices: !!state.me.hide_prices }) });
  } catch (e) {
    apply(before);
    toast(`No se pudo guardar: ${e.message}`);
  }
}

function setupUI() {
  applyPricePrefs();
  $("#btn-members").addEventListener("click", openMenu);
  $("#pref-hide").addEventListener("change", (e) => savePricePrefs({ hide_prices: e.target.checked }));
  $("#pref-metric-row").addEventListener("click", (e) => {
    const b = e.target.closest("[data-metric]");
    if (b) savePricePrefs({ price_metric: b.dataset.metric });
  });
  $("#form-member").addEventListener("submit", memberAction);
  setupAlbum();
  // El navegador a veces rellena solo los campos al recargar: se dejan vacíos para empezar sin filtros
  for (const id of ["q", "f-price-min", "f-price-max"]) $(`#${id}`).value = "";
  $("#f-grade-only").checked = false;
  const syncGrade = () => {
    document.querySelectorAll("[data-grade]").forEach((b) => b.classList.toggle("on", b.dataset.grade === state.grade));
    $(".grade-only").hidden = !state.grade;
    $("#f-price-min").title = state.grade ? `Precio mínimo en PSA ${state.grade}` : "Precio mínimo";
    $("#f-price-max").title = state.grade ? `Precio máximo en PSA ${state.grade}` : "Precio máximo";
    $("#f-price-metric").disabled = !!state.grade;
  };
  document.querySelectorAll("[data-grade]").forEach((b) =>
    b.addEventListener("click", () => {
      state.grade = b.dataset.grade;
      syncGrade();
      render();
    }),
  );
  $("#f-grade-only").addEventListener("change", (e) => { state.gradeOnly = e.target.checked; render(); });
  syncGrade();
  $("#f-price-metric").addEventListener("change", (e) => { state.priceMetric = e.target.value; render(); });
  $("#f-price-min").addEventListener("input", (e) => { state.priceMin = e.target.value; render(); });
  $("#f-price-max").addEventListener("input", (e) => { state.priceMax = e.target.value; render(); });
  $("#me-avatar").addEventListener("click", openAvatarPicker);
  $("#avatar-grid").addEventListener("click", (e) => {
    const b = e.target.closest("[data-avatar]");
    if (b) chooseAvatar(b.dataset.avatar);
  });
  $("#member-list").addEventListener("click", async (e) => {
    const eye = e.target.closest("[data-reveal]");
    if (eye) {
      const id = eye.dataset.reveal;
      if (!revealedValues.delete(id)) revealedValues.add(id);
      renderMemberList();
      $(`#member-list [data-reveal="${CSS.escape(id)}"]`)?.focus();
      return;
    }
    const del = e.target.closest("[data-del-user]");
    if (!del) return;
    if (!del.dataset.confirm) {
      del.dataset.confirm = "1";
      del.textContent = "¿Seguro? Toca otra vez";
      return;
    }
    try {
      await api(`/api/users/${encodeURIComponent(del.dataset.delUser)}`, { method: "DELETE" });
      await load();
      render();
      renderMemberList();
    } catch (ex) {
      toast(ex.message);
    }
  });
  $("#file-pick").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f && uploadTarget) uploadImage(uploadTarget, f);
  });
  $("#img-warning").addEventListener("click", () => { state.owner = "noimage"; state.set = "all"; render(); });

  document.addEventListener("click", (e) => {
    const up = e.target.closest("[data-upload]");
    if (up) { e.preventDefault(); e.stopPropagation(); pickImage(up.dataset.upload); return; }
    const t = e.target.closest("[data-inc],[data-dec],[data-open],[data-toggle],[data-set],[data-user],[data-view],[data-close],[data-lang-inc],[data-lang-dec],[data-rar]");
    if (!t) return;
    const d = t.dataset;
    if (d.langInc) changeLang(d.langCard, d.langInc, 1);
    else if (d.langDec) changeLang(d.langCard, d.langDec, -1);
    else if (d.inc) setQty(d.inc, qty(d.inc, state.me.id) + 1);
    else if (d.dec) setQty(d.dec, qty(d.dec, state.me.id) - 1);
    else if (d.toggle) setQty(d.toggle, qty(d.toggle, state.me.id) ? 0 : 1);
    else if (d.open) { e.preventDefault(); openCard(d.open); }
    else if (d.rar) {
      // Atajo por tipo: activa/desactiva la rareza; si la colección elegida no tiene ese tipo, se pasa a «Todas»
      state.rarity = state.rarity === d.rar ? "" : d.rar;
      if (state.rarity && !cardsInScope().some((c) => c.rarity === state.rarity)) { state.set = "all"; }
      render();
    }
    else if (d.set) { state.set = d.set; render(); }
    else if (d.user) {
      // Desde el bloque de promos: se salta a la colección de promos y se empieza por «lo que tiene»
      const jumpRarity = d.userRarity !== undefined && state.rarity !== d.userRarity;
      if ((d.userSet && state.set !== d.userSet) || jumpRarity) {
        if (d.userSet) state.set = d.userSet;
        if (d.userRarity !== undefined) state.rarity = d.userRarity;
        state.owner = "all";
      }
      const has = `has:${d.user}`;
      state.owner = state.owner === has ? `lacks:${d.user}` : state.owner === `lacks:${d.user}` ? "all" : has;
      if (d.user === state.me.id) state.owner = state.owner.startsWith("has") ? "have" : state.owner.startsWith("lacks") ? "missing" : "all";
      render();
    } else if (d.view) { state.view = d.view; localSet("view", d.view); render(); }
    else if (d.close !== undefined) t.closest("dialog").close();
  });

  $("#q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
  document.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-price-form]");
    if (!f) return;
    e.preventDefault();
    const val = (k) => f.elements[k].value.trim() || null;
    if (!val("trend") && !val("mid")) return toast("Pon al menos un precio");
    saveManualPrice(f.dataset.priceForm, val("trend"), val("mid"));
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-price-clear]");
    if (b) saveManualPrice(b.dataset.priceClear, null, null);
  });
  setupTrades();
  $("#dlg-card").addEventListener("click", (e) => {
    const b = e.target.closest("[data-trade-card]");
    if (b) tradeForCard(b.dataset.tradeCard, b.dataset.tradeUser);
  });
  setupVault();
  $("#btn-spend").addEventListener("click", openSpend);
  $("#spend-body").addEventListener("submit", (e) => {
    const f = e.target.closest("[data-buy-form]");
    if (f) { e.preventDefault(); addPurchase(f); }
  });
  $("#spend-body").addEventListener("click", (e) => {
    const d = e.target.closest("[data-del-purchase]");
    if (d) deletePurchase(Number(d.dataset.delPurchase));
    const ed = e.target.closest("[data-edit-sealed]");
    if (ed) editSealed(Number(ed.dataset.editSealed));
  });
  $("#spend-body").addEventListener("toggle", (e) => {
    const d = e.target.closest("details.prod");
    if (d?.open) spend.open = d.dataset.prod;
  }, true);
  $("#btn-types").addEventListener("click", () => {
    typesOpen = !typesOpen;
    renderSummary();
  });
  $("#f-rarity").addEventListener("change", (e) => { state.rarity = e.target.value; render(); });
  $("#f-owner").addEventListener("change", (e) => { state.owner = e.target.value; render(); });
  $("#dlg-card").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

  $("#btn-logout").addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST" });
    location.href = "/";
  });

  $("#btn-sync").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    toast("Buscando cartas nuevas…");
    try {
      const r = await api("/api/sync", { method: "POST" });
      await load();
      render();
      toast(r.added ? `¡${r.added} cartas nuevas!` : "Todo al día, no hay cartas nuevas");
    } catch (err) {
      toast(`Sincronización fallida: ${err.message}`);
    } finally {
      e.currentTarget.disabled = false;
    }
  });

  const dlg = $("#dlg-add");
  const form = $("#form-add");
  $("#btn-add").addEventListener("click", () => {
    $("#add-set").innerHTML =
      state.sets.map((s) => `<option value="${esc(s.id)}" ${s.id === state.set ? "selected" : ""}>${esc(s.name)}</option>`).join("") +
      `<option value="__new">➕ Nueva colección / producto…</option>`;
    $("#rarities").innerHTML = RARITY_ORDER.map((r) => `<option value="${esc(r)}">`).join("");
    $("#new-set-row").hidden = true;
    $("#add-error").hidden = true;
    form.reset();
    if (state.set !== "all") $("#add-set").value = state.set;
    dlg.showModal();
  });
  $("#add-set").addEventListener("change", (e) => ($("#new-set-row").hidden = e.target.value !== "__new"));
  form.addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const fd = new FormData(form);
    const f = Object.fromEntries(fd);
    try {
      if (!(f.file && f.file.size) && !f.image) throw new Error("La imagen es obligatoria: sube una foto o pega una URL");
      if (f.set_id === "__new") {
        if (!f.new_set) throw new Error("Pon nombre a la colección");
        fd.set("set_id", (await api("/api/sets", { method: "POST", body: JSON.stringify({ name: f.new_set, kind: "promo" }) })).id);
      }
      await api("/api/cards", { method: "POST", body: fd });
      dlg.close();
      await load();
      render();
      toast(`«${f.name}» añadida para todos`);
    } catch (err) {
      $("#add-error").textContent = err.message;
      $("#add-error").hidden = false;
    }
  });
}

boot();
