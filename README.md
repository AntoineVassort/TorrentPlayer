# TorrentPlayer

Stream torrents through your existing video player — no codecs, no transcoding.

TorrentPlayer downloads and streams simultaneously. It serves the file over a local HTTP server with range-request support, then launches your external player (VLC, mpv, MPC-HC…) directly with the URL. Seeking, subtitles and buffering are handled natively by the player.

> **Windows-first.** macOS and Linux builds are available (`npm run dist:mac` / `dist:linux`) but less tested.

---

## Features

- **Search** — find movies, series and anime via [Torrentio](https://torrentio.strem.fun) (metadata from Cinemeta & Kitsu), with quality shortcuts (4K / 1080p / 720p / 480p)
- **Discover** — browse popular movies, currently-airing series and top anime without searching
- **Stream while downloading** — playback starts before the download completes
- **Continue Watching** — resume where you left off; the library shows a progress bar and a one-click resume
- **Auto-play next episode** — when an episode ends, the next one is fetched and played automatically (toggle in Settings)
- **Follow series** — ★ follow a series to get notified when a new episode airs; download it in one click, or auto-download (opt-in). Followed shows and their next air date appear in the Library
- **Resume position** — saved and restored for both mpv (IPC) and VLC (HTTP interface)
- **Subtitles** — uses `.srt`/`.ass`/`.vtt` embedded in the torrent, and can auto-fetch from OpenSubtitles when none are present
- **Smart queue** — download one at a time, drag to reorder
- **Stuck-download recovery** — when a torrent finds no peers, switch to another release (series/anime) or retry the search in one click; warns when disk space is low
- **Library** — media grid with posters, ratings and titles for everything you've watched (metadata via Cinemeta, no API key)
- **Chromecast** — cast to any device on your local network
- **Bandwidth limits** — optional max download / upload speed
- **Languages** — English & French
- **Auto-update** — notifies you when a new version is available
- **System tray** — closing the window minimizes to tray; tray shows live download speed
- **Clipboard detection** — paste a magnet link and the app picks it up automatically

---

## Installation

**No Node.js required.**

1. Go to [Releases](../../releases/latest)
2. Download `TorrentPlayer-Windows-x64.zip`
3. Extract anywhere
4. Run `TorrentPlayer.exe`

On first launch the app shows a short disclaimer, then helps you pick a video player (it auto-detects VLC, mpv, MPC-HC, MPC-BE, PotPlayer). No further configuration required.

---

## Supported players

| Player | Auto-detected | Resume position |
|--------|--------------|-----------------|
| mpv    | ✓            | ✓ (IPC)         |
| VLC    | ✓            | ✓ (HTTP)        |
| MPC-HC | ✓            | —               |
| MPC-BE | ✓            | —               |
| PotPlayer | ✓         | —               |

> mpv is recommended for the smoothest HTTP streaming.

---

## Optional: OpenSubtitles

If a torrent has no embedded subtitles, TorrentPlayer can fetch them automatically.

1. Create a free API key at [opensubtitles.com](https://www.opensubtitles.com/en/consumers)
2. Open **⚙ Settings → Subtitles**
3. Pick a subtitle language and paste your API key

---

## For developers

> Node.js is bundled in the release exe — end users don't need to install anything.

```bash
git clone https://github.com/AntoineVassort/TorrentPlayer
cd TorrentPlayer
npm install      # requires Node.js 18+
npm start        # dev mode
npm run lint     # ESLint (correctness checks)
npm run dist     # build Windows exe → dist/TorrentPlayer-win32-x64/
```

**Stack:** Electron · WebTorrent v2 · Vanilla JS (no framework) · ESM

---

## Legal

TorrentPlayer is a neutral tool. It does not host, index or distribute any content. Users are solely responsible for what they download. Only use it with content you have the right to access.

---

## License

[MIT](LICENSE)
