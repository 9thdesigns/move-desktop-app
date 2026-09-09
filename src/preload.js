'use strict';

// The one bridge between the website and the shell. Exposed only to pages on
// the site itself (never to an OAuth provider page loaded in the window), and
// every call is validated again in the main process.
//
//   window.moveDesktop.isDesktop            – true
//   window.moveDesktop.version              – app version
//   window.moveDesktop.platform / .arch     – 'darwin' | 'win32', 'arm64' | 'x64'
//   window.moveDesktop.titleBarHeight       – height of the draggable strip
//   window.moveDesktop.openExternal(url)    – open an http(s) URL in the system browser
//   window.moveDesktop.setTitleBarOverlay({ color, symbolColor })
//                                           – recolour the Windows caption buttons

const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('move:app-info');

function isAppHost(hostname) {
  return hostname === info.appHost || hostname.endsWith(`.${info.appHost}`);
}

if (info && isAppHost(window.location.hostname)) {
  contextBridge.exposeInMainWorld('moveDesktop', {
    isDesktop: true,
    version: info.version,
    platform: info.platform,
    arch: info.arch,
    titleBarHeight: info.titleBarHeight,
    openExternal: (url) => ipcRenderer.invoke('move:open-external', String(url)),
    setTitleBarOverlay: (options) => ipcRenderer.invoke('move:set-titlebar-overlay', options || {}),
  });
}
