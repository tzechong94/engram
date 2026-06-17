import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { api, type GraphLink, type GraphNode, type SleepCycle, type SearchResult, type Stats, type CoreBlock } from './api';

/**
 * Engram brain viewer. The knowledge graph is rendered as a neural net: entities
 * are neurons (size = salience), edges are synapses (invalidated ones grey out).
 * A recall query lights up the activated neurons and shows the budgeter's packing
 * trace; sleep cycles show the before→after consolidation.
 */
export function App() {
  const [tenants, setTenants] = useState<string[]>([]);
  const [tenant, setTenant] = useState<string>('');
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; links: GraphLink[] }>({ nodes: [], links: [] });
  const [stats, setStats] = useState<Stats | null>(null);
  const [cycles, setCycles] = useState<SleepCycle[]>([]);
  const [core, setCore] = useState<CoreBlock[]>([]);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [activated, setActivated] = useState<Set<string>>(new Set());
  const [selectedCycle, setSelectedCycle] = useState<SleepCycle | null>(null);
  const fgRef = useRef<any>(null);

  useEffect(() => {
    api.tenants().then((r) => {
      setTenants(r.tenants);
      if (r.tenants.length && !tenant) setTenant(r.tenants[0]!);
    }).catch(() => undefined);
  }, []);

  const load = useCallback((t: string) => {
    if (!t) return;
    api.graph(t).then(setGraph).catch(() => setGraph({ nodes: [], links: [] }));
    api.overview(t).then((r) => setStats(r.stats)).catch(() => setStats(null));
    api.cycles(t).then((r) => setCycles(r.cycles)).catch(() => setCycles([]));
    api.core(t).then((r) => setCore(r.blocks)).catch(() => setCore([]));
    setResult(null); setActivated(new Set());
  }, []);

  useEffect(() => { load(tenant); }, [tenant, load]);

  const runSearch = async () => {
    if (!tenant || !query.trim()) return;
    const r = await api.search(tenant, query.trim());
    setResult(r);
    // "Activation": light up neurons whose name appears in any recalled memory.
    const hay = r.memories.map((m) => m.content.toLowerCase()).join(' ');
    const hot = new Set<string>();
    for (const n of graph.nodes) if (n.name && hay.includes(n.name.toLowerCase())) hot.add(n.id);
    setActivated(hot);
    if (fgRef.current) fgRef.current.zoomToFit(600, 60);
  };

  const profile = core.find((b) => b.label === 'profile');

  // Brain rendering: glowing neurons sized by salience, hot ones flare.
  const drawNode = useCallback((node: any, ctx: CanvasRenderingContext2D, scale: number) => {
    const r = Math.max(2.5, Math.min(9, (node.val || 1) * 2.5));
    const hot = activated.has(node.id);
    const color = hot ? '#f0abfc' : node.type === 'person' ? '#a78bfa' : '#5eead4';
    ctx.shadowBlur = hot ? 22 : 10;
    ctx.shadowColor = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowBlur = 0;
    if (scale > 1.6 || hot) {
      ctx.font = `${hot ? 11 : 9}px ui-sans-serif`;
      ctx.fillStyle = hot ? '#fdf4ff' : '#9fb0c8';
      ctx.fillText(node.name || '', node.x + r + 2, node.y + 3);
    }
  }, [activated]);

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">engram <span className="dot">●</span> memory brain</div>
        <select value={tenant} onChange={(e) => setTenant(e.target.value)}>
          {tenants.length === 0 && <option value="">no tenants</option>}
          {tenants.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button onClick={() => load(tenant)}>↻ refresh</button>
        <div className="spacer" />
        <span className="muted">{stats ? `${stats.entities} neurons · ${stats.edges} synapses · ${stats.notes} notes` : '—'}</span>
      </div>

      <div className="main">
        <div className="side">
          <div className="card">
            <h3>Memory at a glance</h3>
            {stats ? (
              <div className="stats">
                <div className="stat hot"><div className="n">{stats.entities}</div><div className="l">neurons (entities)</div></div>
                <div className="stat"><div className="n">{stats.edges}</div><div className="l">synapses (edges)</div></div>
                <div className="stat"><div className="n">{stats.notes}</div><div className="l">semantic notes</div></div>
                <div className="stat"><div className="n">{stats.activeEpisodes}</div><div className="l">active episodes</div></div>
                <div className="stat forget"><div className="n">{stats.forgotten}</div><div className="l">forgotten</div></div>
              </div>
            ) : <div className="empty">select a tenant</div>}
          </div>

          {profile && (
            <div className="card">
              <h3>Core memory · learned profile</h3>
              <div className="profile">{profile.body}</div>
            </div>
          )}

          <div className="card">
            <h3>Recall (PPR activation)</h3>
            <div className="search-row">
              <input placeholder="ask the memory…" value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
              <button className="primary" onClick={runSearch}>recall</button>
            </div>
            {result && (
              <>
                {result.memories.length === 0 && <div className="empty">nothing recalled yet</div>}
                {result.memories.slice(0, 8).map((m) => (
                  <div key={m.id} className={`mem ${m.kind}`}>
                    {m.kind === 'core' && <span className="pill">core</span>} {m.content}
                  </div>
                ))}
                <div className="trace">
                  packed {result.trace.tokensUsed}/{result.trace.tokenBudget} tokens ·
                  {' '}{result.trace.candidates.filter((c) => c.included).length}/{result.trace.candidates.length} candidates ·
                  weights rel {result.trace.weights.relevance} / rec {result.trace.weights.recency} / imp {result.trace.weights.importance} / div {result.trace.weights.diversity}
                </div>
                {result.trace.candidates.slice(0, 6).map((c) => (
                  <div key={c.id} className="trace" title={c.content}>
                    <span style={{ color: c.included ? 'var(--neuron)' : 'var(--muted)' }}>{c.included ? '✓' : '·'}</span>{' '}
                    {c.kind} score {c.score.toFixed(2)}
                    <div className="bar"><span style={{ width: `${Math.round(c.score * 100)}%` }} /></div>
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="card">
            <h3>Sleep cycles (REM)</h3>
            {cycles.length === 0 && <div className="empty">no cycles yet — run a sleep cycle</div>}
            {cycles.map((c) => {
              const s = c.stats as any;
              return (
                <div key={c.id} className="cycle" onClick={() => setSelectedCycle(c)}>
                  <span>{new Date(c.startedAt).toLocaleString()}</span>
                  <span className="delta">+{s.consolidated ?? 0}◆ +{s.connectionsSynthesized ?? 0}✶ −{s.forgotten ?? 0}</span>
                </div>
              );
            })}
            {selectedCycle && <CycleDetail cycle={selectedCycle} />}
          </div>
        </div>

        <div className="graphwrap">
          {graph.nodes.length === 0 ? (
            <div className="empty" style={{ paddingTop: 80 }}>
              No graph yet for this tenant.<br />Chat with the agent, then run a sleep cycle to grow the brain.
            </div>
          ) : (
            <ForceGraph2D
              ref={fgRef}
              graphData={graph as any}
              backgroundColor="rgba(0,0,0,0)"
              nodeRelSize={4}
              nodeCanvasObject={drawNode}
              nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
                ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x, node.y, 8, 0, 2 * Math.PI); ctx.fill();
              }}
              linkColor={(l: any) => (l.invalidated ? 'rgba(58,65,84,0.5)' : 'rgba(45,212,191,0.35)')}
              linkWidth={(l: any) => (l.invalidated ? 0.5 : Math.min(3, 0.5 + l.weight))}
              linkLineDash={(l: any) => (l.invalidated ? [3, 3] : null)}
              linkDirectionalParticles={(l: any) => (l.invalidated ? 0 : 1)}
              linkDirectionalParticleWidth={1.6}
              onNodeClick={(n: any) => { setQuery(n.name); }}
            />
          )}
          <div className="legend">
            <span><i style={{ background: '#5eead4' }} /> entity</span>
            <span><i style={{ background: '#a78bfa' }} /> person</span>
            <span><i style={{ background: '#f0abfc' }} /> activated</span>
            <span><i style={{ background: '#3a4154' }} /> invalidated</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function CycleDetail({ cycle }: { cycle: SleepCycle }) {
  const s = cycle.stats as any;
  return (
    <div className="beforeafter">
      <div className="col">
        <div className="muted">scanned</div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>{s.episodesScanned ?? 0}</div>
        <div className="muted">episodes</div>
      </div>
      <div className="arrow">→ sleep →</div>
      <div className="col">
        <div className="muted">produced</div>
        <div style={{ fontSize: 13 }}>
          {s.consolidated ?? 0} notes · {s.entitiesMerged ?? 0} neurons<br />
          {s.connectionsSynthesized ?? 0} new links · {s.forgotten ?? 0} forgotten<br />
          {s.contradictionsResolved ?? 0} contradictions resolved
        </div>
      </div>
    </div>
  );
}
