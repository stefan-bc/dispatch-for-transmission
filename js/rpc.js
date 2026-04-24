// Transmission RPC client.
// Docs: https://github.com/transmission/transmission/blob/main/docs/rpc-spec.md
// The session-id handshake: first request returns 409 with an
// X-Transmission-Session-Id header. We resend with that header set.

export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

// Fields we request per torrent for the list view, grouped by how each
// subset feeds the UI. Kept narrow so the JSON-RPC response stays small
// even on large seedboxes.
const FIELDS_IDENTITY = ["id", "name", "status", "addedDate", "downloadDir"];
const FIELDS_PROGRESS = ["percentDone", "sizeWhenDone", "leftUntilDone", "eta", "metadataPercentComplete"];
const FIELDS_TRAFFIC  = ["rateDownload", "rateUpload", "uploadedEver", "downloadedEver"];
const FIELDS_PEERS    = ["peersConnected", "peersSendingToUs", "peersGettingFromUs"];
const FIELDS_ERROR    = ["error", "errorString"];

export const LIST_FIELDS = [
  ...FIELDS_IDENTITY,
  ...FIELDS_PROGRESS,
  ...FIELDS_TRAFFIC,
  ...FIELDS_PEERS,
  ...FIELDS_ERROR
];

// Extra fields for the per-torrent file manager. We only need the file
// tree + their wanted/priority stats; the base metadata comes with the
// list row that's already loaded.
export const FILES_FIELDS = ["name", "downloadDir", "files", "fileStats"];

export class RpcClient {
  constructor(server) {
    this.endpoint = server.rpc;
    this.id = server.id;
    this.sessionStorageKey = STORAGE.sidPrefix + server.id;
    if (server.authEnabled) {
      // Basic auth. Username + password in memory only, encoded once.
      this.authHeader = "Basic " + btoa(server.username + ":" + server.password);
    }
    this.sessionId = null;
  }

  async #loadSessionId() {
    // Restore the cached session id from session storage if we have one.
    if (this.sessionId) return;
    const cached = await chrome.storage.session.get(this.sessionStorageKey);
    if (cached[this.sessionStorageKey]) {
      this.sessionId = cached[this.sessionStorageKey];
    }
  }

  async #storeSessionId(id) {
    this.sessionId = id;
    await chrome.storage.session.set({ [this.sessionStorageKey]: id });
  }

  async post(body) {
    // Single-shot POST to the RPC endpoint, transparently handling the 409
    // session-id handshake. All Transmission RPC calls go through here.
    await this.#loadSessionId();
    const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
    if (this.authHeader) headers.set("Authorization", this.authHeader);
    const sessionHeaderName = "X-Transmission-Session-Id";
    if (this.sessionId) headers.set(sessionHeaderName, this.sessionId);

    // AbortController timeout — without this a blackholed host (VPN dropout,
    // firewall drop) hangs the popup on "Loading…" indefinitely. Generous so
    // slow-but-reachable seedboxes still work.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const options = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    };

    let response;
    try {
      response = await fetch(this.endpoint, options);
      if (response.status === 409) {
        // Handshake: grab the new session id and retry once.
        const newId = response.headers.get(sessionHeaderName);
        if (newId) {
          await this.#storeSessionId(newId);
          headers.set(sessionHeaderName, newId);
          response = await fetch(this.endpoint, options);
        }
      }
    } catch (err) {
      if (err?.name === "AbortError") throw new RpcError(1, "Server did not respond in time");
      throw new RpcError(1, "Cannot connect to server");
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) throw new RpcError(2, "Authorisation failed");
    if (!response.ok) throw new RpcError(0, "Unexpected status: " + response.status);

    const json = await response.json();
    if (json.result !== "success") throw new RpcError(3, json.result);
    return json.arguments;
  }

  // --- Torrent list -------------------------------------------------------
  async getTorrents(ids = null, fields = LIST_FIELDS) {
    const args = { fields };
    if (ids) args.ids = ids;
    return this.post({ method: "torrent-get", arguments: args });
  }

  async getRecentTorrents(fields = LIST_FIELDS) {
    // Incremental refresh: Transmission returns only torrents that changed
    // since the last recently-active call, plus a list of removed ids.
    return this.post({
      method: "torrent-get",
      arguments: { ids: "recently-active", fields }
    });
  }

  async getTorrentFiles(id) {
    return this.getTorrents([id], FILES_FIELDS);
  }

  // --- Add / remove / start / stop ---------------------------------------
  async addTorrent({ url, metainfo, downloadDir, paused }) {
    const args = {};
    if (url) args.filename = url;
    if (metainfo) args.metainfo = metainfo;
    if (downloadDir) args["download-dir"] = downloadDir;
    if (paused) args.paused = true;
    return this.post({ method: "torrent-add", arguments: args });
  }

  async removeTorrents(ids, deleteLocalData = false) {
    return this.post({
      method: "torrent-remove",
      arguments: { ids, "delete-local-data": deleteLocalData }
    });
  }

  async startTorrents(ids) {
    return this.post({ method: "torrent-start", arguments: { ids } });
  }

  async stopTorrents(ids) {
    return this.post({ method: "torrent-stop", arguments: { ids } });
  }

  async setTorrentFiles(id, wanted, unwanted) {
    const args = { ids: [id] };
    if (wanted?.length) args["files-wanted"] = wanted;
    if (unwanted?.length) args["files-unwanted"] = unwanted;
    return this.post({ method: "torrent-set", arguments: args });
  }

  // --- Session info -------------------------------------------------------
  async getSession() {
    return this.post({ method: "session-get" });
  }

  async getSessionStats() {
    return this.post({ method: "session-stats" });
  }
}

