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
  return res.status === 204 ? null : res.json();
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
    ? `Dernier contrôle ${relTime(s.last_run)} · ${dtf.format(new Date(s.last_run))}`
    : "Aucun contrôle pour l’instant";

  const items = state.urls.map((entry, i) => ({ entry, i, st: s.pages?.[state.ids[i]] }));
  // Les modifications les plus récentes en premier, puis l'ordre du fichier.
  items.sort((a, b) =>
    (b.st?.last_change || "").localeCompare(a.st?.last_change || "") || a.i - b.i);

  const list = $("#list");
  list.replaceChildren(...items.map(card));
  $("#empty").hidden = items.length > 0;
}

function card({ entry, i, st }) {
  const node = $("#tplCard").content.firstElementChild.cloneNode(true);
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

$("#btnRun").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    const repo = await gh("");
    await gh("/actions/workflows/veille.yml/dispatches", {
      method: "POST",
      body: JSON.stringify({ ref: repo.default_branch }),
    });
    $("#dlgSettings").close();
    banner("Contrôle lancé. Actualisez dans une à deux minutes.", true);
  } catch (e) {
    $("#tokenState").textContent = "⚠︎ " + e.message +
      (e.status === 403 ? " (le jeton doit avoir la permission « Actions : lecture et écriture »)" : "");
  } finally {
    btn.disabled = false;
  }
});

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
