import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

/**
 * Qwen Code engine provider — the NanoClaw engine swapped from Claude to Qwen.
 *
 * Drives the Qwen Code terminal agent (a Gemini-CLI fork) directly, with NO
 * routing/middle layer: Qwen Code talks straight to Model Studio / DashScope
 * (configured via env it inherits). Two invocation modes behind one provider:
 *
 *   - acp (default): run `qwen --experimental-acp`, a persistent agent process
 *     speaking the Agent Client Protocol (JSON-RPC over stdio). This is the mode
 *     the build brief points at — real streaming (→ activity events), session
 *     continuity (continuation = ACP sessionId), and native MCP (the cloud memory
 *     server is handed to Qwen Code via session/new mcpServers).
 *   - oneshot: `qwen -p "<prompt>" --yolo`, one process per turn. Fallback for
 *     environments where the ACP daemon misbehaves. Set QWEN_MODE=oneshot.
 *
 *        host ──QUERY──▶ QwenProvider ──ACP/stdio──▶ qwen ──OpenAI API──▶ Model Studio
 *                              │                       │
 *                              │◀── session/update ────┘ (streaming chunks, tool calls)
 *                              └── mcp__memory__* tools reach the Engram memory MCP server
 *
 * NOTE: the ACP method names/framing below follow the Agent Client Protocol spec
 * (newline-delimited JSON-RPC 2.0). Validate against the installed qwen-code
 * version on first live run (see docs/qwen-engine.md); the framing helper is
 * isolated so a switch to Content-Length framing is a one-line change.
 */

const QWEN_BIN = process.env.QWEN_BIN || 'qwen';
const QWEN_MODE = (process.env.QWEN_MODE || 'acp').toLowerCase();

// An ACP session id from a prior daemon is gone after a container respawn (the
// daemon is in-memory). qwen-code reports this as JSON-RPC code -32002
// "Resource not found: session:<id>". JsonRpcPeer rejects with
// new Error(JSON.stringify(error)), so the message holds the code and text.
// Word order ("not found" before "session") varies, so test code + both terms
// independently rather than a session-first regex.
const SESSION_INVALID_TERMS = /not found|unknown|invalid|expired|no such/i;

const CONVERSATIONAL_PREAMBLE =
  'You are Engram, a warm, concise personal assistant reached over chat (Telegram/WhatsApp/WeChat). ' +
  'You are NOT a coding tool. Converse naturally and keep replies short. ' +
  'You have a persistent long-term memory. When relevant past context exists it is provided to you ' +
  'automatically below under "Relevant memories" — use it naturally, as if you simply remember the ' +
  'person. You also have memory tools (write, search, forget) you may call when useful — for example, ' +
  'call forget when the user asks you to forget or corrects a fact. Never mention tools, memory, or ' +
  'the fact that you looked anything up.';

/**
 * Minimal MCP stdio client — spawns a one-shot connection to an MCP server,
 * runs the initialize handshake, calls a single tool, and returns the joined
 * text content. Used by the provider's DETERMINISTIC memory path (recall before
 * a turn, capture after), which does not depend on the model deciding to call
 * the memory tools. The @modelcontextprotocol/sdk stdio transport speaks
 * newline-delimited JSON-RPC, so we frame messages with '\n'.
 *
 * Best-effort by contract: callers swallow errors so a memory hiccup never
 * breaks a chat turn. Short-lived (one tool call per spawn) for simplicity and
 * isolation; chat latency tolerates the ~200ms server startup.
 */
async function callMemoryStdioTool(
  cfg: McpServerConfig,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 20000,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buf = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('memory tool timeout'))), timeoutMs);
    const send = (obj: unknown): void => {
      try {
        child.stdin.write(JSON.stringify(obj) + '\n');
      } catch {
        /* server gone */
      }
    };
    child.on('error', (e) => finish(() => reject(e)));
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { content?: Array<{ text?: string }> } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2) {
          const text = (msg.result?.content ?? []).map((c) => c.text ?? '').join('\n').trim();
          finish(() => resolve(text));
        }
      }
    });
    // Handshake → tool call. id:1 initialize, then the call as id:2.
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'engram-runner', version: '1' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
  });
}

