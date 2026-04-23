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

function notify(title, message, isError = false) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon/icon.png",
    title,
    message: message || "",
    priority: isError ? 2 : 0
  });
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
const BADGE_BG = "#50fa7b";      // Dracula green
const BADGE_FG = "#282a36";      // Dracula background — readable on green

async function updateBadge() {
  try {
    const prefs = await loadPreferences();
    if (prefs.badgeEnabled === false) {
      await chrome.action.setBadgeText({ text: "" });
      return;
    }
    const servers = await loadServers();
    if (servers.length === 0) {
      await chrome.action.setBadgeText({ text: "" });
      return;
    }
    // Poll the last-used server so the badge matches what the popup shows.
    const stored = await chrome.storage.local.get(STORAGE.lastServer);
    const server = servers.find(s => s.id === stored[STORAGE.lastServer]) || servers[0];
    const client = new RpcClient(server);
    const { torrents } = await client.getTorrents(null, ["percentDone"]);
    // Count finished torrents (100% downloaded), regardless of whether
    // they're now seeding or stopped.
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
  } catch {
    // Swallow transient errors — a server that's momentarily down shouldn't
    // throw up UI. The next tick will retry.
  }
}

chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM) updateBadge();
});
chrome.runtime.onInstalled.addListener(() => updateBadge());
chrome.runtime.onStartup.addListener(() => updateBadge());

// Let the popup nudge a badge refresh after its own polls for snappier UX.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "badge-refresh") updateBadge();
});

updateBadge();
