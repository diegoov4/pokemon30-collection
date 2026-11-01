const CATALOG = /*CATALOG*/null;

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#f97316", "#14b8a6", "#ec4899", "#64748b", "#84cc16"];
const RARITY_ORDER = ["Común", "Poco común", "Rara", "Rara doble", "Rara Pikachu", "Rara ilustración", "Rara ilustración especial", "Rara futurista", "Rara RGB", "Clásica", "Promo"];

// Los ids de documento solo admiten letras, dígitos y _ - . ~ : @ +
const keyOf = (id) => id.replace(/[^A-Za-z0-9_.~:@+-]/g, "_");

const state = {
  me: null, // username
  accounts: new Map(), // username -> {name, pass, color, admin}
  owned: new Map(), // username -> {cardKey: qty}
  images: new Map(), // cardKey -> assetId
  extras: [], // cartas añadidas por el grupo
  extraSets: [],
  view: lsGet("view") || "grid",
  set: lsGet("set") || "all",
  q: "",
  rarity: "",
  owner: "all",
  canWrite: true,
};
let db = null;
let assets = null;

function lsGet(k) { try { return localStorage.getItem(`p30:${k}`); } catch { return null; } }
function lsSet(k, v) { try { v === null ? localStorage.removeItem(`p30:${k}`) : localStorage.setItem(`p30:${k}`, v); } catch {} }

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2800);
}

