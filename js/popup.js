// Transmission Remote popup.
// Wires the toolbar, list, dialogs and keyboard shortcuts to the RPC client.

import {
  RpcClient,
  RpcError,
  loadServers,
  loadServer,
  saveServer,
  deleteServer,
  loadPreferences,
  savePreferences,
  STATUS,
  STORAGE,
  statusLabel
} from "./rpc.js";

// --- State --------------------------------------------------------------

// All state lives in plain objects / Maps to keep things transparent and
// easy to follow without a framework.
const state = {
  prefs: null,
  servers: [],
  currentServerId: null,
  client: null,
  // Map<torrentId, Torrent> — the canonical view of torrents for the active
  // server. We update in place so row DOM can be recycled.
  torrents: new Map(),
  // Set<torrentId> of selected rows.
  selection: new Set(),
  // Last single-click anchor for shift-range selection.
  anchor: null,
  search: "",
  refreshTimer: null,
  firstLoad: true
};

// --- Boot ---------------------------------------------------------------

// If opened as a tab, mark the <html> so CSS can expand to the viewport.
if (new URLSearchParams(location.search).get("view") === "tab") {
  document.documentElement.dataset.view = "tab";
}

document.addEventListener("DOMContentLoaded", init);

async function init() {
  state.prefs = await loadPreferences();
  state.servers = await loadServers();

  wireToolbar();
  wireDialogs();
  wireShortcuts();
  wireRowMenu();
  wireDragDrop();
  wirePasteAdd();
  wireServers();
  hydrateServerSelects();

  if (state.servers.length === 0) {
    renderEmptyState({
      title: "No server configured",
      body: "Add a Transmission server to get started.",
      action: { label: "Add server", fn: () => openServersDialog() }
    });
    return;
  }

  // Pick last-used server or first one.
  const stored = await chrome.storage.local.get(STORAGE.lastServer);
  const lastId = stored[STORAGE.lastServer];
  const exists = state.servers.some(s => s.id === lastId);
  state.currentServerId = exists ? lastId : state.servers[0].id;
  document.getElementById("server-select").value = state.currentServerId;

  await switchServer(state.currentServerId);
}

// --- Toolbar wiring -----------------------------------------------------

function wireToolbar() {
  document.getElementById("server-select").addEventListener("change", (e) => {
    switchServer(e.target.value);
  });
  const searchEl = document.getElementById("search");
  searchEl.addEventListener("input", (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderList();
  });

  document.getElementById("btn-add").addEventListener("click", openAddDialog);
  document.getElementById("btn-start").addEventListener("click", () => bulkAction("start"));
  document.getElementById("btn-stop").addEventListener("click", () => bulkAction("stop"));
  document.getElementById("btn-delete").addEventListener("click", openDeleteDialog);
  document.getElementById("btn-servers").addEventListener("click", openServersDialog);
  document.getElementById("btn-settings").addEventListener("click", openSettingsDialog);
  document.getElementById("btn-expand").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?view=tab") });
    window.close();
  });

  // Clicking empty list space (not on a row) deselects everything.
  document.getElementById("list").addEventListener("click", (e) => {
    if (e.target.closest(".row")) return;
    if (state.selection.size === 0) return;
    state.selection.clear();
    state.anchor = null;
    renderList();
    updateStatusBar();
  });
}

function hydrateServerSelects() {
  const main = document.getElementById("server-select");
  const addDlg = document.getElementById("add-server");
  main.innerHTML = "";
  addDlg.innerHTML = "";
  for (const server of state.servers) {
    main.append(new Option(server.name, server.id));
    addDlg.append(new Option(server.name, server.id));
  }
}

// --- Server switching ---------------------------------------------------

async function switchServer(id) {
  state.currentServerId = id;
  await chrome.storage.local.set({ [STORAGE.lastServer]: id });
  const server = state.servers.find(s => s.id === id);
  if (!server) return;
  state.client = new RpcClient(server);
  state.torrents.clear();
  state.selection.clear();
  state.anchor = null;
  state.firstLoad = true;
  hydrateDownloadDirs(server);
  stopRefresh();
  await refresh();
  startRefresh();
}

function hydrateDownloadDirs(server) {
  const select = document.getElementById("add-dir");
  select.innerHTML = "";
  // First option: server default (empty string = use server's own default).
  select.append(new Option("Server default", ""));
  if (Array.isArray(server.downloadDirs)) {
    for (const dir of server.downloadDirs) {
      select.append(new Option(`${dir.name} — ${dir.path}`, dir.path));
    }
  }
}

// --- Refresh loop -------------------------------------------------------

function startRefresh() {
  stopRefresh();
  const ms = (state.prefs.refreshSeconds || 2) * 1000;
  state.refreshTimer = setInterval(refresh, ms);
}

function stopRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

async function refresh() {
  if (!state.client) return;
  try {
    // First load: full list. Subsequent loads: recently-active only.
    const args = state.firstLoad
      ? await state.client.getTorrents()
      : await state.client.getRecentTorrents();

    // Upsert changed torrents.
    for (const t of args.torrents || []) {
      state.torrents.set(t.id, { ...state.torrents.get(t.id), ...t });
    }

    // Delete removed ids (only present on incremental refreshes).
    if (Array.isArray(args.removed)) {
      for (const id of args.removed) {
        state.torrents.delete(id);
        state.selection.delete(id);
      }
    }

    state.firstLoad = false;
    renderList();
    updateStatusBar();
    // Nudge the background so the toolbar badge matches the popup state.
    chrome.runtime.sendMessage({ type: "badge-refresh" }).catch(() => {});
  } catch (err) {
    if (err instanceof RpcError) {
      renderEmptyState({
        title: err.code === 2 ? "Authentication failed" : "Cannot connect",
        body: err.code === 2
          ? "Check username and password in settings."
          : "The Transmission daemon didn't respond. Check the server URL and ensure remote access is enabled.",
        action: { label: "Edit server", fn: () => openServersDialog() }
      });
    } else {
      toast(err.message || "Unexpected error", "error");
    }
    stopRefresh();
  }
}