// --- Storage schema -------------------------------------------------------
// Every chrome.storage.local key owned by this extension is namespaced
// under `tr.*` so the schema is versionable and easy to inspect in devtools.
// Shape:
//   tr.server.<uuid>   → { id, name, rpc, webui, authEnabled, ... }
//   tr.sid.<uuid>      → cached X-Transmission-Session-Id for that server
//   tr.prefs           → user preferences blob ({ v: 1, ...overrides })
//   tr.lastServer      → id of the server last viewed in the popup
export const STORAGE = Object.freeze({
  serverPrefix: "tr.server.",
  sidPrefix: "tr.sid.",
  prefs: "tr.prefs",
  lastServer: "tr.lastServer"
});

export function isServerKey(key) {
  return typeof key === "string" && key.startsWith(STORAGE.serverPrefix);
}

export async function loadServers() {
  const all = await chrome.storage.local.get(null);
  const servers = [];
  for (const [key, value] of Object.entries(all)) {
    if (isServerKey(key)) servers.push(value);
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return servers;
}

export async function loadServer(id) {
  const key = STORAGE.serverPrefix + id;
  return (await chrome.storage.local.get(key))[key] || null;
}

export async function saveServer(server) {
  if (!server.id) server.id = crypto.randomUUID();
  await chrome.storage.local.set({ [STORAGE.serverPrefix + server.id]: server });
  return server;
}

export async function deleteServer(id) {
  await chrome.storage.local.remove(STORAGE.serverPrefix + id);
}

// Versioned preferences blob. Bumping `v` lets us migrate shape later
// without silently corrupting old installs.
const PREF_DEFAULTS = Object.freeze({
  v: 1,
  order: "dateDesc",
  refreshSeconds: 2,
  actionMode: "popup",
  deleteDataByDefault: false,
  startOnAdd: true,
  badgeEnabled: true,
  notifyOnComplete: false
});

export async function loadPreferences() {
  const result = await chrome.storage.local.get(STORAGE.prefs);
  return { ...PREF_DEFAULTS, ...(result[STORAGE.prefs] || {}) };
}

export async function savePreferences(prefs) {
  await chrome.storage.local.set({ [STORAGE.prefs]: { ...prefs, v: PREF_DEFAULTS.v } });
}

// Transmission status codes — see the RPC spec.
export const STATUS = {
  STOPPED: 0,
  QUEUED_VERIFY: 1,
  VERIFYING: 2,
  QUEUED_DOWNLOAD: 3,
  DOWNLOADING: 4,
  QUEUED_SEED: 5,
  SEEDING: 6
};

export function statusLabel(code) {
  switch (code) {
    case STATUS.STOPPED: return "Stopped";
    case STATUS.QUEUED_VERIFY: return "Queued (verify)";
    case STATUS.VERIFYING: return "Verifying";
    case STATUS.QUEUED_DOWNLOAD: return "Queued";
    case STATUS.DOWNLOADING: return "Downloading";
    case STATUS.QUEUED_SEED: return "Queued (seed)";
    case STATUS.SEEDING: return "Seeding";
    default: return "Unknown";
  }
}
