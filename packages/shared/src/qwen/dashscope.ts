import type { QwenConfig } from '../config.js';
import { createLogger } from '../log.js';
import type { ChatMessage, ChatOptions, ChatResult, QwenClient, RerankItem } from './types.js';

const log = createLogger('qwen');

/**
 * Real Qwen via Model Studio / DashScope's OpenAI-compatible endpoint. Hit
 * directly over HTTP — no routing layer, no SDK indirection. Retries transient
 * failures with backoff; callers (memory.write) additionally queue to a
 * dead-letter on exhaustion so a write is never dropped.
 */
export class DashScopeQwenClient implements QwenClient {
  readonly isMock = false;
  readonly embedDim: number;
  private cfg: QwenConfig;

  constructor(cfg: QwenConfig) {
    if (!cfg.apiKey) throw new Error('DASHSCOPE_API_KEY required for real Qwen (or set QWEN_MOCK=true)');
    this.cfg = cfg;
    this.embedDim = cfg.embedDim;
  }

  private async post(path: string, body: unknown, attempt = 0): Promise<unknown> {
    const url = `${this.cfg.baseUrl}${path}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const text = await res.text().catch(() => '');
        if (retryable && attempt < 3) {
          const wait = 250 * Math.pow(2, attempt);
          log.warn('qwen retryable error, backing off', { status: res.status, attempt, wait });
          await sleep(wait);
          return this.post(path, body, attempt + 1);
        }
        throw new Error(`DashScope ${path} ${res.status}: ${text.slice(0, 300)}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt < 3 && isNetworkError(err)) {
        const wait = 250 * Math.pow(2, attempt);
        log.warn('qwen network error, backing off', { attempt, wait, err: String(err) });
        await sleep(wait);
        return this.post(path, body, attempt + 1);
      }
      throw err;
    }
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    const model = opts?.tier === 'turbo' ? this.cfg.turboModel : this.cfg.chatModel;
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts?.temperature ?? 0.3,
    };
    if (opts?.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts?.json) body.response_format = { type: 'json_object' };

    const json = (await this.post('/chat/completions', body)) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = json.choices?.[0]?.message?.content ?? '';
    return {
      text,
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const json = (await this.post('/embeddings', {
      model: this.cfg.embedModel,
      input: texts,
      dimensions: this.cfg.embedDim,
    })) as { data?: Array<{ embedding: number[]; index: number }> };
    const data = json.data ?? [];
    // DashScope returns results indexed; sort to preserve input order.
    const sorted = [...data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }

  async rerank(query: string, documents: string[]): Promise<RerankItem[]> {
    if (documents.length === 0) return [];
    // DashScope rerank uses the native (non-OpenAI) text rerank API shape.
    const json = (await this.post('/rerank', {
      model: this.cfg.rerankModel,
      query,
      documents,
      top_n: documents.length,
    })) as { results?: Array<{ index: number; relevance_score: number }> };
    const results = json.results ?? [];
    return results
      .map((r) => ({ index: r.index, score: r.relevance_score }))
      .sort((a, b) => b.score - a.score);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(msg);
}
