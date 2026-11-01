const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = {
  me: null,
  sets: [],
  cards: [],
  users: [],
  avatars: [],
  owned: new Map(), // cardId -> Map(userId -> qty)
  view: localGet("view") || "grid",
  set: localGet("set") || "all",
  q: "",
  rarity: "",
  owner: "all",
  priceMetric: "cm_trend",
  priceMin: "",
  priceMax: "",
};

const RARITY_ORDER = ["Común", "Poco común", "Rara", "Rara doble", "Rara Pikachu", "Rara ilustración", "Rara ilustración especial", "Rara futurista", "Rara RGB", "Clásica", "Promo"];

function localGet(k) {
  try { return localStorage.getItem(`p30:${k}`); } catch { return null; }
}
function localSet(k, v) {
  try { localStorage.setItem(`p30:${k}`, v); } catch {}
}

async function api(path, opts = {}) {
  const headers = typeof opts.body === "string" ? { "content-type": "application/json" } : {};
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error("auth"), { status: 401 });
  if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
  return body;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

// ------------------------------------------------------------- carga

async function load() {
  const data = await api("/api/data");
  state.me = data.me;
  state.sets = data.sets;
  state.cards = data.cards;
  state.users = data.users;
  state.avatars = data.avatars;
  state.owned = new Map();
  for (const [u, c, q] of data.owned) {
    if (!state.owned.has(c)) state.owned.set(c, new Map());
    state.owned.get(c).set(u, q);
  }
  if (state.set !== "all" && !state.sets.some((s) => s.id === state.set)) state.set = "all";
}

async function boot() {
  try {
    await load();
  } catch (e) {
    if (e.status === 401) {
      $("#login").hidden = false;
      $("#form-login").addEventListener("submit", login);
      return;
    }
    throw e;
  }
  $("#login").hidden = true;
  $("#app").hidden = false;
  setupUI();
  render();
  // Refresco periódico para ver los cambios de los demás
  setInterval(async () => {
    if (document.hidden || $("dialog[open]")) return;
    try { await load(); render(); } catch {}
  }, 20000);
}

async function login(e) {
  e.preventDefault();
  const err = $("#login-error");
  err.hidden = true;
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: $("#login-user").value, password: $("#login-pass").value }),
  });
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

function pricesHtml(c) {
  if (c.cm_trend == null && c.cm_mid == null) return `<div class="prices none"><span>Sin precio en Cardmarket</span></div>`;
  return `<div class="prices"><span>Trend <b>${price(c.cm_trend)}</b></span><span>Mid <b>${price(c.cm_mid)}</b></span></div>`;
}