// --- Rendering ----------------------------------------------------------

const tpl = document.getElementById("row-tp");

function renderList() {
  const list = document.getElementById("list");
  const emptyEl = document.getElementById("empty-state");

  const sorted = sortTorrents(Array.from(state.torrents.values()));
  const filtered = sorted.filter(matchesFilter);

  if (filtered.length === 0) {
    list.hidden = true;
    if (state.torrents.size === 0) {
      renderEmptyState({
        title: "No torrents yet",
        body: "Drop a magnet link or upload a .torrent to get started.",
        action: { label: "Add torrent", fn: openAddDialog }
      });
    } else {
      renderEmptyState({
        title: "No matches",
        body: "No torrents match your filter or search.",
        action: null
      });
    }
    updateActionButtons();
    return;
  }

  emptyEl.hidden = true;
  list.hidden = false;

  // Reconcile DOM: we keep rows keyed by torrent id and update them
  // in place. If the ordering changes, we re-insert. This keeps focus.
  const existing = new Map();
  for (const row of list.children) existing.set(Number(row.dataset.id), row);

  list.innerHTML = "";
  for (const t of filtered) {
    const row = existing.get(t.id) || tpl.content.firstElementChild.cloneNode(true);
    row.dataset.id = t.id;
    updateRow(row, t);
    list.append(row);
  }

  updateActionButtons();
}

function matchesFilter(t) {
  if (state.search && !t.name.toLowerCase().includes(state.search)) return false;
  return true;
}

function sortTorrents(arr) {
  const order = state.prefs.order;
  const cmp = {
    dateDesc: (a, b) => b.addedDate - a.addedDate,
    dateAsc: (a, b) => a.addedDate - b.addedDate,
    nameAsc: (a, b) => a.name.localeCompare(b.name),
    nameDesc: (a, b) => b.name.localeCompare(a.name),
    progress: (a, b) => b.percentDone - a.percentDone,
    rateDown: (a, b) => b.rateDownload - a.rateDownload
  }[order] || ((a, b) => b.addedDate - a.addedDate);
  return [...arr].sort(cmp);
}

// DaisyUI badge + progress modifier classes keyed off the derived state.
// Kept subtle on purpose: only active/error states get colour, the rest stay
// neutral so a long list doesn't look like a traffic light.
const STATE_BADGE = {
  downloading: "badge-ghost",
  seeding: "badge-success badge-soft",
  stopped: "badge-ghost",
  complete: "badge-success badge-soft",
  metadata: "badge-ghost",
  error: "badge-error badge-soft",
  verifying: "badge-warning badge-soft",
  queued: "badge-ghost"
};

// Neutral (base-content) while in progress; green once finished (seeding /
// complete). Red on error, yellow while verifying, grey for everything else.
const STATE_PROGRESS = {
  downloading: "",
  seeding: "progress-success",
  stopped: "",
  complete: "progress-success",
  metadata: "",
  error: "progress-error",
  verifying: "progress-warning",
  queued: ""
};

function updateRow(row, t) {
  const done = t.percentDone >= 1;
  const stateKey = deriveStateKey(t);
  row.dataset.state = stateKey;

  // Selection: flat, slightly lighter background. No border, no depth.
  // Styling lives in css/overrides.css → .row.selected.
  const selected = state.selection.has(t.id);
  row.classList.toggle("selected", selected);

  row.querySelector(".row-name").textContent = t.name;

  // Reset badge classes to the DaisyUI defaults, then add state modifiers.
  const statusEl = row.querySelector(".row-status");
  statusEl.className = "row-status badge badge-xs shrink-0 " + STATE_BADGE[stateKey];
  statusEl.textContent = humanStatus(t, done);

  // <progress> element: set value/max and swap colour modifier classes.
  const pct = Math.min(100, Math.round((t.percentDone || 0) * 100));
  const progEl = row.querySelector("progress");
  progEl.value = pct;
  progEl.max = 100;
  progEl.className = "progress progress-xs w-full my-1 " + STATE_PROGRESS[stateKey];

  row.querySelector(".row-meta").textContent = buildMeta(t, done);
  row.querySelector(".rate-down").textContent = formatRate(t.rateDownload);
  row.querySelector(".rate-up").textContent = formatRate(t.rateUpload);

  // Re-wire events (cheap; rows are small).
  row.onclick = (e) => onRowClick(e, t.id);
  row.ondblclick = () => openFilesDialog(t.id);
  row.onkeydown = (e) => onRowKey(e, t.id);
  row.oncontextmenu = (e) => openRowMenu(e, t.id);
}

function deriveStateKey(t) {
  if (t.error && t.error !== 0) return "error";
  switch (t.status) {
    case STATUS.STOPPED:
      return t.percentDone >= 1 ? "complete" : "stopped";
    case STATUS.DOWNLOADING:
      // Still fetching metadata (magnet without .torrent yet) — no actual
      // payload is transferring, so treat it as neutral rather than green.
      if (t.metadataPercentComplete < 1) return "metadata";
      return "downloading";
    case STATUS.SEEDING: return "seeding";
    case STATUS.VERIFYING: return "verifying";
    case STATUS.QUEUED_DOWNLOAD:
    case STATUS.QUEUED_SEED:
    case STATUS.QUEUED_VERIFY:
      return "queued";
    default: return "stopped";
  }
}

