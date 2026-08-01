#!/usr/bin/env node
/**
 * Package the editor as a downloadable, runnable bundle.
 *
 *   npm run package:editor        # → dist/phantom-editor-<version>.zip
 *
 * The output is a Next.js standalone build: its own trimmed `node_modules`,
 * a `server.js`, the static assets, and the Prisma schema and migrations. It
 * runs with `node server.js` and a Postgres URL — no `npm install`, no build
 * step, no clone.
 *
 * CI runs this on every tag and attaches the zip to the GitHub release, which
 * is what makes the editor downloadable from GitHub rather than only
 * buildable from source.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** Resolved lazily: these packages download a platform binary on install. */
const ffmpegPath = () => require('ffmpeg-static');
const ffprobePath = () => require('ffprobe-static').path;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `phantom-editor-${pkg.version}`;
const dist = join(root, 'dist');
// The staged directory has a fixed name so the desktop build can reference it
// from a config file that must not change every time the version does.
const stage = join(dist, 'phantom-editor');

function run(command, argv, env = {}) {
  execFileSync(command, argv, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    // On Windows `npx` is `npx.cmd`, which execFileSync cannot spawn directly
    // — it fails with ENOENT and a pid of 0, naming the command but not the
    // reason. A shell resolves the extension.
    shell: process.platform === 'win32',
  });
}

// --- Build ------------------------------------------------------------------
// Skipped when CI has already produced the standalone output, so the release
// job does not pay for the same build twice.
if (!process.argv.includes('--skip-build')) {
  run('npx', ['prisma', 'generate']);
  run('npx', ['next', 'build'], { BUILD_STANDALONE: '1' });
}

const standalone = join(root, '.next', 'standalone');
if (!existsSync(standalone)) {
  console.error(
    'No standalone output at .next/standalone.\n' +
      'Build it with:  BUILD_STANDALONE=1 npx next build',
  );
  process.exit(1);
}

// --- Assemble ---------------------------------------------------------------
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// The standalone server, plus the two directories Next deliberately leaves
// out of it because they are served as files rather than required as code.
cpSync(standalone, stage, { recursive: true });
cpSync(join(root, '.next', 'static'), join(stage, '.next', 'static'), { recursive: true });
if (existsSync(join(root, 'public'))) {
  cpSync(join(root, 'public'), join(stage, 'public'), { recursive: true });
}

// Migrations travel with the build: a downloaded copy has to be able to
// create its own database without the repository.
cpSync(join(root, 'prisma'), join(stage, 'prisma'), { recursive: true });

// ffmpeg travels with the build too. It is the difference between an app that
// can make a video and one that can only describe one — and asking a creator
// to install a native binary by hand is exactly the kind of step that ends
// with "nothing works".
const binDir = join(stage, 'bin');
mkdirSync(binDir, { recursive: true });

for (const [name, from] of [
  ['ffmpeg', ffmpegPath()],
  ['ffprobe', ffprobePath()],
]) {
  if (!from || !existsSync(from)) {
    console.error(`Missing ${name} binary; the packaged app could not render video.`);
    process.exit(1);
  }
  const to = join(binDir, name + (from.endsWith('.exe') ? '.exe' : ''));
  cpSync(from, to);
  chmodSync(to, 0o755);
}
cpSync(join(root, '.env.example'), join(stage, '.env.example'));

// --- Prune ------------------------------------------------------------------
// Next's dependency trace is conservative: it keeps anything that *might* be
// required. These three cannot be, and together they are a third of the
// download.
//
//   - typescript / @types — compile-time only, never loaded by `server.js`
//   - sharp and its libvips binaries — only used to optimise `next/image`,
//     and this app renders no `next/image` anywhere
const PRUNE = ['typescript', '@types', 'sharp', '@img'];
for (const entry of PRUNE) {
  rmSync(join(stage, 'node_modules', entry), { recursive: true, force: true });
}

writeFileSync(
  join(stage, 'start.sh'),
  `#!/usr/bin/env bash
# Phantom editor — start script. No configuration required.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a

# The commonest failure is no Node at all, and the default message for that
# ("command not found") does not say what to install.
if ! command -v node > /dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org (version 20 or newer),"
  echo "then run this script again."
  exit 1
fi

# The editor itself is pure computation and runs without a database. Saving
# projects needs one; without DATABASE_URL the app still starts and says so,
# which is friendlier than refusing to open.
if [ -z "\${DATABASE_URL:-}" ]; then
  echo "No DATABASE_URL set — the editor will run, saving will not."
  echo "Set one in .env when you want projects to persist."
fi

echo "Phantom editor → http://localhost:\${PORT:-3000}"
exec node server.js
`,
  { mode: 0o755 },
);

