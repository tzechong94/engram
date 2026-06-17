import { loadConfig, type QwenConfig } from '../config.js';
import { createLogger } from '../log.js';
import { DashScopeQwenClient } from './dashscope.js';
import { MockQwenClient } from './mock.js';
import type { QwenClient } from './types.js';

export * from './types.js';
export { MockQwenClient } from './mock.js';
export { DashScopeQwenClient } from './dashscope.js';

const log = createLogger('qwen');

/**
 * Build the Qwen client from config. Mock by default; real DashScope only when
 * QWEN_MOCK=false AND a key is present. Falls back to mock (loudly) if someone
 * asks for real Qwen without a key, so the system never hard-crashes on a
 * missing key in dev.
 */
export function createQwenClient(cfg: QwenConfig = loadConfig().qwen): QwenClient {
  if (cfg.mock) {
    log.info('using MOCK Qwen client (offline). Set QWEN_MOCK=false + DASHSCOPE_API_KEY for real Qwen.');
    return new MockQwenClient(cfg.embedDim);
  }
  if (!cfg.apiKey) {
    log.warn('QWEN_MOCK=false but DASHSCOPE_API_KEY is empty — falling back to mock.');
    return new MockQwenClient(cfg.embedDim);
  }
  log.info('using real DashScope Qwen client', { chatModel: cfg.chatModel, embedModel: cfg.embedModel });
  return new DashScopeQwenClient(cfg);
}