function humanStatus(t, done) {
  if (t.error && t.error !== 0) return "Error";
  if (t.status === STATUS.DOWNLOADING && t.metadataPercentComplete < 1) {
    return `Metadata ${Math.round(t.metadataPercentComplete * 100)}%`;
  }
  if (t.status === STATUS.STOPPED && done) return "Complete";
  return statusLabel(t.status);
}

function buildMeta(t, done) {
  const parts = [];
  const size = formatSize(t.sizeWhenDone);
  if (done) {
    parts.push(size);
    const ratio = t.sizeWhenDone > 0 ? (t.uploadedEver / t.sizeWhenDone) : 0;
    parts.push(`Ratio ${ratio.toFixed(2)}`);
  } else {
    const pct = Math.round((t.percentDone || 0) * 100);
    const downloaded = formatSize(t.sizeWhenDone - t.leftUntilDone);
    parts.push(`${downloaded} / ${size} (${pct}%)`);
    if (t.eta > 0) parts.push(formatEta(t.eta));
  }
  if (t.peersConnected) {
    parts.push(`${t.peersSendingToUs}↓/${t.peersGettingFromUs}↑ of ${t.peersConnected}`);
  }
  return parts.join(" • ");
}

function renderEmptyState({ title, body, action }) {
  const section = document.getElementById("empty-state");
  const list = document.getElementById("list");
  list.hidden = true;
  section.hidden = false;
  document.getElementById("empty-title").textContent = title;
  document.getElementById("empty-body").textContent = body;
  const btn = document.getElementById("empty-action");
  if (action) {
    btn.hidden = false;
    btn.textContent = action.label;
    btn.onclick = action.fn;
  } else {
    btn.hidden = true;
  }
}

function updateActionButtons() {
  const has = state.selection.size > 0;
  document.getElementById("btn-start").disabled = !has;
  document.getElementById("btn-stop").disabled = !has;
  document.getElementById("btn-delete").disabled = !has;
}

function updateStatusBar() {
  const torrents = Array.from(state.torrents.values());
  const totalDown = torrents.reduce((s, t) => s + (t.rateDownload || 0), 0);
  const totalUp = torrents.reduce((s, t) => s + (t.rateUpload || 0), 0);
  document.getElementById("rate-down").textContent = formatRate(totalDown);
  document.getElementById("rate-up").textContent = formatRate(totalUp);

  document.getElementById("status-left").textContent =
    `${torrents.length} torrent${torrents.length === 1 ? "" : "s"}`;

  // Middle slot: selection count when something is picked, otherwise a
  // small donation link so the space isn't wasted.
  const mid = document.getElementById("status-middle");
  if (state.selection.size > 0) {
    mid.textContent = `${state.selection.size} selected`;
  } else {
    // Line-drawn coffee mug, matches the rest of the toolbar glyphs.
    mid.innerHTML = '<a href="https://buymeacoffee.com/stefanvca" target="_blank" rel="noopener" class="link link-hover opacity-70 inline-flex items-center" title="Buy me a coffee" aria-label="Buy me a coffee">'
      + '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M17 8h1a4 4 0 0 1 0 8h-1"/>'
      + '<path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"/>'
      + '<line x1="6" y1="2" x2="6" y2="4"/>'
      + '<line x1="10" y1="2" x2="10" y2="4"/>'
      + '<line x1="14" y1="2" x2="14" y2="4"/>'
      + '</svg></a>';
  }
}

// --- Selection ----------------------------------------------------------

function onRowClick(e, id) {
  const multi = e.metaKey || e.ctrlKey;
  const range = e.shiftKey;
  if (range && state.anchor !== null) {
    selectRange(state.anchor, id);
  } else if (multi) {
    if (state.selection.has(id)) state.selection.delete(id);
    else state.selection.add(id);
    state.anchor = id;
  } else {
    // Clicking the sole selected row again clears selection (toggle off).
    const onlyThis = state.selection.size === 1 && state.selection.has(id);
    state.selection.clear();
    if (onlyThis) {
      state.anchor = null;
    } else {
      state.selection.add(id);
      state.anchor = id;
    }
  }
  renderList();
  updateStatusBar();
}

function selectRange(from, to) {
  const visible = Array.from(document.querySelectorAll(".list .row"))
    .map(r => Number(r.dataset.id));
  const i = visible.indexOf(from);
  const j = visible.indexOf(to);
  if (i < 0 || j < 0) return;
  const [a, b] = i < j ? [i, j] : [j, i];
  for (let k = a; k <= b; k++) state.selection.add(visible[k]);
}

function onRowKey(e, id) {
  if (e.key === "Enter") {
    e.preventDefault();
    openFilesDialog(id);
  }
}

// --- Row context menu ---------------------------------------------------

