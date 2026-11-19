"use strict";

/* ---------- Réglages (localStorage) ---------- */

const LS = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};

function detectRepo() {
  const host = location.hostname;
  if (!host.endsWith(".github.io")) return "";
  const owner = host.split(".")[0];
  const first = location.pathname.split("/").filter(Boolean)[0];
  return first ? `${owner}/${first}` : `${owner}/${owner}.github.io`;
}
const settings = {
  get token() { return LS.get("veille.token"); },
  set token(v) { LS.set("veille.token", v); },
  get repo() { return LS.get("veille.repo") || detectRepo(); },
  set repo(v) { LS.set("veille.repo", v === detectRepo() ? "" : v); },
};

/* ---------- Utilitaires ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
const dtf = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

function relTime(iso) {
  if (!iso) return "—";
  const diff = (new Date(iso) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "à l’instant";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return dtf.format(new Date(iso));
}

async function pageId(entry) {
  const key = `${(entry.url || "").trim()}\n${(entry.selector || "").trim()}`;
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(key));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

const b64encode = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin);
};
const b64decode = (b64) => {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
};

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; }
}

let bannerTimer;
function banner(msg, ok = false, ms = 6000) {
  const el = $("#banner");
  el.textContent = msg;
  el.className = "banner" + (ok ? " ok" : "");
  el.hidden = !msg;
  clearTimeout(bannerTimer);
  if (msg && ms) bannerTimer = setTimeout(() => (el.hidden = true), ms);
}

function renderDiff(pre, diff) {
  pre.replaceChildren();
  for (const line of (diff || "").split("\n")) {
    const span = document.createElement("span");
    if (line.startsWith("@@")) { span.className = "hunk"; span.textContent = "⋯"; }
    else if (line.startsWith("+")) { span.className = "add"; span.textContent = line; }
    else if (line.startsWith("-")) { span.className = "del"; span.textContent = line; }
    else span.textContent = line;
    pre.append(span);
  }
}

/* ---------- API GitHub ---------- */

