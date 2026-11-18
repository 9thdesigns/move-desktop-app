'use strict';

// Bridge for the launch splash (src/splash.html), and nothing else. The
// splash is a local page in its own sandboxed view; all it can do is listen
// for state changes and ask for a retry. src/splash.js checks that these
// messages come from the splash view before acting on them.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('moveSplash', {
  onState: (listener) => {
    if (typeof listener !== 'function') return;
    ipcRenderer.on('move-splash:state', (_event, snapshot) => listener(snapshot));
    ipcRenderer.send('move-splash:hello');
  },
  retry: () => ipcRenderer.send('move-splash:retry'),
  online: () => ipcRenderer.send('move-splash:online'),
});