function wireRowMenu() {
  const rowMenu = document.getElementById("row-menu");
  const listMenu = document.getElementById("list-menu");

  // Row-menu clicks.
  rowMenu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-action]");
    if (!item) return;
    // daisyUI puts `menu-disabled` on the <li>; bail if pointer-events
    // didn't already stop us (belt-and-braces).
    if (item.closest("li")?.classList.contains("menu-disabled")) return;
    const action = item.dataset.action;
    closeRowMenu();
    if (action === "files") {
      const id = state.selection.values().next().value;
      if (id != null) openFilesDialog(id);
    }
    else if (action === "start") bulkAction("start");
    else if (action === "stop") bulkAction("stop");
    else if (action === "delete") openDeleteDialog();
    else if (action === "add") openAddDialog();
    else if (action === "start-all") bulkActionAll("start");
    else if (action === "stop-all") bulkActionAll("stop");
    else if (action === "edit-servers") openServersDialog();
    else if (action === "copy-magnet") {
      const id = state.selection.values().next().value;
      if (id != null) copyMagnet(id);
    }
    else if (action === "paste") pasteFromClipboard();
  });

  // List-menu clicks (empty area / background).
  listMenu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-action]");
    if (!item) return;
    const action = item.dataset.action;
    closeRowMenu();
    if (action === "add") openAddDialog();
    else if (action === "start-all") bulkActionAll("start");
    else if (action === "stop-all") bulkActionAll("stop");
    else if (action === "edit-servers") openServersDialog();
    else if (action === "paste") pasteFromClipboard();
  });

  // Intercept right-click anywhere in the popup: if not on a row, show
  // the list menu instead of the browser's default context menu.
  document.addEventListener("contextmenu", (e) => {
    // Leave native menus for inputs, textareas, links — right-click-to-
    // paste is too useful to override there.
    if (e.target.closest("input, textarea, a[href]")) return;
    if (e.target.closest(".list .row")) return;          // row-menu handles this
    if (e.target.closest("dialog[open]")) return;        // never steal from dialogs
    e.preventDefault();
    openListMenu(e);
  });

  // Dismiss on outside click, Escape, scroll, or window blur.
  document.addEventListener("click", (e) => {
    if (!rowMenu.hidden && !rowMenu.contains(e.target)) closeRowMenu();
    if (!listMenu.hidden && !listMenu.contains(e.target)) closeRowMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (!rowMenu.hidden || !listMenu.hidden)) closeRowMenu();
  });
  document.addEventListener("scroll", () => closeRowMenu(), true);
  window.addEventListener("blur", () => closeRowMenu());
}

function openListMenu(e) {
  closeRowMenu();
  const menu = document.getElementById("list-menu");
  menu.hidden = false;
  const pad = 4;
  const x = Math.min(e.clientX, window.innerWidth  - menu.offsetWidth  - pad);
  const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - pad);
  menu.style.left = `${Math.max(pad, x)}px`;
  menu.style.top  = `${Math.max(pad, y)}px`;
}

function openRowMenu(e, id) {
  e.preventDefault();
  // Hide any other menu that may already be open (e.g. the empty-space
  // list menu) so we never show two at once.
  document.getElementById("list-menu").hidden = true;
  // If the right-clicked row isn't in the current selection, make it the
  // selection so the action targets what the user clicked on.
  if (!state.selection.has(id)) {
    state.selection.clear();
    state.selection.add(id);
    state.anchor = id;
    renderList();
    updateStatusBar();
  }
  // Enable/disable Resume/Pause based on whether any selected torrent is
  // stopped / running.
  const selected = Array.from(state.selection)
    .map(tid => state.torrents.get(tid))
    .filter(Boolean);
  const anyStopped = selected.some(t => t.status === STATUS.STOPPED);
  const anyRunning = selected.some(t => t.status !== STATUS.STOPPED);
  const startItem = document.getElementById("row-menu-start");
  const stopItem  = document.getElementById("row-menu-stop");
  startItem.classList.toggle("menu-disabled", !anyStopped);
  stopItem.classList.toggle("menu-disabled", !anyRunning);

  const menu = document.getElementById("row-menu");
  menu.hidden = false;
  // Position: clamp to viewport so the menu never clips out of the popup.
  const pad = 4;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const x = Math.min(e.clientX, window.innerWidth  - mw - pad);
  const y = Math.min(e.clientY, window.innerHeight - mh - pad);
  menu.style.left = `${Math.max(pad, x)}px`;
  menu.style.top  = `${Math.max(pad, y)}px`;
}

function closeRowMenu() {
  document.getElementById("row-menu").hidden = true;
  document.getElementById("list-menu").hidden = true;
}

// --- Server manager (dialog-based, mirrors options.html) --------------

function wireServers() {
  document.getElementById("btn-add-server").addEventListener("click", () => openServerEditor(null));
  document.getElementById("btn-save").addEventListener("click", onServerSave);
  document.getElementById("btn-test").addEventListener("click", onServerTest);
  document.getElementById("btn-add-dir").addEventListener("click", () => addDirRow());
  document.getElementById("s-auth").addEventListener("change", (e) => {
    document.getElementById("s-auth-fields").hidden = !e.target.checked;
  });
}

async function openServersDialog() {
  state.servers = await loadServers();
  renderServerList();
  document.getElementById("dlg-servers").showModal();
}

function renderServerList() {
  const list = document.getElementById("server-list");
  const tpl = document.getElementById("server-row-tp");
  list.innerHTML = "";
  if (state.servers.length === 0) {
    const empty = document.createElement("li");
    empty.className = "px-2 py-4 text-center text-xs opacity-60";
    empty.textContent = "No servers yet — click 'Add server'.";
    list.append(empty);
    return;
  }
  for (const s of state.servers) {
    const row = tpl.content.firstElementChild.cloneNode(true);
    row.querySelector(".server-name").textContent = s.name;
    row.querySelector(".server-url").textContent = s.rpc;
    row.querySelector(".server-edit").onclick = () => openServerEditor(s);
    row.querySelector(".server-delete").onclick = () => confirmDeleteServer(s);
    const dot = row.querySelector(".server-dot");
    list.append(row);
    pingServer(s).then(ok => {
      dot.classList.remove("bg-base-300");
      dot.classList.add(ok ? "bg-success" : "bg-error");
    });
  }
}

async function pingServer(server) {
  try {
    const origin = originFrom(server.rpc);
    if (!origin) return false;
    const granted = await chrome.permissions.contains({ origins: [origin + "/*"] });
    if (!granted) return false;
    const client = new RpcClient(server);
    await client.getSession();
    return true;
  } catch {
    return false;
  }
}

function originFrom(url) {
  try { return new URL(url).origin; } catch { return null; }
}

