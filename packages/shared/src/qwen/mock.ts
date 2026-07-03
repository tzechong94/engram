import { createHash } from 'node:crypto';
import type { ChatMessage, ChatOptions, ChatResult, QwenClient, RerankItem } from './types.js';

/**
 * Deterministic offline Qwen. No network. Used until a DASHSCOPE_API_KEY is set
 * and QWEN_MOCK=false. Goals:
 *  - embeddings are stable per text and carry *some* semantic signal (token
 *    hashing into buckets) so cosine similarity isn't pure noise — enough for the
 *    eval harness to show recall/clustering behaving sensibly offline.
 *  - chat returns structured, schema-valid stubs for the sleep phase so the whole
 *    REM cycle runs end-to-end with no key.
 */
export class MockQwenClient implements QwenClient {
  readonly isMock = true;
  readonly embedDim: number;

  constructor(embedDim = 1024) {
    this.embedDim = embedDim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.embedDim).fill(0);
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    for (const tok of tokens) {
      const h = createHash('sha1').update(tok).digest();
      // Spread each token across a few buckets so related text overlaps.
      for (let i = 0; i < 4; i++) {
        const idx = ((h[i] ?? 0) | ((h[i + 4] ?? 0) << 8)) % this.embedDim;
        const sign = ((h[i + 8] ?? 0) & 1) === 0 ? 1 : -1;
        vec[idx] = (vec[idx] ?? 0) + sign;
      }
    }
    // L2 normalize so cosine == dot product.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return vec.map((v) => v / norm);
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    // Route on the SYSTEM message (the step instruction) only — user content can
    // contain routing keywords (e.g. a synthesis note mentions "connection"),
    // which would misroute if we sniffed it. Extract keywords from USER text.
    const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const userText = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const routeText = systemText || userText;
    let text: string;
    if (opts?.json) {
      text = this.mockJsonForPrompt(routeText, userText);
    } else {
      // Conversational stub: echo a short, plausible reply.
      const userText = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      text = `(«mock-qwen» reply) I noted that. ${userText.slice(0, 120)}`.trim();
    }
    return {
      text,
      promptTokens: estimateTokens(messages.map((m) => m.content).join(' ')),
      completionTokens: estimateTokens(text),
    };
  }

  /**
   * The sleep phase asks for strict JSON at each cognitive step. We sniff the
   * prompt for which step it is and return a schema-valid stub. This keeps the
   * REM cycle fully exercisable offline.
   */
  private mockJsonForPrompt(routeText: string, userText: string): string {
    const p = routeText.toLowerCase();
    // Order matters: check the most specific step instructions first. Graph
    // ("knowledge graph") and synthesis ("connection") prompts also mention
    // notes, so they must be matched before the generic consolidate branch.
    if (p.includes('knowledge graph') || (p.includes('entities') && p.includes('edges'))) {
      const words = topWords(userText, 2);
      const a = words[0] ?? 'topic';
      const b = words[1] ?? 'context';
      return JSON.stringify({
        entities: [
          { name: a, type: 'concept' },
          { name: b, type: 'concept' },
        ],
        edges: [{ src: a, dst: b, relation: 'related-to' }],
      });
    }
    if (p.includes('connection') || p.includes('synthes')) {
      // Surface a connection so the demo shows synthesis working offline.
      const words = topWords(userText, 3);
      return JSON.stringify({
        connection: true,
        title: 'Synthesized connection (mock)',
        body: `These notes share an underlying theme: ${words.join(', ')}.`,
      });
    }
    if (p.includes('profile')) {
      const words = topWords(userText, 12);
      return JSON.stringify({ profile: `User profile (mock) — key themes: ${words.join(', ')}.` });
    }
    if (p.includes('contradictory') || p.includes('reconcile')) {
      return JSON.stringify({ contradictory: false, keep: 'a', resolution: '' });
    }
    if (p.includes('consolidate') || p.includes('semantic note')) {
      // Keyword-preserving summary: a good consolidation keeps the salient terms
      // so recall still works after the raw episodes are archived.
      const words = topWords(userText, 10);
      return JSON.stringify({
        title: words.slice(0, 3).join(' ') || 'Consolidated note',
        body: `Consolidated memory about: ${words.join(', ')}.`,
        confidence: 0.8,
      });
    }
    return JSON.stringify({});
  }

  async describeImage(_imageDataUrl: string, _prompt: string): Promise<ChatResult> {
    // Deterministic stub — enough for offline tests to exercise the ingest path.
    return { text: 'MOCK OCR: an uploaded image containing sample text.', promptTokens: 0, completionTokens: 0 };
  }

  async rerank(query: string, documents: string[]): Promise<RerankItem[]> {
    const q = new Set(
      query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean),
    );
    return documents
      .map((doc, index) => {
        const toks = doc.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
        const overlap = toks.filter((t) => q.has(t)).length;
        const score = overlap / (toks.length || 1);
        return { index, score };
      })
      .sort((a, b) => b.score - a.score);
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const STOPWORDS = new Set([
  'note', 'notes', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'this', 'that', 'with',
  'for', 'on', 'these', 'two', 'into', 'one', 'reply', 'json', 'strict', 'user', 'about',
  // instruction words that appear in step prompts — never real content keywords
  'consolidate', 'related', 'memories', 'memory', 'semantic', 'durable', 'summary', 'episodes',
  'episodic', 'extract', 'knowledge', 'graph', 'connection', 'between', 'them', 'their', 'when',
]);

/** Pick the N most frequent content words — used to fabricate plausible entity
 *  names for the offline mock graph extraction. */
function topWords(text: string, n: number): string[] {
  const counts = new Map<string, number>();
  for (const tok of text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (tok.length < 4 || STOPWORDS.has(tok)) continue;
    counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}
