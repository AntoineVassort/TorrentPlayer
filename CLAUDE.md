# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # launch Electron app in dev mode
npm run cli        # CLI mode: node src/index.js <magnet>
npm run dist       # build Windows exe (dist/TorrentPlayer-win32-x64/)
```

No linter, no test suite. Verify changes by running `npm start` and exercising the relevant feature.

## Architecture

**Process model:** Standard Electron — `src/main.js` is the main process (Node), `src/renderer/` is the renderer (browser context). They communicate exclusively through IPC.

**IPC bridge:** `src/preload.cjs` uses `contextBridge.exposeInMainWorld('api', {...})` to expose a typed `window.api` surface to the renderer. Every renderer→main call is `ipcRenderer.invoke`, every main→renderer push is `ipcRenderer.on`. The `.cjs` extension is mandatory — Electron requires preloads in CommonJS even when `"type": "module"` is set in package.json.

**ESM constraint:** The whole project is ESM (`"type": "module"`). WebTorrent v2 is ESM-only — `require()` anywhere will break. All `import/export`, no `require`.

**Torrent lifecycle in main.js:**
1. `client.add()` → WebTorrent resolves metadata
2. A raw `http.createServer` is created per torrent (port 8888+, auto-increments on EADDRINUSE)
3. Requests are served via `file.createReadStream({ start, end })` with range-request support
4. The active map `Map<infoHash, { torrent, fileState, server, port, magnet, speedHistory, playback, resumePos }>` tracks everything
5. A `setInterval` (1 s) pushes state to renderer via `mainWindow.webContents.send('torrent:state', [...])`

**WebTorrent v2 gotcha:** `torrent.createServer()` was removed — the HTTP server is built manually in `addTorrentInternal`. Stream errors from VLC dropping connections are silenced with `.on('error', () => {})`.

**mpv IPC:** When the player is mpv, main.js opens a named pipe (`\\.\pipe\mpvTP-<16chars>` on Windows) to read `time-pos`/`duration`. On socket close it saves `resumePos` to session if `pos > 5s`. On next play it passes `--start=<pos>` and clears `resumePos`.

**Persistence:**
- `userData/settings.json` — player path/args, download dir, throttle limits, deleteAfterPlay
- `userData/session.json` — active torrents restored on next launch (magnet + resumePos)

**Renderer (`src/renderer/renderer.js`):** Vanilla JS, no framework. `init()` wires everything. `renderList()` is called each time `torrent:state` arrives — it diffs the DOM (update existing cards, add new, remove stale). No virtual DOM.

**Player detection (`src/playerDetector.js`):** Windows registry (`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\`) → known paths → PATH fallback. Each player has a default args profile.

**Build:** `@electron/packager` (not electron-builder — it fails on Windows Home due to symlinks in winCodeSign). `--ignore=^/dist` regex excludes only the root `dist/` folder. `scripts/postbuild.mjs` copies back `node_modules/**/dist/` folders that packager deletes (data-uri-to-buffer, netmask, webtorrent…).

## Workflow Orchestration
### 1. Plan Node Default
Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions) If something goes sideways, STOP and re-plan immediately - don't keep pushing - Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity
### 2. Subagent Strategy
Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
One tack per subagent for focused execution
### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project
### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
Run tests, check logs, demonstrate correctness
### 5. Demand Elegance (Balanced)
For non-trivial changes: pause and ask "is there a more elegant way?"
If a fix feels hacky: "Knowing everything I know now, implement the elegant solution" Skip this for simple, obvious fixes - don't over-engineer
Challenge your own work before presenting it
### 6. Autonomous Bug Fizing
When given a bug report: just fix it. Don't ask for hand-holding Point at logs, errors, failing tests - then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how
## Task Management
1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to tasks/todo.md`
6. **Capture Lessons**: Update tasks/lessons.md after corrections
## Core Principles
- **Simplicity First**: Make every change as simple as possible. Impact minimal code. - 
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimat Impact**: Changes should only touch what's necessary. Avoid introducing bugs.



# TorrentPlayer

App desktop qui télécharge un torrent et lance la lecture en parallèle via un player externe déjà installé sur la machine de l'utilisateur (VLC, mpv, MPC-HC, etc.).

## Principe technique

WebTorrent télécharge le torrent en priorisant les pièces dans l'ordre de lecture (streaming sequential) et expose le fichier via `torrent.createServer()` en HTTP local avec range requests. L'app lance ensuite le player externe choisi avec cette URL HTTP en argument — le player gère seek, pause, buffering nativement.

