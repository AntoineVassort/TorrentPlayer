# Changelog

All notable changes to TorrentPlayer are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [1.14.1] - 2026-11-09

> **About v1.14.0:** it was tagged but **never published**. Its release job was cancelled because GitHub retired the `macos-14` runner image (macOS Apple Silicon build), so no archive was ever uploaded. Everything from 1.14.0 is included here, plus the fix below.

### Fixed
- Removed the *Rarest first* download-order option that 1.14.0 added to Settings. WebTorrent's rarest-first rescans the whole selected window for every request: on a 130 MB torrent it kept the main thread ~93 % busy with 5–6 s freezes and ~1.5 MB/s, versus ~42 % busy and ~14 MB/s with the default sequential order. A `strategy` value already saved in `settings.json` is ignored.

### Changed
- The macOS Apple Silicon release job now builds on `macos-15` (the retired `macos-14` image made the whole release fail).

## [1.14.0] - 2026-11-09 (tag only — not published)

### Added
- **Network & performance settings** — download / upload speed limits, max connections per torrent, read-ahead window, stop-seeding at a ratio, and DHT / local peer discovery / UPnP-NAT-PMP / web seeds / listening port (those last ones apply at next launch). Sensible defaults and a one-click *Restore network defaults*.
- Redesigned Settings page: side navigation (General, Video player, Downloads, Network & performance, Subtitles, Torrentio), a description under every option and real toggle switches.

### Fixed
- Freeze on very large torrents (19–30 GB): WebTorrent re-scanned every piece of the selected range for every peer, saturating a CPU core in the main process. The download is now scheduled in a sliding window ahead of the first missing piece (512 MB by default); the whole file still downloads. Measured on a 21 GB torrent: 14–26 MB/s instead of ~15 KB/s.

### Changed
- Local builds are ~480 MB instead of ~2 GB (the untracked `.deepsec` folder is no longer packaged). Release builds were never affected.

## [1.13.0] - 2026-10-21

### Added
- Cast with subtitles: MKV embedded track, `.srt` shipped with the torrent, or OpenSubtitles, with an ON/OFF button in the app.
- On-the-fly AAC audio (bundled ffmpeg) when the receiver can't decode E-AC-3 / AC-3 / DTS.
- "Download the whole season" for season packs.

### Fixed
- Cast uses the local IP on the same subnet as the target device (not a WSL / link-local adapter).
- Abandoned stream readers are destroyed when the player's socket closes; `file.downloaded` is computed once per state tick.
- Device discovery is shared, which stops leaking mDNS / SSDP sockets.

## [1.12.0] - 2026-09-07

### Fixed
- Anime catalog: Jikan 504 now falls back to Kitsu.
- Correct MIME type and Range handling for cast.

### Changed
- Smarter "ready to play" buffer: contiguous pieces from the start of the file instead of a ratio of downloaded bytes.
- Upgraded to WebTorrent 3.
- CI: macOS build host pinned to Node 20.

## [1.11.11] - 2026-07-20

### Changed
- Refactor: `main.js` split into focused ESM modules (1255 → 209 lines); renderer files broken up.

## [1.11.10] - 2026-07-20
### Fixed
- Season packs: stream the episode you picked, not the biggest file.

## [1.11.9] - 2026-07-20
### Fixed
- Wrong posters: Cinemeta matches are scored by title + year instead of taking the first hit.

## [1.11.8] - 2026-07-02
### Fixed
- *Stop seeding* now disconnects peers instead of only choking them.

## [1.11.7] - 2026-07-02
### Fixed
- macOS crash "Symbol not found (basic_ifstream)" on older macOS.

## [1.11.6] - 2026-07-01
### Security
- Fixed findings from a security review: path traversal, LAN exposure of the stream, XSS, SSRF, and CI action pinning.

## [1.11.5] - 2026-06-27
### Fixed
- CI: macOS Intel build moved to `macos-15-intel` (`macos-13` was retired by GitHub).

## [1.10.3] - 2026-06-27
### Fixed
- macOS x64 build shipping the arm64 native binary of node-datachannel ("wrong architecture").