async function hashPass(user, pass) {
  const data = new TextEncoder().encode(`pokemon30:${user}:${pass}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------- datos

const allSets = () => CATALOG.sets.concat(state.extraSets.filter((s) => !CATALOG.sets.some((c) => c.id === s.id)));
const allCards = () => CATALOG.cards.concat(state.extras);
const users = () =>
  [...state.accounts.entries()]
    .map(([id, a]) => ({ id, ...a }))
    .sort((a, b) => (b.admin ? 1 : 0) - (a.admin ? 1 : 0) || (a.created || 0) - (b.created || 0));

function qty(card, userId) {
  return state.owned.get(userId)?.[keyOf(card.id)] || 0;
}
function owners(card) {
  return users().filter((u) => qty(card, u.id) > 0);
}
function imageId(card) {
  return state.images.get(keyOf(card.id)) || card.asset || null;
}

async function connect() {
  try {
    db = await claude.use("db");
  } catch {
    db = null;
  }
  if (!db) {
    $("#login-btn").textContent = "No disponible";
    showLoginError("Abre esta página en claude.ai con tu cuenta iniciada para poder entrar.");
    return;
  }
  claude.use("assets").then((a) => { assets = a; if (state.me) render(); }).catch(() => {});

  let first = true;
  db.collection("accounts").onSnapshot((snap) => {
    state.accounts = new Map(snap.docs.map((d) => [d.id, d.data()]));
    if (first) {
      first = false;
      $("#login-btn").disabled = false;
      $("#login-btn").textContent = "Entrar";
      const saved = lsGet("user");
      if (saved && state.accounts.has(saved)) enter(saved);
    }
    if (state.me && !state.accounts.has(state.me)) logout();
    if (state.me) render();
  }, dbError);
  db.collection("owned").onSnapshot((snap) => {
    for (const d of snap.docs) {
      // Mientras tengo cambios sin guardar, mi propia colección manda en local
      if (d.id === state.me && dirty) continue;
      state.owned.set(d.id, { ...(d.data().cards || {}) });
    }
    if (state.me) render();
  }, dbError);
  db.collection("images").onSnapshot((snap) => {
    state.images = new Map(snap.docs.map((d) => [d.id, d.data().asset]));
    if (state.me) render();
  }, dbError);
  db.collection("extra").onSnapshot((snap) => {
    state.extras = snap.docs.map((d) => d.data()).filter((c) => c.type !== "set");
    state.extraSets = snap.docs.map((d) => d.data()).filter((c) => c.type === "set");
    if (state.me) render();
  }, dbError);
}

function dbError(e) {
  console.warn("db", e);
  if (e?.code === "revoked") toast("Se ha perdido el acceso a los datos. Recarga la página.");
}

// Guardado de mi colección: una escritura cada vez, agrupando clics seguidos
let dirty = false;
let saving = Promise.resolve();
let saveTimer = null;
function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}
function flushSave() {
  saveTimer = null;
  const me = state.me;
  const cards = { ...(state.owned.get(me) || {}) };
  saving = saving
    .then(() => db.doc(`owned/${me}`).set({ cards, at: Date.now() }))
    .catch((e) => {
      if (e?.code === "invalid_argument") {
        state.canWrite = false;
        render();
        toast("Tu acceso a esta página es de solo lectura: no se pueden guardar cambios.");
      } else toast("No se pudo guardar. Revisa la conexión.");
    })
    .finally(() => { if (!saveTimer) dirty = false; });
}

// ------------------------------------------------------------- login

function showLoginError(msg) {
  $("#login-error").textContent = msg;
  $("#login-error").hidden = false;
}

async function login(e) {
  e.preventDefault();
  const user = $("#login-user").value.trim().toLowerCase();
  const pass = $("#login-pass").value;
  const acc = state.accounts.get(user);
  if (!acc || acc.pass !== (await hashPass(user, pass))) {
    showLoginError("Usuario o contraseña incorrectos.");
    return;
  }
  $("#login-error").hidden = true;
  $("#login-pass").value = "";
  lsSet("user", user);
  enter(user);
}

function enter(user) {
  state.me = user;
  $("#login").hidden = true;
  $("#app").hidden = false;
  render();
}

function logout() {
  lsSet("user", null);
  state.me = null;
  $("#app").hidden = true;
  $("#login").hidden = false;
}

// ------------------------------------------------------------- render

function avatar(u, cls = "") {
  return `<span class="avatar ${cls}" style="--c:${esc(u.color)}" title="${esc(u.name)}">${esc((u.name || "?").trim().charAt(0).toUpperCase())}</span>`;
}

function setById(id) {
  return allSets().find((s) => s.id === id);
}

function displayNumber(c) {
  const set = setById(c.set);
  if (/^\d+$/.test(c.number) && set?.official && set.kind === "expansion") return `${c.number}/${String(set.official).padStart(3, "0")}`;
  return c.number;
}

function cardsInScope() {
  return state.set === "all" ? allCards() : allCards().filter((c) => c.set === state.set);
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  const me = state.me;
  return cardsInScope()
    .filter((c) => {
      if (state.rarity && c.rarity !== state.rarity) return false;
      if (q && !`${c.name} ${c.number} ${c.note || ""} ${c.rarity || ""}`.toLowerCase().includes(q)) return false;
      const mine = qty(c, me);
      const n = owners(c).length;
      switch (state.owner) {
        case "missing": return !mine;
        case "have": return mine > 0;
        case "dupes": return mine > 1;
        case "nobody": return n === 0;
        case "trade": return !mine && n > 0;
        case "noimage": return !imageId(c);
        default:
          if (state.owner.startsWith("has:")) return qty(c, state.owner.slice(4)) > 0;
          if (state.owner.startsWith("lacks:")) return !qty(c, state.owner.slice(6));
          return true;
      }
    });
}

function render() {
  const me = state.accounts.get(state.me);
  if (!me) return;
  $("#me-avatar").innerHTML = avatar({ ...me, id: state.me });
  $("#btn-members").hidden = !me.admin;
  $("#btn-add").hidden = !assets || !state.canWrite;
  $("#readonly-note").hidden = state.canWrite;
  $("#readonly-note").textContent = "Solo lectura: tu acceso a esta página no permite guardar cambios.";
  renderSummary();
  renderSets();
  renderFilters();
  const n = allCards().filter((c) => !imageId(c)).length;
  $("#img-warning").hidden = n === 0;
  $("#img-warning").textContent = assets
    ? `${n} carta${n === 1 ? "" : "s"} sin imagen · toca para verlas y subir la foto`
    : `${n} carta${n === 1 ? "" : "s"} sin imagen`;
  const list = filtered();
  $("#result-count").textContent = `${list.length} carta${list.length === 1 ? "" : "s"}`;
  $("#grid").hidden = state.view !== "grid";
  $("#table-wrap").hidden = state.view !== "table";
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
  if (state.view === "grid") renderGrid(list);
  else renderTable(list);
  if ($("#dlg-card").open) openCard($("#dlg-card").dataset.id, true);
}

function renderSummary() {
  const scope = cardsInScope();
  const total = scope.length;
  const anyone = scope.filter((c) => owners(c).length).length;
  const us = users();
  $("#group-count").textContent = `${anyone} / ${total}`;
  $("#group-bar").style.width = total ? `${(anyone / total) * 100}%` : "0";
  $("#group-sub").textContent = `${total ? Math.round((anyone / total) * 100) : 0}% conseguido por al menos uno · ${us.length} coleccionista${us.length === 1 ? "" : "s"}`;
  $("#members").innerHTML = us
    .map((u) => {
      let have = 0;
      let copies = 0;
      for (const c of scope) {
        const n = qty(c, u.id);
        if (n) { have++; copies += n; }
      }
      const pct = total ? Math.round((have / total) * 100) : 0;
      const active = state.owner === `has:${u.id}` || state.owner === `lacks:${u.id}`;
      return `<button class="member ${active ? "active" : ""}" data-user="${esc(u.id)}" style="--c:${esc(u.color)}">
        ${avatar(u, "lg")}
        <div class="name"><span>${esc(u.name)}${u.id === state.me ? " (tú)" : ""}</span><small>${pct}%</small></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="stats"><span>${have} / ${total} distintas</span><span>${copies - have > 0 ? `${copies - have} repe${copies - have === 1 ? "" : "s"}` : ""}</span></div>
      </button>`;
    })
    .join("");
}

function renderSets() {
  const cards = allCards();
  const chips = [{ id: "all", name: "Todas", n: cards.length }].concat(
    allSets().map((s) => ({ id: s.id, name: s.name, n: cards.filter((c) => c.set === s.id).length })),
  );
  if (!chips.some((c) => c.id === state.set)) state.set = "all";
  $("#sets").innerHTML = chips
    .map((s) => `<button class="chip ${state.set === s.id ? "on" : ""}" data-set="${esc(s.id)}" role="tab">${esc(s.name)}<b>${s.n}</b></button>`)
    .join("");
}

function renderFilters() {
  const rarities = [...new Set(cardsInScope().map((c) => c.rarity).filter(Boolean))].sort(
    (a, b) => ((RARITY_ORDER.indexOf(a) + 99) % 99) - ((RARITY_ORDER.indexOf(b) + 99) % 99),
  );
  if (state.rarity && !rarities.includes(state.rarity)) state.rarity = "";
  $("#f-rarity").innerHTML = `<option value="">Todas las rarezas</option>` + rarities.map((r) => `<option ${r === state.rarity ? "selected" : ""}>${esc(r)}</option>`).join("");
  const opts = [
    ["all", "Todas las cartas"],
    ["missing", "Me faltan"],
    ["have", "Las tengo"],
    ["dupes", "Mis repetidas"],
    ["trade", "Las tiene alguien y yo no"],
    ["nobody", "No las tiene nadie"],
    ["noimage", "Sin imagen"],
  ];
  for (const u of users()) {
    if (u.id === state.me) continue;
    opts.push([`has:${u.id}`, `Las tiene ${u.name}`], [`lacks:${u.id}`, `Le faltan a ${u.name}`]);
  }
  $("#f-owner").innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}" ${v === state.owner ? "selected" : ""}>${esc(l)}</option>`).join("");
}

