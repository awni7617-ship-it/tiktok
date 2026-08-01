/**
 * Update checking.
 *
 * The app asks GitHub what the current build is, compares it with its own
 * version, and tells the user when there is a newer one. It does not install
 * anything: these builds are unsigned, and macOS refuses to auto-install an
 * unsigned update — an updater that silently fails on one platform is worse
 * than one that consistently points at the download.
 *
 * The comparison and parsing are pure and exported separately so they can be
 * tested without a network or a window.
 */

const DOWNLOAD_BASE = 'https://github.com/awni7617-ship-it/tiktok/releases/download/latest';
const VERSION_URL = `${DOWNLOAD_BASE}/version.json`;
const CHECKSUMS_URL = `${DOWNLOAD_BASE}/SHA256SUMS.txt`;
const RELEASES_URL = 'https://github.com/awni7617-ship-it/tiktok/releases/latest';

/**
 * Compare two dotted numeric versions.
 *
 * Returns a negative number when `a` is older, 0 when equal, positive when
 * newer. Any pre-release suffix is ignored: `0.1.5-beta` and `0.1.5` are the
 * same build as far as "should I nag the user" is concerned.
 */
function compareVersions(a, b) {
  const parts = (value) =>
    String(value ?? '')
      .split('-')[0]
      .split('.')
      .map((piece) => Number.parseInt(piece, 10) || 0);

  const left = parts(a);
  const right = parts(b);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isNewer(current, candidate) {
  return compareVersions(candidate, current) > 0;
}

/**
 * Read the published version descriptor.
 *
 * Anything malformed is treated as "no information", never as an update —
 * a bad file must not produce a prompt to download something that is not
 * there.
 */
function parseVersionInfo(text) {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data.version !== 'string') return null;
    return {
      version: data.version,
      publishedAt: typeof data.publishedAt === 'string' ? data.publishedAt : null,
      notes: typeof data.notes === 'string' ? data.notes : null,
    };
  } catch {
    return null;
  }
}

/**
 * Ask GitHub for the current build.
 *
 * `fetchImpl` is injectable so tests never touch the network. A failure
 * resolves to a status rather than throwing, because a background check that
 * crashes the app on a flaky connection is unacceptable.
 */
async function checkForUpdate({
  currentVersion,
  fetchImpl = globalThis.fetch,
  url = VERSION_URL,
  timeoutMs = 8000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return { status: 'unknown', reason: `HTTP ${response.status}` };

    const info = parseVersionInfo(await response.text());
    if (!info) return { status: 'unknown', reason: 'malformed version file' };

    return isNewer(currentVersion, info.version)
      ? { status: 'update', latest: info, releasesUrl: RELEASES_URL }
      : { status: 'current', latest: info };
  } catch (error) {
    return {
      status: 'unknown',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which file this computer needs.
 *
 * The names come from electron-builder's defaults, so they are derived rather
 * than listed — a version bump must not require editing this.
 */
function assetNameFor({ platform = process.platform, arch = process.arch, version }) {
  if (platform === 'win32') return `Phantom-Setup-${version}.exe`;
  if (platform === 'darwin') {
    return arch === 'arm64' ? `Phantom-${version}-arm64.dmg` : `Phantom-${version}.dmg`;
  }
  return `Phantom-${version}.AppImage`;
}

/** Parse `sha256sum` output into a filename → hash map. */
function parseChecksums(text) {
  const table = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (match?.[1] && match[2]) table.set(match[2], match[1].toLowerCase());
  }
  return table;
}

/**
 * Download the installer for this computer and verify it.
 *
 * The checksum check is not ceremony: this file is about to be executed with
 * the user's privileges, and the only thing standing between "downloaded over
 * a hostile network" and "ran the installer" is this comparison. A mismatch
 * deletes the file and fails loudly.
 */
async function downloadUpdate({
  version,
  targetDir,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  onProgress,
  base = DOWNLOAD_BASE,
  checksumsUrl = CHECKSUMS_URL,
} = {}) {
  const { createWriteStream, promises: fs } = require('node:fs');
  const { createHash } = require('node:crypto');
  const { pipeline } = require('node:stream/promises');
  const { Readable } = require('node:stream');
  const path = require('node:path');

  const asset = assetNameFor({ platform, arch, version });
  const destination = path.join(targetDir, asset);

  const checksumResponse = await fetchImpl(checksumsUrl, { cache: 'no-store' });
  if (!checksumResponse.ok) {
    throw new Error(`Could not fetch checksums (HTTP ${checksumResponse.status})`);
  }
  const expected = parseChecksums(await checksumResponse.text()).get(asset);
  if (!expected) {
    throw new Error(`No published checksum for ${asset}; refusing to run an unverified installer`);
  }

  const response = await fetchImpl(`${base}/${asset}`, { cache: 'no-store' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (HTTP ${response.status})`);
  }

  const total = Number(response.headers?.get?.('content-length') ?? 0);
  const hash = createHash('sha256');
  let received = 0;

  // Hashing happens as a pipeline stage rather than a `data` listener: a
  // listener switches the stream to flowing mode and consumes the bytes
  // before the file writer is attached, which writes an empty file.
  const { Transform } = require('node:stream');
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      received += chunk.length;
      if (total > 0) onProgress?.(Math.min(received / total, 1));
      callback(null, chunk);
    },
  });

  await fs.mkdir(targetDir, { recursive: true });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination));

  const actual = hash.digest('hex');
  if (actual !== expected) {
    await fs.rm(destination, { force: true });
    throw new Error('Downloaded file did not match its published checksum, so it was deleted');
  }

  // The AppImage arrives without the executable bit, which makes a
  // double-click do nothing at all.
  if (platform === 'linux') await fs.chmod(destination, 0o755);

  return { path: destination, asset, bytes: received };
}

module.exports = {
  compareVersions,
  isNewer,
  parseVersionInfo,
  checkForUpdate,
  assetNameFor,
  parseChecksums,
  downloadUpdate,
  VERSION_URL,
  CHECKSUMS_URL,
  DOWNLOAD_BASE,
  RELEASES_URL,
};