async function confirmDeleteServer(server) {
  if (!confirm(`Delete server "${server.name}"?`)) return;
  await deleteServer(server.id);
  state.servers = await loadServers();
  renderServerList();
  hydrateServerSelects();
  // If the active server was deleted, flip to another (or show empty).
  if (server.id === state.currentServerId) {
    if (state.servers.length > 0) switchServer(state.servers[0].id);
    else {
      state.client = null;
      state.torrents.clear();
      stopRefresh();
      renderList();
    }
  }
}

function openServerEditor(server) {
  state.editingServer = server;
  const isNew = !server;
  document.getElementById("dlg-server-title").textContent = isNew ? "Add server" : "Edit server";
  document.getElementById("s-name").value = server?.name || "";
  document.getElementById("s-rpc").value = server?.rpc || "http://127.0.0.1:9091/transmission/rpc";
  document.getElementById("s-webui").value = server?.webui || "";
  document.getElementById("s-auth").checked = !!server?.authEnabled;
  document.getElementById("s-auth-fields").hidden = !server?.authEnabled;
  document.getElementById("s-user").value = server?.username || "";
  document.getElementById("s-pass").value = server?.password || "";

  const dirs = document.getElementById("dirs");
  dirs.innerHTML = "";
  if (Array.isArray(server?.downloadDirs)) {
    for (const dir of server.downloadDirs) addDirRow(dir);
  }

  document.getElementById("s-status").hidden = true;
  document.getElementById("dlg-server").showModal();
  setTimeout(() => document.getElementById("s-name").focus(), 50);
}

function addDirRow(dir = { name: "", path: "" }) {
  const tpl = document.getElementById("dir-tp");
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.querySelector(".dir-name").value = dir.name;
  el.querySelector(".dir-path").value = dir.path;
  el.querySelector(".dir-remove").onclick = () => el.remove();
  document.getElementById("dirs").append(el);
}

function collectServerForm() {
  const downloadDirs = Array.from(document.querySelectorAll("#dirs .dir-row"))
    .map(row => ({
      name: row.querySelector(".dir-name").value.trim(),
      path: row.querySelector(".dir-path").value.trim()
    }))
    .filter(d => d.name && d.path);
  return {
    name: document.getElementById("s-name").value.trim(),
    rpc: document.getElementById("s-rpc").value.trim(),
    webui: document.getElementById("s-webui").value.trim(),
    authEnabled: document.getElementById("s-auth").checked,
    username: document.getElementById("s-user").value,
    password: document.getElementById("s-pass").value,
    downloadDirs
  };
}

function setServerStatus(message, ok) {
  const el = document.getElementById("s-status");
  el.textContent = message;
  el.className = "alert alert-soft py-2 text-xs " + (ok ? "alert-success" : "alert-error");
  el.hidden = false;
}

async function onServerTest() {
  const data = collectServerForm();
  if (!data.name || !data.rpc) return setServerStatus("Name and RPC URL are required.", false);
  const origin = originFrom(data.rpc);
  if (!origin) return setServerStatus("Invalid RPC URL.", false);
  const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
  if (!granted) return setServerStatus("Permission denied. Cannot reach server without it.", false);
  try {
    const client = new RpcClient({ ...data, id: state.editingServer?.id || "probe" });
    const session = await client.getSession();
    setServerStatus(`Connected (Transmission ${session?.version || ""})`, true);
  } catch (err) {
    setServerStatus((err instanceof RpcError ? "RPC error: " : "Error: ") + (err.message || err), false);
  }
}

async function onServerSave() {
  const data = collectServerForm();
  if (!data.name || !data.rpc) return setServerStatus("Name and RPC URL are required.", false);
  const origin = originFrom(data.rpc);
  if (!origin) return setServerStatus("Invalid RPC URL.", false);
  const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
  if (!granted) return setServerStatus("Permission denied. Cannot reach server without it.", false);

  const server = {
    id: state.editingServer?.id || crypto.randomUUID(),
    enabled: true,
    ...data
  };
  await saveServer(server);
  state.servers = await loadServers();
  renderServerList();
  hydrateServerSelects();
  // Keep the popup's active server in sync with the dropdown.
  document.getElementById("server-select").value = state.currentServerId || server.id;
  if (!state.currentServerId) switchServer(server.id);
  document.getElementById("dlg-server").close();
  toast(`Saved "${server.name}"`, "success");
}

// --- Drag-and-drop .torrent files --------------------------------------

function wireDragDrop() {
  const overlay = document.getElementById("drop-overlay");
  // Use an event-depth counter so nested dragenter/dragleave on child
  // elements don't flicker the overlay.
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");

  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  document.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const files = Array.from(e.dataTransfer.files);
    const torrents = files.filter(f => f.name.toLowerCase().endsWith(".torrent"));
    if (torrents.length === 0) {
      toast("Drop a .torrent file to add", "error");
      return;
    }
    for (const file of torrents) await addTorrentFromDrop(file);
    refresh();
  });
}

async function addTorrentFromDrop(file) {
  if (!state.client) {
    toast("No server selected", "error");
    return;
  }
  try {
    const metainfo = await readFileAsBase64(file);
    const paused = state.prefs.startOnAdd === false;
    const result = await state.client.addTorrent({ metainfo, paused });
    const added = result["torrent-added"];
    const dup = result["torrent-duplicate"];
    if (added) toast(`Added: ${added.name}`, "success");
    else if (dup) toast(`Duplicate: ${dup.name}`, "error");
  } catch (err) {
    toast(err.message || "Failed to add torrent", "error");
  }
}

// --- Paste-to-add magnet / torrent URL ---------------------------------
// A plain document-level `paste` listener doesn't reliably fire in a Chrome
// extension popup when no input is focused. Instead, intercept Cmd/Ctrl+V
// via keydown and read the clipboard via navigator.clipboard.readText()
// — the keypress counts as a user gesture, so no permission is needed.

