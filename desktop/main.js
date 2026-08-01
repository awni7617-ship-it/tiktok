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
const { checkForUpdate, downloadUpdate, RELEASES_URL } = require('./updates');

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
 * Fetch the installer for this computer, then hand it to the OS.
 *
 * Progress goes on the taskbar/dock icon rather than in a modal, so the
 * download does not take the app hostage — a 100 MB transfer on a slow line
 * should not stop someone editing.
 *
 * The app deliberately does not install silently. These builds are unsigned,
 * so a silent replacement would be an unsigned binary swapping itself in
 * without the user ever seeing it — the OS's own installer prompt is the
 * check that keeps that honest.
 */
async function downloadAndOffer(version) {
  const target = app.getPath('downloads');

  try {
    window?.setProgressBar(0);

    const { path: file } = await downloadUpdate({
      version,
      targetDir: target,
      onProgress: (fraction) => window?.setProgressBar(fraction),
    });

    window?.setProgressBar(-1);

    const isLinux = process.platform === 'linux';
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update downloaded',
      message: `Phantom ${version} is ready to install.`,
      detail: isLinux
        ? `Saved to ${file}\n\nIt replaces the AppImage you are running now — quit Phantom first, then swap the file.`
        : `Saved to ${file}\n\nInstalling closes Phantom. Your projects are not affected.`,
      buttons: isLinux ? ['Show in Folder', 'Later'] : ['Install now', 'Show in Folder', 'Later'],
      defaultId: 0,
      cancelId: isLinux ? 1 : 2,
    });

    if (!isLinux && response === 0) {
      // Quit first: on Windows the installer cannot replace files that a
      // running process holds open.
      shell.openPath(file);
      app.quit();
      return;
    }
    if (response === (isLinux ? 0 : 1)) shell.showItemInFolder(file);
  } catch (error) {
    window?.setProgressBar(-1);

    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'Download failed',
      message: 'Phantom could not download the update.',
      detail: `${error instanceof Error ? error.message : String(error)}\n\nYou can download it from the releases page instead.`,
      buttons: ['Open Releases Page', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(RELEASES_URL);
  }
}

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
      // Clicking the notification starts the download rather than opening a
      // browser — the notification *is* the update button.
      notification.on('click', () => void downloadAndOffer(result.latest.version));
      notification.show();
    }

    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `Phantom ${result.latest.version} is available.`,
      detail: `You are running ${app.getVersion()}.\n\nPhantom can download it for you now. It is a few hundred megabytes, and progress shows on the app icon — you can keep working while it runs.`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) await downloadAndOffer(result.latest.version);
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
            click: () => shell.openExternal(RELEASES_URL),
          },
        ],
      },
    ]),
  );

  try {
    // The app directory is read-only once installed, so renders and their
    // intermediate assets go to the per-user data directory. Without this,
    // producing a video fails at the first file write.
    const renders = path.join(app.getPath('userData'), 'renders');
    server = await startServer({
      serverDir,
      env: { PHANTOM_OUTPUT_DIR: renders, MEDIA_TMP_DIR: renders },
    });
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
