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

const VERSION_URL =
  'https://github.com/awni7617-ship-it/tiktok/releases/download/latest/version.json';
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

module.exports = {
  compareVersions,
  isNewer,
  parseVersionInfo,
  checkForUpdate,
  VERSION_URL,
  RELEASES_URL,
};
