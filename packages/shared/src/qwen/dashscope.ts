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
    const model = opts?.model ?? (opts?.tier === 'turbo' ? this.cfg.turboModel : this.cfg.chatModel);
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

  async describeImage(imageDataUrl: string, prompt: string): Promise<ChatResult> {
    // Vision via the same OpenAI-compatible endpoint: qwen-vl takes content
    // arrays with an image_url part (data: URLs supported).
    const body = {
      model: this.cfg.vlModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: prompt },
          ],
        },
      ],
      temperature: 0.1,
    };
    const json = (await this.post('/chat/completions', body)) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    };
  }

  async rerank(query: string, documents: string[]): Promise<RerankItem[]> {
    // Rerank is optional — set QWEN_RERANK_MODEL='' to disable (recall still works
    // via vector+keyword+PPR+budgeter). DashScope rerank is NOT on the OpenAI-
    // compatible endpoint; it lives on the native text-rerank service, with a
    // different URL + request/response shape. Derive the native base from the
    // compatible-mode base.
    if (documents.length === 0 || !this.cfg.rerankModel) return [];
    const nativeBase = this.cfg.baseUrl.replace(/\/compatible-mode\/v1\/?$/, '/api/v1');
    const url = `${nativeBase}/services/rerank/text-rerank/text-rerank`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: this.cfg.rerankModel,
        input: { query, documents },
        parameters: { top_n: documents.length, return_documents: false },
      }),
    });
    if (!res.ok) throw new Error(`DashScope rerank ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const json = (await res.json()) as { output?: { results?: Array<{ index: number; relevance_score: number }> } };
    const results = json.output?.results ?? [];
    return results.map((r) => ({ index: r.index, score: r.relevance_score })).sort((a, b) => b.score - a.score);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(msg);
}
