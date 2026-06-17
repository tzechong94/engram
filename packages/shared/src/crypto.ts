import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createLogger } from './log.js';

const log = createLogger('crypto');

/**
 * Field-level encryption for memory content at rest (AES-256-GCM). Stored format:
 *   v1:<iv-hex>:<tag-hex>:<ciphertext-hex>
 *
 * If ENGRAM_ENCRYPTION_KEY is unset we pass through plaintext with a one-time loud
 * warning so local dev isn't blocked. In cloud the key is required (KMS-backed).
 */

let warned = false;

function key(): Buffer | null {
  const hex = process.env.ENGRAM_ENCRYPTION_KEY ?? '';
  if (!hex) {
    if (!warned) {
      log.warn('ENGRAM_ENCRYPTION_KEY unset — memory content stored as PLAINTEXT (dev only).');
      warned = true;
    }
    return null;
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) throw new Error('ENGRAM_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  return buf;
}

export function encrypt(plaintext: string): string {
  const k = key();
  if (!k) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decrypt(stored: string): string {
  if (!stored.startsWith('v1:')) return stored; // plaintext (key was unset at write time)
  const k = key();
  if (!k) throw new Error('encrypted content present but ENGRAM_ENCRYPTION_KEY unset');
  const [, ivHex, tagHex, ctHex] = stored.split(':');
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(ivHex!, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex!, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctHex!, 'hex')), decipher.final()]).toString('utf8');
}

export function isEncryptionEnabled(): boolean {
  return (process.env.ENGRAM_ENCRYPTION_KEY ?? '') !== '';
}
