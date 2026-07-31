import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { config } from '@/server/config';
import { logger } from '@/server/obs/logger';
import { R2StorageDriver } from './r2';

const log = logger.child({ module: 'storage' });

/**
 * Object storage abstraction.
 *
 * Three drivers: the local filesystem (development, self-hosting, tests), any
 * S3-compatible service (production, MinIO), and R2 via the Workers binding.
 * Callers only ever see storage keys — never paths or bucket names — so
 * switching drivers requires no application changes and no data migration.
 */

export interface StoredObject {
  key: string;
  sizeBytes: number;
  contentType: string;
}

export interface StorageDriver {
  readonly name: string;
  put(key: string, body: Buffer | Readable, contentType: string): Promise<StoredObject>;
  /** Copy an object out of storage onto local disk, for ffmpeg to read. */
  download(key: string, destinationPath: string): Promise<string>;
  /** Move a local file into storage; used by the renderer for its output. */
  upload(sourcePath: string, key: string, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Time-limited URL for direct browser access. */
  signedUrl(key: string, expiresInSec: number): Promise<string>;
  /** Time-limited URL the browser can PUT to, so uploads bypass the app server. */
  signedUploadUrl(key: string, contentType: string, expiresInSec: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Key construction
// ---------------------------------------------------------------------------

/**
 * Build a storage key. Keys are namespaced by workspace so a misconfigured
 * bucket policy or a leaked signed URL cannot expose another tenant's media,
 * and sanitised so a crafted filename cannot escape the prefix.
 */
export function buildKey(parts: {
  workspaceId: string;
  projectId?: string;
  kind: string;
  filename: string;
}): string {
  const segments = [
    'workspaces',
    sanitizeSegment(parts.workspaceId),
    ...(parts.projectId ? ['projects', sanitizeSegment(parts.projectId)] : []),
    sanitizeSegment(parts.kind),
    sanitizeFilename(parts.filename),
  ];
  return segments.join('/');
}

/**
 * Reduce a path segment to safe characters.
 *
 * Separators become underscores and runs of dots are collapsed, so a crafted
 * id like `../../root` cannot contribute a traversal sequence even before the
 * driver's own resolve-check runs.
 */
export function sanitizeSegment(value: string): string {
  const cleaned = value
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 128);
  return cleaned.length > 0 ? cleaned : 'unnamed';
}

/** Strip directory traversal and control characters from a user-supplied name. */
export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[\x00-\x1f\x7f]/g, '');
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'file';
}

// ---------------------------------------------------------------------------
// Local driver
// ---------------------------------------------------------------------------

export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';
  private readonly root: string;

  constructor(root = config.STORAGE_LOCAL_PATH) {
    this.root = path.resolve(root);
  }

  /**
   * Resolve a key to an absolute path, refusing anything that escapes the
   * storage root. This is the last line of defence against path traversal.
   */
  private resolve(key: string): string {
    const target = path.resolve(this.root, key);
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      throw new Error(`Storage key escapes the storage root: ${key}`);
    }
    return target;
  }

  async put(key: string, body: Buffer | Readable, contentType: string): Promise<StoredObject> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });

    if (Buffer.isBuffer(body)) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(target, body);
      return { key, sizeBytes: body.length, contentType };
    }

    await pipeline(body, createWriteStream(target));
    const stats = await stat(target);
    return { key, sizeBytes: stats.size, contentType };
  }

  async upload(sourcePath: string, key: string, contentType: string): Promise<StoredObject> {
    return this.put(key, createReadStream(sourcePath), contentType);
  }

  async download(key: string, destinationPath: string): Promise<string> {
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await pipeline(createReadStream(this.resolve(key)), createWriteStream(destinationPath));
    return destinationPath;
  }

  async get(key: string): Promise<Readable> {
    return createReadStream(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string): Promise<string> {
    // Served by the authenticated media route rather than a signature; the
    // local driver is for development and single-tenant self-hosting.
    return `/api/media/${encodeURIComponent(key)}`;
  }

  async signedUploadUrl(key: string): Promise<string> {
    return `/api/media/upload?key=${encodeURIComponent(key)}`;
  }

  /** Absolute path for a key — used by the renderer to avoid a needless copy. */
  localPath(key: string): string {
    return this.resolve(key);
  }
}

