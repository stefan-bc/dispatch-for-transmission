// Background service worker.
// Responsibilities:
//   - Manage context menus (one per configured server, plus per-download-dir).
//   - Handle "Add to server X" clicks for magnet links and .torrent URLs.
//   - Fire notifications for success / failure.
//   - On action click, open the popup — if Chrome can't open it (e.g. popup
//     disabled), fall back to opening the popup.html as a full tab.

import { RpcClient, loadServers, loadServer, loadPreferences, isServerKey, STORAGE } from "./rpc.js";

// --- Context menu rebuild ------------------------------------------------

async function rebuildContextMenus() {
  // Wipe and re-create. Keeps menus in sync whenever servers change.
  await chrome.contextMenus.removeAll();
  const servers = await loadServers();
  for (const server of servers) {
    if (server.enabled === false) continue;
    addMenusForServer(server);
  }
}

function addMenusForServer(server) {
  // Root entry: "Add torrent to <server>".
  chrome.contextMenus.create({
    id: server.id,
    contexts: ["link", "selection"],
    title: `Add torrent to ${server.name}`,
    type: "normal"
  });
  // One sub-entry per configured download directory so users can route
  // straight to Movies / TV / etc.
  if (Array.isArray(server.downloadDirs)) {
    for (let i = 0; i < server.downloadDirs.length; i++) {
      const dir = server.downloadDirs[i];
      chrome.contextMenus.create({
        id: `${server.id}:${i}`,
        contexts: ["link", "selection"],
        title: `Add torrent to ${server.name} → ${dir.name}`,
        type: "normal"
      });
    }
  }
}

// --- Notifications -------------------------------------------------------

// The notifications image loader has flaky support for chrome-extension://
// URLs from a service worker context (fails with "Unable to download all
// specified images"). Pre-fetch the icon once and cache it as a data URL
// — the loader always accepts those.
let cachedIconDataUrl = null;
async function getIconDataUrl() {
  if (cachedIconDataUrl) return cachedIconDataUrl;
  try {
    const resp = await fetch(chrome.runtime.getURL("icon/icon.png"));
    const blob = await resp.blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    cachedIconDataUrl = `data:${blob.type || "image/png"};base64,${btoa(bin)}`;
  } catch (e) {
    console.warn("icon pre-fetch failed:", e);
  }
  return cachedIconDataUrl;
}

async function notify(title, message, isError = false) {
  // Await the create() callback. Without this the SW can be torn down
  // before Chrome actually enqueues the toast, so nothing appears.
  const iconUrl = (await getIconDataUrl()) || chrome.runtime.getURL("icon/icon.png");
  const level = await new Promise((resolve) => {
    chrome.notifications.getPermissionLevel(resolve);
  });
  const id = await new Promise((resolve) => {
    chrome.notifications.create({
      type: "basic",
      iconUrl,
      title,
      message: message || "",
      priority: isError ? 2 : 0
    }, (nid) => {
      if (chrome.runtime.lastError) {
        console.warn("notifications.create failed:", chrome.runtime.lastError.message);
      }
      resolve(nid);
    });
  });
  return { id, permissionLevel: level, lastError: chrome.runtime.lastError?.message || null };
}

// --- Download a .torrent file via the active tab ------------------------
// For http(s) .torrent URLs, we execute a small script in the page context
// so that any cookies / referer / auth on the origin site are applied.
// The file comes back as base64 that we pass to Transmission's "metainfo".

async function fetchTorrentFileInPage(url) {
  const response = await fetch(url, { mode: "cors", credentials: "include" });
  if (!response.ok) return { success: false };
  const blob = await response.blob();
  if (blob.size === 0) return { success: false };
  const reader = new FileReader();
  const data = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(btoa(reader.result));
    reader.onerror = reject;
    reader.readAsBinaryString(blob);
  });
  return { success: true, data };
}

// --- Click handler ------------------------------------------------------

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const [serverId, dirIndex] = String(info.menuItemId).split(":");
  const server = await loadServer(serverId);
  if (!server) return;

  // Either the link itself or a selected magnet link in page text.
  let url = info.linkUrl || info.selectionText;
  if (url) url = url.trim();
  if (!url) {
    notify("Failed to add torrent", "No magnet link or URL found", true);
    return;
  }

  const downloadDir = dirIndex !== undefined && server.downloadDirs
    ? server.downloadDirs[parseInt(dirIndex, 10)]?.path
    : undefined;

  const prefs = await loadPreferences();
  const paused = prefs.startOnAdd === false;
  const client = new RpcClient(server);

  try {
    let result;
    if (url.startsWith("magnet:?")) {
      result = await client.addTorrent({ url, downloadDir, paused });
    } else if (url.startsWith("http") && tab) {
      // Try to grab the .torrent bytes from the tab so origin cookies work.
      let file = null;
      try {
        const exec = await chrome.scripting.executeScript({
          func: fetchTorrentFileInPage,
          args: [url],
          target: { tabId: tab.id, frameIds: [info.frameId] }
        });
        file = exec?.[0]?.result;
      } catch {
        // Fell through to direct URL add below.
      }
      if (file?.success) {
        result = await client.addTorrent({ metainfo: file.data, downloadDir, paused });
      } else {
        result = await client.addTorrent({ url, downloadDir, paused });
      }
    } else {
      notify("Failed to add torrent", "Unrecognised link", true);
      return;
    }

    const added = result["torrent-added"];
    const duplicate = result["torrent-duplicate"];
    if (added) notify("Torrent added", added.name);
    else if (duplicate) notify("Duplicate torrent", duplicate.name, true);
    else notify("Torrent added", "(no details)");
  } catch (err) {
    notify("Failed to add torrent", err.message || String(err), true);
  }
});