async function gh(path, opts = {}) {
  if (!settings.token) throw new Error("Aucun jeton : ouvrez les réglages ⚙︎.");
  if (!settings.repo) throw new Error("Dépôt inconnu : renseignez-le dans les réglages ⚙︎.");
  const res = await fetch(`https://api.github.com/repos/${settings.repo}${path}`, {
    ...opts,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${settings.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg += " – " + (await res.json()).message; } catch {}
    const err = new Error(`GitHub : ${msg}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function readUrlsRemote() {
  const file = await gh("/contents/urls.json");
  return { list: JSON.parse(b64decode(file.content)), sha: file.sha };
}

/** Applique `mutate` sur la version la plus récente de urls.json et la commite. */
async function updateUrls(mutate, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { list, sha } = await readUrlsRemote();
    const next = mutate(list);
    try {
      await gh("/contents/urls.json", {
        method: "PUT",
        body: JSON.stringify({
          message,
          content: b64encode(JSON.stringify(next, null, 2) + "\n"),
          sha,
        }),
      });
      return next;
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e; // conflit : on recommence
    }
  }
  throw new Error("Conflit persistant sur urls.json, réessayez.");
}

/* ---------- Données ---------- */

const state = { urls: [], status: { pages: {} }, ids: [] };

async function fetchLocal(path) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} : ${res.status}`);
  return res.json();
}

async function load() {
  $("#btnRefresh").disabled = true;
  try {
    const [urls, status] = await Promise.all([
      settings.token
        ? readUrlsRemote().then(r => r.list).catch(() => fetchLocal("urls.json"))
        : fetchLocal("urls.json"),
      fetchLocal("data/status.json").catch(() => ({ pages: {} })),
    ]);
    state.urls = Array.isArray(urls) ? urls : [];
    state.status = status || { pages: {} };
    state.ids = await Promise.all(state.urls.map(pageId));
    render();
    cleanDeadSubscriptions().catch(() => {});
  } catch (e) {
    banner("Chargement impossible : " + e.message, false, 0);
  } finally {
    $("#btnRefresh").disabled = false;
  }
}

/* ---------- Rendu ---------- */

function render() {
  const s = state.status;
  $("#lastRun").textContent = s.last_run
    ? `dernier contrôle ${relTime(s.last_run)}`
    : "aucun contrôle pour l’instant";
  $("#lastRun").title = s.last_run ? dtf.format(new Date(s.last_run)) : "";

  const items = state.urls.map((entry, i) => ({ entry, i, st: s.pages?.[state.ids[i]] }));
  // Les modifications les plus récentes en premier, puis l'ordre du fichier.
  items.sort((a, b) =>
    (b.st?.last_change || "").localeCompare(a.st?.last_change || "") || a.i - b.i);

  const list = $("#list");
  list.replaceChildren(...items.map(card));
  $("#empty").hidden = items.length > 0;
  focusFromHash();
}

/** Ouvre la carte visée par #p-<id> (lien d'une notification). */
function focusFromHash() {
  const id = location.hash.slice(1);
  if (!id.startsWith("p-")) return;
  const el = document.getElementById(id);
  if (!el) return;
  history.replaceState(null, "", location.pathname + location.search);
  const det = $(".diff-wrap", el);
  if (det && !det.classList.contains("empty")) det.open = true;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 2500);
}
window.addEventListener("hashchange", focusFromHash);

function card({ entry, i, st }) {
  const node = $("#tplCard").content.firstElementChild.cloneNode(true);
  node.id = `p-${state.ids[i]}`;
  $(".name", node).textContent = entry.name || hostOf(entry.url);
  const host = $(".host", node);
  host.textContent = hostOf(entry.url);
  host.href = entry.url;
  $(".open", node).href = entry.url;

  $(".checked", node).textContent = st?.last_check ? relTime(st.last_check) : "en attente";
  $(".checked", node).title = st?.last_check ? dtf.format(new Date(st.last_check)) : "";
  const changed = $(".changed", node);
  if (st?.last_change) {
    changed.textContent = relTime(st.last_change);
    changed.title = dtf.format(new Date(st.last_change));
    if (Date.now() - new Date(st.last_change) < 86400e3) node.classList.add("recent");
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
    $(".history", det).onclick = () => openHistory(entry, state.ids[i]);
  } else {
    det.classList.add("empty");
    summary.textContent = st ? "Pas encore de modification" : "Premier contrôle à venir";
    summary.onclick = (e) => e.preventDefault();
  }

  const actions = $(".card-actions", node);
  $(".menu", node).onclick = () => (actions.hidden = !actions.hidden);
  $(".edit", node).onclick = () => openEdit(entry);
  $(".delete", node).onclick = () => removeEntry(entry);
  return node;
}

async function openHistory(entry, id) {
  const dlg = $("#dlgHistory");
  $("#histTitle").textContent = entry.name;
  const body = $("#histBody");
  body.textContent = "Chargement…";
  dlg.showModal();
  try {
    const hist = await fetchLocal(`data/history/${id}.json`);
    body.replaceChildren(...hist.map(h => {
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
    if (!hist.length) body.textContent = "Aucune modification enregistrée.";
  } catch (e) {
    body.textContent = "Historique indisponible (" + e.message + ").";
  }
}

/* ---------- Ajout / modification / suppression ---------- */

const sameEntry = (a, b) =>
  a.url === b.url && (a.selector || "") === (b.selector || "") && a.name === b.name;

let editing = null;

function openEdit(entry = null) {
  if (!settings.token) { banner("Ajoutez d’abord votre jeton dans les réglages ⚙︎."); openSettings(); return; }
  editing = entry;
  const f = $("#formEdit");
  $("#editTitle").textContent = entry ? "Modifier" : "Ajouter une URL";
  f.name.value = entry?.name || "";
  f.url.value = entry?.url || "";
  f.selector.value = entry?.selector || "";
  $("#dlgEdit").showModal();
}

$("#formEdit").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const item = { name: f.name.value.trim(), url: f.url.value.trim() };
  const sel = f.selector.value.trim();
  if (sel) item.selector = sel;
  const btn = $("button[type=submit]", f);
  btn.disabled = true;
  const old = editing;
  try {
    await updateUrls((list) => {
      if (!old) return [...list, item];
      const idx = list.findIndex(e => sameEntry(e, old));
      if (idx < 0) throw new Error("Cette entrée a été modifiée ailleurs, actualisez.");
      list[idx] = item;
      return list;
    }, old ? `Modification : ${item.name}` : `Ajout : ${item.name}`);
    $("#dlgEdit").close();
    banner("Enregistré. Un contrôle démarre, résultat dans une à deux minutes.", true);
    await load();
  } catch (e) {
    banner(e.message, false, 0);
  } finally {
    btn.disabled = false;
  }
});

async function removeEntry(entry) {
  if (!settings.token) { banner("Ajoutez d’abord votre jeton dans les réglages ⚙︎."); openSettings(); return; }
  if (!confirm(`Supprimer « ${entry.name} » ?\nSon historique sera effacé au prochain contrôle.`)) return;
  try {
    await updateUrls(list => list.filter(e => !sameEntry(e, entry)), `Suppression : ${entry.name}`);
    banner("Supprimé.", true);
    await load();
  } catch (e) {
    banner(e.message, false, 0);
  }
}

/* ---------- Réglages ---------- */

function openSettings() {
  const f = $("#formSettings");
  f.repo.value = settings.repo;
  f.token.value = settings.token;
  $("#tokenState").textContent = settings.token ? "Jeton enregistré." : "Aucun jeton enregistré.";
  $("#dlgSettings").showModal();
  document.activeElement?.blur(); // évite d'ouvrir le clavier sur iPhone
  refreshPushUi();
}

$("#formSettings").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  settings.repo = f.repo.value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  settings.token = f.token.value.trim();
  const st = $("#tokenState");
  if (!settings.token) { st.textContent = "Aucun jeton enregistré."; return; }
  st.textContent = "Vérification…";
  try {
    const repo = await gh("");
    const canPush = repo.permissions?.push;
    st.textContent = canPush
      ? `✓ Accès en écriture à ${repo.full_name}.`
      : `⚠︎ Jeton valide mais sans droit d’écriture sur ${repo.full_name} (permission « Contents »).`;
    refreshPushUi();
    if (canPush) { setTimeout(() => $("#dlgSettings").close(), 900); load(); }
  } catch (e) {
    st.textContent = "⚠︎ " + e.message;
  }
});

