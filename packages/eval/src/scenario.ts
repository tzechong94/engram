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
  /** Tokens that MUST NOT appear (e.g. a superseded/old value). Optional. */
  expectNone?: string[];
  /** The ground-truth answer, for the LLM-judged answer-quality eval. Optional. */
  answer?: string;
}

/**
 * A fact that gets updated/contradicted later. After sleep, recall must return
 * the NEW value and must NOT surface the OLD one (bi-temporal supersede). This
 * exercises the reconcile step — meaningful on real Qwen (mock can't reconcile).
 */
export interface ContradictionPair {
  /** The original statement (older). */
  oldFact: { content: string; channel: string; ageDays: number };
  /** The correcting statement (newer). */
  newFact: { content: string; channel: string; ageDays: number };
  query: string;
  /** Tokens proving the NEW value is recalled. */
  expectNew: string[];
  /** Tokens proving the OLD value is gone. */
  expectOldGone: string[];
  answer?: string;
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
  { query: 'what do I like to do for fun on weekends', expectAny: ['hiking', 'eagle', 'trail', 'mountains'], answer: 'hiking (favourite trail: Eagle Peak)' },
  { query: 'what are my dietary preferences', expectAny: ['vegetarian', 'meat', 'plant'], answer: 'vegetarian / plant-based; does not eat meat' },
  { query: 'tell me about my pet', expectAny: ['rocky', 'dog', 'retriever'], answer: 'a golden retriever dog named Rocky' },
  { query: 'what is my job', expectAny: ['designer', 'product', 'startup', 'launch'], answer: 'product designer at a startup' },
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

/**
 * Updated/contradicted facts. Seeded as old→new; after sleep, recall must return
 * the new value and drop the old (timely forgetting of outdated info — a Track-1
 * keyword). Reconcile is LLM-driven, so these pass meaningfully on real Qwen.
 */
export const CONTRADICTION_PAIRS: ContradictionPair[] = [
  {
    oldFact: { content: 'I live in New York City', channel: 'telegram', ageDays: 45 },
    newFact: { content: 'I just moved from New York to San Francisco', channel: 'telegram', ageDays: 1 },
    query: 'where do I live now',
    expectNew: ['san francisco', 'sf'],
    expectOldGone: ['new york'],
    answer: 'San Francisco',
  },
  {
    oldFact: { content: 'My partner and I are planning a wedding for next spring', channel: 'whatsapp', ageDays: 60 },
    newFact: { content: 'We moved our wedding from spring to this autumn', channel: 'whatsapp', ageDays: 2 },
    query: 'in which season is my wedding',
    expectNew: ['autumn', 'fall'],
    expectOldGone: ['spring'],
    answer: 'this autumn',
  },
  {
    oldFact: { content: 'My phone number is 555-1234', channel: 'telegram', ageDays: 50 },
    newFact: { content: 'I got a new phone number, it is now 555-9876', channel: 'telegram', ageDays: 1 },
    query: 'what is my current phone number',
    expectNew: ['9876'],
    expectOldGone: ['1234'],
    answer: '555-9876',
  },
  {
    oldFact: { content: 'I usually go to the gym on Mondays', channel: 'telegram', ageDays: 35 },
    newFact: { content: 'I switched my gym day from Monday to Thursday', channel: 'telegram', ageDays: 2 },
    query: 'which day do I go to the gym now',
    expectNew: ['thursday'],
    expectOldGone: ['monday'],
    answer: 'Thursday',
  },
];

/**
 * Document RAG: an uploaded reference doc (durable, never decayed). Recall must
 * surface the chunk holding a fact, and the bot must answer from it — including
 * "I don't know" for a fact the doc doesn't contain.
 */
export const RAG_DOC = [
  '## ALPHA — Reactor',
  'The Zorblax reactor sustains a core temperature of 4271 kelvin during steady-state operation.',
  '',
  '## BRAVO — Finance',
  "Project Nightingale's approved budget is 3.2 million credits for fiscal year 2031.",
  '',
  '## CHARLIE — Hardware',
  'The Kelmari device weighs 88 kilograms and runs exclusively on pressurized argon gas.',
  '',
  '## DELTA — Personnel',
  'The lead cryptographer is Dr. Priya Venkataraman, reachable only at secure extension 5571.',
  '',
  '## ECHO — Schedule',
  'The Project Nightingale summit keynote is on 14 March 2031 at 09:30 in Hall C.',
].join('\n');

export const RAG_QUERIES: RecallQuery[] = [
  { query: 'what is the Zorblax reactor core temperature', expectAny: ['4271'], answer: '4271 kelvin' },
  { query: "what is Project Nightingale's budget", expectAny: ['3.2 million', '3,200,000'], answer: '3.2 million credits' },
  { query: 'what gas does the Kelmari device run on', expectAny: ['argon'], answer: 'argon gas' },
  { query: "what is the lead cryptographer's secure extension", expectAny: ['5571'], answer: 'extension 5571' },
  // Date-bearing fact — the answer must carry the absolute date, time, and place.
  { query: 'when and where is the Nightingale summit keynote', expectAny: ['14 march', 'march 14', 'hall c', '09:30'], answer: '14 March 2031 at 09:30 in Hall C' },
];

/** Doc does NOT contain this — the bot must say so, not invent. */
export const RAG_NEGATIVE: RecallQuery = {
  query: 'what is the mainframe root password in the briefing',
  expectAny: [],
  expectNone: ['password is', 'root password'],
  answer: 'unknown — the document does not contain a password',
};

/**
 * Cross-session learning curve ("makes increasingly accurate decisions"): N
 * simulated sessions, one durable fact each. At the END of each session the
 * agent is quizzed on ALL facts accumulated so far.
 *  - memory agent: answers from Engram recall → coverage stays high as sessions grow
 *  - no-memory baseline: sees only the CURRENT session's messages (a context
 *    window without persistent memory) → accuracy decays as 1/k
 * The gap widening with experience is the measurable form of the track's
 * "increasingly accurate across multi-turn, cross-session interactions".
 */
export interface LearningSession {
  fact: string;
  query: string;
  answer: string;
}
export const LEARNING_SESSIONS: LearningSession[] = [
  { fact: 'My cat is called Miso', query: "what is my cat's name", answer: 'Miso' },
  { fact: 'I work at Nimbus Robotics as a controls engineer', query: 'where do I work and what is my role', answer: 'controls engineer at Nimbus Robotics' },
  { fact: 'My favourite dish is laksa', query: 'what is my favourite dish', answer: 'laksa' },
  { fact: 'My apartment door code is 4417', query: 'what is my apartment door code', answer: '4417' },
];

/**
 * Precision / no-confabulation: the user never said any of these. Recall should
 * surface nothing strongly relevant, and a downstream answer should be "I don't
 * know" — not a fabricated fact. `expectNone` are the trap tokens.
 */
export const NEGATIVE_QUERIES: RecallQuery[] = [
  { query: 'what car do I drive', expectAny: [], expectNone: ['tesla', 'toyota', 'honda', 'bmw', 'car'], answer: "unknown — the user never mentioned a car" },
  { query: 'what is my blood type', expectAny: [], expectNone: ['a+', 'o+', 'b+', 'ab', 'type'], answer: 'unknown — never mentioned' },
  { query: 'how many siblings do I have', expectAny: [], expectNone: ['brother', 'sister', 'siblings'], answer: 'unknown — never mentioned' },
];
