'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  addTorrent:        (src)        => ipcRenderer.invoke('torrent:add', src),
  changeFile:        (id, idx)    => ipcRenderer.invoke('torrent:changeFile', id, idx),
  playTorrent:       (id)         => ipcRenderer.invoke('torrent:play', id),
  playLocal:         (id)         => ipcRenderer.invoke('torrent:playLocal', id),
  stopSeed:          (id)         => ipcRenderer.invoke('torrent:stopSeed', id),
  removeTorrent:     (id)         => ipcRenderer.invoke('torrent:remove', id),
  reorderQueue:      (order)      => ipcRenderer.invoke('queue:reorder', order),
  getHistory:        ()           => ipcRenderer.invoke('history:get'),
  removeHistory:     (id)         => ipcRenderer.invoke('history:remove', id),
  discoverDevices:   ()           => ipcRenderer.invoke('cast:discover'),
  castToDevice:      (id, host)   => ipcRenderer.invoke('cast:play', id, host),
  getSettings:       ()           => ipcRenderer.invoke('settings:get'),
  saveSettings:      (s)          => ipcRenderer.invoke('settings:save', s),
  testTmdb:          (key)        => ipcRenderer.invoke('settings:testTmdb', key),
  detectPlayers:     ()           => ipcRenderer.invoke('players:detect'),
  openTorrentDialog: ()           => ipcRenderer.invoke('dialog:torrent'),
  openPlayerDialog:  ()           => ipcRenderer.invoke('dialog:player'),
  openDirDialog:     ()           => ipcRenderer.invoke('dialog:directory'),
  searchTorrents:    (query)      => ipcRenderer.invoke('search:query', query),
  onState:           (cb)         => ipcRenderer.on('torrent:state', (_, data) => cb(data)),
  onClipboardMagnet: (cb)         => ipcRenderer.on('clipboard:magnet', (_, magnet) => cb(magnet)),
  // Window controls
  minimize:          ()           => ipcRenderer.send('window:minimize'),
  maximize:          ()           => ipcRenderer.send('window:maximize'),
  close:             ()           => ipcRenderer.send('window:close'),
  isMaximized:       ()           => ipcRenderer.invoke('window:isMaximized'),
  onMaximize:        (cb)         => ipcRenderer.on('window:maximize',   () => cb(true)),
  onUnmaximize:      (cb)         => ipcRenderer.on('window:unmaximize', () => cb(false)),
});
