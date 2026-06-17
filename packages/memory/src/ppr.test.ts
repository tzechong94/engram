import { describe, it, expect } from 'vitest';
import { personalizedPageRank, normalizeScores, type PprEdge } from './ppr.js';

describe('personalizedPageRank', () => {
  it('returns empty for an empty graph', () => {
    expect(personalizedPageRank([], [], new Map()).size).toBe(0);
  });

  it('concentrates mass on the seed in a single node', () => {
    const r = personalizedPageRank(['a'], [], new Map([['a', 1]]));
    expect(r.get('a')).toBeCloseTo(1, 5);
  });

  it('decays mass with distance from the seed', () => {
    // a - b - c ; seed a. Mass decays with hop distance: a,b outrank the 2-hop c.
    const edges: PprEdge[] = [
      { src: 'a', dst: 'b', weight: 1 },
      { src: 'b', dst: 'c', weight: 1 },
    ];
    const r = personalizedPageRank(['a', 'b', 'c'], edges, new Map([['a', 1]]));
    expect(r.get('a')!).toBeGreaterThan(r.get('c')!);
    expect(r.get('b')!).toBeGreaterThan(r.get('c')!);
  });

  it('does multi-hop association: a node reachable from two seeds ranks high', () => {
    // seeds a, e both connect to hub h. h should accumulate from both.
    const edges: PprEdge[] = [
      { src: 'a', dst: 'h', weight: 1 },
      { src: 'e', dst: 'h', weight: 1 },
      { src: 'h', dst: 'z', weight: 1 },
      { src: 'x', dst: 'y', weight: 1 }, // disconnected component, should stay ~0
    ];
    const r = personalizedPageRank(['a', 'e', 'h', 'z', 'x', 'y'], edges, new Map([['a', 1], ['e', 1]]));
    expect(r.get('h')!).toBeGreaterThan(r.get('z')!);
    expect(r.get('h')!).toBeGreaterThan(r.get('x')!);
    expect(r.get('x')!).toBeLessThan(0.01); // disconnected from seeds
  });

  it('edge weight influences spread', () => {
    // seed a connects to b (weak) and c (strong). c should get more mass.
    const edges: PprEdge[] = [
      { src: 'a', dst: 'b', weight: 0.1 },
      { src: 'a', dst: 'c', weight: 10 },
    ];
    const r = personalizedPageRank(['a', 'b', 'c'], edges, new Map([['a', 1]]));
    expect(r.get('c')!).toBeGreaterThan(r.get('b')!);
  });

  it('falls back to uniform when seeds are not in the graph', () => {
    const r = personalizedPageRank(['a', 'b'], [{ src: 'a', dst: 'b', weight: 1 }], new Map([['ghost', 1]]));
    // no seed mass -> uniform restart -> both get nonzero, roughly equal
    expect(r.get('a')!).toBeGreaterThan(0);
    expect(r.get('b')!).toBeGreaterThan(0);
  });
});

describe('normalizeScores', () => {
  it('min-max normalizes to [0,1]', () => {
    const n = normalizeScores(new Map([['a', 2], ['b', 4], ['c', 6]]));
    expect(n.get('a')).toBe(0);
    expect(n.get('c')).toBe(1);
    expect(n.get('b')).toBeCloseTo(0.5, 5);
  });
  it('handles all-equal scores', () => {
    const n = normalizeScores(new Map([['a', 3], ['b', 3]]));
    expect(n.get('a')).toBe(0);
    expect(n.get('b')).toBe(0);
  });
});