function artHtml(c) {
  const id = imageId(c);
  const ph = `<div class="ph" data-r="${esc(c.rarity)}"><span class="nm">${esc(c.name)}</span><span class="rr">${esc(c.rarity || "")}</span></div>`;
  const up = assets && state.canWrite ? `<span class="upload" data-upload="${esc(c.id)}" role="button" tabindex="0">📷 Falta la imagen · Subir</span>` : `<span class="upload ro">Sin imagen</span>`;
  if (!id) return ph + up;
  return `${ph}<img src="/_blob/${esc(id)}" alt="${esc(c.name)}" loading="lazy" onerror="this.parentNode.classList.add('noimg');this.remove()">${up}`;
}

function ownersHtml(c) {
  const os = owners(c);
  if (!os.length) return `<span class="none">Nadie la tiene aún</span>`;
  return os
    .map((u) => {
      const n = qty(c, u.id);
      return `<span class="avatar" style="--c:${esc(u.color)}" title="${esc(u.name)}: ${n}">${esc(u.name.charAt(0).toUpperCase())}${n > 1 ? `<sup>×${n}</sup>` : ""}</span>`;
    })
    .join("");
}

function renderGrid(list) {
  const me = state.accounts.get(state.me);
  $("#grid").innerHTML = list
    .map((c) => {
      const mine = qty(c, state.me);
      const ro = !state.canWrite;
      return `<article class="card ${mine ? "mine" : ""}" style="--c:${esc(me.color)}">
        <button class="art ${imageId(c) ? "" : "noimg"}" data-open="${esc(c.id)}" aria-label="Ver ${esc(c.name)}">${artHtml(c)}<span class="numtag">${esc(displayNumber(c))}</span></button>
        <div class="meta"><strong>${esc(c.name)}</strong><span class="rar" data-r="${esc(c.rarity)}">${esc(c.rarity || "—")}</span></div>
        <div class="owners">${ownersHtml(c)}</div>
        <div class="stepper">
          <button data-dec="${esc(c.id)}" aria-label="Quitar una" ${mine && !ro ? "" : "disabled style=visibility:hidden"}>−</button>
          <span>${mine ? `Tengo <b>${mine}</b>` : "No la tengo"}</span>
          <button class="add" data-inc="${esc(c.id)}" aria-label="Añadir una" ${ro ? "disabled style=visibility:hidden" : ""}>+</button>
        </div>
      </article>`;
    })
    .join("");
}

