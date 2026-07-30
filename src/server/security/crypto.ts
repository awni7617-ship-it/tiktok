import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { config } from '@/server/config';

/**
 * Promisified scrypt. Hand-written rather than `promisify`d because the
 * options-carrying overload is not one of the shapes `promisify`'s types
 * understand, and the options are what let us tune the work factor.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/**
 * Cryptographic primitives.
 *
 * Two distinct jobs live here and must not be confused:
 *   - password hashing (slow, salted, one-way) for user credentials
 *   - authenticated encryption (fast, keyed, reversible) for OAuth tokens
 *
 * OAuth access tokens are the most sensitive data the platform holds — they
 * grant posting rights on a creator's real accounts — so they are encrypted at
 * rest with AES-256-GCM rather than merely stored in a private column.
 */

// ---------------------------------------------------------------------------
// Password hashing (scrypt)
// ---------------------------------------------------------------------------

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keyLength: 64 };

/**
 * Hash a password. The output encodes the algorithm and parameters so they can
 * be raised later without invalidating existing hashes.
 * Format: `scrypt$N$r$p$salt$hash`
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keyLength } = SCRYPT_PARAMS;
  const derived = await scrypt(password.normalize('NFKC'), salt, keyLength, {
    N,
    r,
    p,
    // scrypt needs memory proportional to N*r*128; raise the ceiling to match.
    maxmem: 256 * 1024 * 1024,
  });

  return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
}

/** Constant-time password check that tolerates older parameter sets. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltRaw!, 'base64');
  const expected = Buffer.from(hashRaw!, 'base64');

  try {
    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash used weaker parameters and should be re-hashed. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < SCRYPT_PARAMS.N;
}

// ---------------------------------------------------------------------------
// Authenticated encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

/** Derive a stable 32-byte key from the configured secret. */
function encryptionKey(): Buffer {
  return createHash('sha256').update(config.ENCRYPTION_KEY).digest();
}

/**
 * Encrypt a secret for storage.
 * Format: `v1.<iv>.<authTag>.<ciphertext>`, all base64url.
 * The version prefix allows key rotation and algorithm changes later.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return ['v1', iv.toString('base64url'), authTag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/**
 * Decrypt a stored secret. Throws on tampering — GCM's auth tag makes a
 * modified ciphertext fail loudly rather than decrypt to garbage.
 */
export function decryptSecret(encoded: string): string {
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Malformed encrypted value');
  }

  const [, ivRaw, tagRaw, dataRaw] = parts;
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw!, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw!, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw!, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Tokens & comparison
// ---------------------------------------------------------------------------

/** Cryptographically random URL-safe token. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Hash a bearer/session token for storage; the raw value never persists. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Length-safe constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    // Still perform a comparison so timing does not leak the length check.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/** PKCE code verifier and its S256 challenge, for OAuth authorization flows. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
