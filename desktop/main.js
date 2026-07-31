/**
 * Phantom desktop — Electron main process.
 *
 * The app is the same web application, with the server running as a child
 * process on a loopback port that nothing outside the machine can reach. That
 * keeps one codebase: the desktop build cannot drift from the web build,
 * because it *is* the web build.
 */

const { app, BrowserWindow, dialog, shell, Menu, Notification } = require('electron');
const path = require('node:path');
const { startServer } = require('./server');
const { checkForUpdate } = require('./updates');

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

/** How often to look for a new build while the app stays open. */
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Look for a newer build and offer it.
 *
 * Automatic checks stay quiet unless there is something to say — a dialog on
 * every launch saying "you are up to date" is noise. A manual check from the
 * menu always answers, because silence there reads as a broken button.
 */
async function checkUpdates({ manual = false } = {}) {
  const result = await checkForUpdate({ currentVersion: app.getVersion() });

  if (result.status === 'update') {
    // A system notification first: it is unobtrusive and survives the window
    // being in the background, which is where the app usually is.
    if (!manual && Notification.isSupported()) {
      const notification = new Notification({
        title: 'Phantom update available',
        body: `Version ${result.latest.version} is ready to download.`,
      });
      notification.on('click', () => shell.openExternal(result.releasesUrl));
      notification.show();
    }

    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `Phantom ${result.latest.version} is available.`,
      detail: `You are running ${app.getVersion()}.\n\nDownloads open in your browser. Install it over this copy — your work is not affected.`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(result.releasesUrl);
    return;
  }

  if (!manual) return;

  dialog.showMessageBox({
    type: result.status === 'current' ? 'info' : 'warning',
    title: result.status === 'current' ? 'Up to date' : 'Could not check',
    message:
      result.status === 'current'
        ? `Phantom ${app.getVersion()} is the latest version.`
        : 'Could not reach the update server.',
    detail: result.status === 'current' ? '' : result.reason,
    buttons: ['OK'],
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        label: 'Help',
        submenu: [
          { label: 'Check for Updates…', click: () => void checkUpdates({ manual: true }) },
          { type: 'separator' },
          {
            label: 'Open Releases Page',
            click: () => shell.openExternal(require('./updates').RELEASES_URL),
          },
        ],
      },
    ]),
  );

  try {
    server = await startServer({ serverDir });
    createWindow(server.url);

    // After the window, never before it: a slow or unreachable GitHub must
    // not delay the app opening. Packaged builds only — a development run
    // has a version that means nothing.
    if (app.isPackaged) {
      setTimeout(() => void checkUpdates(), 10_000).unref?.();
      setInterval(() => void checkUpdates(), UPDATE_INTERVAL_MS).unref?.();
    }
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