// --- Lifecycle ----------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  await rebuildContextMenus();
  if (details?.reason === "install") {
    // On fresh install, open the options page so the user can add a server.
    chrome.tabs.create({ url: "options.html?from=install" });
  }
});

chrome.runtime.onStartup.addListener(() => rebuildContextMenus());

// Rebuild menus and refresh badge whenever server data changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const key of Object.keys(changes)) {
    if (isServerKey(key)) {
      rebuildContextMenus();
      updateBadge();
      return;
    }
  }
});

// The popup mode is controlled by the user in settings. If they chose
// "open in tab", we clear the default_popup at runtime and open a tab here.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("popup.html?view=tab");
  chrome.tabs.create({ url });
});

// Apply the current popup-vs-tab preference on startup.
async function applyActionMode() {
  const prefs = await loadPreferences();
  const popup = prefs.actionMode === "tab" ? "" : "popup.html";
  await chrome.action.setPopup({ popup });
}
applyActionMode();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE.prefs]) applyActionMode();
});

// --- Toolbar badge ------------------------------------------------------
// Shows the number of currently-downloading torrents on the extension
// icon. Polled in the background every 30s (the MV3 alarm minimum) and
// nudged by the popup after each normal refresh so it stays responsive.

const BADGE_ALARM = "badge-poll";
const BADGE_BG = "#22c55e";      // DaisyUI success green — high contrast on the dark theme
const BADGE_FG = "#000000";      // pure black — readable on the green badge

// Keys for per-server completion state so we can diff across polls even
// after the service worker is torn down and restarted.
const NOTIFY_STATE_KEY = "notify.progress"; // in chrome.storage.session

async function updateBadge() {
  try {
    const prefs = await loadPreferences();
    const servers = await loadServers();
    if (servers.length === 0) {
      await chrome.action.setBadgeText({ text: "" });
      return;
    }
    // Poll the last-used server so the badge matches what the popup shows.
    const stored = await chrome.storage.local.get(STORAGE.lastServer);
    const server = servers.find(s => s.id === stored[STORAGE.lastServer]) || servers[0];
    const client = new RpcClient(server);
    const { torrents } = await client.getTorrents(null, ["id", "name", "percentDone"]);

    // Badge: count fully-finished torrents for the active server.
    if (prefs.badgeEnabled === false) {
      await chrome.action.setBadgeText({ text: "" });
    } else {
      const done = torrents.filter(t => (t.percentDone || 0) >= 1).length;
      if (done === 0) {
        await chrome.action.setBadgeText({ text: "" });
      } else {
        await chrome.action.setBadgeText({ text: String(done) });
        await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
        if (chrome.action.setBadgeTextColor) {
          await chrome.action.setBadgeTextColor({ color: BADGE_FG });
        }
      }
    }

    // Notifications: fire once per torrent that just crossed 100%.
    if (prefs.notifyOnComplete === true) {
      await detectCompletions(server.id, torrents);
    }
  } catch {
    // Swallow transient errors — a server that's momentarily down shouldn't
    // throw up UI. The next tick will retry.
  }
}

async function detectCompletions(serverId, torrents) {
  const store = await chrome.storage.session.get(NOTIFY_STATE_KEY);
  const all = store[NOTIFY_STATE_KEY] || {};
  const prev = all[serverId] || {};
  const next = {};
  // First time we see this server: seed the map so we don't toast every
  // already-completed torrent on the first poll.
  const firstRun = Object.keys(prev).length === 0;
  for (const t of torrents) {
    const p = t.percentDone || 0;
    next[t.id] = p;
    if (firstRun) continue;
    const was = prev[t.id];
    if (was != null && was < 1 && p >= 1) {
      await notify("Torrent complete", t.name || "");
    }
  }
  all[serverId] = next;
  await chrome.storage.session.set({ [NOTIFY_STATE_KEY]: all });
}

chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 0.5 });
// Async + await so Chrome keeps the SW alive for the full updateBadge()
// cycle — otherwise a fire-and-forget handler risks the SW being torn down
// mid-RPC, losing the session-state write and/or the notifications.create
// call. Same reason for onInstalled / onStartup below.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === BADGE_ALARM) await updateBadge();
});
chrome.runtime.onInstalled.addListener(async () => { await updateBadge(); });
chrome.runtime.onStartup.addListener(async () => { await updateBadge(); });

// Let the popup nudge a badge refresh after its own polls for snappier UX.
// Returning `true` keeps the message channel (and the service worker)
// alive until the async work completes — otherwise Chrome can tear the
// SW down before the icon fetch + notifications.create finish firing.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "badge-refresh") {
        await updateBadge();
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === "notify-test") {
        const info = await notify("Notifications enabled", "You'll get a toast like this when a torrent finishes.");
        sendResponse({ ok: true, ...info });
        return;
      }
      sendResponse({ ok: true });
    } catch (e) {
      console.warn("onMessage handler failed:", e);
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});

updateBadge();
