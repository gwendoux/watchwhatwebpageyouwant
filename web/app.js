// Veille – interface (module ES, sans dépendance).

/* ---------- Sécurité ---------- */

// Trusted Types (exigé par la CSP) : seule l'URL du service worker est autorisée.
const ttPolicy = globalThis.trustedTypes?.createPolicy("veille", {
  createScriptURL: (url) => {
    if (url === "sw.js") return url;
    throw new TypeError(`URL de script refusée : ${url}`);
  },
});

/** Renvoie l'URL si elle est en http(s), sinon null (bloque javascript:, data:…). */
function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const TOKEN_RE = /^(github_pat_|ghp_)[A-Za-z0-9_]{20,255}$/;

/* ---------- Réglages (localStorage) ---------- */

const store = {
  get: (k) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } },
  set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* stockage indisponible */ } },
};

function detectRepo() {
  const { hostname, pathname } = location;
  if (!hostname.endsWith(".github.io")) return "";
  const owner = hostname.split(".")[0];
  const first = pathname.split("/").find(Boolean);
  return first ? `${owner}/${first}` : `${owner}/${owner}.github.io`;
}

const settings = {
  get token() { return store.get("veille.token"); },
  set token(v) { store.set("veille.token", v); },
  get repo() { return store.get("veille.repo") || detectRepo(); },
  set repo(v) { store.set("veille.repo", v === detectRepo() ? "" : v); },
};

/* ---------- Utilitaires ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
const dtf = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
const enc = new TextEncoder();

function relTime(iso) {
  if (!iso) return "—";
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "à l’instant";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return dtf.format(new Date(iso));
}

/** 12 premiers caractères hexadécimaux du SHA-1 (identique à short_id côté Python). */
async function shortId(text) {
  const buf = await crypto.subtle.digest("SHA-1", enc.encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}
const pageId = (e) => shortId(`${(e.url ?? "").trim()}\n${(e.selector ?? "").trim()}`);

const bytesToB64 = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const utf8ToB64 = (str) => bytesToB64(enc.encode(str));
const b64ToUtf8 = (b64) => new TextDecoder().decode(b64ToBytes(b64.replace(/\s/g, "")));
const b64urlToBytes = (s) => b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; }
}

let bannerTimer;
function banner(msg, { ok = false, ms = 6000 } = {}) {
  const el = $("#banner");
  el.textContent = msg;
  el.classList.toggle("ok", ok);
  el.hidden = !msg;
  clearTimeout(bannerTimer);
  if (msg && ms) bannerTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function renderDiff(pre, diff) {
  const lines = (diff ?? "").split("\n").map((line) => {
    const span = document.createElement("span");
    if (line.startsWith("@@")) { span.className = "hunk"; span.textContent = "⋯"; return span; }
    if (line.startsWith("+")) span.className = "add";
    else if (line.startsWith("-")) span.className = "del";
    span.textContent = line;
    return span;
  });
  pre.replaceChildren(...lines);
}

/* ---------- API GitHub ---------- */

class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const HINTS = {
  401: "jeton invalide, expiré ou révoqué",
  403: "permission manquante sur le jeton",
  404: "dépôt introuvable ou inaccessible avec ce jeton",
};

async function gh(path, { method = "GET", body } = {}) {
  const { token, repo } = settings;
  if (!token) throw new GitHubError(0, "Aucun jeton : ouvrez les réglages ⚙︎.");
  if (!REPO_RE.test(repo)) throw new GitHubError(0, "Dépôt invalide : renseignez-le dans les réglages ⚙︎.");
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    body: body && JSON.stringify(body),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body && { "Content-Type": "application/json" }),
    },
    // Lecture : revalidation par ETag (une réponse 304 ne consomme pas le quota d'API).
    cache: method === "GET" ? "no-cache" : "no-store",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).message ?? ""; } catch { /* corps vide */ }
    throw new GitHubError(res.status, `GitHub ${res.status} : ${HINTS[res.status] ?? detail}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function readUrlsRemote() {
  const file = await gh("/contents/urls.json");
  const list = JSON.parse(b64ToUtf8(file.content));
  return { list: Array.isArray(list) ? list : [], sha: file.sha };
}

/** Applique `mutate` sur la dernière version de urls.json et la commite (réessaie en cas de conflit). */
async function updateUrls(mutate, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { list, sha } = await readUrlsRemote();
    const content = utf8ToB64(`${JSON.stringify(mutate(list), null, 2)}\n`);
    try {
      await gh("/contents/urls.json", { method: "PUT", body: { message, content, sha } });
      return;
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
    }
  }
  throw new Error("Conflit persistant sur urls.json, réessayez.");
}

async function dispatchRun(inputs) {
  const { default_branch: ref } = await gh("");
  await gh("/actions/workflows/veille.yml/dispatches", { method: "POST", body: { ref, ...(inputs && { inputs }) } });
}

/* ---------- Données ---------- */

const state = { urls: [], status: { pages: {} }, ids: [], loadedAt: 0, loading: null };

/** Données du site (le paramètre contourne le cache de 10 min du CDN de GitHub Pages). */
async function fetchLocal(path) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${path} : HTTP ${res.status}`);
  return res.json();
}

