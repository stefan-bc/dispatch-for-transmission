# Privacy Policy — Dispatch for Transmission

**Last updated:** 24 April 2026

> This is a third-party extension. It is not affiliated with, endorsed by,
> or an official product of The Transmission Project. "Transmission"
> is used nominatively to describe compatibility with the Transmission
> BitTorrent client.

Dispatch for Transmission is a Chrome extension that lets you control a
Transmission BitTorrent daemon from your browser. This page explains, in
plain English, what data the extension handles and where it goes.

## What data the extension handles

The extension stores and processes the following, **only** on your device:

- **Transmission server details you enter** — name, RPC URL, optional
  Web UI URL, optional username, optional password, and any download
  directory shortcuts you configure.
- **Torrent data** received from your own Transmission server — names,
  sizes, progress, peers, file lists. This data is only held in memory
  for the duration of the popup / tab session.
- **User preferences** — sort order, refresh interval, toolbar-badge
  toggle, and the like.

## Where the data goes

- **Nowhere outside your browser and your Transmission server.**
- The extension makes network requests only to the RPC URL(s) you
  configure yourself. Every request is a JSON-RPC call to Transmission's
  documented `/transmission/rpc` endpoint.
- There is **no analytics, no telemetry, no crash reporting, no
  advertising**, and no third-party SDKs.
- The extension **never** sends your server credentials, torrents, or
  any other data to the extension author, to Google, or to any other
  third party.

## Storage

- Server configurations and preferences are saved in
  `chrome.storage.local`, which is local to your browser profile on your
  machine. This storage is **not** synced to Chrome Sync and is not
  transmitted off your device.
- Transmission's per-session ID (used for the RPC handshake) is kept in
  `chrome.storage.session`, which is cleared automatically when you
  close the browser.
- Passwords, if you set them, are stored **as entered**. They are not
  encrypted at rest beyond the protection Chrome provides for its own
  local storage. Do not use the extension on a shared browser profile
  you do not control.

## Permissions

The extension requests the following Chrome permissions. Each is used
solely for the purpose listed:

| Permission | Why it's needed |
|---|---|
| `storage` | Save your server list and preferences on your device. |
| `contextMenus` | Add a right-click "Add torrent to…" entry on magnet links and `.torrent` URLs. |
| `notifications` | Show a desktop notification when a torrent is added or fails. |
| `scripting` | Fetch `.torrent` files from the current page using your existing site cookies when you right-click a link. |
| `activeTab` | Access the current tab only when you right-click, to forward the link/URL. |
| `alarms` | Run a short background poll (once every 30 seconds) so the toolbar-icon badge stays current when the popup is closed. |
| `optional_host_permissions: http(s)://*/*` | Contact the RPC endpoint(s) you configure. Requested **only** for the host you add, and only at the moment you click "Test connection" or "Save" in settings. |

The extension does **not** request broad host permissions up-front — it
only asks for access to the specific Transmission server(s) you add.

## Your rights

- You can remove any server, and therefore any stored credentials, from
  the extension's settings page at any time.
- Uninstalling the extension deletes all of its stored data.

## Contact

Questions about this policy? Open an issue on the project repository or
contact the developer via the Chrome Web Store listing's support link.