export class QwenProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;
  readonly usesMemoryScaffold = false; // durable memory is the cloud MCP, not a local tree

  private model?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private assistantName?: string;

  constructor(options: ProviderOptions = {}) {
    this.model = options.model;
    this.mcpServers = options.mcpServers ?? {};
    this.env = options.env ?? {};
    this.assistantName = options.assistantName;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('-32002')) return true;
    return /session/i.test(msg) && SESSION_INVALID_TERMS.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    return QWEN_MODE === 'oneshot' ? this.queryOneShot(input) : this.queryAcp(input);
  }

  // ── Deterministic memory (recall before a turn, capture after) ───────────────
  // The conversational model cannot be relied on to call the memory tools, so
  // Engram drives memory itself: search for relevant context and inject it, then
  // write the user's turn into the pipeline. Reuses the same `memory` MCP server
  // the agent is wired to, so there is one source of truth. All best-effort.

  private get memoryCfg(): McpServerConfig | undefined {
    return this.mcpServers['memory'];
  }

  /**
   * Strip NanoClaw's inbound envelope to the user's actual words. The prompt
   * arrives as `<context .../>\n<message ...>BODY</message>`; we store/search on
   * BODY so memory stays clean (better embeddings, readable viewer, better
   * sleep consolidation). Falls back to tag-stripping if the shape changes.
   */
  private cleanUserText(raw: string): string {
    if (!raw) return '';
    const bodies: string[] = [];
    const re = /<message\b[^>]*>([\s\S]*?)<\/message>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) bodies.push(m[1]);
    const text = bodies.length ? bodies.join('\n') : raw.replace(/<[^>]+>/g, ' ');
    return text.replace(/\s+/g, ' ').trim();
  }

  /** Recall relevant memories for the user's message; returns a context block or ''. */
  private async recallContext(userText: string): Promise<string> {
    const cfg = this.memoryCfg;
    if (!cfg || !userText.trim()) return '';
    try {
      const recalled = await callMemoryStdioTool(cfg, 'search', { query: userText });
      if (!recalled) return '';
      return `Relevant memories about the user (use naturally; do not say you looked them up):\n${recalled}`;
    } catch {
      return '';
    }
  }

  /** Write the user's message into memory. Fire-and-forget; never blocks a turn. */
  private captureTurn(userText: string, channel?: string): void {
    const cfg = this.memoryCfg;
    if (!cfg || !userText.trim()) return;
    void callMemoryStdioTool(cfg, 'write', {
      content: userText,
      ...(channel ? { source_channel: channel } : {}),
    }).catch(() => {
      /* best-effort capture */
    });
  }

  // ── ACP daemon mode ────────────────────────────────────────────────────────

  private queryAcp(input: QueryInput): AgentQuery {
    const queue = new EventQueue();
    const child = spawn(QWEN_BIN, ['--experimental-acp'], {
      cwd: input.cwd,
      env: this.childEnv(input),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rpc = new JsonRpcPeer(child, {
      // The agent asks permission before tool calls; we auto-allow (the host
      // already gates credentialed actions via OneCLI, and runs bypass mode).
      'session/request_permission': async (params) => {
        const options = (params?.options as Array<{ optionId: string; kind?: string }>) ?? [];
        const allow =
          options.find((o) => o.kind === 'allow_always') ??
          options.find((o) => o.kind === 'allow_once') ??
          options[0];
        return { outcome: { outcome: 'selected', optionId: allow?.optionId ?? 'allow' } };
      },
    });

    let aborted = false;
    const instructions = [CONVERSATIONAL_PREAMBLE, input.systemContext?.instructions].filter(Boolean).join('\n\n');

    const run = async () => {
      child.on('error', (e) => queue.push({ type: 'error', message: `qwen spawn failed: ${e.message}`, retryable: false }));
      child.stderr.on('data', (d) => {
        const s = d.toString().trim();
        if (s) queue.push({ type: 'activity' });
      });

      try {
        const initRes = (await rpc.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })) as { authMethods?: Array<{ id?: string }> };

        // ACP requires selecting an auth method before opening a session when
        // the agent advertises any. Qwen Code talks to Model Studio's
        // OpenAI-compatible endpoint via OPENAI_API_KEY (mapped from
        // DASHSCOPE_API_KEY in childEnv) — that's the "openai" method.
        const authMethods = initRes?.authMethods ?? [];
        if (authMethods.length > 0) {
          const methodId =
            authMethods.find((m) => m.id === 'openai')?.id ?? authMethods[0]?.id ?? 'openai';
          await rpc.request('authenticate', { methodId });
        }

        // session/update notifications stream the turn; bridge them to events.
        rpc.onNotification('session/update', (params) => {
          const update = (params?.update ?? {}) as { sessionUpdate?: string; content?: { text?: string } };
          queue.push({ type: 'activity' });
          if (update.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
            queue.pushText(update.content.text);
          } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
            queue.push({ type: 'progress', message: 'working…' });
          }
        });

        const mcpServers = this.acpMcpServers();
        let sessionId: string;
        if (input.continuation) {
          try {
            const loaded = (await rpc.request('session/load', { sessionId: input.continuation, cwd: input.cwd, mcpServers })) as { sessionId?: string };
            sessionId = loaded?.sessionId ?? input.continuation;
          } catch (err) {
            if (this.isSessionInvalid(err)) {
              const created = (await rpc.request('session/new', { cwd: input.cwd, mcpServers })) as { sessionId: string };
              sessionId = created.sessionId;
            } else {
              throw err;
            }
          }
        } else {
          const created = (await rpc.request('session/new', { cwd: input.cwd, mcpServers })) as { sessionId: string };
          sessionId = created.sessionId;
        }
        queue.push({ type: 'init', continuation: sessionId });

        const promptOnce = async (text: string) => {
          queue.beginTurn();
          const clean = this.cleanUserText(text);
          const memory = await this.recallContext(clean);
          const fullPrompt = [instructions, memory, text].filter(Boolean).join('\n\n');
          const res = (await rpc.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: fullPrompt }],
          })) as { stopReason?: string };
          queue.endTurn(res?.stopReason);
          this.captureTurn(clean, 'telegram');
        };

        await promptOnce(input.prompt);
        // Follow-ups via push(); resolved when end()/abort() closes the input.
        for await (const next of queue.inputs()) {
          if (aborted) break;
          await promptOnce(next);
        }
      } catch (err) {
        queue.push({ type: 'error', message: err instanceof Error ? err.message : String(err), retryable: true });
      } finally {
        queue.close();
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    };

    void run();

    return {
      push: (m) => queue.pushInput(m),
      end: () => queue.endInput(),
      events: queue.events(),
      abort: () => {
        aborted = true;
        queue.endInput();
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      },
    };
  }

  // ── one-shot fallback mode ───────────────────────────────────────────────────

  private queryOneShot(input: QueryInput): AgentQuery {
    const queue = new EventQueue();
    let aborted = false;
    let current: ChildProcess | null = null;
    const instructions = [CONVERSATIONAL_PREAMBLE, input.systemContext?.instructions].filter(Boolean).join('\n\n');

    const runPrompt = async (text: string): Promise<void> => {
      const clean = this.cleanUserText(text);
      const memory = await this.recallContext(clean);
      const composed = [instructions, memory, text].filter(Boolean).join('\n\n');
      await new Promise<void>((resolve) => {
        const args = ['--yolo', '-p', composed];
        if (this.model) args.push('-m', this.model);
        const proc = spawn(QWEN_BIN, args, { cwd: input.cwd, env: this.childEnv(input), stdio: ['ignore', 'pipe', 'pipe'] });
        current = proc;
        let out = '';
        proc.stdout?.on('data', (d) => {
          out += d.toString();
          queue.push({ type: 'activity' });
        });
        proc.on('error', (e) => queue.push({ type: 'error', message: `qwen spawn failed: ${e.message}`, retryable: false }));
        proc.on('close', () => {
          queue.push({ type: 'result', text: out.trim() || null });
          resolve();
        });
      });
      this.captureTurn(clean, 'telegram');
    };

    const run = async () => {
      // No persistent session in one-shot; continuation is a synthetic marker.
      queue.push({ type: 'init', continuation: input.continuation ?? `qwen-oneshot-${process.pid}` });
      await runPrompt(input.prompt);
      for await (const next of queue.inputs()) {
        if (aborted) break;
        await runPrompt(next);
      }
      queue.close();
    };
    void run();

    return {
      push: (m) => queue.pushInput(m),
      end: () => queue.endInput(),
      events: queue.events(),
      abort: () => {
        aborted = true;
        queue.endInput();
        current?.kill('SIGKILL');
      },
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private childEnv(input: QueryInput): NodeJS.ProcessEnv {
    // Pass env through (DashScope creds live here, injected by the host/OneCLI).
    // Force Qwen Code to talk to Model Studio's OpenAI-compatible endpoint.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(this.env)) if (v !== undefined) env[k] = v;
    if (env.DASHSCOPE_API_KEY && !env.OPENAI_API_KEY) env.OPENAI_API_KEY = env.DASHSCOPE_API_KEY;
    if (!env.OPENAI_BASE_URL && env.DASHSCOPE_BASE_URL) env.OPENAI_BASE_URL = env.DASHSCOPE_BASE_URL;
    if (this.model) env.QWEN_MODEL = this.model;
    // Qwen Code auto-selects the "openai" auth type ONLY when all three of
    // OPENAI_API_KEY, OPENAI_MODEL, and OPENAI_BASE_URL are present in the env
    // (getAuthTypeFromEnv in modelConfigUtils). The ACP daemon, unlike the
    // oneshot `-p` path, won't fall back to QWEN_MODEL for this check — so we
    // must set OPENAI_MODEL explicitly. Fall back to the group model, then the
    // host-threaded QWEN_MODEL, so a group with no explicit model still works.
    if (!env.OPENAI_MODEL) env.OPENAI_MODEL = this.model || env.QWEN_MODEL;
    void input;
    return env;
  }

  /** Convert the nanoclaw mcpServers map into the ACP session/new shape. */
  private acpMcpServers(): Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> {
    return Object.entries(this.mcpServers).map(([name, cfg]) => ({
      name,
      command: cfg.command,
      args: cfg.args ?? [],
      env: Object.entries(cfg.env ?? {}).map(([k, v]) => ({ name: k, value: v })),
    }));
  }
}

// ── A tiny event queue bridging callback-style RPC into an async-iterable ──────

class EventQueue {
  private events_: ProviderEvent[] = [];
  private inputs_: string[] = [];
  private resolveEvent: (() => void) | null = null;
  private resolveInput: (() => void) | null = null;
  private closed = false;
  private inputClosed = false;
  private turnText = '';

  push(e: ProviderEvent): void {
    this.events_.push(e);
    this.resolveEvent?.();
  }
  pushText(t: string): void {
    this.turnText += t;
  }
  beginTurn(): void {
    this.turnText = '';
  }
  endTurn(stopReason?: string): void {
    void stopReason;
    this.push({ type: 'result', text: this.turnText.trim() || null });
  }
  close(): void {
    this.closed = true;
    this.resolveEvent?.();
  }

  pushInput(m: string): void {
    this.inputs_.push(m);
    this.resolveInput?.();
  }
  endInput(): void {
    this.inputClosed = true;
    this.resolveInput?.();
  }
  pushInputClose(): void {
    this.endInput();
  }

  events(): AsyncIterable<ProviderEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (self.events_.length > 0) yield self.events_.shift()!;
          if (self.closed) return;
          await new Promise<void>((r) => (self.resolveEvent = r));
          self.resolveEvent = null;
        }
      },
    };
  }

  inputs(): AsyncIterable<string> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (self.inputs_.length > 0) yield self.inputs_.shift()!;
          if (self.inputClosed) return;
          await new Promise<void>((r) => (self.resolveInput = r));
          self.resolveInput = null;
        }
      },
    };
  }
}

// ── Minimal newline-delimited JSON-RPC 2.0 peer over a child process ───────────

type RpcHandler = (params: Record<string, unknown> | undefined) => Promise<unknown>;

class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private notificationHandlers = new Map<string, (params: Record<string, unknown> | undefined) => void>();
  private buffer = '';

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private requestHandlers: Record<string, RpcHandler> = {},
  ) {
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
  }

  private onData(text: string): void {
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON log lines on stdout
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.id !== 'undefined' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      const params = msg.params as Record<string, unknown> | undefined;
      if (typeof msg.id !== 'undefined' && this.requestHandlers[msg.method]) {
        void this.requestHandlers[msg.method]!(params)
          .then((result) => this.send({ jsonrpc: '2.0', id: msg.id, result }))
          .catch((err) => this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(err) } }));
        return;
      }
      this.notificationHandlers.get(msg.method)?.(params);
    }
  }

  onNotification(method: string, handler: (params: Record<string, unknown> | undefined) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  private send(msg: Record<string, unknown>): void {
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }
}

registerProvider('qwen', (opts) => new QwenProvider(opts));