function load() {
  state.loading ??= (async () => {
    $("#btnRefresh").disabled = true;
    try {
      const [urls, status] = await Promise.all([
        settings.token ? readUrlsRemote().then((r) => r.list).catch(() => fetchLocal("urls.json")) : fetchLocal("urls.json"),
        fetchLocal("data/status.json").catch(() => ({ pages: {} })),
      ]);
      state.urls = (Array.isArray(urls) ? urls : []).filter((e) => e && typeof e.url === "string");
      state.status = status ?? { pages: {} };
      state.ids = await Promise.all(state.urls.map(pageId));
      state.loadedAt = Date.now();
      render();
      cleanDeadSubscriptions().catch(() => {});
    } catch (e) {
      banner(`Chargement impossible : ${e.message}`, { ms: 0 });
    } finally {
      $("#btnRefresh").disabled = false;
      $("#list").ariaBusy = "false";
      state.loading = null;
    }
  })();
  return state.loading;
}

/* ---------- Rendu ---------- */

function render() {
  const s = state.status;
  const last = $("#lastRun");
  last.textContent = s.last_run ? `dernier contrôle ${relTime(s.last_run)}` : "aucun contrôle pour l’instant";
  last.title = s.last_run ? dtf.format(new Date(s.last_run)) : "";
  if (s.warnings?.length) banner(`⚠︎ urls.json : ${s.warnings.join(" · ")}`, { ms: 0 });

  const items = state.urls.map((entry, i) => ({ entry, id: state.ids[i], i, st: s.pages?.[state.ids[i]] }));
  // Modifications les plus récentes en premier, puis l'ordre du fichier.
  items.sort((a, b) => (b.st?.last_change ?? "").localeCompare(a.st?.last_change ?? "") || a.i - b.i);

  $("#list").replaceChildren(...items.map(card));
  $("#empty").hidden = items.length > 0;
  focusFromHash();
}

/** Ouvre la carte visée par #p-<id> (lien d'une notification). */
function focusFromHash() {
  const id = location.hash.slice(1);
  if (!/^p-[0-9a-f]{12}$/.test(id)) return;
  const el = document.getElementById(id);
  if (!el) return;
  history.replaceState(null, "", location.pathname + location.search);
  const det = $(".diff-wrap", el);
  if (!det.classList.contains("no-diff")) det.open = true;
  el.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 2500);
}

