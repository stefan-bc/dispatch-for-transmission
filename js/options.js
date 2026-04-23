// Options page: manage one or more Transmission servers.

import {
  RpcClient,
  RpcError,
  loadServers,
  loadServer,
  saveServer,
  deleteServer
} from "./rpc.js";

// --- State --------------------------------------------------------------

// We keep a reactive copy of servers in memory; the list re-renders whenever
// it changes. The editor dialog operates on a scratch copy.
const ui = {
  servers: [],
  editing: null // the server object currently being edited (or null = new)
};

// --- Boot ---------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  if (new URLSearchParams(location.search).get("from") === "install") {
    document.getElementById("welcome").hidden = false;
  }

  ui.servers = await loadServers();
  renderServers();
  wireHandlers();
});

function wireHandlers() {
  document.getElementById("btn-add-server").addEventListener("click", () => openEditor(null));
  document.getElementById("btn-save").addEventListener("click", onSave);
  document.getElementById("btn-test").addEventListener("click", onTest);
  document.getElementById("btn-add-dir").addEventListener("click", () => addDirRow());
  document.getElementById("s-auth").addEventListener("change", (e) => {
    document.getElementById("s-auth-fields").hidden = !e.target.checked;
  });
  document.querySelectorAll("[data-close]").forEach(btn =>
    btn.addEventListener("click", () => document.getElementById(btn.dataset.close).close())
  );
}

// --- Render server list -------------------------------------------------

function renderServers() {
  const list = document.getElementById("server-list");
  const tpl = document.getElementById("server-row-tp");
  list.innerHTML = "";
  if (ui.servers.length === 0) {
    const empty = document.createElement("li");
    empty.className = "px-4 py-8 text-center text-sm opacity-60";
    empty.textContent = "No servers yet — click 'Add server' to get started.";
    list.append(empty);
    return;
  }
  for (const s of ui.servers) {
    const row = tpl.content.firstElementChild.cloneNode(true);
    row.querySelector(".server-name").textContent = s.name;
    row.querySelector(".server-url").textContent = s.rpc;
    row.querySelector(".server-edit").onclick = () => openEditor(s);
    row.querySelector(".server-delete").onclick = () => confirmDelete(s);
    const dot = row.querySelector(".server-dot");
    list.append(row);
    // Fire-and-forget connectivity check paints the dot green or red.
    pingServer(s).then(ok => {
      dot.classList.remove("bg-base-300");
      dot.classList.add(ok ? "bg-success" : "bg-error");
    });
  }
}

async function pingServer(server) {
  try {
    // Request host permission lazily — ping won't work without it.
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

async function confirmDelete(server) {
  if (!confirm(`Delete server "${server.name}"?`)) return;
  await deleteServer(server.id);
  ui.servers = await loadServers();
  renderServers();
}

// --- Editor dialog ------------------------------------------------------

function openEditor(server) {
  ui.editing = server;
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

function collectForm() {
  const name = document.getElementById("s-name").value.trim();
  const rpc = document.getElementById("s-rpc").value.trim();
  const webui = document.getElementById("s-webui").value.trim();
  const authEnabled = document.getElementById("s-auth").checked;
  const username = document.getElementById("s-user").value;
  const password = document.getElementById("s-pass").value;
  const downloadDirs = Array.from(document.querySelectorAll(".dir-row"))
    .map(row => ({
      name: row.querySelector(".dir-name").value.trim(),
      path: row.querySelector(".dir-path").value.trim()
    }))
    .filter(d => d.name && d.path);
  return { name, rpc, webui, authEnabled, username, password, downloadDirs };
}

async function onTest() {
  const statusEl = document.getElementById("s-status");
  const data = collectForm();
  if (!data.name || !data.rpc) {
    return setStatus("Name and RPC URL are required.", false);
  }

  // Request host permission for the RPC origin. Must happen from a user
  // gesture, which the button click satisfies.
  const origin = originFrom(data.rpc);
  if (!origin) return setStatus("Invalid RPC URL.", false);
  const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
  if (!granted) return setStatus("Permission denied. Cannot reach server without it.", false);

  try {
    const client = new RpcClient({ ...data, id: ui.editing?.id || "probe" });
    const session = await client.getSession();
    const version = session?.version || "";
    setStatus(`Connected successfully (Transmission ${version})`, true);
  } catch (err) {
    setStatus((err instanceof RpcError ? "RPC error: " : "Error: ") + (err.message || err), false);
  }
}

function setStatus(message, ok) {
  // DaisyUI alert variants: success for OK, error for a failure.
  const el = document.getElementById("s-status");
  el.textContent = message;
  el.className = "alert alert-soft py-2 text-xs " + (ok ? "alert-success" : "alert-error");
  el.hidden = false;
}

async function onSave() {
  const data = collectForm();
  if (!data.name || !data.rpc) {
    return setStatus("Name and RPC URL are required.", false);
  }
  const origin = originFrom(data.rpc);
  if (!origin) return setStatus("Invalid RPC URL.", false);

  // Ensure we have host permission for the origin; needed for the popup too.
  const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
  if (!granted) return setStatus("Permission denied. Cannot reach server without it.", false);

  const server = {
    id: ui.editing?.id || crypto.randomUUID(),
    enabled: true,
    ...data
  };
  await saveServer(server);
  ui.servers = await loadServers();
  renderServers();
  document.getElementById("dlg-server").close();
  toast(`Saved "${server.name}"`, "success");
}

// --- Toast --------------------------------------------------------------

function toast(message, kind = "") {
  const host = document.getElementById("toasts");
  const el = document.createElement("div");
  const variant = kind === "error" ? "alert-error"
    : kind === "success" ? "alert-success"
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