function renderTable(list) {
  const us = users();
  const head = `<thead><tr><th>Nº</th><th>Carta</th><th>Rareza</th>${us.map((u) => `<th class="u">${avatar(u)}${esc(u.name.split(" ")[0])}</th>`).join("")}</tr></thead>`;
  const body = list
    .map((c) => {
      const cells = us
        .map((u) => {
          const n = qty(c, u.id);
          const isMe = u.id === state.me && state.canWrite;
          return `<td class="q ${isMe ? "meq" : ""}" ${isMe ? `data-toggle="${esc(c.id)}"` : ""}>${n ? `<span class="dot" style="--c:${esc(u.color)}">${n > 1 ? n : "✓"}</span>` : `<span class="no">·</span>`}</td>`;
        })
        .join("");
      return `<tr><td class="n">${esc(displayNumber(c))}</td><td><a href="#" data-open="${esc(c.id)}">${esc(c.name)}</a></td><td><span class="rar" data-r="${esc(c.rarity)}">${esc(c.rarity || "—")}</span></td>${cells}</tr>`;
    })
    .join("");
  const foot = `<tfoot><tr><td colspan="3" style="text-align:left">Total en esta vista</td>${us.map((u) => `<td>${list.filter((c) => qty(c, u.id)).length}</td>`).join("")}</tr></tfoot>`;
  $("#table").innerHTML = head + `<tbody>${body}</tbody>` + foot;
}

function openCard(id, refresh = false) {
  const c = allCards().find((x) => x.id === id);
  const dlg = $("#dlg-card");
  if (!c) { if (dlg.open) dlg.close(); return; }
  const set = setById(c.set);
  const os = owners(c);
  dlg.dataset.id = id;
  dlg.innerHTML = `<button class="btn ghost small close" data-close>✕</button>
    <div class="cd">
      <div class="art ${imageId(c) ? "" : "noimg"}">${artHtml(c)}</div>
      <div>
        <h2>${esc(c.name)}</h2>
        <span class="rar" data-r="${esc(c.rarity)}">${esc(c.rarity || "—")}</span>
        <dl>
          <dt>Colección</dt><dd>${esc(set?.name)}</dd>
          <dt>Número</dt><dd>${esc(displayNumber(c))}</dd>
          ${c.note ? `<dt>Detalles</dt><dd>${esc(c.note)}</dd>` : ""}
          ${c.by ? `<dt>Origen</dt><dd>Añadida por el grupo</dd>` : ""}
        </dl>
        <strong>Quién la tiene</strong>
        <div class="who">${
          os.length ? os.map((u) => `<div>${avatar(u)} ${esc(u.name)} · ${qty(c, u.id)} copia${qty(c, u.id) > 1 ? "s" : ""}</div>`).join("") : `<span style="color:var(--muted)">Nadie todavía</span>`
        }</div>
        ${state.canWrite ? `<div class="stepper" style="max-width:220px">
          <button data-dec="${esc(c.id)}">−</button><span>Tengo <b>${qty(c, state.me)}</b></span><button class="add" data-inc="${esc(c.id)}">+</button>
        </div>` : ""}
        ${assets && state.canWrite ? `<button class="btn ghost small" data-upload="${esc(c.id)}" style="margin-top:14px">📷 ${imageId(c) ? "Cambiar imagen" : "Subir imagen"}</button>` : ""}
      </div>
    </div>`;
  if (!refresh && !dlg.open) dlg.showModal();
}

