'use strict';

// Native menu bar: standard roles plus Back / Forward / Home and Help links.

const { Menu, app, shell } = require('electron');
const { APP_NAME, HELP_URL, RELEASES_URL } = require('./config');

function build({ getWindow, goHome, openInApp, checkForUpdates }) {
  const isMac = process.platform === 'darwin';

  const withWindow = (fn) => () => {
    const win = getWindow();
    if (win && !win.isDestroyed()) fn(win);
  };

  const checkForUpdatesItem = { label: 'Check for Updates…', click: () => checkForUpdates() };

  const template = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about' },
              checkForUpdatesItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => goHome({ newWindow: true }),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }, { type: 'separator' }, { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }]
          : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }]),
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        {
          label: 'Back',
          accelerator: isMac ? 'Cmd+[' : 'Alt+Left',
          click: withWindow((win) => win.webContents.navigationHistory.goBack()),
        },
        {
          label: 'Forward',
          accelerator: isMac ? 'Cmd+]' : 'Alt+Right',
          click: withWindow((win) => win.webContents.navigationHistory.goForward()),
        },
        { type: 'separator' },
        {
          label: 'Home',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => goHome({ newWindow: false }),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: `${APP_NAME} Help`, click: () => shell.openExternal(HELP_URL) },
        { label: 'Contact Support', click: () => openInApp('/support') },
        { type: 'separator' },
        { label: 'Release Notes', click: () => shell.openExternal(RELEASES_URL) },
        ...(isMac
          ? []
          : [
              { type: 'separator' },
              checkForUpdatesItem,
              {
                label: `About ${APP_NAME}`,
                click: () => {
                  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() });
                  app.showAboutPanel();
                },
              },
            ]),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { build };