function wirePasteAdd() {
  document.addEventListener("keydown", async (e) => {
    if (!(e.key === "v" || e.key === "V")) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    // Leave input fields, selects, and open dialogs alone — user may be
    // doing a normal paste.
    const inField = e.target.closest?.("input, textarea, select, [contenteditable]");
    const anyDialogOpen = document.querySelector("dialog[open]");
    if (inField || anyDialogOpen) return;

    let text = "";
    try { text = (await navigator.clipboard.readText()) || ""; }
    catch { return; } // clipboard read blocked → silent no-op
    text = text.trim();
    if (!text) return;

    const links = extractTorrentLinks(text);
    if (links.length === 0) return;

    e.preventDefault();
    for (const link of links) await addTorrentFromLink(link);
    refresh();
  });
}

// Any magnet URI or http(s) URL — let Transmission decide whether it's a
// real torrent, that's more forgiving than a strict ".torrent" suffix.
function extractTorrentLinks(text) {
  return text.split(/\s+/)
    .map(s => s.trim())
    .filter(s => s.startsWith("magnet:") || /^https?:\/\//i.test(s));
}

async function pasteFromClipboard() {
  let text = "";
  try { text = (await navigator.clipboard.readText()) || ""; }
  catch { toast("Clipboard not readable", "error"); return; }
  const links = extractTorrentLinks(text.trim());
  if (links.length === 0) {
    toast("No magnet or URL in clipboard", "error");
    return;
  }
  for (const link of links) await addTorrentFromLink(link);
  refresh();
}

async function copyMagnet(id) {
  try {
    const data = await state.client.getTorrents([id], ["magnetLink", "name"]);
    const t = data.torrents?.[0];
    if (!t?.magnetLink) { toast("No magnet link for this torrent", "error"); return; }
    await navigator.clipboard.writeText(t.magnetLink);
    toast(`Copied magnet for "${t.name}"`, "success");
  } catch (err) {
    toast(err.message || "Copy failed", "error");
  }
}

async function addTorrentFromLink(url) {
  if (!state.client) {
    toast("No server selected", "error");
    return;
  }
  try {
    const paused = state.prefs.startOnAdd === false;
    const result = await state.client.addTorrent({ url, paused });
    const added = result["torrent-added"];
    const dup = result["torrent-duplicate"];
    if (added) toast(`Added: ${added.name}`, "success");
    else if (dup) toast(`Duplicate: ${dup.name}`, "error");
  } catch (err) {
    toast(err.message || "Failed to add torrent", "error");
  }
}

// --- Actions ------------------------------------------------------------

// Spacebar toggle: if anything in the selection is running, pause the lot;
// otherwise resume. Matches how media players use space for play/pause.
function toggleStartStop() {
  const selected = Array.from(state.selection)
    .map(id => state.torrents.get(id))
    .filter(Boolean);
  if (selected.length === 0) return;
  const anyRunning = selected.some(t => t.status !== STATUS.STOPPED);
  bulkAction(anyRunning ? "stop" : "start");
}

async function bulkAction(kind) {
  const ids = Array.from(state.selection);
  if (ids.length === 0) return;
  try {
    if (kind === "start") await state.client.startTorrents(ids);
    if (kind === "stop") await state.client.stopTorrents(ids);
    toast(`${ids.length} torrent${ids.length === 1 ? "" : "s"} ${kind}ed`, "neutral");
    refresh();
  } catch (err) {
    toast(err.message || "Action failed", "error");
  }
}

// Act on every torrent for the active server, regardless of selection.
// Used by the list (empty-area) context menu — "Start all" / "Stop all".
async function bulkActionAll(kind) {
  const ids = Array.from(state.torrents.keys());
  if (ids.length === 0 || !state.client) return;
  try {
    if (kind === "start") await state.client.startTorrents(ids);
    if (kind === "stop") await state.client.stopTorrents(ids);
    toast(`All ${ids.length} torrent${ids.length === 1 ? "" : "s"} ${kind}ed`, "neutral");
    refresh();
  } catch (err) {
    toast(err.message || "Action failed", "error");
  }
}

// --- Dialogs ------------------------------------------------------------

function wireDialogs() {
  // Generic close handlers.
  document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", () => {
      const dlg = document.getElementById(btn.dataset.close);
      dlg.close();
    });
  });

  document.getElementById("add-submit").addEventListener("click", submitAdd);
  document.getElementById("delete-submit").addEventListener("click", submitDelete);
  document.getElementById("settings-submit").addEventListener("click", submitSettings);
  document.getElementById("files-submit").addEventListener("click", submitFiles);
  document.getElementById("open-options").addEventListener("click", (e) => {
    e.preventDefault();
    // Close the settings dialog first so the servers dialog opens cleanly.
    document.getElementById("dlg-settings").close();
    openServersDialog();
  });
  document.getElementById("empty-action").addEventListener("click", () => {});
}

function openAddDialog() {
  if (state.servers.length === 0) {
    openServersDialog();
    return;
  }
  const dlg = document.getElementById("dlg-add");
  document.getElementById("add-server").value = state.currentServerId;
  document.getElementById("add-link").value = "";
  document.getElementById("add-file").value = "";
  document.getElementById("add-dir").value = "";
  document.getElementById("add-paused").checked = state.prefs.startOnAdd === false;
  document.getElementById("add-error").hidden = true;
  dlg.showModal();
  setTimeout(() => document.getElementById("add-link").focus(), 50);
}

