/**
 * Forgetting / decay math for the sleep phase's forget sweep. The brain forgets
 * what it doesn't use; Engram does the same. An episode's *retained value* decays
 * with age but is propped up by how recently and how often it was accessed. Below
 * a threshold (and if not pinned), it gets archived/forgotten.
 *
 *   retained = importance · recency(age) · accessBoost(count, lastAccess)
 *
 * Pure + deterministic so the eval harness can prove "stale-recall drops while
 * retention of useful memories holds".
 */

const DAY_MS = 86_400_000;

export interface DecayInput {
  importance: number; // 0..1 intrinsic
  ageMs: number; // since created
  accessCount: number;
  lastAccessedAgeMs: number; // since last accessed
  pinned?: boolean;
}

export interface DecayOptions {
  /** Half-life of base recency decay (default 14 days). */
  halfLifeMs?: number;
  /** Recently-accessed protection window (default 3 days). */
  protectWindowMs?: number;
}

/** Retained value in 0..1+. Higher = keep. */
export function retainedValue(input: DecayInput, opts: DecayOptions = {}): number {
  const halfLife = opts.halfLifeMs ?? 30 * DAY_MS;
  const recency = Math.pow(0.5, Math.max(0, input.ageMs) / halfLife);
  // Access boost: 1.0 at zero accesses, rising with log of count (diminishing).
  const accessBoost = 1 + 0.4 * Math.log1p(Math.max(0, input.accessCount));
  return clampLow(input.importance * recency * accessBoost);
}

export interface ForgetDecision {
  forget: boolean;
  retained: number;
  reason: string;
}

/**
 * Decide whether to forget. Pinned and recently-accessed memories are always
 * protected regardless of decayed value, so a low-importance-but-just-used fact
 * isn't yanked out from under the user.
 */
export function decideForget(input: DecayInput, threshold: number, opts: DecayOptions = {}): ForgetDecision {
  const retained = retainedValue(input, opts);
  if (input.pinned) return { forget: false, retained, reason: 'pinned' };
  const protectWindow = opts.protectWindowMs ?? 3 * DAY_MS;
  if (input.lastAccessedAgeMs <= protectWindow) {
    return { forget: false, retained, reason: 'recently-accessed' };
  }
  if (retained < threshold) {
    return { forget: true, retained, reason: `retained ${retained.toFixed(3)} < threshold ${threshold}` };
  }
  return { forget: false, retained, reason: 'above-threshold' };
}

function clampLow(x: number): number {
  return x < 0 ? 0 : x;
}