Conséquence : pas de codecs à embarquer, pas de transcoding. Le player externe (qui lit déjà tout) fait le boulot.

## Stack

- **Electron + Node.js** pour l'app et l'UI
- **WebTorrent** pour le client torrent + serveur HTTP de streaming
- **Player externe** lancé via `child_process.spawn` détaché
- **electron-store** pour settings et historique

## Plan d'action

### Étape 1 — MVP CLI (1 soir)
Script Node minimaliste : prend un magnet en argument, démarre WebTorrent + `createServer()`, détecte VLC/mpv via le registre Windows, lance le player avec l'URL HTTP locale.

**Critère de succès** : la lecture démarre avant la fin du DL, le seek fonctionne.

### Étape 2 — Détection des players (1-2 jours)
Module `playerDetector.js` qui retourne la liste des players installés.

- **Windows** : registre `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<player>.exe` (source primaire) + chemins connus (`C:\Program Files\...`) + `where` en fallback
- **macOS/Linux** : scan `/Applications` ou `which` (à différer si Windows-first)
- Liste cible : mpv, VLC, MPC-HC, MPC-BE, PotPlayer
- Profil par player avec args recommandés pour streaming HTTP
  - mpv : `--cache=yes --demuxer-max-bytes=500M`
  - VLC : `--file-caching=10000`

### Étape 3 — Sélection du fichier dans le torrent (0.5 jour)
- 1 seul fichier vidéo → auto-sélection
- Plusieurs → UI de choix (liste avec tailles)
- Filtrer sur extensions vidéo : `.mp4`, `.mkv`, `.avi`, `.mov`, `.webm`

### Étape 4 — Shell Electron (3-5 jours)
- Champ d'ajout (magnet ou drag-drop d'un `.torrent`)
- Liste des téléchargements actifs : nom, progression, vitesse DL/UL, peers, bouton "Lire"
- Bouton "Lire" → `spawn(playerPath, [...args, streamUrl], { detached: true }).unref()`
- Page **Settings** : dropdown players détectés + "Parcourir...", champ args custom par player, bouton "Re-scanner"

### Étape 5 — Robustesse (2-3 jours)
- **Cycle de vie** : politique quand le player ferme / quand l'app ferme (DL continue en arrière-plan ou s'arrête ?)
- **Reprise** : sauvegarder l'état des torrents actifs entre sessions
- **Gestion d'erreurs** : magnet invalide, aucun peer, player introuvable, port occupé
- **Nettoyage disque** : option "supprimer après lecture" + dossier de cache configurable

### Étape 6 — Polish (optionnel)
- Historique avec reprise de position (mpv IPC ou VLC HTTP interface)
- Sous-titres : passer les `.srt` du torrent au player en argument
- Indicateur "buffer suffisant" (ex. attendre 2 % de DL avant de proposer "Lire")
- Limite de bande passante, ratio UL/DL

## Format des settings

```json
{
  "player": {
    "path": "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
    "args": ["--file-caching=10000"]
  },
  "downloadDir": "%APPDATA%\\TorrentPlayer\\downloads",
  "deleteAfterPlay": false,
  "detectedPlayers": []
}
```

## Lancement du player

```js
const { spawn } = require('child_process');
const child = spawn(playerPath, [...customArgs, streamUrl], {
  detached: true,
  stdio: 'ignore'
});
child.unref();
```

`detached: true` + `unref()` : fermer l'app ne tue pas le player, et inversement.

## Points de décision à trancher tôt

1. **Plateformes cibles** : Windows-only pour le MVP, ou cross-platform dès le début ?
2. **Disclaimer légal** au premier lancement (pas de tracker intégré, l'utilisateur est responsable du contenu)
3. **Emplacement du cache** : `%APPDATA%\TorrentPlayer\downloads` par défaut, configurable

## Estimations

- **MVP fonctionnel** (étapes 1-4) : ~1 à 1.5 semaine
- **v1 distribuable** (avec étape 5) : ~2-3 semaines
- **v1 polish** (avec étape 6) : ~1 mois

## Pièges connus

- **Codecs** : résolu en déléguant au player externe — ne pas régresser sur ce choix
- **Seek en avant** : WebTorrent re-priorise les pièces autour de la nouvelle position quand le player fait une range request — à tester sur de vrais torrents
- **Port occupé** : `createServer()` peut échouer, prévoir un retry sur port libre
- **Player système Windows** : "Films et TV" est souvent le défaut mais lit mal le HTTP streaming → préférer mpv > VLC > MPC-HC dans l'auto-sélection
