# TorrentPlayer

Stream torrents through your existing video player — no codecs, no transcoding.

TorrentPlayer downloads and streams simultaneously. It serves the file over a local HTTP server with range-request support, then launches your external player (VLC, mpv, MPC-HC…) directly with the URL. Seeking, subtitles and buffering are handled natively by the player.

> **Windows only** — macOS/Linux detection is partial, contributions welcome.

---

## Features

- **Search** — built-in search powered by a public torrent index
- **Stream while downloading** — playback starts before the download completes
- **Smart queue** — download one at a time, drag to reorder
- **TMDB metadata** — automatic posters, titles, ratings (optional API key)
- **mpv resume** — saves and restores playback position via IPC
- **Subtitles** — auto-detects `.srt`/`.ass`/`.vtt` in the torrent and passes them to the player
- **Chromecast** — cast to any device on your local network
- **History** — browse and re-download previously watched torrents
- **System tray** — closing the window minimizes to tray
- **Clipboard detection** — paste a magnet link and the app picks it up automatically

---

## Installation

**No Node.js required.**

1. Go to [Releases](../../releases/latest)
2. Download `TorrentPlayer-Windows-x64.zip`
3. Extract anywhere
4. Run `TorrentPlayer.exe`

The app auto-detects installed players (VLC, mpv, MPC-HC, MPC-BE, PotPlayer). No configuration required to get started.

---

## Supported players

| Player | Auto-detected | Resume position |
|--------|--------------|-----------------|
| mpv    | ✓            | ✓ (via IPC)     |
| VLC    | ✓            | —               |
| MPC-HC | ✓            | —               |
| MPC-BE | ✓            | —               |
| PotPlayer | ✓         | —               |

---

## Optional: TMDB posters

1. Create a free account at [themoviedb.org](https://www.themoviedb.org/)
2. Go to **Settings → API** and copy your **Read Access Token**
3. Paste it in TorrentPlayer → **⚙ Settings → Métadonnées**

---

## For developers

> Node.js is bundled in the release exe — end users don't need to install anything.

```bash
git clone https://github.com/AntoineVassort/TorrentPlayer
cd TorrentPlayer
npm install      # requires Node.js 18+
npm start        # dev mode
npm run dist     # build Windows exe → dist/TorrentPlayer-win32-x64/
```

**Stack:** Electron · WebTorrent v2 · Vanilla JS · No framework

---

## Legal

TorrentPlayer is a neutral tool. It does not host, index or distribute any content. Users are solely responsible for what they download. Only use it with content you have the right to access.

---

## License

[MIT](LICENSE)
