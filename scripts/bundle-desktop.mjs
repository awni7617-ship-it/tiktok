#!/usr/bin/env node
/**
 * Assemble the server bundle the desktop app ships.
 *
 * Next's `standalone` output is nearly what we need — a `server.js` plus a
 * trimmed `node_modules` — but it deliberately leaves out two things it cannot
 * know are needed at runtime: the static assets, and the ffmpeg binaries,
 * which are data files rather than anything the tracer can follow through a
 * `require`.
 *
 * The result goes in `dist/server/` and is shipped as an extra resource rather
 * than inside `app.asar`, because a Node server reading its own build output
 * from inside an archive is a class of bug not worth inviting.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const dist = path.join(root, 'dist', 'server');
const standalone = path.join(root, '.next', 'standalone');

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function copyBinaryPackage(name) {
  // Resolve the package's own directory, then copy it whole. Copying just the
  // binary would leave the `require(name)` that finds it without a package to
  // resolve.
  const entry = require.resolve(name);
  const packageDir = path.dirname(entry);
  const target = path.join(dist, 'node_modules', name);

  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(packageDir, target, { recursive: true });

  // `cp` preserves the mode on most platforms, but a bundle that ships a
  // non-executable ffmpeg fails at the last possible moment — during a render.
  for (const file of await fs.readdir(target)) {
    if (/^(ffmpeg|ffprobe)(\.exe)?$/.test(file)) {
      await fs.chmod(path.join(target, file), 0o755);
    }
  }
}

async function main() {
  console.log('› building the standalone server');
  await fs.rm(path.join(root, 'dist'), { recursive: true, force: true });
  run('npx', ['next', 'build'], { BUILD_STANDALONE: '1' });

  if (!(await exists(standalone))) {
    throw new Error('next build produced no standalone output — is BUILD_STANDALONE set?');
  }

  console.log('› assembling dist/server');
  await fs.mkdir(dist, { recursive: true });
  await fs.cp(standalone, dist, { recursive: true });

  // Static assets are emitted outside the standalone tree and served from
  // `.next/static`, so without this every page loads unstyled with no JS.
  await fs.cp(path.join(root, '.next', 'static'), path.join(dist, '.next', 'static'), {
    recursive: true,
  });

  if (await exists(path.join(root, 'public'))) {
    await fs.cp(path.join(root, 'public'), path.join(dist, 'public'), { recursive: true });
  }

  console.log('› copying ffmpeg and ffprobe');
  await copyBinaryPackage('ffmpeg-static');
  await copyBinaryPackage('ffprobe-static');

  console.log(`✓ bundled to ${path.relative(root, dist)}`);
}

main().catch((error) => {
  console.error('bundle failed:', error.message);
  process.exit(1);
});
