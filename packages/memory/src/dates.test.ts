import { describe, it, expect } from 'vitest';
import { anchorRelativeDates, findRelativeDates } from './dates.js';

// Wed 2026-07-01, 15:00 local
const NOW = new Date(2026, 6, 1, 15, 0, 0);

describe('anchorRelativeDates', () => {
  it('anchors "tomorrow"', () => {
    expect(anchorRelativeDates('My flight is tomorrow at 6pm', NOW)).toBe(
      'My flight is tomorrow at 6pm [tomorrow = 2026-07-02]',
    );
  });

  it('anchors "tonight" to today', () => {
    expect(anchorRelativeDates('Dinner tonight at 8', NOW)).toContain('[tonight = 2026-07-01]');
  });

  it('anchors "day after tomorrow" (and not plain tomorrow twice)', () => {
    const out = anchorRelativeDates('Call the client day after tomorrow', NOW);
    expect(out).toContain('day after tomorrow = 2026-07-03');
    expect(out.match(/tomorrow =/g)).toHaveLength(1);
  });

  it('anchors "on Friday" to the coming Friday', () => {
    // NOW is Wednesday → coming Friday is 2026-07-03
    expect(anchorRelativeDates('Dentist on Friday', NOW)).toContain('= 2026-07-03');
  });

  it('pushes "next <weekday>" past the immediate one when it is close', () => {
    // Said on Wed, "next Friday" (2 days away) conventionally means the week after.
    expect(anchorRelativeDates('Standup moved to next Friday', NOW)).toContain('= 2026-07-10');
  });

  it('anchors "in 2 weeks"', () => {
    expect(anchorRelativeDates('Renew passport in 2 weeks', NOW)).toContain('in 2 weeks = 2026-07-15');
  });

  it('skips bare weekdays and recurring "every"', () => {
    expect(anchorRelativeDates('I hate Mondays', NOW)).toBe('I hate Mondays');
    expect(anchorRelativeDates('Gym every Tuesday', NOW)).toBe('Gym every Tuesday');
  });

  it('leaves absolute dates untouched', () => {
    expect(anchorRelativeDates('Dinner on July 16 at 7pm', NOW)).toBe('Dinner on July 16 at 7pm');
  });

  it('is idempotent (no double anchoring)', () => {
    const once = anchorRelativeDates('Flight tomorrow at 6pm', NOW);
    expect(anchorRelativeDates(once, NOW)).toBe(once);
  });

  it('findRelativeDates dedupes repeated phrases', () => {
    const anchors = findRelativeDates('tomorrow, yes tomorrow!', NOW);
    expect(anchors).toHaveLength(1);
  });
});