function card({ entry, id, st }) {
  const node = $("#tplCard").content.firstElementChild.cloneNode(true);
  node.id = `p-${id}`;
  const href = safeHttpUrl(entry.url);
  $(".name", node).textContent = entry.name || hostOf(entry.url);
  const host = $(".host", node);
  host.textContent = hostOf(entry.url);
  if (href) { host.href = href; $(".open", node).href = href; } else { $(".open", node).hidden = true; }

  const checked = $(".checked", node);
  checked.textContent = st?.last_check ? relTime(st.last_check) : "en attente";
  if (st?.last_check) checked.title = dtf.format(new Date(st.last_check));
  const changed = $(".changed", node);
  if (st?.last_change) {
    changed.textContent = relTime(st.last_change);
    changed.title = dtf.format(new Date(st.last_change));
    if (Date.now() - Date.parse(st.last_change) < 86_400_000) node.classList.add("recent");
  } else {
    changed.textContent = st ? "aucune" : "—";
  }
  $(".selector", node).textContent = entry.selector ? `⌖ ${entry.selector}` : "";
  if (st?.error) $(".error", node).textContent = `⚠︎ ${st.error}`;

  const det = $(".diff-wrap", node);
  const summary = $("summary", det);
  if (st?.diff) {
    summary.textContent = `Dernier changement : +${st.added ?? 0} / −${st.removed ?? 0}`;
    renderDiff($(".diff", det), st.diff);
    $(".history", det).addEventListener("click", () => openHistory(entry, id));
  } else {
    det.classList.add("no-diff");
    summary.textContent = st ? "Pas encore de modification" : "Premier contrôle à venir";
    summary.tabIndex = -1;
    summary.addEventListener("click", (e) => e.preventDefault());
  }

  const actions = $(".card-actions", node);
  actions.id = `a-${id}`;
  const menu = $(".menu", node);
  menu.setAttribute("aria-controls", actions.id);
  menu.addEventListener("click", () => {
    actions.hidden = !actions.hidden;
    menu.ariaExpanded = String(!actions.hidden);
  });
  $(".edit", node).addEventListener("click", () => openEdit(entry));
  $(".delete", node).addEventListener("click", () => removeEntry(entry));
  return node;
}

async function openHistory(entry, id) {
  $("#histTitle").textContent = entry.name;
  const body = $("#histBody");
  body.textContent = "Chargement…";
  $("#dlgHistory").showModal();
  try {
    const hist = await fetchLocal(`data/history/${id}.json`);
    if (!Array.isArray(hist) || !hist.length) { body.textContent = "Aucune modification enregistrée."; return; }
    body.replaceChildren(...hist.map((h) => {
      const div = document.createElement("div");
      div.className = "hist-item";
      const h4 = document.createElement("h4");
      h4.textContent = `${dtf.format(new Date(h.date))} · +${h.added} / −${h.removed}`;
      const pre = document.createElement("pre");
      pre.className = "diff";
      renderDiff(pre, h.diff);
      div.append(h4, pre);
      return div;
    }));
  } catch (e) {
    body.textContent = `Historique indisponible (${e.message}).`;
  }
}

/* ---------- Ajout / modification / suppression ---------- */

const sameEntry = (a, b) => a.url === b.url && (a.selector ?? "") === (b.selector ?? "") && a.name === b.name;
let editing = null;

function requireToken() {
  if (settings.token) return true;
  banner("Ajoutez d’abord votre jeton dans les réglages ⚙︎.");
  openSettings();
  return false;
}

function openEdit(entry = null) {
  if (!requireToken()) return;
  editing = entry;
  const f = $("#formEdit");
  $("#editTitle").textContent = entry ? "Modifier" : "Ajouter une URL";
  f.elements.name.value = entry?.name ?? "";
  f.elements.url.value = entry?.url ?? "";
  f.elements.selector.value = entry?.selector ?? "";
  $("#dlgEdit").showModal();
}

$("#formEdit").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.currentTarget;
  const url = safeHttpUrl(f.elements.url.value.trim());
  if (!url) { f.elements.url.setCustomValidity("Adresse http(s) uniquement."); f.reportValidity(); return; }
  const item = { name: f.elements.name.value.trim(), url };
  const selector = f.elements.selector.value.trim();
  if (selector) item.selector = selector;
  const btn = $("button[type=submit]", f);
  btn.disabled = true;
  const old = editing;
  try {
    await updateUrls((list) => {
      if (!old) return [...list, item];
      const idx = list.findIndex((e) => sameEntry(e, old));
      if (idx < 0) throw new Error("Cette entrée a été modifiée ailleurs, actualisez.");
      return list.with(idx, item);
    }, old ? `Modification : ${item.name}` : `Ajout : ${item.name}`);
    $("#dlgEdit").close();
    banner("Enregistré. Un contrôle démarre, résultat dans une à deux minutes.", { ok: true });
    await load();
  } catch (e) {
    banner(e.message, { ms: 0 });
  } finally {
    btn.disabled = false;
  }
});
$("#formEdit").elements.url.addEventListener("input", (e) => e.currentTarget.setCustomValidity(""));