// ------------------------------------------------------------- acciones

function setQty(cardId, n) {
  if (!state.canWrite) return;
  const c = allCards().find((x) => x.id === cardId);
  if (!c) return;
  const mine = { ...(state.owned.get(state.me) || {}) };
  const k = keyOf(c.id);
  n = Math.max(0, Math.min(99, n));
  if (n) mine[k] = n;
  else delete mine[k];
  state.owned.set(state.me, mine);
  render();
  scheduleSave();
}

async function uploadFile(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("La imagen tiene que ser JPG, PNG o WebP.");
  if (file.size > 15 * 1024 * 1024) throw new Error("La imagen pesa más de 15 MB.");
  try {
    return (await assets.upload(file)).id;
  } catch (e) {
    const msgs = { too_large: "La imagen es demasiado grande.", unsupported_type: "Ese formato de imagen no vale.", quota_or_state: "No queda espacio para más imágenes.", rate_limited: "Demasiadas subidas seguidas, espera un momento." };
    throw new Error(msgs[e?.code] || "No se pudo subir la imagen. Inténtalo de nuevo.");
  }
}

let uploadTarget = null;
async function uploadImage(cardId, file) {
  const c = allCards().find((x) => x.id === cardId);
  if (!c) return;
  toast("Subiendo imagen…");
  try {
    const id = await uploadFile(file);
    if (c.by) await db.doc(`extra/${keyOf(c.id)}`).update({ asset: id });
    await db.doc(`images/${keyOf(c.id)}`).set({ asset: id, by: state.me, at: Date.now() });
    toast("Imagen guardada para todos");
  } catch (e) {
    toast(e.message);
  }
}

