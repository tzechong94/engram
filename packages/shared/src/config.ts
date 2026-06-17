/**
 * Central, env-driven config. No hardcoded cloud endpoints anywhere else in the
 * codebase — everything funnels through here so local ↔ Alibaba is a config swap.
 */

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function envOpt(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

export type InfraMode = 'local' | 'alibaba';

export interface QwenConfig {
  mock: boolean;
  apiKey: string;
  baseUrl: string;
  chatModel: string;
  turboModel: string;
  embedModel: string;
  embedDim: number;
  rerankModel: string;
}

export interface SleepConfig {
  costCapCents: number;
  cron: string;
  inactivityMinutes: number;
  forgetThreshold: number;
  /** Reflection trigger: fire a cycle when accumulated episode importance since
   *  the last cycle exceeds this (Generative Agents). 0 disables. */
  importanceThreshold: number;
}

export interface EngramConfig {
  infra: InfraMode;
  databaseUrl: string;
  redisUrl: string;
  blob: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
    region: string;
  };
  qwen: QwenConfig;
  sleep: SleepConfig;
  encryptionKey: string;
}

let cached: EngramConfig | null = null;

export function loadConfig(): EngramConfig {
  if (cached) return cached;
  // QWEN_MOCK defaults to true unless a real key is present, so the system is
  // always runnable offline. A key alone does not disable the mock — the operator
  // must set QWEN_MOCK=false explicitly. This avoids surprise live spend.
  const apiKey = envOpt('DASHSCOPE_API_KEY');
  const mock = envBool('QWEN_MOCK', true);

  cached = {
    infra: (envOpt('ENGRAM_INFRA', 'local') as InfraMode),
    databaseUrl: envOpt('DATABASE_URL', 'postgres://engram:engram@localhost:5433/engram'),
    redisUrl: envOpt('REDIS_URL', 'redis://localhost:6380'),
    blob: {
      endpoint: envOpt('BLOB_ENDPOINT', 'http://localhost:9000'),
      accessKey: envOpt('BLOB_ACCESS_KEY', 'engram'),
      secretKey: envOpt('BLOB_SECRET_KEY', 'engrampassword'),
      bucket: envOpt('BLOB_BUCKET', 'engram-archive'),
      region: envOpt('BLOB_REGION', 'us-east-1'),
    },
    qwen: {
      mock,
      apiKey,
      baseUrl: envOpt('DASHSCOPE_BASE_URL', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
      chatModel: envOpt('QWEN_CHAT_MODEL', 'qwen-max'),
      turboModel: envOpt('QWEN_TURBO_MODEL', 'qwen-turbo'),
      embedModel: envOpt('QWEN_EMBED_MODEL', 'text-embedding-v3'),
      embedDim: envInt('QWEN_EMBED_DIM', 1024),
      rerankModel: envOpt('QWEN_RERANK_MODEL', 'gte-rerank'),
    },
    sleep: {
      costCapCents: envInt('SLEEP_COST_CAP_CENTS', 50),
      cron: envOpt('SLEEP_CRON', '0 4 * * *'),
      inactivityMinutes: envInt('SLEEP_INACTIVITY_MINUTES', 120),
      forgetThreshold: envFloat('FORGET_THRESHOLD', 0.15),
      importanceThreshold: envFloat('SLEEP_IMPORTANCE_THRESHOLD', 15),
    },
    encryptionKey: envOpt('ENGRAM_ENCRYPTION_KEY'),
  };
  return cached;
}

/** Test helper: clear the memoized config so a test can re-load with new env. */
export function resetConfigForTest(): void {
  cached = null;
}
