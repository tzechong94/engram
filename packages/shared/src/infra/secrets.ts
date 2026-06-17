import type { Secrets } from './interfaces.js';

/**
 * Env-backed secrets for local dev. In cloud this is replaced by a KMS-backed
 * impl (or the OneCLI vault on the agent-runtime side). Same interface.
 */
export class EnvSecrets implements Secrets {
  async get(name: string): Promise<string | null> {
    return process.env[name] ?? null;
  }
}