async function addCard(e) {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  const err = $("#add-error");
  err.hidden = true;
  const btn = e.submitter;
  try {
    let set = $("#add-set").value;
    const number = $("#add-number").value.trim().slice(0, 20);
    const name = $("#add-name").value.trim().slice(0, 80);
    const file = $("#add-file").files[0];
    if (!number || !name) throw new Error("Pon el número y el nombre de la carta.");
    if (!file) throw new Error("La imagen es obligatoria: sube una foto o escaneo de la carta.");
    if (set === "__new") {
      const setName = $("#add-new-set").value.trim().slice(0, 80);
      if (!setName) throw new Error("Pon nombre a la nueva colección.");
      set = `x-${keyOf(setName.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "-")).slice(0, 60)}`;
      await db.doc(`extra/set-${set}`).set({ type: "set", id: set, name: setName, kind: "promo", by: state.me });
    }
    const id = `${set}-${number}`;
    if (allCards().some((c) => c.id === id)) throw new Error("Esa carta ya existe en esa colección.");
    btn.disabled = true;
    const asset = await uploadFile(file);
    await db.doc(`extra/${keyOf(id)}`).set({
      id, set, number, sort: parseInt(number.match(/\d+/)?.[0] ?? "9999", 10), name,
      rarity: $("#add-rarity").value.trim().slice(0, 40) || null,
      note: $("#add-note").value.trim().slice(0, 120) || null,
      asset, by: state.me, at: Date.now(),
    });
    $("#dlg-add").close();
    toast(`«${name}» añadida para todos`);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function renderMemberList() {
  const me = state.accounts.get(state.me);
  $("#member-list").innerHTML = users()
    .map((u) => `<li>${avatar(u)} <span><b>${esc(u.name)}</b> <small>@${esc(u.id)}${u.admin ? " · admin" : ""}</small></span>
      ${!u.admin && me?.admin ? `<button type="button" class="btn ghost small" data-del-user="${esc(u.id)}">Quitar</button>` : ""}</li>`)
    .join("");
}

async function addMember(e) {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  const err = $("#m-error");
  err.hidden = true;
  try {
    const user = $("#m-user").value.trim().toLowerCase();
    const name = $("#m-name").value.trim().slice(0, 40) || user;
    const pass = $("#m-pass").value;
    if (!/^[a-z0-9_.-]{2,30}$/.test(user)) throw new Error("El usuario solo puede tener letras sin acentos, números, punto, guion o guion bajo.");
    if (state.accounts.has(user)) throw new Error("Ese usuario ya existe.");
    if (pass.length < 4) throw new Error("La contraseña necesita al menos 4 caracteres.");
    await db.doc(`accounts/${user}`).set({ name, pass: await hashPass(user, pass), color: COLORS[state.accounts.size % COLORS.length], admin: false, created: Date.now() });
    $("#m-user").value = $("#m-name").value = $("#m-pass").value = "";
    toast(`Usuario ${user} creado`);
    setTimeout(renderMemberList, 300);
  } catch (ex) {
    err.textContent = ex.code === "invalid_argument" ? "Tu acceso no permite crear usuarios." : ex.message;
    err.hidden = false;
  }
}

function setupUI() {
  $("#form-login").addEventListener("submit", login);
  $("#file-pick").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f && uploadTarget) uploadImage(uploadTarget, f);
  });
  document.addEventListener("click", (e) => {
    const up = e.target.closest("[data-upload]");
    if (up) {
      e.preventDefault();
      e.stopPropagation();
      uploadTarget = up.dataset.upload;
      $("#file-pick").value = "";
      $("#file-pick").click();
      return;
    }
    const del = e.target.closest("[data-del-user]");
    if (del) {
      const u = del.dataset.delUser;
      if (del.dataset.confirm) {
        db.doc(`accounts/${u}`).delete().then(() => { toast(`Usuario ${u} quitado`); setTimeout(renderMemberList, 300); });
      } else {
        del.dataset.confirm = "1";
        del.textContent = "¿Seguro? Toca otra vez";
      }
      return;
    }
    const t = e.target.closest("[data-inc],[data-dec],[data-open],[data-toggle],[data-set],[data-user],[data-view],[data-close]");
    if (!t) return;
    const d = t.dataset;
    const cardOf = (id) => allCards().find((c) => c.id === id);
    if (d.inc) setQty(d.inc, qty(cardOf(d.inc), state.me) + 1);
    else if (d.dec) setQty(d.dec, qty(cardOf(d.dec), state.me) - 1);
    else if (d.toggle) setQty(d.toggle, qty(cardOf(d.toggle), state.me) ? 0 : 1);
    else if (d.open) { e.preventDefault(); openCard(d.open); }
    else if (d.set) { state.set = d.set; lsSet("set", d.set); render(); }
    else if (d.user) {
      const own = d.user === state.me;
      const has = own ? "have" : `has:${d.user}`;
      const lacks = own ? "missing" : `lacks:${d.user}`;
      state.owner = state.owner === has ? lacks : state.owner === lacks ? "all" : has;
      render();
    } else if (d.view) { state.view = d.view; lsSet("view", d.view); render(); }
    else if (d.close !== undefined) t.closest("dialog").close();
  });
  $("#q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
  $("#f-rarity").addEventListener("change", (e) => { state.rarity = e.target.value; render(); });
  $("#f-owner").addEventListener("change", (e) => { state.owner = e.target.value; render(); });
  $("#img-warning").addEventListener("click", () => { state.owner = "noimage"; state.set = "all"; render(); });
  $("#dlg-card").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $("#btn-logout").addEventListener("click", logout);
  $("#btn-members").addEventListener("click", () => { renderMemberList(); $("#m-error").hidden = true; $("#dlg-members").showModal(); });
  $("#form-member").addEventListener("submit", addMember);
  $("#btn-add").addEventListener("click", () => {
    $("#form-add").reset();
    $("#add-error").hidden = true;
    $("#add-set").innerHTML = allSets().map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("") + `<option value="__new">➕ Nueva colección / producto…</option>`;
    if (state.set !== "all") $("#add-set").value = state.set;
    $("#rarities").innerHTML = RARITY_ORDER.map((r) => `<option value="${esc(r)}">`).join("");
    $("#new-set-row").hidden = true;
    $("#dlg-add").showModal();
  });
  $("#add-set").addEventListener("change", (e) => ($("#new-set-row").hidden = e.target.value !== "__new"));
  $("#form-add").addEventListener("submit", addCard);
}

setupUI();
connect();
