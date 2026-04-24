# Chrome Web Store listing — Dispatch for Transmission

Paste the blocks below into the corresponding fields on the Web Store
developer dashboard (https://chrome.google.com/webstore/devconsole).
Text is British English.

---

## Category
**Productivity** (secondary: Developer Tools)

## Short description (132 characters max)

```
Fast, dark-mode control panel for your remote Transmission BitTorrent server. Add, pause, resume, remove, and manage files.
```

## Detailed description

```
A compact, dark-mode control panel for a Transmission BitTorrent daemon
running on your seedbox, home server, or NAS.

This is a third-party extension. It is not affiliated with, endorsed by,
or an official product of The Transmission Project. The name
"Transmission" describes compatibility only.

WHY THIS EXTENSION
• Dark, restrained Dracula interface designed for density, not decoration.
• Add torrents by magnet link, .torrent URL, file upload, or drag-and-drop.
• Start, pause, remove, and bulk-action your torrents with a click,
  a keyboard shortcut, or the right-click menu.
• Live progress bars, per-torrent download / upload rates, peer counts,
  ETA, and share ratio.
• Search across torrents by name.
• Right-click any magnet link or .torrent URL on a page to add it
  directly to a chosen server — with optional download-directory
  shortcuts (e.g. "Movies", "TV", "Software").
• Toolbar badge shows how many torrents have finished (toggle in
  settings).
• File manager: pick which files inside a torrent you want before it
  starts downloading.
• Multi-server: connect to as many Transmission instances as you like
  and switch between them with one click.
• Keyboard-first: O to add, Space to pause/resume, Del to remove,
  S or / to search, arrows to navigate, Enter to open the file list,
  Cmd/Ctrl+Shift+P to open the popup from anywhere.

WHAT IT IS NOT
• Not a torrent client itself — it needs a Transmission daemon running
  somewhere you can reach (local PC, NAS, seedbox, Raspberry Pi…).
• Not a tracker, not a search engine, not a cloud service.

PRIVACY
• No analytics. No telemetry. No ads.
• Credentials are stored locally in your browser profile and sent only
  to the Transmission server(s) you configure yourself.
• Host permission is requested lazily — the extension only asks Chrome
  for access to the specific server URL you add, not the whole web.

REQUIREMENTS
Transmission 3.x or newer, with remote access enabled
(Transmission → Preferences → Remote → Allow remote access).
Typical RPC URL: http://host:9091/transmission/rpc

Full privacy policy, keyboard shortcuts, and source are linked below.
```

## Permission justifications

Paste one-liners into the dashboard's "justification" fields.

| Permission | Justification (paste as-is) |
|---|---|
| `storage` | Persist the user's list of Transmission servers and preferences (sort order, refresh interval, units) in local browser storage. |
| `contextMenus` | Add an "Add torrent to <server>" right-click menu on magnet links and torrent URLs so users don't have to copy-paste. |
| `notifications` | Show a brief desktop notification confirming a torrent was added, or surfacing a connection/auth error from the server. |
| `scripting` | Needed by the right-click handler to fetch the target `.torrent` file from the current page context (so site cookies / auth cookies apply) before forwarding its bytes to Transmission. |
| `activeTab` | Access the current tab only at the moment of a user click on the context-menu entry, to read the link the user right-clicked. |
| `alarms` | Background poll (once every 30 seconds) so the toolbar-icon badge stays up to date when the popup is closed. |
| `optional_host_permissions` (`http://*/*`, `https://*/*`) | Make JSON-RPC calls to the exact Transmission server URL the user configures. Requested at runtime, per-host, only after the user clicks "Test connection" or "Save" — the extension is never granted the full web up-front. |

## Single purpose statement

```
Control a remote Transmission BitTorrent daemon: add, start, stop,
remove, and manage torrents from the browser toolbar.
```

## Distribution

- **Regions:** All regions.
- **Mature content:** No.
- **Visibility:** Public.
- **Pricing:** Free.

## Required URLs

- **Homepage URL** — your GitHub (or GitLab) repo URL.
- **Support URL** — repository issues page.
- **Privacy policy URL** — a public URL that serves `PRIVACY.md` (e.g.
  GitHub Pages: `https://stefan-bc.github.io/dispatch-for-transmission/privacy.html`
  or the raw markdown
  `https://github.com/stefan-bc/dispatch-for-transmission/blob/main/PRIVACY.md`).
  The URL **must** be publicly reachable when you submit.

## Screenshots (upload these)

1280 × 800 PNGs generated in `build/screenshots/`:

1. `01-list.png` — main torrent list populated with sample data.
2. `02-add.png` — "Add torrent" dialog open.
3. `03-options.png` — Server configuration page.

Upload **at least one** (more is better; the max is five).
