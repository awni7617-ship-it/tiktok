import type { Readable } from 'node:stream';
import { config } from '@/server/config';
import { getBindings } from '@/server/cloudflare/env';
import type { StorageDriver, StoredObject } from './index';

/**
 * R2 storage via the Workers binding.
 *
 * Deliberately not the S3 driver pointed at R2's S3 endpoint: the binding skips
 * SigV4 entirely, keeps the AWS SDK out of a Worker bundle that has a hard size
 * limit, and does not require credentials to exist at all — access is granted
 * by the binding itself.
 *
 * `download` throws: a Worker has no writable filesystem. Anything that needs
 * bytes on disk (ffmpeg) runs in the render container, which uses the local or
 * S3 driver instead. Failing loudly here is better than a confusing ENOENT
 * three layers down.
 */
export class R2StorageDriver implements StorageDriver {
  readonly name = 'r2';

  private async bucket(): Promise<R2Bucket> {
    const bindings = await getBindings();
    if (!bindings?.MEDIA) {
      throw new Error(
        'R2 bucket binding "MEDIA" is not available. Check the r2_buckets entry in wrangler.jsonc.',
      );
    }
    return bindings.MEDIA;
  }

  async put(key: string, body: Buffer | Readable, contentType: string): Promise<StoredObject> {
    const bucket = await this.bucket();

    // R2's put accepts a stream, but only a web ReadableStream — a Node
    // Readable has to be collected first.
    const payload = Buffer.isBuffer(body) ? body : await collect(body);

    await bucket.put(key, payload, {
      httpMetadata: { contentType },
    });

    return { key, sizeBytes: payload.length, contentType };
  }

  async upload(sourcePath: string, key: string, contentType: string): Promise<StoredObject> {
    const { readFile } = await import('node:fs/promises');
    return this.put(key, await readFile(sourcePath), contentType);
  }

  async download(): Promise<string> {
    throw new Error(
      'Workers have no writable filesystem. Media that must land on disk is handled by the render container.',
    );
  }

  async get(key: string): Promise<Readable> {
    const bucket = await this.bucket();
    const object = await bucket.get(key);
    if (!object) throw new Error(`Object not found: ${key}`);

    const { Readable: NodeReadable } = await import('node:stream');
    return NodeReadable.fromWeb(object.body as Parameters<typeof NodeReadable.fromWeb>[0]);
  }

  async delete(key: string): Promise<void> {
    (await this.bucket()).delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await (await this.bucket()).head(key)) !== null;
  }

  /**
   * R2 bindings cannot mint presigned URLs, so reads go through the app's own
   * authenticated media route unless a public bucket URL is configured.
   *
   * That is the safer default anyway: a signed URL leaks the object to whoever
   * holds the link, while the media route can check workspace membership.
   */
  async signedUrl(key: string): Promise<string> {
    if (config.S3_PUBLIC_URL) {
      return `${config.S3_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
    }
    return `/api/media/${encodeURIComponent(key)}`;
  }

  async signedUploadUrl(key: string): Promise<string> {
    return `/api/media/upload?key=${encodeURIComponent(key)}`;
  }
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}
