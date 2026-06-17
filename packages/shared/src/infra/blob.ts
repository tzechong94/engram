import fs from 'node:fs/promises';
import path from 'node:path';
import type { Blob } from './interfaces.js';

/**
 * Filesystem-backed blob store for local dev (cold archive of forgotten/superseded
 * memory). S3/OSS-compatible MinIO sits in docker-compose for deploy parity, but
 * the cold-archive path is low-traffic and not on any scored hot path, so locally
 * we avoid the S3 SDK + sigv4 weight and write to .data/blob. The cloud impl
 * (OSS/S3) implements the same `Blob` interface — see deploy/alibaba.
 */
export class FilesystemBlob implements Blob {
  private root: string;

  constructor(root = path.resolve(process.cwd(), '.data/blob')) {
    this.root = root;
  }

  private pathFor(key: string): string {
    // Keys may contain slashes (e.g. tenant/episode-id) — keep the hierarchy.
    const safe = key.replace(/\.\./g, '_');
    return path.join(this.root, safe);
  }

  async put(key: string, body: Buffer | string): Promise<void> {
    const p = this.pathFor(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.pathFor(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(key));
    } catch {
      /* idempotent */
    }
  }
}