$("#btnForget").addEventListener("click", () => {
  settings.token = "";
  $("#formSettings").token.value = "";
  $("#tokenState").textContent = "Jeton effacé de cet appareil.";
});

async function dispatchRun(inputs) {
  const repo = await gh("");
  await gh("/actions/workflows/veille.yml/dispatches", {
    method: "POST",
    body: JSON.stringify({ ref: repo.default_branch, ...(inputs ? { inputs } : {}) }),
  });
}

$("#btnRun").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    await dispatchRun();
    $("#dlgSettings").close();
    banner("Contrôle lancé. Actualisez dans une à deux minutes.", true);
  } catch (e) {
    $("#tokenState").textContent = "⚠︎ " + e.message +
      (e.status === 403 ? " (le jeton doit avoir la permission « Actions : lecture et écriture »)" : "");
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Notifications Web Push ---------- */

const PUSH_VAR = "PUSH_SUBSCRIPTIONS";
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
let vapidKey = null;
const vapidReady = fetchLocal("vapid.json").then(j => (vapidKey = j.publicKey || null)).catch(() => null);

const sha1short = async (text) => {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
};

function urlB64ToBytes(b64) {
  const s = atob((b64 + "=".repeat((4 - b64.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

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
  const body = JSON.stringify({ name: PUSH_VAR, value: JSON.stringify(list) });
  if (exists) await gh(`/actions/variables/${PUSH_VAR}`, { method: "PATCH", body });
  else await gh("/actions/variables", { method: "POST", body });
}

async function currentSubscription() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
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
  await vapidReady;
  if (!vapidKey) {
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
  btn.classList.toggle("danger", !!sub);
  btn.textContent = sub ? "Désactiver sur cet appareil" : "Activer les notifications sur cet appareil";
  test.hidden = !sub;
  st.textContent = sub ? "✓ Cet appareil reçoit les notifications."
    : "Recevez une notification à chaque modification détectée.";
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
      await writeSubs(list.filter(s => s.endpoint !== existing.endpoint), exists);
      await existing.unsubscribe();
      banner("Notifications désactivées sur cet appareil.", true);
    } else {
      // La demande d'autorisation doit suivre directement le geste de l'utilisateur (iOS).
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Autorisation refusée.");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: urlB64ToBytes(vapidKey),
      });
      const json = sub.toJSON();
      const { list, exists } = await readSubs();
      const next = list.filter(s => s.endpoint !== json.endpoint);
      next.push({ endpoint: json.endpoint, keys: json.keys, label: deviceLabel(),
                  created: new Date().toISOString() });
      await writeSubs(next, exists);
      banner("Notifications activées ✓", true);
    }
  } catch (e) {
    st.textContent = "⚠︎ " + e.message +
      (e.status === 403 ? " (le jeton doit avoir la permission « Variables : lecture et écriture »)" : "");
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  refreshPushUi();
});

$("#btnPushTest").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    await dispatchRun({ test_push: "true" });
    $("#pushState").textContent = "Test lancé : la notification arrive d’ici une à deux minutes.";
  } catch (e) {
    $("#pushState").textContent = "⚠︎ " + e.message +
      (e.status === 403 ? " (le jeton doit avoir la permission « Actions : lecture et écriture »)" : "");
  } finally {
    btn.disabled = false;
  }
});

/** Retire de la variable les abonnements signalés expirés par le dernier contrôle. */
async function cleanDeadSubscriptions() {
  const dead = state.status.push?.dead || [];
  if (!settings.token || !dead.length) return;
  const { list, exists } = await readSubs();
  const ids = await Promise.all(list.map(s => sha1short(s.endpoint)));
  const next = list.filter((_, i) => !dead.includes(ids[i]));
  if (next.length !== list.length) await writeSubs(next, exists);
}

/* ---------- Démarrage ---------- */

document.querySelectorAll("[data-close]").forEach(b =>
  b.addEventListener("click", () => b.closest("dialog").close()));
document.querySelectorAll("dialog").forEach(d =>
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

$("#btnAdd").addEventListener("click", () => openEdit());
$("#btnSettings").addEventListener("click", openSettings);
$("#btnRefresh").addEventListener("click", load);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

load();