function cardsInScope() {
  return state.set === "all" ? state.cards : state.cards.filter((c) => c.set_id === state.set);
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  const me = state.me.id;
  return cardsInScope().filter((c) => {
    if (state.rarity && c.rarity !== state.rarity) return false;
    if (q && !`${c.name} ${c.number} ${c.note || ""} ${c.rarity || ""}`.toLowerCase().includes(q)) return false;
    if (state.priceMin !== "" || state.priceMax !== "") {
      const p = c[state.priceMetric];
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

function renderSummary() {
  const scope = cardsInScope();
  const total = scope.length;
  const anyone = scope.filter((c) => state.owned.get(c.id)?.size).length;
  $("#group-count").textContent = `${anyone} / ${total}`;
  $("#group-bar").style.width = total ? `${(anyone / total) * 100}%` : "0";
  const people = collectors();
  $("#group-sub").textContent = `${total ? Math.round((anyone / total) * 100) : 0}% conseguido por al menos uno · ${people.length} coleccionista${people.length === 1 ? "" : "s"}`;

  $("#members").innerHTML = people
    .map((u) => {
      let have = 0;
      let copies = 0;
      for (const c of scope) {
        const n = qty(c.id, u.id);
        if (n) { have++; copies += n; }
      }
      const pct = total ? Math.round((have / total) * 100) : 0;
      const active = state.owner === `has:${u.id}` || state.owner === `lacks:${u.id}`;
      return `<button class="member ${active ? "active" : ""}" data-user="${esc(u.id)}" style="--c:${esc(u.color)}" title="Ver lo que tiene ${esc(u.name)}">
        ${avatar(u, "lg")}
        <div class="name"><span>${esc(u.name)}${u.id === state.me.id ? " (tú)" : ""}</span><small>${pct}%</small></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="stats"><span>${have} / ${total} distintas</span><span>${copies - have > 0 ? `${copies - have} repe${copies - have === 1 ? "" : "s"}` : ""}</span></div>
      </button>`;
    })
    .join("");
}

function renderSets() {
  const chips = [{ id: "all", name: "Todas", n: state.cards.length }].concat(
    state.sets.map((s) => ({ id: s.id, name: s.name, n: state.cards.filter((c) => c.set_id === s.id).length })),
  );
  $("#sets").innerHTML = chips
    .map((s) => `<button class="chip ${state.set === s.id ? "on" : ""}" data-set="${esc(s.id)}" role="tab">${esc(s.name)}<b>${s.n}</b></button>`)
    .join("");
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
        <button class="art ${c.image_status === "missing" || brokenImages.has(c.id) ? "noimg" : ""}" data-open="${esc(c.id)}" aria-label="Ver ${esc(c.name)}">${artHtml(c)}<span class="numtag">${esc(displayNumber(c))}</span></button>
        <div class="meta"><strong>${esc(c.name)}</strong><span class="rar" data-r="${esc(c.rarity)}">${esc(c.rarity || "—")}</span></div>
        ${pricesHtml(c)}
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
  const head = `<thead><tr><th>Nº</th><th>Carta</th><th>Rareza</th><th>Trend</th><th>Mid</th>${users
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
      return `<tr><td class="n">${esc(displayNumber(c))}</td><td><a href="#" data-open="${esc(c.id)}">${esc(c.name)}</a></td><td><span class="rar" data-r="${esc(c.rarity)}">${esc(c.rarity || "—")}</span></td><td class="price">${price(c.cm_trend)}</td><td class="price">${price(c.cm_mid)}</td>${cells}</tr>`;
    })
    .join("");
  const foot = `<tfoot><tr><td colspan="5" style="text-align:left">Total en esta vista</td>${users
    .map((u) => `<td>${list.filter((c) => qty(c.id, u.id)).length}</td>`)
    .join("")}</tr></tfoot>`;
  $("#table").innerHTML = head + `<tbody>${body}</tbody>` + foot;
}

function openCard(id) {
  const c = state.cards.find((x) => x.id === id);
  if (!c) return;
  const set = setById(c.set_id);
  const owners = state.owned.get(c.id);
  const dlg = $("#dlg-card");
  dlg.innerHTML = `<button class="btn ghost small close" data-close>✕</button>
    <div class="cd">
      <div class="art ${c.image_status === "missing" || brokenImages.has(c.id) ? "noimg" : ""}">${artHtml(c)}</div>
      <div>
        <h2>${esc(c.name)}</h2>
        <span class="rar" data-r="${esc(c.rarity)}">${esc(c.rarity || "—")}</span>
        <dl>
          <dt>Colección</dt><dd>${esc(set?.name)}</dd>
          <dt>Número</dt><dd>${esc(displayNumber(c))}</dd>
          ${c.note ? `<dt>Detalles</dt><dd>${esc(c.note)}</dd>` : ""}
          ${c.source === "manual" ? `<dt>Origen</dt><dd>Añadida por el grupo</dd>` : ""}
          <dt>Trend</dt><dd>${price(c.cm_trend)}</dd>
          <dt>Mid</dt><dd>${price(c.cm_mid)}</dd>
          ${c.cm_updated ? `<dt>Cardmarket</dt><dd>Actualizado el ${esc(new Date(c.cm_updated).toLocaleDateString("es-ES"))}</dd>` : ""}
        </dl>
        <strong>Quién la tiene</strong>
        <div class="who">${
          owners?.size
            ? state.users.filter((u) => owners.has(u.id)).map((u) => `<div>${avatar(u)} ${esc(u.name)} · ${owners.get(u.id)} copia${owners.get(u.id) > 1 ? "s" : ""}</div>`).join("")
            : `<span class="none" style="color:var(--muted)">Nadie todavía</span>`
        }</div>
        ${state.me.is_admin ? "" : `<div class="stepper" style="max-width:220px">
          <button data-dec="${esc(c.id)}">−</button><span>Tengo <b>${qty(c.id, state.me.id)}</b></span><button class="add" data-inc="${esc(c.id)}">+</button>
        </div>`}
        <button class="btn ghost small" data-upload="${esc(c.id)}" style="margin-top:14px">📷 Cambiar imagen</button>
      </div>
    </div>`;
  if (!dlg.open) dlg.showModal();
}

// ------------------------------------------------------------- acciones

async function setQty(cardId, n) {
  n = Math.max(0, n);
  const me = state.me.id;
  const prev = qty(cardId, me);
  const apply = (v) => {
    if (!state.owned.has(cardId)) state.owned.set(cardId, new Map());
    if (v) state.owned.get(cardId).set(me, v);
    else state.owned.get(cardId).delete(me);
  };
  apply(n);
  render();
  if ($("#dlg-card").open) openCard(cardId);
  try {
    await api(`/api/collection/${encodeURIComponent(cardId)}`, { method: "PUT", body: JSON.stringify({ qty: n }) });
  } catch (e) {
    apply(prev);
    render();
    toast(`No se pudo guardar: ${e.message}`);
  }
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
const album = { owner: "", set: "all", pages: [], leaves: 0, flipped: 0, side: "right", rx: 10, ry: 0, drag: null };

function albumQty(cardId) {
  return album.owner === "__group" ? state.owned.get(cardId)?.size || 0 : qty(cardId, album.owner);
}

function albumCards() {
  return state.sets.filter((s) => album.set === "all" || s.id === album.set).flatMap((s) => state.cards.filter((c) => c.set_id === s.id));
}

// Portada, interior, una hoja de fundas por cada 9 cartas en orden, guarda y contraportada
function albumPages() {
  const pages = [{ kind: "cover" }, { kind: "inside" }];
  let number = 0;
  for (const set of state.sets) {
    if (album.set !== "all" && set.id !== album.set) continue;
    const cards = state.cards.filter((c) => c.set_id === set.id);
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
  if (!n) return `<button type="button" class="slot empty" ${open} aria-label="Falta ${esc(c.name)}"><span class="no">${esc(displayNumber(c))}</span><span class="nm">${esc(c.name)}</span></button>`;
  const img = c.image_status === "missing" || brokenImages.has(c.id) ? "" : `<img src="${esc(imgUrl(c))}" alt="" data-id="${esc(c.id)}" onerror="p30ImgError(this)">`;
  const copies = n > 1 && album.owner !== "__group" ? `<sup>×${n}</sup>` : "";
  return `<button type="button" class="slot has" ${open} aria-label="${esc(c.name)}"><span class="nm">${esc(c.name)}</span>${img}${copies}</button>`;
}

function albumPageHtml(page) {
  const cards = albumCards();
  const have = cards.filter((c) => albumQty(c.id)).length;
  const pct = cards.length ? Math.round((have / cards.length) * 100) : 0;
  const setName = album.set === "all" ? "Todas las colecciones" : setById(album.set)?.name;
  switch (page.kind) {
    case "cover":
      return `<div class="badge30 big"><span>30</span></div><h2>Pokémon 30</h2><p>${esc(setName)}</p><p class="owner">${esc(albumOwnerName())}</p>`;
    case "inside":
      return `<p>Álbum de ${esc(albumOwnerName())}</p><strong>${have} / ${cards.length}</strong><div class="bar"><i style="width:${pct}%"></i></div><p>${pct}% completado · faltan ${cards.length - have}</p>`;
    case "pockets":
      return `<div class="album-pockets">${page.cards.map(pocketHtml).join("")}</div><div class="album-foot"><span>${esc(page.set.name)}</span><span>${page.number}</span></div>`;
    case "back":
      return `<div class="badge30"><span>30</span></div>`;
    default:
      return "";
  }
}

function fillAlbumFace(face) {
  const page = album.pages[Number(face.dataset.page)];
  face.classList.toggle("album-cover", page.kind === "cover" || page.kind === "back");
  face.classList.toggle("album-inside", page.kind === "inside");
  face.innerHTML = albumPageHtml(page);
  face.dataset.filled = "1";
}

function buildAlbum() {
  album.pages = albumPages();
  album.leaves = album.pages.length / 2;
  album.flipped = Math.min(album.flipped, album.leaves);
  let html = `<div class="album-block left"></div><div class="album-block right"></div>`;
  for (let i = 0; i < album.leaves; i++) {
    html += `<div class="album-leaf" data-leaf="${i}"><div class="album-face front" data-page="${i * 2}"></div><div class="album-face back" data-page="${i * 2 + 1}"></div></div>`;
  }
  $("#album-book").innerHTML = html;
  $("#album-range").max = album.leaves;
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

function updateAlbumBook() {
  let x = 0;
  if (albumNarrow.matches) x = album.side === "left" ? 25 : -25;
  else if (album.flipped === 0) x = -25;
  else if (album.flipped === album.leaves) x = 25;
  $("#album-book").style.transform = `translateX(${x}%) rotateX(${album.rx}deg) rotateY(${album.ry}deg)`;
}

function updateAlbum() {
  const { flipped, leaves } = album;
  document.querySelectorAll("#album-book .album-leaf").forEach((leaf) => {
    const i = Number(leaf.dataset.leaf);
    leaf.classList.remove("dragging");
    leaf.style.transform = albumLeafTransform(i);
    // Solo se pintan las hojas cercanas: así no se piden las 209 imágenes de golpe
    const near = i >= flipped - 2 && i <= flipped + 1;
    leaf.style.display = near ? "" : "none";
    if (near) leaf.querySelectorAll('.album-face:not([data-filled="1"])').forEach(fillAlbumFace);
  });
  $("#album-book .album-block.left").style.display = flipped > 0 ? "" : "none";
  $("#album-book .album-block.right").style.display = flipped < leaves ? "" : "none";
  updateAlbumBook();
  $("#album-range").value = flipped;
  $("#album-prev").disabled = flipped === 0;
  $("#album-next").disabled = flipped === leaves;
  const numbers = [album.pages[flipped * 2 - 1], album.pages[flipped * 2]].filter((p) => p?.kind === "pockets").map((p) => p.number);
  const total = album.pages.filter((p) => p.kind === "pockets").length;
  $("#album-pos").textContent = numbers.length ? `Pág. ${numbers.join("–")} de ${total}` : flipped === 0 ? "Portada" : flipped === leaves ? "Contraportada" : "Interior";
}

function albumStep(dir) {
  const narrow = albumNarrow.matches;
  if (dir > 0) {
    if (narrow && album.side === "left" && album.flipped < album.leaves) album.side = "right";
    else if (album.flipped < album.leaves) { album.flipped++; album.side = "left"; }
  } else if (narrow && album.side === "right" && album.flipped > 0) album.side = "left";
  else if (album.flipped > 0) { album.flipped--; album.side = album.flipped === 0 ? "right" : narrow ? "right" : album.side; }
  updateAlbum();
}

// Hoja que se mueve al pasar en esa dirección; null si en móvil basta con desplazar el libro
function albumDragLeaf(dir) {
  if (albumNarrow.matches && (dir > 0 ? album.side !== "right" : album.side !== "left")) return null;
  const i = dir > 0 ? album.flipped : album.flipped - 1;
  return i >= 0 && i < album.leaves ? $(`#album-book .album-leaf[data-leaf="${i}"]`) : null;
}

function setupAlbum() {
  const stage = $("#album-stage");
  const openAlbum = () => {
    album.owner = state.me.is_admin ? "__group" : state.me.id;
    album.set = state.set;
    album.flipped = 0;
    album.side = "right";
    album.rx = albumNarrow.matches ? 4 : 10;
    album.ry = 0;
    $("#album-owner").innerHTML =
      (state.me.is_admin ? "" : `<option value="${esc(state.me.id)}">Mi álbum</option>`) +
      `<option value="__group">Entre todos</option>` +
      collectors().filter((u) => u.id !== state.me.id).map((u) => `<option value="${esc(u.id)}">Álbum de ${esc(u.name)}</option>`).join("");
    $("#album-set").innerHTML = `<option value="all">Todas las colecciones</option>` + state.sets.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
    $("#album-owner").value = album.owner;
    $("#album-set").value = album.set;
    $("#dlg-album").showModal();
    buildAlbum();
  };
  $("#btn-album").addEventListener("click", openAlbum);
  $("#album-owner").addEventListener("change", (e) => { album.owner = e.target.value; buildAlbum(); });
  $("#album-set").addEventListener("change", (e) => { album.set = e.target.value; album.flipped = 0; album.side = "right"; buildAlbum(); });
  $("#album-prev").addEventListener("click", () => albumStep(-1));
  $("#album-next").addEventListener("click", () => albumStep(1));
  $("#album-range").addEventListener("input", (e) => {
    album.flipped = Number(e.target.value);
    album.side = album.flipped === 0 ? "right" : album.flipped === album.leaves ? "left" : albumNarrow.matches ? "right" : album.side;
    updateAlbum();
  });
  $("#dlg-album").addEventListener("keydown", (e) => {
    if (/^(SELECT|INPUT)$/.test(e.target.tagName) || $("#dlg-card").open) return;
    if (e.key === "ArrowRight") albumStep(1);
    else if (e.key === "ArrowLeft") albumStep(-1);
  });
  albumNarrow.addEventListener("change", () => { if ($("#dlg-album").open) updateAlbum(); });

  stage.addEventListener("dblclick", () => {
    album.rx = albumNarrow.matches ? 4 : 10;
    album.ry = 0;
    updateAlbumBook();
  });
  stage.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    album.drag = { x: e.clientX, y: e.clientY, onPage: !!e.target.closest(".album-face"), mode: null, rx: album.rx, ry: album.ry, t: 0 };
  });
  stage.addEventListener("pointermove", (e) => {
    const d = album.drag;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.mode) {
      if (Math.hypot(dx, dy) < 8) return; // por debajo de esto es un clic en la carta
      stage.setPointerCapture(e.pointerId);
      stage.classList.add("grabbing");
      d.mode = d.onPage && Math.abs(dx) > Math.abs(dy) ? "flip" : "orbit";
      if (d.mode === "flip") {
        d.dir = dx < 0 ? 1 : -1;
        d.leaf = albumDragLeaf(d.dir);
        d.leaf?.classList.add("dragging");
      } else $("#album-book").classList.add("orbiting");
    }
    if (d.mode === "orbit") {
      album.ry = Math.max(-40, Math.min(40, d.ry + dx * 0.25));
      album.rx = Math.max(-25, Math.min(40, d.rx - dy * 0.25));
      updateAlbumBook();
    } else {
      const width = $("#album-book").offsetWidth / 2;
      d.t = Math.max(0, Math.min(1, (-dx * d.dir) / width));
      if (d.leaf) d.leaf.style.transform = `rotateY(${d.dir > 0 ? -180 * d.t : -180 + 180 * d.t}deg) translateZ(1px)`;
    }
  });
  const endDrag = (e) => {
    const d = album.drag;
    album.drag = null;
    if (!d?.mode) return;
    stage.classList.remove("grabbing");
    $("#album-book").classList.remove("orbiting");
    if (d.mode !== "flip") return;
    if (e.type !== "pointercancel" && d.t > 0.25) albumStep(d.dir);
    else updateAlbum();
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

function renderMemberList() {
  const admin = !!state.me.is_admin;
  $("#new-member").hidden = !admin;
  $("#member-list").innerHTML = state.users
    .map((u) => `<li>${avatar(u)} <span><b>${esc(u.name)}</b> <small>@${esc(u.id)}${u.is_admin ? " · admin" : ""}</small></span>
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

function setupUI() {
  $("#btn-members").addEventListener("click", () => { renderMemberList(); $("#m-error").hidden = true; $("#dlg-members").showModal(); });
  $("#form-member").addEventListener("submit", memberAction);
  setupAlbum();
  $("#f-price-metric").addEventListener("change", (e) => { state.priceMetric = e.target.value; render(); });
  $("#f-price-min").addEventListener("input", (e) => { state.priceMin = e.target.value; render(); });
  $("#f-price-max").addEventListener("input", (e) => { state.priceMax = e.target.value; render(); });
  $("#me-avatar").addEventListener("click", openAvatarPicker);
  $("#avatar-grid").addEventListener("click", (e) => {
    const b = e.target.closest("[data-avatar]");
    if (b) chooseAvatar(b.dataset.avatar);
  });
  $("#member-list").addEventListener("click", async (e) => {
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
    const t = e.target.closest("[data-inc],[data-dec],[data-open],[data-toggle],[data-set],[data-user],[data-view],[data-close]");
    if (!t) return;
    const d = t.dataset;
    if (d.inc) setQty(d.inc, qty(d.inc, state.me.id) + 1);
    else if (d.dec) setQty(d.dec, qty(d.dec, state.me.id) - 1);
    else if (d.toggle) setQty(d.toggle, qty(d.toggle, state.me.id) ? 0 : 1);
    else if (d.open) { e.preventDefault(); openCard(d.open); }
    else if (d.set) { state.set = d.set; localSet("set", d.set); render(); }
    else if (d.user) {
      const has = `has:${d.user}`;
      state.owner = state.owner === has ? `lacks:${d.user}` : state.owner === `lacks:${d.user}` ? "all" : has;
      if (d.user === state.me.id) state.owner = state.owner.startsWith("has") ? "have" : state.owner.startsWith("lacks") ? "missing" : "all";
      render();
    } else if (d.view) { state.view = d.view; localSet("view", d.view); render(); }
    else if (d.close !== undefined) t.closest("dialog").close();
  });

  $("#q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
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
