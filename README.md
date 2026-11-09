# TorrentPlayer

Stream torrents through your existing video player — no codecs, no transcoding.

TorrentPlayer downloads and streams simultaneously. It serves the file over a local HTTP server with range-request support, then launches your external player (VLC, mpv, MPC-HC…) directly with the URL. Seeking, subtitles and buffering are handled natively by the player.

The interface is **inspired by Popcorn Time** — a poster wall you browse by Movies / TV Series / Anime, filter by genre and sort, with infinite scroll, a rich detail view (seasons, episodes, synopsis) and a clean full-screen download screen.

> **Windows-first.** macOS (Intel and Apple Silicon) and Linux builds are published with every release, but they are less tested than the Windows one.

---

## Features

- **Browse** — a Popcorn Time–style poster wall of popular movies, series and anime, with **Genre** and **Sort** filters and **infinite scroll** that loads more as you go (metadata from Cinemeta & Kitsu)
- **Detail view** — click any title for a full-screen page: backdrop, synopsis, rating, and for series a **Seasons │ Episodes │ Episode-info** layout with one-click **Watch Now**
- **Download screen** — a clean full-screen view while a pick buffers (progress, speeds, peers, cancel); the player launches automatically once there's enough to play
- **Search** — find movies, series and anime via [Torrentio](https://torrentio.strem.fun), with quality shortcuts (4K / 1080p / 720p / 480p)
- **Stream while downloading** — playback starts before the download completes
- **Continue Watching** — resume where you left off; the library shows a progress bar and a one-click resume
- **Auto-play next episode** — when an episode ends, the next one is fetched and played automatically (toggle in Settings)
- **Follow series** — ★ follow a series to get notified when a new episode airs; download it in one click, or auto-download (opt-in). Followed shows and their next air date appear in the Library
- **Episode view & watched markers** — browse a followed series season-by-season, with a ✓ on episodes (and library items) you've already watched
- **Quality auto-pick** — set a preferred quality (4K / 1080p / 720p / 480p) and the best matching stream is added automatically, skipping the stream list
- **Resume position** — saved and restored for both mpv (IPC) and VLC (HTTP interface)
- **Subtitles** — uses `.srt` / `.ass` / `.ssa` / `.vtt` / `.sub` files shipped in the torrent, and can auto-fetch from OpenSubtitles when none are present
- **Smart queue** — download one at a time, drag to reorder
- **Stuck-download recovery** — when a torrent finds no peers, switch to another release (series/anime) or retry the search in one click; warns when disk space is low
- **Library** — media grid with posters, ratings and titles for everything you've watched (metadata via Cinemeta, no API key)
- **Cast** — stream to Chromecast or DLNA/UPnP devices on your local network. Subtitles (embedded in the MKV, shipped with the torrent, or from OpenSubtitles) are sent as a track you can toggle from the app; audio the receiver can't decode (E-AC-3, AC-3, DTS) is converted to AAC on the fly with a bundled ffmpeg
- **Network & performance settings** — a dedicated Settings page: max download / upload speed, max connections per torrent, read-ahead window, stop-seeding ratio, and DHT / local discovery / UPnP-NAT-PMP / web seeds / protocol encryption / listening port. Sensible defaults, one-click "restore defaults"
- **Verification progress** — when a big torrent re-checks its files after a restart, its card shows the real progress ("Verifying files… 42 %") and can be cancelled
- **Big-file friendly** — the download is scheduled in a sliding window ahead of the missing data, so 20 GB+ torrents no longer saturate the app's main thread
- **Keyboard shortcuts** — `Ctrl+K` (or `/`) opens the search, `Esc` goes back
- **Languages** — English & French
- **Auto-update** — download and install new versions from inside the app, in one click
- **System tray** — closing the window minimizes to tray; tray shows live download speed
- **Clipboard detection** — paste a magnet link and the app picks it up automatically

---

## Installation

**No Node.js required.**

1. Go to [Releases](../../releases/latest)
2. Download `TorrentPlayer-Windows-x64.zip`
3. Extract anywhere
4. Run `TorrentPlayer.exe`

macOS (Intel / Apple Silicon) and Linux builds are attached to each release as `TorrentPlayer-macOS-x64.zip`, `TorrentPlayer-macOS-arm64.zip` and `TorrentPlayer-Linux-x64.zip` (less tested than Windows). See the [CHANGELOG](CHANGELOG.md) for what changed in each version.

On first launch the app shows a short disclaimer, then helps you pick a video player. It auto-detects the players installed on your machine (see below); you can also browse to any other player manually. No further configuration required.

---

## Supported players

| Player    | Auto-detected on            | Resume position |
|-----------|-----------------------------|-----------------|
| mpv       | Windows, macOS, Linux       | ✓ (IPC)         |
| VLC       | Windows, macOS, Linux       | ✓ (HTTP)        |
| MPC-HC    | Windows                     | —               |
| MPC-BE    | Windows                     | —               |
| PotPlayer | Windows                     | —               |
| IINA      | macOS                       | —               |
| MPlayer, SMPlayer, Celluloid | Linux    | —               |

> mpv is recommended for the smoothest HTTP streaming. Any other player that accepts a URL can be added with **Settings → Video player → Browse…**

---

## Optional: OpenSubtitles

If a torrent has no embedded subtitles, TorrentPlayer can fetch them automatically.

1. Create a free API key at [opensubtitles.com](https://www.opensubtitles.com/en/consumers)
2. Open **⚙ Settings → Subtitles**
3. Pick a subtitle language and paste your API key

> Settings is organised in a side navigation: General, Video player, Downloads, Network & performance, Subtitles and Torrentio.

---

## For developers

> Node.js is bundled in the release exe — end users don't need to install anything.

```bash
git clone https://github.com/AntoineVassort/TorrentPlayer
cd TorrentPlayer
npm install      # requires Node.js 22+ (WebTorrent v3)
npm start        # dev mode
npm run cli -- "<magnet>"   # headless CLI: download + launch your player, no UI
npm run lint     # ESLint (correctness checks)
npm run dist     # build Windows exe → dist/TorrentPlayer-win32-x64/
npm run dist:mac-x64 / dist:mac-arm64 / dist:linux   # other platforms (build on the matching OS)
```

Releases are built by GitHub Actions when a `vX.Y.Z` tag is pushed; the release notes are taken from the matching section of the [CHANGELOG](CHANGELOG.md).

**Stack:** Electron · WebTorrent v3 · Vanilla JS (no framework) · ESM

---

## Legal

TorrentPlayer is a neutral tool. It does not host, index or distribute any content. Users are solely responsible for what they download. Only use it with content you have the right to access.

---

## License

[MIT](LICENSE)
