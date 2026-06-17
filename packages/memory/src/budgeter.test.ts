import { describe, it, expect } from 'vitest';
import { packContext, estimateTokens, type BudgeterCandidate } from './budgeter.js';

function cand(over: Partial<BudgeterCandidate> & { id: string }): BudgeterCandidate {
  return {
    kind: 'episode',
    content: over.content ?? over.id,
    tokens: 10,
    relevance: 0.5,
    importance: 0.5,
    ageMs: 0,
    ...over,
  };
}

describe('context budgeter', () => {
  it('packs under the token budget and never exceeds it', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      cand({ id: `c${i}`, tokens: 30, relevance: Math.random() }),
    );
    const trace = packContext(candidates, { tokenBudget: 100 });
    expect(trace.tokensUsed).toBeLessThanOrEqual(100);
    const includedTokens = trace.candidates.filter((c) => c.included).reduce((s, c) => s + c.tokens, 0);
    expect(includedTokens).toBe(trace.tokensUsed);
  });

  it('prefers high-relevance candidates', () => {
    const candidates = [
      cand({ id: 'low', relevance: 0.1, tokens: 50 }),
      cand({ id: 'high', relevance: 0.95, tokens: 50 }),
    ];
    const trace = packContext(candidates, { tokenBudget: 50, weights: { relevance: 1, recency: 0, importance: 0, diversity: 0 } });
    const included = trace.candidates.filter((c) => c.included).map((c) => c.id);
    expect(included).toEqual(['high']);
  });

  it('diversity penalty avoids packing near-duplicates', () => {
    // Equal relevance so diversity is the deciding factor: two identical items +
    // one distinct. With a 2-item budget, diversity should pick dup + distinct,
    // not both dups.
    const dup = 'i love hiking in the mountains every weekend';
    const candidates = [
      cand({ id: 'dup1', content: dup, relevance: 0.9, tokens: 40 }),
      cand({ id: 'dup2', content: dup, relevance: 0.9, tokens: 40 }),
      cand({ id: 'distinct', content: 'my dentist appointment is on tuesday', relevance: 0.9, tokens: 40 }),
    ];
    const trace = packContext(candidates, {
      tokenBudget: 80,
      weights: { relevance: 0.5, recency: 0, importance: 0, diversity: 0.5 },
    });
    const included = new Set(trace.candidates.filter((c) => c.included).map((c) => c.id));
    expect(included.has('distinct')).toBe(true);
    // only one of the dups should be in (budget = 2 items)
    expect(included.has('dup1') && included.has('dup2')).toBe(false);
  });

  it('recency decay favors fresh memories when weighted', () => {
    const candidates = [
      cand({ id: 'old', ageMs: 30 * 86_400_000, tokens: 50 }),
      cand({ id: 'fresh', ageMs: 0, tokens: 50 }),
    ];
    const trace = packContext(candidates, {
      tokenBudget: 50,
      weights: { relevance: 0, recency: 1, importance: 0, diversity: 0 },
      recencyHalfLifeMs: 7 * 86_400_000,
    });
    expect(trace.candidates.find((c) => c.id === 'fresh')!.included).toBe(true);
    expect(trace.candidates.find((c) => c.id === 'old')!.included).toBe(false);
  });

  it('every candidate appears in the trace with a score breakdown', () => {
    const candidates = [cand({ id: 'a' }), cand({ id: 'b' })];
    const trace = packContext(candidates, { tokenBudget: 1000 });
    expect(trace.candidates).toHaveLength(2);
    for (const c of trace.candidates) {
      expect(c).toHaveProperty('relevance');
      expect(c).toHaveProperty('recency');
      expect(c).toHaveProperty('diversity');
      expect(c).toHaveProperty('score');
    }
  });
});

describe('estimateTokens', () => {
  it('is roughly chars/4 and at least 1', () => {
    expect(estimateTokens('')).toBe(1);
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });
});
