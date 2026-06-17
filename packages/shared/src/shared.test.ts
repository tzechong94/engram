import { describe, it, expect, beforeEach } from 'vitest';
import { MockQwenClient } from './qwen/mock.js';
import { encrypt, decrypt } from './crypto.js';
import { parseDailyCron } from './infra/scheduler.js';
import { toVectorLiteral, parseVector } from './infra/pg.js';

describe('MockQwenClient', () => {
  const q = new MockQwenClient(64);

  it('produces stable, normalized embeddings', async () => {
    const [a, b] = await q.embed(['hello world', 'hello world']);
    expect(a).toEqual(b); // deterministic
    const norm = Math.sqrt(a!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5); // L2 normalized
    expect(a!.length).toBe(64);
  });

  it('related text is more similar than unrelated', async () => {
    const [base, near, far] = await q.embed([
      'i love hiking in the mountains',
      'hiking mountains is my favorite',
      'quarterly tax accounting spreadsheet',
    ]);
    const dot = (x: number[], y: number[]) => x.reduce((s, xi, i) => s + xi * (y[i] ?? 0), 0);
    expect(dot(base!, near!)).toBeGreaterThan(dot(base!, far!));
  });

  it('returns schema-valid JSON for sleep-phase prompts', async () => {
    const r = await q.chat([{ role: 'user', content: 'consolidate these into a semantic note' }], { json: true });
    const parsed = JSON.parse(r.text);
    expect(parsed).toHaveProperty('title');
    expect(parsed).toHaveProperty('body');
  });

  it('rerank ranks token-overlapping docs higher', async () => {
    const ranked = await q.rerank('mountain hiking', [
      'tax accounting documents',
      'mountain hiking trip plan',
    ]);
    expect(ranked[0]!.index).toBe(1);
  });
});

describe('crypto (AES-256-GCM)', () => {
  beforeEach(() => {
    process.env.ENGRAM_ENCRYPTION_KEY = '0'.repeat(64); // 32 bytes hex
  });

  it('round-trips and produces non-plaintext ciphertext', () => {
    const secret = 'my therapist appointment is at 3pm';
    const enc = encrypt(secret);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('therapist');
    expect(decrypt(enc)).toBe(secret);
  });

  it('passes through plaintext when key unset', () => {
    delete process.env.ENGRAM_ENCRYPTION_KEY;
    const enc = encrypt('hello');
    expect(enc).toBe('hello');
    expect(decrypt('hello')).toBe('hello');
  });
});

describe('parseDailyCron', () => {
  it('parses daily cron', () => {
    expect(parseDailyCron('0 4 * * *')).toEqual({ minute: 0, hour: 4 });
    expect(parseDailyCron('30 23 * * *')).toEqual({ minute: 30, hour: 23 });
  });
  it('rejects non-daily / malformed', () => {
    expect(parseDailyCron('0 4 * * 1')).toBeNull();
    expect(parseDailyCron('garbage')).toBeNull();
    expect(parseDailyCron('99 4 * * *')).toBeNull();
  });
});

describe('pgvector literals', () => {
  it('round-trips a vector through text form', () => {
    const v = [0.1, -0.2, 0.3];
    expect(toVectorLiteral(v)).toBe('[0.1,-0.2,0.3]');
    expect(parseVector('[0.1,-0.2,0.3]')).toEqual(v);
    expect(parseVector(null)).toBeNull();
  });
});
