/**
 * The server half of the desktop app.
 *
 * Deliberately free of any Electron import: this is ordinary Node, so it can
 * be started and checked from a script or a test without a display, which is
 * the only way the app's startup path gets exercised anywhere but a laptop.
 */

const { fork } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

/** Ask the OS for a free port rather than guessing 3000 and colliding. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

/**
 * Start the bundled Next server and resolve once it is actually accepting
 * connections.
 *
 * Waiting for the port rather than a fixed delay is what keeps the window
 * from opening on a connection-refused page — the slowest part of startup is
 * the first request, and it varies by an order of magnitude across machines.
 */
async function startServer({ serverDir, env = {}, timeoutMs = 60_000 } = {}) {
  const port = await freePort();
  // Absolute, because the child's cwd is this same directory — a relative
  // path would be resolved against it a second time.
  const dir = path.resolve(serverDir);

  const child = fork(path.join(dir, 'server.js'), [], {
    cwd: dir,
    env: {
      ...process.env,
      ...env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const logs = [];
  const remember = (chunk) => {
    logs.push(chunk.toString());
    if (logs.length > 200) logs.shift();
  };
  child.stdout?.on('data', remember);
  child.stderr?.on('data', remember);

  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(`Server exited with code ${exited}.\n${logs.join('')}`);
    }
    if (await canConnect(port)) {
      return { url, port, child, stop: () => stop(child) };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  stop(child);
  throw new Error(`Server did not start within ${timeoutMs}ms.\n${logs.join('')}`);
}

function stop(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  // A Next server that ignores SIGTERM would otherwise outlive the window and
  // hold the port until the machine is rebooted.
  setTimeout(() => child.killed || child.kill('SIGKILL'), 3000).unref?.();
}

module.exports = { startServer, freePort, canConnect };