async function submitAdd() {
  const serverId = document.getElementById("add-server").value;
  const link = document.getElementById("add-link").value.trim();
  const fileInput = document.getElementById("add-file");
  const file = fileInput.files?.[0];
  const downloadDir = document.getElementById("add-dir").value || undefined;
  const paused = document.getElementById("add-paused").checked;
  const errEl = document.getElementById("add-error");

  if (!link && !file) {
    errEl.textContent = "Provide a magnet link or a .torrent file.";
    errEl.hidden = false;
    return;
  }

  const server = state.servers.find(s => s.id === serverId);
  const client = new RpcClient(server);

  try {
    let result;
    if (file) {
      const metainfo = await readFileAsBase64(file);
      result = await client.addTorrent({ metainfo, downloadDir, paused });
    } else {
      result = await client.addTorrent({ url: link, downloadDir, paused });
    }

    const added = result["torrent-added"];
    const dup = result["torrent-duplicate"];
    if (added) toast(`Added: ${added.name}`, "success");
    else if (dup) toast(`Duplicate: ${dup.name}`, "error");

    document.getElementById("dlg-add").close();
    if (serverId === state.currentServerId) refresh();
  } catch (err) {
    errEl.textContent = err.message || "Failed to add torrent.";
    errEl.hidden = false;
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // Strip the data: prefix; Transmission wants plain base64.
      const result = reader.result;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function openDeleteDialog() {
  if (state.selection.size === 0) return;
  const list = document.getElementById("delete-list");
  list.innerHTML = "";
  for (const id of state.selection) {
    const t = state.torrents.get(id);
    if (!t) continue;
    const li = document.createElement("li");
    li.textContent = t.name;
    list.append(li);
  }
  document.getElementById("delete-data").checked = state.prefs.deleteDataByDefault;
  document.getElementById("dlg-delete").showModal();
  // Put focus on Delete so Enter confirms straight away. Done after the
  // showModal() microtask so <dialog>'s default autofocus doesn't override.
  setTimeout(() => document.getElementById("delete-submit").focus(), 0);
}

async function submitDelete() {
  const ids = Array.from(state.selection);
  const deleteData = document.getElementById("delete-data").checked;
  try {
    await state.client.removeTorrents(ids, deleteData);
    toast(`Deleted ${ids.length} torrent${ids.length === 1 ? "" : "s"}`, "success");
    state.selection.clear();
    document.getElementById("dlg-delete").close();
    refresh();
  } catch (err) {
    toast(err.message || "Delete failed", "error");
  }
}

function openSettingsDialog() {
  document.getElementById("pref-order").value = state.prefs.order;
  document.getElementById("pref-refresh").value = String(state.prefs.refreshSeconds);
  document.getElementById("pref-mode").value = state.prefs.actionMode;
  document.getElementById("pref-delete-data").checked = state.prefs.deleteDataByDefault;
  document.getElementById("pref-start-on-add").checked = state.prefs.startOnAdd !== false;
  document.getElementById("pref-badge").checked = state.prefs.badgeEnabled !== false;
  document.getElementById("dlg-settings").showModal();
}

async function submitSettings() {
  state.prefs = {
    order: document.getElementById("pref-order").value,
    refreshSeconds: parseInt(document.getElementById("pref-refresh").value, 10),
    actionMode: document.getElementById("pref-mode").value,
    deleteDataByDefault: document.getElementById("pref-delete-data").checked,
    startOnAdd: document.getElementById("pref-start-on-add").checked,
    badgeEnabled: document.getElementById("pref-badge").checked
  };
  await savePreferences(state.prefs);
  document.getElementById("dlg-settings").close();
  startRefresh();
  renderList();
  // Ask the background to apply the new badge preference immediately.
  chrome.runtime.sendMessage({ type: "badge-refresh" }).catch(() => {});
}

// --- Files dialog -------------------------------------------------------

const filesState = { id: null, files: [], stats: [], wanted: new Set(), unwanted: new Set() };

async function openFilesDialog(id) {
  const dlg = document.getElementById("dlg-files");
  const tree = document.getElementById("files-tree");
  const titleEl = document.getElementById("files-title");
  const dirEl = document.getElementById("files-dir");
  tree.innerHTML = "<p class=\"opacity-60 p-2\">Loading…</p>";
  filesState.id = id;
  filesState.wanted.clear();
  filesState.unwanted.clear();
  dlg.showModal();

  try {
    const data = await state.client.getTorrentFiles(id);
    const t = data.torrents?.[0];
    if (!t) throw new Error("Torrent not found");
    titleEl.textContent = t.name;
    dirEl.textContent = t.downloadDir || "";
    filesState.files = t.files || [];
    filesState.stats = t.fileStats || [];
    renderFileTree(tree, t.files || [], t.fileStats || []);
  } catch (err) {
    tree.innerHTML = "";
    const p = document.createElement("p");
    p.className = "alert alert-error alert-soft text-xs";
    p.textContent = err.message || "Failed to load files";
    tree.append(p);
  }
}

function renderFileTree(container, files, stats) {
  // Build a hierarchical tree from flat paths.
  const root = { name: "", children: new Map(), file: null, indices: [] };
  files.forEach((f, i) => {
    const parts = f.name.split("/");
    let node = root;
    parts.forEach((part, idx) => {
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, children: new Map(), file: null, indices: [] });
      }
      node = node.children.get(part);
      node.indices.push(i);
      if (idx === parts.length - 1) node.file = { ...f, index: i, wanted: stats[i]?.wanted };
    });
  });

  container.innerHTML = "";
  for (const child of root.children.values()) {
    container.append(buildNode(child, 0));
  }
}

