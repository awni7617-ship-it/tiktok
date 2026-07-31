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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `phantom-editor-${pkg.version}`;
const dist = join(root, 'dist');
const stage = join(dist, name);

function run(command, argv, env = {}) {
  execFileSync(command, argv, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
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
cpSync(join(root, '.env.example'), join(stage, '.env.example'));

writeFileSync(
  join(stage, 'start.sh'),
  `#!/usr/bin/env bash
# Phantom editor — start script. No configuration required.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a

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
  `@echo off\r\nrem Phantom editor - start script. No configuration required.\r\ncd /d "%~dp0"\r\nif "%DATABASE_URL%"=="" echo No DATABASE_URL set - the editor will run, saving will not.\r\necho Phantom editor -^> http://localhost:3000\r\nnode server.js\r\n`,
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
const zip = join(dist, `${name}.zip`);
rmSync(zip, { force: true });
execFileSync('zip', ['-qr', zip, name], { cwd: dist, stdio: 'inherit' });

console.log(`\nPackaged: dist/${name}.zip\n`);
