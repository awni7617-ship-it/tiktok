'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Refuse to package an app with no server in it.
 *
 * `extraResources` treats a missing source directory as a warning and lets the
 * build exit 0, so forgetting to run `desktop:bundle` produces an installer
 * that looks perfectly normal, installs fine, and then does nothing at all —
 * the shell starts, spawns a `server.js` that was never copied in, and no
 * window ever appears.
 *
 * That shipped once. This makes it impossible however electron-builder is
 * invoked, rather than relying on every caller remembering the right order.
 */
exports.default = async function beforePack(context) {
  const root = context.packager.info.projectDir;
  const server = path.join(root, 'dist', 'server', 'server.js');

  if (!fs.existsSync(server)) {
    throw new Error(
      [
        'The server bundle is missing, so this build would produce an app that starts and does nothing.',
        `Expected: ${server}`,
        '',
        'Run `npm run desktop:bundle` first, or use `npm run desktop:build`, which does both.',
      ].join('\n'),
    );
  }

  // A bundle without the static assets renders every page unstyled with no
  // JavaScript, which is its own silent-looking failure.
  const staticDir = path.join(root, 'dist', 'server', '.next', 'static');
  if (!fs.existsSync(staticDir)) {
    throw new Error(`The server bundle has no static assets. Expected: ${staticDir}`);
  }
};