writeFileSync(
  join(stage, 'start.cmd'),
  // `pause` at the end matters: double-clicked from Explorer, a .cmd window
  // closes the instant the command fails, which looks exactly like "nothing
  // happened". Keeping it open shows the reason.
  [
    '@echo off',
    'rem Phantom editor - start script. No configuration required.',
    'cd /d "%~dp0"',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo Node.js is not installed. Get it from https://nodejs.org ^(version 20 or newer^),',
    '  echo then run this file again.',
    '  pause',
    '  exit /b 1',
    ')',
    'if "%DATABASE_URL%"=="" echo No DATABASE_URL set - the editor will run, saving will not.',
    'echo Phantom editor -^> http://localhost:3000',
    'echo Leave this window open while you use it.',
    'node server.js',
    'pause',
    '',
  ].join('\r\n'),
);

writeFileSync(
  join(stage, 'README.md'),
  `# Phantom editor — ${pkg.version}

A self-contained build. Node 20.11+ is the only requirement — no clone, no
\`npm install\`, no database, no API key.

## Run it

\`\`\`bash
./start.sh          # → http://localhost:3000
\`\`\`

On Windows, double-click \`start.cmd\`.

That is the whole thing. Every AI capability falls back to a deterministic
offline provider that produces real output, so the editor — cut detection,
filler removal, pacing, reframing, captions, the optimizer — works
immediately. \`/settings\` shows which provider is serving each capability.

## If nothing happens

The page only exists while the server is running, so the terminal window has
to stay open. In order of likelihood:

1. **No Node.js.** Check with \`node --version\` — it must print v20 or
   higher. If it does not, install from https://nodejs.org and try again.
2. **The window closed instantly.** That means the command failed. On
   Windows, open a terminal in this folder and run \`node server.js\` so the
   error stays on screen.
3. **Port 3000 is taken.** Start it somewhere else: \`PORT=8080 ./start.sh\`
   (Windows: \`set PORT=8080\` then \`node server.js\`), and open
   http://localhost:8080.
4. **You are on a machine that did not build this.** The bundle carries a
   Linux database engine. The editor still runs anywhere Node runs; only
   saving needs a matching engine, and it will say so rather than fail to
   start.

Whatever the terminal prints when it stops is the answer — it is never
silent.

## Adding a database (optional)

Without one the editor runs but nothing persists between restarts. To keep
projects, point it at any Postgres:

\`\`\`bash
cp .env.example .env                    # set DATABASE_URL
npx prisma migrate deploy               # create the schema
./start.sh
\`\`\`

## What needs more than this bundle

**Rendering.** Exporting a finished video runs ffmpeg, which is not included
here. Install ffmpeg and put it on \`PATH\` (or set \`FFMPEG_PATH\` and
\`FFPROBE_PATH\`), then run the background worker from a source checkout with
\`npm run worker\`. Everything up to export works without it: the editor is a
review surface over cut plans, and those are computed in-process.

**Publishing.** Connecting a social account needs that platform's OAuth
credentials in \`.env\`, and nothing is ever posted without you authorising the
connection and approving the post.
`,
);

// The lockfile's exact dependency set is already baked into the standalone
// node_modules; the manifest is here so `node server.js` and tooling see a
// sane package name and version.
writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: 'phantom-editor',
      version: pkg.version,
      private: true,
      engines: pkg.engines,
      scripts: { start: 'node server.js', 'db:deploy': 'prisma migrate deploy' },
    },
    null,
    2,
  )}\n`,
);

// --- Archive ----------------------------------------------------------------
// The desktop build consumes the staged directory directly and has no use for
// an archive — which matters because `zip` does not exist on a Windows runner,
// and a missing archiver should not fail a build that never needed one.
if (process.argv.includes('--no-archive')) {
  console.log(`\nStaged: dist/phantom-editor\n`);
} else {
  // Zipped under the versioned name even though the directory on disk is not,
  // so the download says which build it is.
  const zip = join(dist, `${name}.zip`);
  rmSync(zip, { force: true });
  execFileSync('zip', ['-qr', zip, 'phantom-editor'], { cwd: dist, stdio: 'inherit' });

  console.log(`\nPackaged: dist/${name}.zip\n`);
}