function buildNode(node, depth) {
  const el = document.createElement("div");
  const row = document.createElement("div");
  row.className = "flex items-center gap-1.5 py-0.5 px-1 rounded hover:bg-base-200";

  const caret = document.createElement("span");
  caret.className = "w-3.5 text-center opacity-60 cursor-pointer select-none";
  const isFolder = node.children.size > 0;
  caret.textContent = isFolder ? "▸" : " ";
  row.append(caret);

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "checkbox checkbox-xs";
  cb.checked = node.file ? !!node.file.wanted : nodeAllWanted(node);
  cb.indeterminate = isFolder && nodeSomeWanted(node) && !nodeAllWanted(node);
  row.append(cb);

  const label = document.createElement("span");
  label.className = "flex-1 min-w-0 truncate";
  label.textContent = node.name;
  row.append(label);

  if (node.file) {
    const size = document.createElement("span");
    size.className = "opacity-60 tnum";
    size.textContent = formatSize(node.file.length);
    row.append(size);
  }

  el.append(row);

  let childrenWrap = null;
  if (isFolder) {
    childrenWrap = document.createElement("div");
    childrenWrap.className = "ml-5";
    childrenWrap.hidden = depth > 0;
    caret.textContent = childrenWrap.hidden ? "▸" : "▾";
    for (const child of node.children.values()) {
      childrenWrap.append(buildNode(child, depth + 1));
    }
    el.append(childrenWrap);
    caret.onclick = () => {
      childrenWrap.hidden = !childrenWrap.hidden;
      caret.textContent = childrenWrap.hidden ? "▸" : "▾";
    };
  }

  cb.onchange = () => {
    for (const idx of node.indices) {
      if (cb.checked) {
        filesState.wanted.add(idx);
        filesState.unwanted.delete(idx);
      } else {
        filesState.unwanted.add(idx);
        filesState.wanted.delete(idx);
      }
    }
    if (childrenWrap) {
      childrenWrap.querySelectorAll("input[type=checkbox]").forEach(child => {
        child.checked = cb.checked;
        child.indeterminate = false;
      });
    }
  };

  return el;
}

function nodeAllWanted(node) {
  return node.indices.every(i => filesState.stats[i]?.wanted);
}
function nodeSomeWanted(node) {
  return node.indices.some(i => filesState.stats[i]?.wanted);
}

async function submitFiles() {
  try {
    await state.client.setTorrentFiles(
      filesState.id,
      Array.from(filesState.wanted),
      Array.from(filesState.unwanted)
    );
    document.getElementById("dlg-files").close();
    toast("File selection saved", "success");
    refresh();
  } catch (err) {
    toast(err.message || "Failed", "error");
  }
}

// --- Keyboard shortcuts -------------------------------------------------

function wireShortcuts() {
  document.addEventListener("keydown", (e) => {
    const inField = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    const anyDialogOpen = document.querySelector("dialog[open]");

    // Esc: close dialog, or clear search, or blur search.
    if (e.key === "Escape") {
      if (anyDialogOpen) {
        anyDialogOpen.close();
        return;
      }
      const s = document.getElementById("search");
      if (document.activeElement === s) {
        if (s.value) { s.value = ""; s.dispatchEvent(new Event("input")); }
        else s.blur();
      }
      return;
    }

    if (inField || anyDialogOpen) return;

    // Cmd/Ctrl+A → select all visible.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      document.querySelectorAll(".list .row").forEach(r => {
        state.selection.add(Number(r.dataset.id));
      });
      renderList();
      updateStatusBar();
      return;
    }

    switch (e.key.toLowerCase()) {
      case "o": e.preventDefault(); openAddDialog(); break;
      case " ": e.preventDefault(); toggleStartStop(); break;
      case "delete":
      case "backspace": e.preventDefault(); openDeleteDialog(); break;
      case "s":
      case "/":
        e.preventDefault();
        document.getElementById("search").focus();
        break;
      case "arrowdown":
      case "j": e.preventDefault(); moveSelection(1, e.shiftKey); break;
      case "arrowup":
      case "k": e.preventDefault(); moveSelection(-1, e.shiftKey); break;
    }
  });
}

function moveSelection(delta, extend) {
  const rows = Array.from(document.querySelectorAll(".list .row"));
  if (rows.length === 0) return;
  const ids = rows.map(r => Number(r.dataset.id));
  const last = state.anchor ?? ids[0];
  let idx = ids.indexOf(last);
  if (idx < 0) idx = 0;
  const next = Math.max(0, Math.min(ids.length - 1, idx + delta));
  const nextId = ids[next];
  if (extend) {
    state.selection.add(nextId);
  } else {
    state.selection.clear();
    state.selection.add(nextId);
  }
  state.anchor = nextId;
  renderList();
  updateStatusBar();
  rows[next].focus();
}

// --- Formatting helpers ------------------------------------------------

function formatSize(bytes) {
  if (!bytes || bytes < 0) return "0 B";
  const base = 1024;
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = 0;
  let v = bytes;
  while (v >= base && i < units.length - 1) { v /= base; i++; }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function formatRate(bytesPerSec) {
  if (!bytesPerSec) return "0 B/s";
  return formatSize(bytesPerSec) + "/s";
}

function formatEta(seconds) {
  if (!seconds || seconds < 0) return "";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// --- Toast --------------------------------------------------------------

function toast(message, kind = "") {
  // DaisyUI `.toast` is the host (positioned container). Individual toasts
  // are `.alert` components; we pick the colour variant from `kind`.
  const host = document.getElementById("toasts");
  const el = document.createElement("div");
  // Neutral toasts render with no colour modifier — daisyUI's base .alert
  // styling is already a muted grey, which is what we want.
  const variant = kind === "error" ? "alert-error"
    : kind === "success" ? "alert-success"
    : kind === "neutral" ? ""
    : "alert-info";
  el.className = `alert alert-sm alert-soft ${variant} text-xs py-2 px-3 shadow-sm`;
  el.setAttribute("role", "status");
  el.textContent = message;
  host.append(el);
  setTimeout(() => {
    el.style.transition = "opacity 200ms ease";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 200);
  }, 2800);
}
