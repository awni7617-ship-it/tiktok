import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Sortable, URL-safe identifier: 8 chars of base36 millisecond timestamp
 * followed by 12 chars of randomness. Sorting by id gives creation order,
 * which keeps list queries index-friendly without a separate sort column.
 */
export function newId(prefix?: string): string {
  const time = Date.now().toString(36).padStart(8, '0');
  const bytes = randomBytes(9);
  let random = '';
  for (const byte of bytes) {
    random += ALPHABET[byte % ALPHABET.length];
  }
  const id = `${time}${random.slice(0, 12)}`;
  return prefix ? `${prefix}_${id}` : id;
}

export function newUuid(): string {
  return randomUUID();
}

/**
 * Deterministic short hash, used for cache keys and stable client-side ids.
 * Not cryptographic — never use it for anything security-bearing.
 */
export function shortHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (((h2 >>> 0) * 4294967296 + (h1 >>> 0)) >>> 0).toString(36).padStart(7, '0');
}
