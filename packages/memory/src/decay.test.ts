import { describe, it, expect } from 'vitest';
import { retainedValue, decideForget } from './decay.js';

const DAY = 86_400_000;

describe('decay / forgetting', () => {
  it('retained value decays with age', () => {
    const fresh = retainedValue({ importance: 0.8, ageMs: 0, accessCount: 0, lastAccessedAgeMs: 0 });
    const old = retainedValue({ importance: 0.8, ageMs: 60 * DAY, accessCount: 0, lastAccessedAgeMs: 60 * DAY });
    expect(old).toBeLessThan(fresh);
  });

  it('access count props up retained value', () => {
    const base = { importance: 0.5, ageMs: 30 * DAY, lastAccessedAgeMs: 30 * DAY };
    const rarely = retainedValue({ ...base, accessCount: 0 });
    const often = retainedValue({ ...base, accessCount: 20 });
    expect(often).toBeGreaterThan(rarely);
  });

  it('forgets stale, low-value, unaccessed episodes', () => {
    const d = decideForget(
      { importance: 0.2, ageMs: 90 * DAY, accessCount: 0, lastAccessedAgeMs: 90 * DAY },
      0.15,
    );
    expect(d.forget).toBe(true);
  });

  it('never forgets pinned memories', () => {
    const d = decideForget(
      { importance: 0.01, ageMs: 365 * DAY, accessCount: 0, lastAccessedAgeMs: 365 * DAY, pinned: true },
      0.15,
    );
    expect(d.forget).toBe(false);
    expect(d.reason).toBe('pinned');
  });

  it('protects recently-accessed memories even if low value', () => {
    const d = decideForget(
      { importance: 0.05, ageMs: 365 * DAY, accessCount: 1, lastAccessedAgeMs: 1 * DAY },
      0.15,
    );
    expect(d.forget).toBe(false);
    expect(d.reason).toBe('recently-accessed');
  });

  it('keeps fresh important memories', () => {
    const d = decideForget(
      { importance: 0.9, ageMs: 1 * DAY, accessCount: 5, lastAccessedAgeMs: 10 * DAY },
      0.15,
    );
    expect(d.forget).toBe(false);
  });
});
