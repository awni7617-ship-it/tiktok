'use strict';

/**
 * The desktop shell.
 *
 * Autoreel is a Next.js server and a worker loop. Packaging it means starting
 * that server on a free local port, waiting for it to answer, and pointing a
 * window at it — not reimplementing any of the app in Electron.
 *
 * The server runs as a child process rather than inside the main process so a
 * long ffmpeg render cannot freeze the window, and so a server crash can be
 * reported rather than taking the whole app down with it.
 */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');

/**
 * The last of the server's output, kept so a failure can show the user what
 * actually went wrong instead of a bare exit code.
 */
let serverLog = '';

function record(chunk) {
  serverLog = (serverLog + chunk).slice(-4000);
}

/** Where the assembled server bundle lives, packaged or not. */
function serverDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.join(__dirname, '..', 'dist', 'server');
}

/**
 * Everything the app owns, under Electron's per-user data directory, so an
 * uninstall has one place to clean and two installs cannot fight over a file.
 */
function dataDirectory() {
  return path.join(app.getPath('userData'), 'data');
}

/** Ask the OS for a free port by binding to 0 and reading back what we got. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Poll until the server answers, or give up. */
function waitForServer(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(
        { host: '127.0.0.1', port, path: '/api/health', timeout: 2000 },
        (response) => {
          response.resume();
          resolve();
        },
      );
      request.on('error', retry);
      request.on('timeout', () => {
        request.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error('the server did not start in time'));
        return;
      }
      setTimeout(attempt, 250);
    };

    attempt();
  });
}

let serverProcess = null;
let mainWindow = null;
let quitting = false;

async function startServer() {
  const port = await freePort();
  const dir = serverDirectory();
  const entry = path.join(dir, 'server.js');

  // A build packaged without the server bundle installs and launches perfectly
  // and then does nothing, because the spawn below fails against a path that
  // was never copied in. Saying so beats an empty screen.
  if (!fs.existsSync(entry)) {
    throw new Error(
      `This build is missing its server (expected ${entry}). It was packaged incorrectly — please report it.`,
    );
  }

  serverProcess = spawn(process.execPath, [entry], {
    cwd: dir,
    env: {
      ...process.env,
      // Runs Electron's bundled Node as plain Node, so the packaged app needs
      // no separate Node installation.
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      AUTOREEL_DATA_DIR: dataDirectory(),
      // In the desktop build the worker runs inside the server process. A
      // packaged app cannot ask its user to open a terminal.
      AUTOREEL_EMBEDDED_WORKER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (chunk) => {
    record(chunk);
    process.stdout.write(`[server] ${chunk}`);
  });
  serverProcess.stderr.on('data', (chunk) => {
    record(chunk);
    process.stderr.write(`[server] ${chunk}`);
  });

  // Without this, a spawn that fails outright raises an unhandled error and
  // the app dies with no window and no message.
  serverProcess.on('error', (error) => {
    serverProcess = null;
    if (quitting) return;
    dialog.showErrorBox('Autoreel could not start', `The server could not be launched: ${error.message}`);
    app.quit();
  });

  serverProcess.on('exit', (code) => {
    serverProcess = null;
    if (quitting) return;
    dialog.showErrorBox(
      'Autoreel stopped',
      [
        `The server exited unexpectedly (code ${code}).`,
        serverLog ? `\nLast output:\n${serverLog.slice(-1500)}` : '',
      ].join(''),
    );
    app.quit();
  });

  await waitForServer(port);
  return port;
}

function buildMenu(port) {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Data Folder',
          click: () => shell.openPath(dataDirectory()),
        },
        {
          label: 'Open in Browser',
          click: () => shell.openExternal(`http://127.0.0.1:${port}`),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'About Autoreel',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: 'Autoreel',
              message: `Autoreel ${app.getVersion()}`,
              detail: [
                'Pick a niche. Get faceless short-form video on autopilot.',
                '',
                `Data folder: ${dataDirectory()}`,
              ].join('\n'),
            }),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0a0a0f',
    // Nothing in the renderer needs Node, and the page is a local web app —
    // leaving these at their secure defaults costs nothing here.
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // `ready-to-show` never fires if the page fails to load, and a window that
  // is created but never shown is exactly the "nothing happens" symptom. Both
  // paths below guarantee the user sees something.
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    if (!mainWindow) return;
    mainWindow.show();
    dialog.showErrorBox(
      'Autoreel could not load',
      [
        `The app failed to load (${description}, code ${code}).`,
        url ? `\nURL: ${url}` : '',
        serverLog ? `\n\nLast server output:\n${serverLog.slice(-1500)}` : '',
      ].join(''),
    );
  });

  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  }, 10_000);

  // Anything that is not the local app opens in the real browser rather than
  // in a chromeless Electron window with no address bar.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

// A second instance would start a second server and a second worker, and the
// two would race for the same jobs.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      const port = await startServer();
      buildMenu(port);
      createWindow(port);

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
      });
    } catch (error) {
      dialog.showErrorBox('Autoreel could not start', String(error && error.message ? error.message : error));
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (serverProcess) serverProcess.kill();
  });
}