## [1.10.2] - 2026-06-26
### Changed
- macOS builds use Electron 32 to support macOS 10.15 Catalina (Windows / Linux stay on Electron 42).

## [1.10.1] - 2026-06-22
### Fixed
- Real *stop seeding* (uploads are cut, not just paused).
### Added
- Wider peer discovery with an auto-fetched public tracker list.

## [1.10.0] - 2026-06-16
### Added
- In-app self-update: download, swap and relaunch, on every OS.
### Fixed
- Double-teardown crash on quit.

## [1.9.1] - 2026-06-10
### Added
- Cross-platform builds (macOS x64 / arm64 and Linux) via a CI matrix.

## [1.9.0] - 2026-06-10
### Added
- DLNA / UPnP cast, quality auto-pick, watched markers and a series episode view.

## [1.8.0] - 2026-06-01
### Added
- Follow series with new-episode alerts (notification, one-click or opt-in auto-download) and a followed shelf in the Library.

## [1.7.0] - 2026-06-01
### Added
- Stalled-torrent recovery (switch release / retry), low-disk-space warning and a poster disk cache.

## [1.6.1] - 2026-06-01
### Changed
- CI: lint gate in the release workflow and lint on every push; auto-play next episode on by default.

## [1.6.0] - 2026-06-01
### Added
- VLC playback resume and auto-play next episode.

## [1.5.1] - 2026-06-01
### Added
- OpenSubtitles auto-fetch and a first-run player setup wizard.

## [1.5.0] - 2026-06-01
### Added
- Stalled-torrent detection, first-run legal disclaimer, and *Continue Watching* with progress bars in the library.

## [1.4.1] - 2026-06-01
### Security
- Hardening: XSS, CSP and `openExternal`.
### Added
- Per-file progress, live download speed in the tray, duplicate detection.

## [1.4.0] - 2026-06-01
### Added
- SVG icons, view transitions, skeleton loading, now-playing glow, keyboard shortcuts, debounced search, global stats bar.

## [1.3.1] - 2026-05-26
### Added
- Detail view, quality shortcuts, About modal, Debrid support.

## [1.3.0] - 2026-05-23
### Added
- Torrentio integration (movies, series, anime).
### Removed
- TMDB.

## [1.2.1] - 2026-05-18
### Added
- Hexagonal app icon and tray icon.

## [1.2.0] - 2026-05-18
### Changed
- UI redesign: cinematic dark theme, streaming-red accents, Outfit font.

## [1.1.1] - 2026-05-18
### Added
- Library sort and filter (type, date / title / rating).

## [1.1.0] - 2026-05-18
### Added
- i18n: English by default with a French option in Settings.

## [1.0.1] - 2026-05-18
### Fixed
- Repository information.

## [1.0.0] - 2026-05-18
- Initial tagged release.

## [0.2.0] - 2026-05-18
### Added
- Library view, multi-source search, filters and auto-update.

[1.14.1]: https://github.com/AntoineVassort/TorrentPlayer/compare/v1.14.0...v1.14.1
[1.14.0]: https://github.com/AntoineVassort/TorrentPlayer/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/AntoineVassort/TorrentPlayer/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/AntoineVassort/TorrentPlayer/compare/v1.11.11...v1.12.0
[1.11.11]: https://github.com/AntoineVassort/TorrentPlayer/compare/v1.11.10...v1.11.11
[1.11.10]: https://github.com/AntoineVassort/TorrentPlayer/compare/v1.11.9...v1.11.10
[1.11.9]: https://github.com/AntoineVassort/TorrentPlayer/compare/v1.11.8...v1.11.9
[1.11.8]: https://github.com/AntoineVassort/TorrentPlayer/compare/v1.11.7...v1.11.8
[1.11.7]: https://github.com/AntoineVassort/TorrentPlayer/compare/v1.11.6...v1.11.7
[1.11.6]: https://github.com/AntoineVassort/TorrentPlayer/compare/v1.11.5...v1.11.6
