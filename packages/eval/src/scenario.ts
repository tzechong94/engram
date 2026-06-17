/**
 * A scripted life for one user, "Alex", spread across channels and time. Designed
 * so the sleep phase has real work to do: tight clusters to consolidate, stale
 * trivia to forget, facts on one channel to recall on another.
 */

export interface SeedEpisode {
  content: string;
  channel: string;
  /** Age in days (backdated after insert so decay/forget can act). */
  ageDays: number;
  importance?: number;
  /** Mark as never-useful trivia so the forget sweep should drop it. */
  forgetTarget?: boolean;
}

export interface RecallQuery {
  query: string;
  /** Any of these tokens appearing in recalled memory counts as a hit. */
  expectAny: string[];
}

export const SEED: SeedEpisode[] = [
  // Hiking cluster (telegram) — should consolidate into one note.
  { content: 'I love hiking on the weekends', channel: 'telegram', ageDays: 20 },
  { content: 'My favorite hiking trail is Eagle Peak', channel: 'telegram', ageDays: 19 },
  { content: 'I went hiking at Eagle Peak last Saturday morning', channel: 'telegram', ageDays: 7 },
  { content: 'Hiking in the mountains helps me clear my head', channel: 'telegram', ageDays: 5 },

  // Diet (whatsapp) — cross-channel recall target.
  { content: 'I am vegetarian and I do not eat meat', channel: 'whatsapp', ageDays: 30 },
  { content: 'I prefer plant-based meals when eating out', channel: 'whatsapp', ageDays: 12 },

  // Pet (telegram).
  { content: 'I have a dog named Rocky', channel: 'telegram', ageDays: 40 },
  { content: 'Rocky is a golden retriever who loves the park', channel: 'telegram', ageDays: 10 },

  // Work (telegram).
  { content: 'I work as a product designer at a startup', channel: 'telegram', ageDays: 25 },
  { content: 'I am preparing a big product launch for Q3', channel: 'telegram', ageDays: 3 },

  // Stale trivia — low importance, old, never accessed → should be forgotten.
  { content: 'The wifi password at the old cafe was guest123', channel: 'telegram', ageDays: 95, importance: 0.05, forgetTarget: true },
  { content: 'I parked in lot B row 7 on that one tuesday', channel: 'telegram', ageDays: 88, importance: 0.05, forgetTarget: true },
  { content: 'The coffee place had a 2 for 1 deal that expired last month', channel: 'whatsapp', ageDays: 80, importance: 0.05, forgetTarget: true },
];

export const RECALL_QUERIES: RecallQuery[] = [
  { query: 'what do I like to do for fun on weekends', expectAny: ['hiking', 'eagle', 'trail', 'mountains'] },
  { query: 'what are my dietary preferences', expectAny: ['vegetarian', 'meat', 'plant'] },
  { query: 'tell me about my pet', expectAny: ['rocky', 'dog', 'retriever'] },
  { query: 'what is my job', expectAny: ['designer', 'product', 'startup', 'launch'] },
];

/** Cross-channel: written on whatsapp, must be recallable as if on telegram. */
export const CROSS_CHANNEL_QUERY: RecallQuery = {
  query: 'am I able to eat a steak dinner',
  expectAny: ['vegetarian', 'meat', 'plant'],
};

/** Forgotten trivia — after sleep, these should NOT be recalled. */
export const FORGET_QUERIES: RecallQuery[] = [
  { query: 'what was the cafe wifi password', expectAny: ['guest123', 'wifi password'] },
  { query: 'where did I park that tuesday', expectAny: ['lot b', 'row 7'] },
];