async function removeEntry(entry) {
  if (!requireToken()) return;
  if (!confirm(`Supprimer « ${entry.name} » ?\nSon historique sera effacé au prochain contrôle.`)) return;
  try {
    await updateUrls((list) => list.filter((e) => !sameEntry(e, entry)), `Suppression : ${entry.name}`);
    banner("Supprimé.", { ok: true });
    await load();
  } catch (e) {
    banner(e.message, { ms: 0 });
  }
}

/* ---------- Réglages ---------- */

function openSettings() {
  const f = $("#formSettings");
  f.elements.repo.value = settings.repo;
  f.elements.token.value = settings.token;
  $("#tokenState").textContent = settings.token ? "Jeton enregistré." : "Aucun jeton enregistré.";
  $("#dlgSettings").showModal();
  document.activeElement?.blur(); // évite d'ouvrir le clavier sur iPhone
  refreshPushUi();
}

$("#formSettings").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.currentTarget;
  const st = $("#tokenState");
  const repo = f.elements.repo.value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  const token = f.elements.token.value.trim();
  if (!REPO_RE.test(repo)) { st.textContent = "⚠︎ Dépôt attendu sous la forme propriétaire/depot."; return; }
  if (token && !TOKEN_RE.test(token)) { st.textContent = "⚠︎ Ce n’est pas un jeton GitHub (github_pat_…)."; return; }
  settings.repo = repo;
  settings.token = token;
  if (!token) { st.textContent = "Aucun jeton enregistré."; return; }
  st.textContent = "Vérification…";
  try {
    const info = await gh("");
    const classic = token.startsWith("ghp_") ? " Préférez un jeton fine-grained limité à ce dépôt." : "";
    st.textContent = info.permissions?.push
      ? `✓ Accès en écriture à ${info.full_name}.${classic}`
      : `⚠︎ Jeton valide mais sans droit d’écriture sur ${info.full_name} (permission « Contents »).`;
    refreshPushUi();
    if (info.permissions?.push) { setTimeout(() => $("#dlgSettings").close(), 900); load(); }
  } catch (e) {
    st.textContent = `⚠︎ ${e.message}`;
  }
});

$("#btnForget").addEventListener("click", () => {
  settings.token = "";
  $("#formSettings").elements.token.value = "";
  $("#tokenState").textContent = "Jeton effacé de cet appareil.";
});

$("#btnRun").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    await dispatchRun();
    $("#dlgSettings").close();
    banner("Contrôle lancé. Actualisez dans une à deux minutes.", { ok: true });
  } catch (e) {
    $("#tokenState").textContent = `⚠︎ ${e.message}${e.status === 403 ? " (« Actions : lecture et écriture »)" : ""}`;
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Notifications Web Push ---------- */

const PUSH_VAR = "PUSH_SUBSCRIPTIONS";
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in globalThis && "Notification" in globalThis;
const vapidKey = fetchLocal("vapid.json").then((j) => j.publicKey ?? null, () => null);

function deviceLabel() {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua) ? "iPhone" : isIOS ? "iPad" : /Android/.test(ua) ? "Android"
    : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Appareil";
  return `${kind} – ${new Date().toLocaleDateString("fr-FR")}`;
}

async function readSubs() {
  try {
    const v = await gh(`/actions/variables/${PUSH_VAR}`);
    const list = JSON.parse(v.value || "[]");
    return { list: Array.isArray(list) ? list : [], exists: true };
  } catch (e) {
    if (e.status === 404) return { list: [], exists: false };
    throw e;
  }
}

async function writeSubs(list, exists) {
  const body = { name: PUSH_VAR, value: JSON.stringify(list) };
  if (exists) await gh(`/actions/variables/${PUSH_VAR}`, { method: "PATCH", body });
  else await gh("/actions/variables", { method: "POST", body });
}

async function currentSubscription() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg?.pushManager.getSubscription() ?? null;
}