// ---------------------------------------------------------------------------
// S3 driver
// ---------------------------------------------------------------------------

export class S3StorageDriver implements StorageDriver {
  readonly name = 's3';
  private client: import('@aws-sdk/client-s3').S3Client | null = null;
  private readonly bucket: string;

  constructor() {
    if (!config.S3_BUCKET) throw new Error('S3_BUCKET is required for the s3 storage driver');
    this.bucket = config.S3_BUCKET;
  }

  /**
   * The AWS SDK is loaded lazily. It is a heavy dependency and a deployment
   * using local storage should never pay to import it.
   */
  private async getClient() {
    if (this.client) return this.client;

    const { S3Client } = await import('@aws-sdk/client-s3');
    this.client = new S3Client({
      region: config.S3_REGION,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: config.S3_ACCESS_KEY_ID,
              secretAccessKey: config.S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });

    return this.client;
  }

  async put(key: string, body: Buffer | Readable, contentType: string): Promise<StoredObject> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();

    await client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );

    const sizeBytes = Buffer.isBuffer(body) ? body.length : 0;
    return { key, sizeBytes, contentType };
  }

  async upload(sourcePath: string, key: string, contentType: string): Promise<StoredObject> {
    const stats = await stat(sourcePath);
    await this.put(key, createReadStream(sourcePath), contentType);
    return { key, sizeBytes: stats.size, contentType };
  }

  async download(key: string, destinationPath: string): Promise<string> {
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await pipeline(await this.get(key), createWriteStream(destinationPath));
    return destinationPath;
  }

  async get(key: string): Promise<Readable> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    const response = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));

    if (!response.Body) throw new Error(`Object not found: ${key}`);
    return response.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, expiresInSec = 3600): Promise<string> {
    // A configured CDN origin is public, so signing would be pointless overhead.
    if (config.S3_PUBLIC_URL) return `${config.S3_PUBLIC_URL.replace(/\/$/, '')}/${key}`;

    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = await this.getClient();

    return getSignedUrl(client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSec,
    });
  }

  async signedUploadUrl(key: string, contentType: string, expiresInSec = 900): Promise<string> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = await this.getClient();

    return getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSec },
    );
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

let driver: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  if (driver) return driver;

  if (config.STORAGE_DRIVER === 'r2') {
    driver = new R2StorageDriver();
  } else if (config.STORAGE_DRIVER === 's3') {
    try {
      driver = new S3StorageDriver();
    } catch (error) {
      log.error('S3 storage misconfigured; falling back to local storage', { error });
      driver = new LocalStorageDriver();
    }
  } else {
    driver = new LocalStorageDriver();
  }

  log.info('storage driver ready', { driver: driver.name });
  return driver;
}

export function setStorage(next: StorageDriver): void {
  driver = next;
}

/** MIME type from a filename extension, for uploads that omit one. */
export function guessContentType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  const types: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.srt': 'application/x-subrip',
    '.vtt': 'text/vtt',
    '.ass': 'text/x-ssa',
    '.json': 'application/json',
  };
  return types[extension] ?? 'application/octet-stream';
}

/** Accepted upload types. Anything else is rejected before it reaches disk. */
export const ALLOWED_UPLOAD_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'audio/mpeg',
  'audio/wav',
  'audio/mp4',
  'audio/aac',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export function isAllowedUpload(contentType: string): boolean {
  return ALLOWED_UPLOAD_TYPES.has(contentType.split(';')[0]!.trim().toLowerCase());
}
