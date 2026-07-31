/**
 * Phantom desktop — Electron main process.
 *
 * The app is the same web application, with the server running as a child
 * process on a loopback port that nothing outside the machine can reach. That
 * keeps one codebase: the desktop build cannot drift from the web build,
 * because it *is* the web build.
 */

const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const { startServer } = require('./server');

// Packaged, the bundle is copied in as an extra resource; unpackaged, it is
// wherever `npm run package:editor` last wrote it.
const serverDir = app.isPackaged
  ? path.join(process.resourcesPath, 'app-server')
  : path.join(__dirname, '..', 'dist', 'phantom-editor');

let server = null;
let window = null;

function createWindow(url) {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    // No preload and no Node in the renderer: the page is ordinary web
    // content and has no reason to hold OS-level authority.
    webPreferences: { contextIsolation: true, nodeIntegration: false },
    show: false,
    title: 'Phantom',
  });

  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => {
    window = null;
  });

  // Anything aimed elsewhere — a platform's OAuth screen, a docs link — opens
  // in the real browser rather than a chromeless window with no address bar.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  window.loadURL(url);
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));

  try {
    server = await startServer({ serverDir });
    createWindow(server.url);
  } catch (error) {
    // A silent failure here is the worst outcome: the icon bounces and
    // nothing appears. Say what happened instead.
    dialog.showErrorBox(
      'Phantom could not start',
      `${error instanceof Error ? error.message : String(error)}`.slice(0, 2000),
    );
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && server) createWindow(server.url);
});

app.on('window-all-closed', () => {
  // macOS convention is to stay in the dock; everywhere else, closing the
  // window means quitting.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  server?.stop();
  server = null;
});
