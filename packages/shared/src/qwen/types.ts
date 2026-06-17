/**
 * The Qwen client interface. Inference and embeddings behave identically from
 * local and cloud because both go through Model Studio / DashScope. A mock impl
 * (deterministic) backs offline tests and the eval harness so nothing requires a
 * live key to run.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** Which tier: 'max' for reasoning/synthesis, 'turbo' for cheap classification. */
  tier?: 'max' | 'turbo';
  temperature?: number;
  maxTokens?: number;
  /** Ask for strict JSON back (uses response_format when supported). */
  json?: boolean;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

export interface RerankItem {
  index: number;
  score: number;
}

export interface QwenClient {
  /** True when this is the deterministic offline mock (not real Qwen). */
  readonly isMock: boolean;
  readonly embedDim: number;

  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;

  /** Batch-embed texts. Returns one vector per input, each length `embedDim`. */
  embed(texts: string[]): Promise<number[][]>;

  /** Rerank documents against a query; returns items sorted by descending score. */
  rerank(query: string, documents: string[]): Promise<RerankItem[]>;
}
