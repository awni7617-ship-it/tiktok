#!/usr/bin/env node
/**
 * Cloudflare preflight.
 *
 *   npm run cf:setup    # create what is missing, then report
 *   npm run cf:check    # report only, change nothing
 *
 * Every Cloudflare deploy failure this project has produced so far came from
 * the account not having something the config references — the R2 bucket, a
 * secret, a real Hyperdrive id. Wrangler reports those at deploy time, after
 * a multi-minute build, in an error that names the binding but not the fix.
 * This runs the same checks in a few seconds and prints the exact command.
 *
 * It is deliberately non-fatal for anything it cannot prove: a check that
 * cannot reach the API warns, it does not block a deploy that might work.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const fix = args.has('--fix');
const configFile = args.has('--containers') ? 'wrangler.containers.jsonc' : 'wrangler.jsonc';

const BUCKET = 'phantom-media';

/** Secrets the Worker cannot start without, and what each one is for. */
const REQUIRED_SECRETS = [
  ['DATABASE_URL', 'Postgres connection string (Neon, Supabase, RDS, your own)'],
  ['SESSION_SECRET', 'signs session cookies — openssl rand -base64 48'],
  ['ENCRYPTION_KEY', 'encrypts stored OAuth tokens — openssl rand -base64 48'],
];

const problems = [];
const warnings = [];
const done = [];

function wrangler(argv, { quiet = true } = {}) {
  return execFileSync('npx', ['wrangler', ...argv], {
    cwd: root,
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

/**
 * Pull the human-readable failure out of wrangler's output.
 *
 * Its stderr ends with a "logs were written to ..." line, so taking the last
 * line reports the log path instead of the problem.
 */
function firstError(output) {
  const lines = output
    // Colour codes survive the pipe and make the message unreadable.
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((line) => /error|✘|not authorized|unauthorized/i.test(line)) ??
    lines[0] ??
    'unknown error'
  );
}

function tryWrangler(argv) {
  try {
    return { ok: true, output: wrangler(argv) };
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    return { ok: false, output: `${stdout}${stderr}` || String(error) };
  }
}

// --- 1. Authentication ------------------------------------------------------
// Nothing below can be checked without it, so a failure here stops the rest
// from producing a page of misleading "missing" results.
const whoami = tryWrangler(['whoami']);
if (!whoami.ok) {
  console.error('✗ Not logged in to Cloudflare.\n');
  console.error('  Run:  npx wrangler login');
  console.error('  Or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.\n');
  process.exit(1);
}
done.push('authenticated with Cloudflare');

// --- 2. Config sanity -------------------------------------------------------
const configText = readFileSync(join(root, configFile), 'utf8');
if (configText.includes('REPLACE_WITH_YOUR_HYPERDRIVE_ID')) {
  problems.push({
    what: `${configFile} still contains the Hyperdrive placeholder id`,
    fix: [
      'npx wrangler hyperdrive create phantom-db \\',
      '  --connection-string="postgres://user:password@host:5432/db"',
      `then paste the returned id into ${configFile}`,
    ],
  });
}

// --- 3. R2 bucket -----------------------------------------------------------
const buckets = tryWrangler(['r2', 'bucket', 'list']);
// `wrangler whoami` can succeed with no credentials at all, so the first real
// API call is where missing auth actually surfaces.
if (!buckets.ok && /CLOUDFLARE_API_TOKEN|not authenticated|10000/i.test(buckets.output)) {
  console.error('\n✗ Not authenticated with Cloudflare.\n');
  console.error('  Run:  npx wrangler login');
  console.error('  Or set CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID).\n');
  process.exit(1);
}
if (!buckets.ok) {
  warnings.push(`could not list R2 buckets: ${firstError(buckets.output)}`);
} else if (buckets.output.includes(BUCKET)) {
  done.push(`R2 bucket "${BUCKET}" exists`);
} else if (fix) {
  const created = tryWrangler(['r2', 'bucket', 'create', BUCKET]);
  if (created.ok) done.push(`created R2 bucket "${BUCKET}"`);
  else problems.push({ what: `could not create R2 bucket "${BUCKET}"`, fix: [firstError(created.output)] });
} else {
  problems.push({
    what: `R2 bucket "${BUCKET}" does not exist`,
    fix: [`npx wrangler r2 bucket create ${BUCKET}`],
  });
}

// --- 4. Secrets -------------------------------------------------------------
// A Worker that has never been deployed has no secret list yet; that is not a
// failure, it just means the secrets have to be set before the first deploy.
const secrets = tryWrangler(['secret', 'list', '--config', configFile]);
const secretNames = secrets.ok
  ? [...secrets.output.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((match) => match[1])
  : [];

if (!secrets.ok && !/not found|does not exist|10007/i.test(secrets.output)) {
  warnings.push('could not read the Worker secret list; check them by hand');
}

for (const [name, purpose] of REQUIRED_SECRETS) {
  if (secretNames.includes(name)) {
    done.push(`secret ${name} is set`);
  } else {
    problems.push({
      what: `secret ${name} is not set — ${purpose}`,
      fix: [`npx wrangler secret put ${name}`],
    });
  }
}

// --- Report -----------------------------------------------------------------
console.log(`\nPhantom · Cloudflare preflight (${configFile})\n`);
for (const line of done) console.log(`  ✓ ${line}`);
for (const line of warnings) console.log(`  ! ${line}`);

if (problems.length === 0) {
  console.log('\nReady to deploy:  npm run cf:deploy\n');
  process.exit(0);
}

console.log(`\n  ${problems.length} thing${problems.length === 1 ? '' : 's'} to fix before deploying:\n`);
for (const problem of problems) {
  console.log(`  ✗ ${problem.what}`);
  for (const line of problem.fix) console.log(`      ${line}`);
  console.log('');
}
if (!fix) console.log('  `npm run cf:setup` creates the bucket for you.\n');
process.exit(1);
