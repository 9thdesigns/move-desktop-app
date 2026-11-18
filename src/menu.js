'use strict';

// Native menu bar: standard roles plus Back / Forward / Home, the site's main
// sections, Search, Settings and Help links. Every accelerator comes from
// src/shortcuts.js, which is unit tested for conflicts.

const { Menu, app } = require('electron');
const { APP_NAME, HELP_URL, RELEASES_URL } = require('./config');
const { shortcutMap } = require('./shortcuts');

function build({ getWindow, goHome, openInApp, openExternal, search, checkForUpdates }) {
  const isMac = process.platform === 'darwin';
  const keys = shortcutMap(process.platform);
  // A second binding for an item: hidden, but its accelerator still fires.
  const alias = (entry, item) => (entry ? [{ ...item, accelerator: entry.accelerator, visible: false, acceleratorWorksWhenHidden: true }] : []);

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
              { label: 'Settings…', accelerator: keys.settings.accelerator, click: () => openInApp(keys.settings.path) },
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
          accelerator: keys.newWindow.accelerator,
          click: () => goHome({ newWindow: true }),
        },
        { type: 'separator' },
        ...(isMac
          ? []
          : [{ label: 'Settings', accelerator: keys.settings.accelerator, click: () => openInApp(keys.settings.path) }, { type: 'separator' }]),
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
        { role: 'reload', accelerator: keys.reload.accelerator },
        ...alias(keys.reloadAlt, { role: 'reload' }),
        { role: 'forceReload', accelerator: keys.forceReload.accelerator },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
        { type: 'separator' },
        {
          label: 'Search…',
          accelerator: keys.search.accelerator,
          // The site owns Cmd/Ctrl+K (src/shortcuts.js): shown here, never
          // taken from the page.
          registerAccelerator: false,
          click: () => search(),
        },
        { type: 'separator' },
        { role: 'resetZoom', accelerator: keys.resetZoom.accelerator },
        { role: 'zoomIn', accelerator: keys.zoomIn.accelerator },
        ...alias(keys.zoomInAlt, { role: 'zoomIn' }),
        { role: 'zoomOut', accelerator: keys.zoomOut.accelerator },
        { type: 'separator' },
        { role: 'togglefullscreen', accelerator: keys.fullscreen.accelerator },
      ],
    },
    {
      label: 'History',
      submenu: [
        {
          label: 'Back',
          accelerator: keys.back.accelerator,
          click: withWindow((win) => win.webContents.navigationHistory.goBack()),
        },
        ...alias(keys.backAlt, { label: 'Back', click: withWindow((win) => win.webContents.navigationHistory.goBack()) }),
        {
          label: 'Forward',
          accelerator: keys.forward.accelerator,
          click: withWindow((win) => win.webContents.navigationHistory.goForward()),
        },
        ...alias(keys.forwardAlt, { label: 'Forward', click: withWindow((win) => win.webContents.navigationHistory.goForward()) }),
        { type: 'separator' },
        {
          label: 'Home',
          accelerator: keys.home.accelerator,
          click: () => goHome({ newWindow: false }),
        },
      ],
    },
    {
      label: 'Go',
      submenu: keys.sections.map((section) => ({
        label: section.label,
        accelerator: section.accelerator,
        click: () => openInApp(section.path),
      })),
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
        { label: `${APP_NAME} Help`, click: () => openExternal(HELP_URL) },
        { label: 'Contact Support', click: () => openInApp('/support') },
        { type: 'separator' },
        { label: 'Release Notes', click: () => openExternal(RELEASES_URL) },
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
