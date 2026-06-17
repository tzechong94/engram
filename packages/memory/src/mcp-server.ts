#!/usr/bin/env node
/**
 * Engram memory MCP server (stdio). This is the online path the agent reaches —
 * the agent (Qwen Code) connects to it as an MCP server configured in
 * container.json. Tools: write / search / forget.
 *
 * Isolation: the tenant is taken from ENGRAM_TENANT_ID (injected at container
 * spawn from the agent group's owner), NOT from tool arguments. There is no way
 * for the agent to read another tenant's memory.
 *
 *   agent ──MCP/stdio──▶ this server ──▶ MemoryService ──▶ Postgres (tenant-scoped)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createInfra, createQwenClient, createLogger, loadConfig } from '@engram/shared';
import { MemoryService } from './service.js';

const log = createLogger('mcp');

const TOOLS = [
  {
    name: 'write',
    description:
      'Capture a memory about the user (an episode). Use when the user shares a fact, preference, plan, or anything worth remembering across conversations. Returns the episode id.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory to store, as a self-contained statement.' },
        source_channel: { type: 'string', description: 'Channel it came from (telegram, whatsapp, ...).' },
        importance: { type: 'number', description: 'Optional 0..1 importance hint.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'search',
    description:
      'Recall memories relevant to a query. Returns the most relevant memories packed under a token budget, plus the packing trace explaining the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall.' },
        token_budget: { type: 'number', description: 'Max tokens of memory to return (default 1500).' },
        k: { type: 'number', description: 'Candidate pool size per recall mode (default 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'forget',
    description: 'Explicitly forget a memory by episode id or by matching query text.',
    inputSchema: {
      type: 'object',
      properties: {
        episode_id: { type: 'string' },
        query: { type: 'string' },
      },
    },
  },
] as const;

async function main(): Promise<void> {
  const tenantId = process.env.ENGRAM_TENANT_ID;
  if (!tenantId) {
    log.error('ENGRAM_TENANT_ID is required (per-tenant isolation). Exiting.');
    process.exit(1);
  }
  const cfg = loadConfig();
  const infra = createInfra(cfg);
  const qwen = createQwenClient(cfg.qwen);
  const memory = new MemoryService(infra.store, qwen, infra.queue);

  const server = new Server(
    { name: 'engram-memory', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as object[] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = await dispatch(memory, tenantId, name, args as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      log.error('tool error', { name, err: String(err) });
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('engram memory MCP server ready', { tenantId, mock: qwen.isMock });
}

async function dispatch(memory: MemoryService, tenantId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'write':
      return memory.write({
        tenantId,
        content: String(args.content ?? ''),
        sourceChannel: args.source_channel ? String(args.source_channel) : undefined,
        importance: typeof args.importance === 'number' ? args.importance : undefined,
      });
    case 'search': {
      const res = await memory.search({
        tenantId,
        query: String(args.query ?? ''),
        tokenBudget: typeof args.token_budget === 'number' ? args.token_budget : undefined,
        k: typeof args.k === 'number' ? args.k : undefined,
      });
      return res;
    }
    case 'forget':
      return memory.forget({
        tenantId,
        episodeId: args.episode_id ? String(args.episode_id) : undefined,
        query: args.query ? String(args.query) : undefined,
      });
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

main().catch((err) => {
  log.error('mcp server fatal', { err: String(err) });
  process.exit(1);
});
