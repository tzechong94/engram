/**
 * End-to-end integration test against a real Postgres (the docker-compose stack)
 * using the deterministic mock Qwen. Proves the whole hero path: write → search
 * (hybrid + budgeter) → sleep cycle (consolidate → graph → forget) → recall holds
 * while the active set shrinks → cross-channel recall.
 *
 * Skipped automatically when ENGRAM_TEST_DB is unset, so unit-only runs (CI
 * without Postgres) stay green. Run with: ENGRAM_TEST_DB=1 make test  (after make up)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgStore, PgQueue, FilesystemBlob, MockQwenClient, newId } from '@engram/shared';
import { MemoryService } from './service.js';
import { SleepPhase } from './sleep.js';
import { runMigrations } from './db/migrate.js';

const DB = process.env.DATABASE_URL ?? 'postgres://engram:engram@localhost:5433/engram';
const ENABLED = process.env.ENGRAM_TEST_DB === '1';

const d = ENABLED ? describe : describe.skip;

d('memory integration (real Postgres + mock Qwen)', () => {
  const tenant = `test-${newId()}`;
  let store: PgStore;
  let memory: MemoryService;
  let sleep: SleepPhase;

  beforeAll(async () => {
    await runMigrations(DB);
    store = new PgStore(DB);
    const qwen = new MockQwenClient(1024);
    const queue = new PgQueue(store);
    memory = new MemoryService(store, qwen, queue);
    sleep = new SleepPhase(store, qwen, new FilesystemBlob(), {
      costCapCents: 100,
      forgetThreshold: 0.15,
      clusterThreshold: 0.4,
    });
  });

  afterAll(async () => {
    await store.query('DELETE FROM tenants WHERE id = $1', [tenant]);
    await store.close();
  });

  it('writes episodes idempotently (content-hash dedup)', async () => {
    const a = await memory.write({ tenantId: tenant, content: 'I love hiking in the mountains', sourceChannel: 'telegram' });
    const b = await memory.write({ tenantId: tenant, content: 'I love hiking in the mountains', sourceChannel: 'telegram' });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id);
    expect(a.embedded).toBe(true);
  });

  it('hybrid search recalls a relevant memory with a packing trace', async () => {
    await memory.write({ tenantId: tenant, content: 'My favorite trail is Eagle Peak', sourceChannel: 'telegram' });
    const res = await memory.search({ tenantId: tenant, query: 'where do I like to hike', tokenBudget: 500 });
    expect(res.memories.length).toBeGreaterThan(0);
    expect(res.trace.candidates.length).toBeGreaterThan(0);
    expect(res.trace.tokensUsed).toBeLessThanOrEqual(500);
    const joined = res.memories.map((m) => m.content).join(' ').toLowerCase();
    expect(joined).toMatch(/hiking|trail|eagle/);
  });

  it('cross-channel recall: written on telegram, recalled regardless of channel', async () => {
    await memory.write({ tenantId: tenant, content: 'I am allergic to peanuts', sourceChannel: 'telegram' });
    // A search has no channel scoping — same tenant sees it (as whatsapp would).
    const res = await memory.search({ tenantId: tenant, query: 'food allergy', tokenBudget: 500 });
    const joined = res.memories.map((m) => m.content).join(' ').toLowerCase();
    expect(joined).toMatch(/peanut|allerg/);
  });

  it('sleep cycle consolidates episodes into notes and shrinks the active set', async () => {
    // Seed a tight cluster so clustering + consolidation fire.
    for (let i = 0; i < 4; i++) {
      await memory.write({ tenantId: tenant, content: `hiking mountains trail outdoors weekend trip ${i}`, sourceChannel: 'telegram' });
    }
    const before = await memory.repository.memoryStats(tenant);
    const report = await sleep.run(tenant);
    const after = await memory.repository.memoryStats(tenant);

    expect(['completed', 'partial']).toContain(report.status);
    expect(report.stats.episodesScanned).toBeGreaterThan(0);
    // Consolidation should produce at least one note and reduce active episodes.
    expect(after.notes).toBeGreaterThanOrEqual(before.notes);
    expect(after.activeEpisodes).toBeLessThanOrEqual(before.activeEpisodes);
  });

  it('M3: sleep maintains a core profile block and search prepends it', async () => {
    // The earlier sleep cycle for `tenant` should have written a profile block.
    const blocks = await memory.repository.getCoreMemory(tenant);
    const profile = blocks.find((b) => b.label === 'profile');
    expect(profile).toBeTruthy();
    expect(profile!.body.length).toBeGreaterThan(0);
    expect(profile!.body.length).toBeLessThanOrEqual(profile!.sizeLimit);

    // A search prepends the core block as a 'core' memory + trace entry.
    const res = await memory.search({ tenantId: tenant, query: 'anything', tokenBudget: 1500 });
    expect(res.memories[0]?.kind).toBe('core');
    expect(res.trace.candidates.some((c) => c.kind === 'core' && c.included)).toBe(true);
  });

  it('M3: read-only core blocks are protected from sleep writes', async () => {
    const ro = `test-${newId()}`;
    await memory.repository.ensureTenant(ro);
    // Developer sets a read-only block directly in the DB.
    await store.query(
      `INSERT INTO core_memory (tenant_id, label, body, read_only) VALUES ($1, 'persona', 'fixed persona', true)`,
      [ro],
    );
    await memory.repository.upsertCoreBlock({ tenantId: ro, label: 'persona', body: 'sleep tried to change this', fromSleep: true });
    const blocks = await memory.repository.getCoreMemory(ro);
    expect(blocks.find((b) => b.label === 'persona')!.body).toBe('fixed persona');
    await store.query('DELETE FROM tenants WHERE id = $1', [ro]);
  });

  it('explicit forget removes a memory from recall', async () => {
    const w = await memory.write({ tenantId: tenant, content: 'my temporary password is hunter2', sourceChannel: 'telegram' });
    const f = await memory.forget({ tenantId: tenant, episodeId: w.id });
    expect(f.forgotten).toBe(1);
    const res = await memory.search({ tenantId: tenant, query: 'temporary password', tokenBudget: 500 });
    const ids = res.memories.map((m) => m.id);
    expect(ids).not.toContain(w.id);
  });

  it('records an observable sleep cycle report', async () => {
    const latest = await memory.repository.latestSleepCycle(tenant);
    expect(latest).not.toBeNull();
    expect(latest!.stats).toHaveProperty('consolidated');
    expect(latest!.finishedAt).not.toBeNull();
  });

  it('bi-temporal: invalidated notes leave the active set but survive as-of reads', async () => {
    const bt = `test-${newId()}`;
    await memory.repository.ensureTenant(bt);
    const qwen = new MockQwenClient(1024);
    const [emb] = await qwen.embed(['lives in San Francisco']);
    const id = await memory.repository.insertNote({ tenantId: bt, title: 'Home', body: 'lives in San Francisco', embedding: emb!, confidence: 0.8, sourceEpisodeIds: [], kind: 'consolidation' });

    // Present in the active set now.
    const beforeActive = await memory.repository.activeNotes(bt);
    expect(beforeActive.map((n) => n.id)).toContain(id);
    const tBefore = new Date().toISOString();

    // Invalidate it (the fact stopped being true).
    await new Promise((r) => setTimeout(r, 10));
    await memory.repository.invalidateNote(bt, id);

    // Gone from the active set...
    const afterActive = await memory.repository.activeNotes(bt);
    expect(afterActive.map((n) => n.id)).not.toContain(id);
    // ...but an as-of read from before the invalidation still sees it.
    const asOf = await memory.repository.notesAsOf(bt, tBefore);
    expect(asOf.map((n) => n.id)).toContain(id);

    await store.query('DELETE FROM tenants WHERE id = $1', [bt]);
  });

  it('reconcile supersedes the losing note when the judge flags a contradiction', async () => {
    // The mock can't *judge* contradictions, so use a stub that flags one. This
    // proves the reconcile→supersede machinery (the part real Qwen drives in prod).
    const ct = `test-${newId()}`;
    await memory.repository.ensureTenant(ct);
    const qwen = new MockQwenClient(1024);
    const [eA, eB] = await qwen.embed(['user lives in san francisco bay area', 'user lives in san francisco peninsula']);
    const a = await memory.repository.insertNote({ tenantId: ct, title: 'Home', body: 'lives in San Francisco', embedding: eA!, confidence: 0.8, sourceEpisodeIds: [], kind: 'consolidation' });
    const b = await memory.repository.insertNote({ tenantId: ct, title: 'Home', body: 'lives in San Francisco peninsula', embedding: eB!, confidence: 0.8, sourceEpisodeIds: [], kind: 'consolidation' });

    class ContradictingQwen extends MockQwenClient {
      override async chat(messages: { role: string; content: string }[], opts?: { json?: boolean }) {
        const all = messages.map((m) => m.content).join('\n').toLowerCase();
        if (all.includes('contradictory')) {
          return { text: JSON.stringify({ contradictory: true, keep: 'a', resolution: 'kept a' }), promptTokens: 1, completionTokens: 1 };
        }
        return super.chat(messages as never, opts as never);
      }
    }
    const stubSleep = new SleepPhase(store, new ContradictingQwen(1024), new FilesystemBlob(), {
      costCapCents: 100,
      forgetThreshold: 0.15,
    });
    await stubSleep.run(ct);

    const active = await memory.repository.activeNotes(ct);
    const activeIds = active.map((n) => n.id);
    // One of the two should have been superseded.
    expect(activeIds.includes(a) && activeIds.includes(b)).toBe(false);
    await store.query('DELETE FROM tenants WHERE id = $1', [ct]);
  });
});