async function refreshPushUi() {
  const st = $("#pushState"), btn = $("#btnPush"), test = $("#btnPushTest");
  btn.hidden = test.hidden = true;
  if (!pushSupported) {
    st.textContent = isIOS && !isStandalone
      ? "Sur iPhone, ajoutez d’abord l’app à l’écran d’accueil (Partager → Sur l’écran d’accueil), puis ouvrez-la depuis son icône."
      : "Ce navigateur ne gère pas les notifications push.";
    return;
  }
  if (!(await vapidKey)) {
    st.textContent = "Le secret VAPID_PRIVATE_KEY n’est pas encore configuré dans le dépôt (voir le README).";
    return;
  }
  if (Notification.permission === "denied") {
    st.textContent = "Notifications refusées pour cette app. Autorisez-les dans Réglages iOS → Notifications → Veille.";
    return;
  }
  const sub = await currentSubscription();
  btn.hidden = false;
  btn.classList.toggle("primary", !sub);
  btn.classList.toggle("danger", Boolean(sub));
  btn.textContent = sub ? "Désactiver sur cet appareil" : "Activer les notifications sur cet appareil";
  test.hidden = !sub;
  st.textContent = sub ? "✓ Cet appareil reçoit les notifications." : "Recevez une notification à chaque modification détectée.";
}

$("#btnPush").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  const st = $("#pushState");
  if (!settings.token) { st.textContent = "Enregistrez d’abord votre jeton ci-dessus."; return; }
  btn.disabled = true;
  try {
    const existing = await currentSubscription();
    if (existing) {
      const { list, exists } = await readSubs();
      await writeSubs(list.filter((s) => s.endpoint !== existing.endpoint), exists);
      await existing.unsubscribe();
      banner("Notifications désactivées sur cet appareil.", { ok: true });
    } else {
      // iOS : la demande d'autorisation doit suivre directement le geste de l'utilisateur.
      if ((await Notification.requestPermission()) !== "granted") throw new Error("Autorisation refusée.");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(await vapidKey) });
      const { endpoint, keys } = sub.toJSON();
      const { list, exists } = await readSubs();
      await writeSubs([...list.filter((s) => s.endpoint !== endpoint),
        { endpoint, keys, label: deviceLabel(), created: new Date().toISOString() }], exists);
      banner("Notifications activées ✓", { ok: true });
    }
  } catch (e) {
    st.textContent = `⚠︎ ${e.message}${e.status === 403 ? " (« Variables : lecture et écriture »)" : ""}`;
    return;
  } finally {
    btn.disabled = false;
  }
  refreshPushUi();
});

$("#btnPushTest").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    await dispatchRun({ test_push: "true" });
    $("#pushState").textContent = "Test lancé : la notification arrive d’ici une à deux minutes.";
  } catch (e) {
    $("#pushState").textContent = `⚠︎ ${e.message}${e.status === 403 ? " (« Actions : lecture et écriture »)" : ""}`;
  } finally {
    btn.disabled = false;
  }
});

/** Retire de la variable les abonnements signalés expirés par le dernier contrôle. */
async function cleanDeadSubscriptions() {
  const dead = new Set(state.status.push?.dead ?? []);
  if (!settings.token || !dead.size) return;
  const { list, exists } = await readSubs();
  const ids = await Promise.all(list.map((s) => shortId(s.endpoint)));
  const next = list.filter((_, i) => !dead.has(ids[i]));
  if (next.length !== list.length) await writeSubs(next, exists);
}

/* ---------- Démarrage ---------- */

for (const b of document.querySelectorAll("[data-close]")) {
  b.addEventListener("click", () => b.closest("dialog").close());
}
// Fermeture d'un tap hors du dialogue, pour les navigateurs sans l'attribut closedby.
if (!("closedBy" in HTMLDialogElement.prototype)) {
  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  }
}

$("#btnAdd").addEventListener("click", () => openEdit());
$("#btnSettings").addEventListener("click", openSettings);
$("#btnRefresh").addEventListener("click", () => load());
addEventListener("hashchange", focusFromHash);
// Retour sur l'app : on actualise, au plus une fois par minute.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - state.loadedAt > 60_000) load();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(ttPolicy ? ttPolicy.createScriptURL("sw.js") : "sw.js", { type: "classic", updateViaCache: "none" })
    .catch(() => {});
}

load();
