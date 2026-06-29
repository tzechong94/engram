#!/usr/bin/env node
/**
 * Engram brain-viewer server. One tiny Node http process that:
 *   1. serves a read-only, tenant-scoped JSON API over the memory layer (using
 *      only MemoryRepo read methods + MemoryService.search — no writes, no
 *      coupling to internals), and
 *   2. serves the built React frontend (dist-web) on the SAME port.
 *
 *   browser ──/api/:tenant/...──▶ this server ──▶ MemoryRepo (read-only)
 *           ◀── brain UI (static dist-web) ──┘
 *
 * Auth: open locally; if VIEWER_TOKEN is set, every /api call needs it (bearer or
 * ?token=). The viewer is read-only, but the token gates which tenants' memory is
 * exposed in a shared/cloud deploy.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInfra, createQwenClient, loadConfig, createLogger } from '@engram/shared';
import { MemoryService, SleepPhase } from '@engram/memory';

const log = createLogger('viewer');
const PORT = Number(process.env.VIEWER_PORT || 8080);
const TOKEN = process.env.VIEWER_TOKEN || '';
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist-web');

const cfg = loadConfig();
const infra = createInfra(cfg);
const qwen = createQwenClient(cfg.qwen);
const memory = new MemoryService(infra.store, qwen, infra.queue);
const repo = memory.repository;

// Manual sleep/REM trigger for the viewer's "Dream now" button. Single-flight:
// one cycle at a time per process so a double-click can't run two in parallel.
const sleepPhase = new SleepPhase(infra.store, qwen, infra.blob, {
  costCapCents: cfg.sleep.costCapCents,
  forgetThreshold: cfg.sleep.forgetThreshold,
});
let sleeping = false;

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(s);
}

function authed(req: http.IncomingMessage, url: URL): boolean {
  if (!TOKEN) return true;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return bearer === TOKEN || url.searchParams.get('token') === TOKEN;
}

/** Collect a raw request body into a Buffer, with a size cap. */
function readBody(req: http.IncomingMessage, limit = 30 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('file too large (max 30MB)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Extract plain text from an uploaded file buffer by extension. */
async function extractText(filename: string, buf: Buffer): Promise<string> {
  if (filename.toLowerCase().endsWith('.pdf')) {
    // Import the lib entry directly — pdf-parse's index.js runs debug code that
    // reads a sample PDF off disk and throws when imported as the package main.
    const mod = await import('pdf-parse/lib/pdf-parse.js');
    const pdfParse = (mod.default ?? mod) as (b: Buffer) => Promise<{ text: string }>;
    return (await pdfParse(buf)).text;
  }
  return buf.toString('utf8'); // .txt / .md / anything textual
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function serveStatic(res: http.ServerResponse, pathname: string): void {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(WEB_DIR, 'index.html'); // SPA fallback
  }
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('viewer frontend not built — run `pnpm --filter @engram/viewer build`');
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (!authed(req, url)) return json(res, { error: 'unauthorized' }, 401);
  // /api/tenants
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ':tenant', 'resource']
  if (parts.length === 2 && parts[1] === 'tenants') {
    return json(res, { tenants: await repo.listTenants() });
  }
  if (parts.length < 3) return json(res, { error: 'not found' }, 404);
  const tenant = decodeURIComponent(parts[1]!);
  const resource = parts[2]!;

  switch (resource) {
    case 'overview':
      return json(res, { stats: await repo.memoryStats(tenant), latestCycle: await repo.latestSleepCycle(tenant) });
    case 'graph': {
      const [entities, edges] = await Promise.all([repo.getEntities(tenant), repo.getEdgesView(tenant)]);
      return json(res, {
        nodes: entities.map((e) => ({ id: e.id, name: e.name, type: e.type, val: 1 + e.salience })),
        links: edges.map((g) => ({ source: g.src, target: g.dst, relation: g.relation, weight: g.weight, invalidated: g.invalidated })),
      });
    }
    case 'notes':
      return json(res, { notes: await repo.listAllNotes(tenant) });
    case 'episodes':
      return json(res, { episodes: await repo.listEpisodes(tenant) });
    case 'cycles':
      return json(res, { cycles: await repo.listSleepCycles(tenant) });
    case 'core':
      return json(res, { blocks: await repo.getCoreMemory(tenant) });
    case 'asof': {
      const t = url.searchParams.get('t');
      if (!t) return json(res, { error: 't (ISO timestamp) required' }, 400);
      return json(res, { notes: await repo.notesAsOf(tenant, t) });
    }
    case 'search': {
      const q = url.searchParams.get('q') || '';
      const budget = Number(url.searchParams.get('budget') || 1500);
      if (!q) return json(res, { error: 'q required' }, 400);
      return json(res, await memory.search({ tenantId: tenant, query: q, tokenBudget: budget }));
    }
    case 'upload': {
      // Ingest an uploaded document as durable RAG knowledge for this tenant.
      if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405);
      const filename = decodeURIComponent(String(req.headers['x-filename'] || 'upload.txt'));
      const buf = await readBody(req);
      const text = await extractText(filename, buf);
      if (!text.trim()) return json(res, { error: 'no extractable text in file' }, 400);
      const result = await memory.ingestDocument({ tenantId: tenant, filename, text });
      log.info('document ingested', { tenant, ...result });
      return json(res, result);
    }
    case 'sleep': {
      // The one write the viewer allows: manually run a sleep/REM cycle now.
      if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405);
      if (sleeping) return json(res, { error: 'a sleep cycle is already running' }, 409);
      sleeping = true;
      try {
        const before = await repo.memoryStats(tenant);
        const report = await sleepPhase.run(tenant);
        const after = await repo.memoryStats(tenant);
        log.info('manual sleep cycle complete', { tenant, status: report.status });
        return json(res, { report, before, after });
      } finally {
        sleeping = false;
      }
    }
    case 'teach': {
      // Interactive playground: teach Engram a fact (writes one episode).
      if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405);
      const buf = await readBody(req, 64 * 1024);
      let content = '';
      try {
        content = String((JSON.parse(buf.toString('utf8') || '{}') as { content?: string }).content || '').trim();
      } catch {
        /* bad json */
      }
      if (!content) return json(res, { error: 'content required' }, 400);
      await repo.ensureTenant(tenant); // allow fresh playground tenants
      const r = await memory.write({ tenantId: tenant, content, sourceChannel: 'viewer' });
      log.info('viewer teach', { tenant, id: r.id });
      return json(res, { id: r.id, content });
    }
    case 'answer': {
      // Two-brains: answer the question WITH Engram memory (recall + ground) vs
      // WITHOUT (a cold model). The headline proof that memory changes the answer.
      const q = url.searchParams.get('q') || '';
      if (!q) return json(res, { error: 'q required' }, 400);
      const recall = await memory.search({ tenantId: tenant, query: q, tokenBudget: 1200 });
      const memBlock = recall.memories.map((m) => `- ${m.content}`).join('\n');
      const ask = async (sys: string, user: string): Promise<string> => {
        const r = await qwen.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { tier: 'max' });
        return r.text.trim();
      };
      const [withMemory, withoutMemory] = await Promise.all([
        ask(
          'You are a personal assistant WITH long-term memory of this user. Answer ONLY from the memories provided. If they do not contain the answer, say "I don\'t know." One sentence.',
          `Memories about the user:\n${memBlock || '(no memories)'}\n\nQuestion: ${q}`,
        ),
        ask('You are a personal assistant with NO memory of this user. Answer the question. One sentence.', `Question: ${q}`),
      ]);
      return json(res, { withMemory, withoutMemory, recalled: recall.memories.map((m) => m.content) });
    }
    case 'evals': {
      // Proof panel: serve the latest eval gate results (packages/eval/out/evals.json).
      try {
        const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../eval/out/evals.json');
        return json(res, JSON.parse(fs.readFileSync(p, 'utf8')));
      } catch {
        return json(res, { error: 'no eval results yet — run `pnpm --filter @engram/eval evals`' }, 404);
      }
    }
    default:
      return json(res, { error: `unknown resource: ${resource}` }, 404);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      log.error('api error', { path: url.pathname, err: String(err) });
      json(res, { error: String(err instanceof Error ? err.message : err) }, 500);
    });
  } else {
    serveStatic(res, url.pathname);
  }
});

server.listen(PORT, () => log.info(`brain viewer on http://localhost:${PORT}`, { mock: qwen.isMock, auth: !!TOKEN }));
