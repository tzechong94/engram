import { useEffect, useRef, useState, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { api, type GraphLink, type GraphNode, type SleepCycle, type SleepTraceEntry, type SearchResult, type Stats, type CoreBlock, type Note, type Episode, type AnswerResult, type EvalReport } from './api';

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
  const [deepRecall, setDeepRecall] = useState(false);
  const [activated, setActivated] = useState<Set<string>>(new Set());
  const [selectedCycle, setSelectedCycle] = useState<SleepCycle | null>(null);
  const [view, setView] = useState<'brain' | 'files' | 'chat'>('chat');
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [notes, setNotes] = useState<Note[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [dreaming, setDreaming] = useState(false);
  const [dreamMsg, setDreamMsg] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  // Interactive playground + two-brains + proof + demo mode
  const [ask, setAsk] = useState('');
  const [answer, setAnswer] = useState<AnswerResult | null>(null);
  const [answering, setAnswering] = useState(false);
  const [teachText, setTeachText] = useState('');
  const [teachMsg, setTeachMsg] = useState('');
  const [evals, setEvals] = useState<EvalReport | null>(null);
  const [demo, setDemo] = useState<{ active: boolean; running: boolean; idx: number; auto: boolean; step: string; log: string[]; mode: 'panel' | 'chat' }>(
    { active: false, running: false, idx: 0, auto: false, step: '', log: [], mode: 'panel' });
  // Live chat playground
  const [chatMsgs, setChatMsgs] = useState<Array<{ role: 'user' | 'assistant' | 'system'; content: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatRecalled, setChatRecalled] = useState<string[]>([]);
  const [chatModel, setChatModel] = useState<string>(() => localStorage.getItem('engram-model') || 'qwen-max');
  const chatFileRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fgRef = useRef<any>(null);
  const tenantRef = useRef(tenant);
  tenantRef.current = tenant; // latest tenant, for the persistence effect below

  useEffect(() => {
    api.tenants().then((r) => {
      setTenants(r.tenants);
      if (r.tenants.length && !tenant) {
        const saved = localStorage.getItem('engram-tenant');
        setTenant(saved && r.tenants.includes(saved) ? saved : r.tenants[0]!);
      }
    }).catch(() => undefined);
  }, []);

  // Remember the selected tenant so a refresh returns to the same session.
  useEffect(() => {
    if (tenant) { try { localStorage.setItem('engram-tenant', tenant); } catch { /* ignore */ } }
  }, [tenant]);
  // Remember the chosen chat model.
  useEffect(() => {
    try { localStorage.setItem('engram-model', chatModel); } catch { /* ignore */ }
  }, [chatModel]);

  const load = useCallback((t: string) => {
    if (!t) return;
    api.graph(t).then(setGraph).catch(() => setGraph({ nodes: [], links: [] }));
    api.overview(t).then((r) => setStats(r.stats)).catch(() => setStats(null));
    api.cycles(t).then((r) => setCycles(r.cycles)).catch(() => setCycles([]));
    api.core(t).then((r) => setCore(r.blocks)).catch(() => setCore([]));
    api.notes(t).then((r) => setNotes(r.notes)).catch(() => setNotes([]));
    api.episodes(t).then((r) => setEpisodes(r.episodes)).catch(() => setEpisodes([]));
    setResult(null); setActivated(new Set());
  }, []);

  useEffect(() => { load(tenant); }, [tenant, load]);

  const runSearch = async (opts?: { q?: string; budget?: number; deep?: boolean }) => {
    const q = (opts?.q ?? query).trim();
    if (!tenant || !q) return;
    const deep = opts?.deep ?? deepRecall;
    const r = await api.search(tenant, q, opts?.budget ?? 1500, deep);
    setResult(r);
    // "Activation": light up neurons whose name appears in any recalled memory.
    const hay = r.memories.map((m) => m.content.toLowerCase()).join(' ');
    const hot = new Set<string>();
    for (const n of graph.nodes) if (n.name && hay.includes(n.name.toLowerCase())) hot.add(n.id);
    setActivated(hot);
    if (fgRef.current) fgRef.current.zoomToFit(600, 60);
  };

  const runDream = async () => {
    if (!tenant || dreaming) return;
    setDreaming(true);
    setDreamMsg('💤 dreaming… clustering, consolidating, reconciling, synthesizing');
    try {
      const r = await api.sleep(tenant);
      const s = (r.report?.stats ?? {}) as Record<string, number>;
      setDreamMsg(
        `✅ dream complete — +${s.consolidated ?? 0} notes · +${s.connectionsSynthesized ?? 0} links · ` +
        `${s.entitiesMerged ?? 0} neurons merged · −${s.forgotten ?? 0} forgotten`,
      );
      load(tenant);
    } catch (e) {
      setDreamMsg(`⚠ ${e instanceof Error ? e.message : 'sleep failed'}`);
    } finally {
      setDreaming(false);
    }
  };

  const onUpload = async (file: File | undefined) => {
    if (!file || !tenant || uploading) return;
    setUploading(true);
    setUploadMsg(`📄 ingesting ${file.name}…`);
    try {
      const r = await api.uploadDoc(tenant, file);
      setUploadMsg(`✅ ${r.filename} — ${r.chunks} chunks embedded into memory`);
      load(tenant);
    } catch (e) {
      setUploadMsg(`⚠ ${e instanceof Error ? e.message : 'upload failed'}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // Two-brains: same question answered WITH Engram memory vs a cold model.
  const runAnswer = async (qOverride?: string) => {
    const q = (qOverride ?? ask).trim();
    if (!tenant || !q || answering) return;
    setAnswering(true);
    setAnswer(null);
    try {
      setAnswer(await api.answer(tenant, q, chatModel));
    } catch (e) {
      setAnswer({ withMemory: `⚠ ${e instanceof Error ? e.message : 'failed'}`, withoutMemory: '', recalled: [] });
    } finally {
      setAnswering(false);
    }
  };

  // Interactive: teach Engram a fact (writes one episode), then refresh.
  const doTeach = async (textOverride?: string) => {
    const c = (textOverride ?? teachText).trim();
    if (!tenant || !c) return;
    setTeachMsg('✍️ teaching…');
    try {
      await api.teach(tenant, c);
      setTeachMsg(`✅ remembered: "${c}"`);
      setTeachText('');
      load(tenant);
    } catch (e) {
      setTeachMsg(`⚠ ${e instanceof Error ? e.message : 'failed'}`);
    }
  };

  // Live chat: recall + answer + capture, on the selected tenant. The Brain/Files
  // views reflect what the chat teaches, so users can test memory end-to-end.
  const sendChat = async (textOverride?: string) => {
    const text = (textOverride ?? chatInput).trim();
    if (!tenant || !text || chatBusy) return;
    const history = chatMsgs.filter((m) => m.role !== 'system').slice(-6) as Array<{ role: 'user' | 'assistant'; content: string }>;
    setChatMsgs((m) => [...m, { role: 'user', content: text }]);
    setChatInput('');
    setChatBusy(true);
    try {
      const r = await api.chat(tenant, text, history, chatModel);
      setChatMsgs((m) => [...m, { role: 'assistant', content: r.reply }]);
      setChatRecalled(r.recalled);
      load(tenant); // refresh graph/stats so the Brain view reflects the new memory
    } catch (e) {
      setChatMsgs((m) => [...m, { role: 'assistant', content: `⚠ ${e instanceof Error ? e.message : 'chat failed'}` }]);
    } finally {
      setChatBusy(false);
    }
  };

  const onChatUpload = async (file: File | undefined) => {
    if (!file || !tenant) return;
    setChatMsgs((m) => [...m, { role: 'system', content: `📄 uploading ${file.name}…` }]);
    try {
      const r = await api.uploadDoc(tenant, file);
      setChatMsgs((m) => [...m, { role: 'system', content: `📄 ingested ${r.filename} — ${r.chunks} chunks embedded. Ask me anything from it.` }]);
      load(tenant);
    } catch (e) {
      setChatMsgs((m) => [...m, { role: 'system', content: `⚠ ${e instanceof Error ? e.message : 'upload failed'}` }]);
    } finally {
      if (chatFileRef.current) chatFileRef.current.value = '';
    }
  };

  // Clear the on-screen transcript only — Engram memory is untouched, so the next
  // question still recalls everything. This is the point: transcript ≠ memory.
  const clearChat = () => { setChatMsgs([]); setChatRecalled([]); };

  // Start a fresh session on a new (or existing) memory tenant, via an inline
  // top-bar input (no jarring window.prompt).
  const createSession = () => {
    const n = newName.trim();
    if (!n) { setNewOpen(false); return; }
    setTenants((ts) => (ts.includes(n) ? ts : [...ts, n]));
    setTenant(n);
    setChatMsgs([]); setChatRecalled([]); setView('chat');
    setNewName(''); setNewOpen(false);
  };

  // Keep the chat scrolled to the latest message.
  useEffect(() => {
    const el = document.getElementById('chatlog');
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMsgs, chatBusy]);

  // Persist the chat transcript per tenant so it survives a page refresh and so
  // switching tenants shows that tenant's history. Restore on tenant change.
  useEffect(() => {
    if (!tenant) { setChatMsgs([]); return; }
    try {
      const saved = localStorage.getItem(`engram-chat-${tenant}`);
      setChatMsgs(saved ? (JSON.parse(saved) as typeof chatMsgs) : []);
    } catch {
      setChatMsgs([]);
    }
    setChatRecalled([]);
  }, [tenant]);
  // Save whenever messages change (under the tenant they belong to).
  useEffect(() => {
    const t = tenantRef.current;
    if (!t) return;
    try {
      localStorage.setItem(`engram-chat-${t}`, JSON.stringify(chatMsgs));
    } catch {
      /* localStorage full/unavailable — non-fatal */
    }
  }, [chatMsgs]);

  // Demo Mode — a scripted "documentary" exercising every memory feature on a
  // coherent persona (Alex planning a Tokyo trip). Step-through by default so a
  // presenter controls the pace; an optional autoplay drives it hands-free.
  const DEMO_T = 'demo';
  const fetchDemoPdf = async (): Promise<File> => {
    const blob = await (await fetch('/tokyo-itinerary.pdf')).blob();
    return new File([blob], 'tokyo-itinerary.pdf', { type: 'application/pdf' });
  };
  // Bring the panel an act is driving into view, so nothing important needs manual
  // scrolling during the demo. Small delay lets the new content render first.
  const scrollToCard = (id: string) => {
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
  };

  // Scripted-demo helper: post a user message in the chat and get the memory-grounded reply.
  const demoPushUser = async (text: string) => {
    setChatMsgs((m) => [...m, { role: 'user', content: text }]);
    try {
      const r = await api.chat(DEMO_T, text, [], chatModel);
      setChatMsgs((m) => [...m, { role: 'assistant', content: r.reply }]);
      setChatRecalled(r.recalled);
    } catch (e) {
      setChatMsgs((m) => [...m, { role: 'assistant', content: `⚠ ${e instanceof Error ? e.message : 'chat failed'}` }]);
    }
  };
  const demoSystem = (content: string) => setChatMsgs((m) => [...m, { role: 'system', content }]);

  type DemoAct = { title: string; run: (say: (s: string) => void) => Promise<void> };

  const demoActsPanel: DemoAct[] = [
    { title: 'Fresh start', run: async (say) => {
      say('Wiping the demo tenant for a clean, repeatable run…');
      await api.seedDemo(DEMO_T, 'reset'); load(DEMO_T);
      say('Blank slate. Meet Alex, planning a work trip to Tokyo.');
    } },
    { title: 'Capture + two brains', run: async (say) => {
      say('Alex tells his assistant a few durable things about himself…');
      await api.teach(DEMO_T, 'I am allergic to peanuts');
      await api.teach(DEMO_T, 'I am vegetarian');
      await api.teach(DEMO_T, 'I always book a window seat when I fly');
      await api.teach(DEMO_T, "My wife Sarah's birthday is March 12");
      load(DEMO_T);
      const q = 'What should you keep in mind before booking me a dinner reservation?';
      setAsk(q); scrollToCard('card-answer'); say('Now ask BOTH brains the same question — one has Engram memory, one has none.');
      await runAnswer(q); scrollToCard('card-answer');
      say('With memory: peanut allergy + vegetarian. Without: a polite shrug. That is the whole pitch.');
    } },
    { title: 'Document RAG', run: async (say) => {
      scrollToCard('card-docs'); say('Alex uploads his Tokyo trip itinerary — a real PDF…');
      await onUpload(await fetchDemoPdf());
      const q = 'What is my hotel confirmation number and how many bags can I check?';
      setAsk(q); scrollToCard('card-answer'); say('Chunked, embedded, stored as durable document memory. Ask it something only the file knows.');
      await runAnswer(q); scrollToCard('card-answer');
      say('Answered straight from the PDF: confirmation PHT-8842, 2 checked bags of 23 kg.');
    } },
    { title: 'No confabulation', run: async (say) => {
      const q = 'What is the wifi password at my Tokyo hotel?';
      setAsk(q); scrollToCard('card-answer'); say('Now ask something the itinerary does NOT contain…');
      await runAnswer(q); scrollToCard('card-answer');
      say('It says it does not know — instead of inventing a password. No confabulation.');
    } },
    { title: 'A plan that changes', run: async (say) => {
      say('Alex makes a plan: "Book the client dinner for July 16 at 7pm."');
      await api.teach(DEMO_T, 'Book the client dinner for July 16 at 7pm'); load(DEMO_T);
      say('…then it changes: "The client pushed our dinner to July 17 at 8pm."');
      await api.teach(DEMO_T, 'Update: the client moved our dinner to July 17 at 8pm'); load(DEMO_T);
      say('Two conflicting facts are now in memory. The sleep cycle will reconcile them.');
    } },
    { title: 'Dream (sleep cycle)', run: async (say) => {
      say('Over the past weeks it also overheard a lot of idle chatter — seeding it now, aged 90 days.');
      await api.seedDemo(DEMO_T, 'trivia'); load(DEMO_T);
      say('💤 Engram sleeps — clustering episodes into notes, growing the graph, forgetting the trivia, reconciling the update…');
      await api.sleep(DEMO_T);
      const cs = await api.cycles(DEMO_T); setCycles(cs.cycles); setSelectedCycle(cs.cycles[0] ?? null);
      load(DEMO_T);
      scrollToCard('card-sleep');
      const s = (cs.cycles[0]?.stats ?? {}) as Record<string, number>;
      say(`Dream complete — +${s.consolidated ?? 0} durable notes · ${s.entitiesMerged ?? 0} neurons · −${s.forgotten ?? 0} trivia demoted · ${s.connectionsSynthesized ?? 0} new link(s). The step-by-step dream trace is open below.`);
    } },
    { title: 'Recall the update', run: async (say) => {
      const q = 'When is my client dinner?';
      setAsk(q); scrollToCard('card-answer'); say('The dinner was first set for July 16, 7pm, then moved. Ask about it now…');
      await runAnswer(q); scrollToCard('card-answer');
      say('It answers July 17, 8pm — the current truth. The original 7pm was not erased (it is archived, and deep recall still finds it). Engram gets more accurate without forgetting that it changed.');
    } },
    { title: 'Limited context window', run: async (say) => {
      const q = 'Summarize everything you know about me and my trip';
      setQuery(q); scrollToCard('card-recall'); say('Ask a broad question but starve it of context — only ~120 tokens allowed.');
      await runSearch({ q, budget: 120 }); scrollToCard('card-recall');
      say('The budgeter packs only the few most critical facts and drops the rest — recall within a limited window, with the full scoring trace shown.');
    } },
    { title: 'Forgetting is demotion', run: async (say) => {
      const q = 'coffee';
      setQuery(q); setDeepRecall(false); scrollToCard('card-recall');
      say('Recall the old "grabbing a coffee" chatter the normal way…');
      await runSearch({ q, deep: false }); scrollToCard('card-recall');
      say('Nothing surfaces — the trivia has faded from active recall. But is it actually gone?');
    } },
    { title: '…still findable (deep)', run: async (say) => {
      const q = 'coffee';
      setQuery(q); setDeepRecall(true); scrollToCard('card-recall');
      say('Flip on DEEP recall to reach the cold tier…');
      await runSearch({ q, deep: true }); scrollToCard('card-recall');
      say("There it is. Engram demotes, it does not delete — like how you stop reciting last week's small talk but can still recall it when asked.");
    } },
    { title: 'What it became', run: async (say) => {
      setDeepRecall(false); load(DEMO_T); scrollToCard('card-profile');
      say('Here is the learned Profile (read first on every turn) and the Proof panel — 11 eval gates, 3× on real Qwen. A memory that gets more accurate over time.');
    } },
  ];

  // Chat-native version of the demo: plays the same Tokyo story as a real
  // conversation in the 💬 Chat view, hopping to the 🧠 Brain view for the visual
  // payoffs (the dream graph + trace, and forgetting/deep-recall).
  const demoActsChat: DemoAct[] = [
    { title: 'Fresh start', run: async (say) => {
      setView('chat'); await api.seedDemo(DEMO_T, 'reset');
      setChatRecalled([]); load(DEMO_T);
      setChatMsgs([{ role: 'system', content: '👋 Meet Alex, planning a work trip to Tokyo. Every message Alex sends becomes memory — watch the assistant learn.' }]);
      say('A clean slate on tenant "demo". The whole story plays out as a real conversation.');
    } },
    { title: 'Alex introduces himself', run: async (say) => {
      say('Alex shares a few durable facts — these get captured as memories.');
      await demoPushUser("Hey! A few things about me: I'm allergic to peanuts, I'm vegetarian, and I always book a window seat when I fly.");
    } },
    { title: 'Memory personalizes', run: async (say) => {
      say('Ask it to use what it now knows. (A model with NO memory would draw a total blank here.)');
      await demoPushUser('Keep that in mind when you help me plan meals on my trip, ok?');
    } },
    { title: 'Upload a document (RAG)', run: async (say) => {
      demoSystem('📎 Alex uploads his Tokyo itinerary (a real PDF).');
      const file = await fetchDemoPdf();
      const up = await api.uploadDoc(DEMO_T, file); load(DEMO_T);
      demoSystem(`📄 ingested ${up.filename} — ${up.chunks} chunks embedded into memory.`);
      say('Now ask it something only the document knows.');
      await demoPushUser('From my itinerary — what is my hotel confirmation number and how many bags can I check?');
    } },
    { title: 'No confabulation', run: async (say) => {
      say('Ask something the itinerary does NOT contain.');
      await demoPushUser("What's the wifi password at my Tokyo hotel?");
    } },
    { title: 'A plan that changes', run: async (say) => {
      await demoPushUser('Book my client dinner for July 16 at 7pm.');
      say('…then it changes.');
      await demoPushUser('Actually, the client moved our dinner to July 17 at 8pm.');
    } },
    { title: '💤 Dream — watch the Brain', run: async (say) => {
      demoSystem('💤 Engram sleeps — consolidating the conversation into durable memory, growing the graph, forgetting the noise, reconciling the dinner change.');
      await api.seedDemo(DEMO_T, 'trivia'); // aged small-talk for the forget sweep to demote
      setView('brain');
      await api.sleep(DEMO_T);
      const cs = await api.cycles(DEMO_T); setCycles(cs.cycles); setSelectedCycle(cs.cycles[0] ?? null);
      load(DEMO_T); scrollToCard('card-sleep');
      const s = (cs.cycles[0]?.stats ?? {}) as Record<string, number>;
      say(`Now in the Brain view: +${s.consolidated ?? 0} notes · ${s.entitiesMerged ?? 0} neurons · −${s.forgotten ?? 0} trivia demoted. The step-by-step dream trace is open below.`);
    } },
    { title: 'Back to chat — recall the update', run: async (say) => {
      setView('chat'); say('Back in the conversation. Ask about the dinner now — note it answers the NEW time.');
      await demoPushUser("Remind me — when's my client dinner again?");
    } },
    { title: 'Forgetting is demotion (Brain)', run: async (say) => {
      setView('brain'); setQuery('coffee'); setDeepRecall(false); scrollToCard('card-recall');
      await runSearch({ q: 'coffee', deep: false });
      say('Normal recall of Alex\'s old "coffee" small talk → nothing. It faded from active memory. Now flip on DEEP recall…');
      setDeepRecall(true);
      await runSearch({ q: 'coffee', deep: true }); scrollToCard('card-recall');
      say('…still there. Engram demotes, it never deletes.');
    } },
    { title: 'What it learned', run: async (say) => {
      setDeepRecall(false); load(DEMO_T); scrollToCard('card-profile');
      say('The learned Profile (read first every turn) + the Proof panel — 11 eval gates, 3× on real Qwen. Now switch to 💬 Chat and keep talking to it yourself.');
    } },
  ];

  const demoActs = demo.mode === 'chat' ? demoActsChat : demoActsPanel;

  const startDemo = (mode: 'panel' | 'chat') => {
    setTenant(DEMO_T);
    if (mode === 'chat') { setView('chat'); setChatMsgs([]); }
    else setView('brain'); // the panel demo drives the sidebar/graph, which live in Brain view
    setDemo({ active: true, running: false, idx: 0, auto: false, mode, step: 'Ready — click "Next ▶" to begin, or "Autoplay" for hands-free.', log: [] });
  };

  const runDemoStep = async (i: number) => {
    if (i >= demoActs.length) return;
    setDemo((d) => ({ ...d, running: true }));
    const say = (s: string) => setDemo((d) => ({ ...d, step: s, log: [...d.log, s].slice(-8) }));
    try {
      await demoActs[i]!.run(say);
    } catch (e) {
      say(`⚠ ${e instanceof Error ? e.message : 'step failed'}`);
    }
    setDemo((d) => ({ ...d, running: false, idx: i + 1 }));
  };

  // Autoplay driver: when enabled and idle, advance to the next act after a beat.
  // Runs each step from a fresh render, so no stale-closure surprises.
  useEffect(() => {
    if (!demo.active || !demo.auto || demo.running || demo.idx >= demoActs.length) return;
    const t = setTimeout(() => { void runDemoStep(demo.idx); }, demo.idx === 0 ? 900 : 7000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo.active, demo.auto, demo.running, demo.idx]);

  // Load the eval gate proof (tenant-independent, but the route needs a segment).
  useEffect(() => {
    api.evals(tenant || 'proof').then(setEvals).catch(() => setEvals(null));
  }, [tenant]);

  // Uploaded documents, grouped from doc-kind notes by source filename.
  const documents = (() => {
    const m = new Map<string, number>();
    for (const n of notes) {
      if (n.kind !== 'document') continue;
      const name = n.title.split(' · part ')[0]!;
      m.set(name, (m.get(name) ?? 0) + 1);
    }
    return [...m.entries()].map(([name, chunks]) => ({ name, chunks }));
  })();

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
        <div className="brand">engram <span className="dot">●</span> <span className="tag">drop-in memory for any agent</span></div>
        <select value={tenant} onChange={(e) => setTenant(e.target.value)}>
          {tenants.length === 0 && <option value="">no tenants</option>}
          {tenants.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {newOpen ? (
          <span className="newsession">
            <input autoFocus placeholder="session name…" value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createSession(); if (e.key === 'Escape') { setNewOpen(false); setNewName(''); } }} />
            <button className="primary" onClick={createSession}>create</button>
            <button onClick={() => { setNewOpen(false); setNewName(''); }}>✕</button>
          </span>
        ) : (
          <button title="start a fresh session on a new memory tenant" onClick={() => setNewOpen(true)}>＋ new</button>
        )}
        <button onClick={() => load(tenant)}>↻ refresh</button>
        <div className="toggle">
          <button className={view === 'chat' ? 'on' : ''} onClick={() => setView('chat')}>💬 Chat</button>
          <button className={view === 'brain' ? 'on' : ''} onClick={() => setView('brain')}>🧠 Brain</button>
          <button className={view === 'files' ? 'on' : ''} onClick={() => setView('files')}>🗂 Files</button>
        </div>
        <button className="demo-btn" title="Guided visual demo — drives the graph, two-brains, and budgeter panels" onClick={() => startDemo('panel')}>
          {demo.active ? '▶ demo open' : '▶ Demo (visual)'}
        </button>
        <div className="spacer" />
        <span className="muted">{stats ? `${stats.entities} neurons · ${stats.edges} synapses · ${stats.notes} notes` : '—'}</span>
      </div>
      {demo.active && (
        <div className="demobar">
          <div className="demoprogress">
            <span className="demono">{Math.min(demo.idx + 1, demoActs.length)}/{demoActs.length}</span>
            <span className="demotitle">{demo.idx < demoActs.length ? demoActs[demo.idx]!.title : '✅ complete'}</span>
          </div>
          <div className="demostep">{demo.step}</div>
          <div className="democtrls">
            <button className="primary" disabled={demo.running || demo.idx >= demoActs.length} onClick={() => void runDemoStep(demo.idx)}>
              {demo.running ? '…running' : demo.idx >= demoActs.length ? 'done' : `Next ▶ ${demoActs[demo.idx]!.title}`}
            </button>
            {demo.auto
              ? <button onClick={() => setDemo((d) => ({ ...d, auto: false }))}>⏸ Pause</button>
              : <button disabled={demo.idx >= demoActs.length} onClick={() => setDemo((d) => ({ ...d, auto: true }))}>▶ Autoplay</button>}
            <button disabled={demo.running} onClick={() => setDemo((d) => ({ ...d, idx: 0, auto: false, log: [], step: 'Restarted — click Next ▶.' }))}>↺ Restart</button>
            <button onClick={() => setDemo((d) => ({ ...d, active: false, running: false, idx: 0, auto: false, step: '', log: [] }))}>✕ Exit</button>
          </div>
        </div>
      )}

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

          {view !== 'chat' && (<>
          <div className="card" id="card-answer">
            <h3>Ask both brains <span className="muted">(memory vs none)</span></h3>
            <div className="search-row">
              <input placeholder="ask a question about you…" value={ask}
                onChange={(e) => setAsk(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runAnswer()} />
              <button className="primary" disabled={answering || !tenant} onClick={() => runAnswer()}>
                {answering ? '…' : 'ask'}
              </button>
            </div>
            {answering && <div className="trace">thinking, with + without memory…</div>}
            {answer && (
              <div className="twobrains">
                <div className="brain with">
                  <div className="blabel">🧠 with Engram</div>
                  <div className="btext">{answer.withMemory || '—'}</div>
                </div>
                <div className="brain without">
                  <div className="blabel">🌫 no memory</div>
                  <div className="btext">{answer.withoutMemory || '—'}</div>
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <h3>Teach Engram</h3>
            <div className="search-row">
              <input placeholder='tell it a fact, e.g. "my flight is at 6pm"' value={teachText}
                onChange={(e) => setTeachText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doTeach()} />
              <button className="primary" disabled={!tenant} onClick={() => doTeach()}>teach</button>
            </div>
            {teachMsg && <div className="trace">{teachMsg}</div>}
            <div className="trace muted">then 💤 Dream to consolidate, and "Ask both brains" to recall it.</div>
          </div>
          </>)}

          {evals && evals.gates && (
            <div className="card">
              <h3>Proof · {evals.gates.filter((g) => g.pass).length}/{evals.gates.length} eval gates {evals.runs ? `(${evals.runs}× ${evals.mode})` : ''}</h3>
              <div className="gates">
                {evals.gates.map((g) => (
                  <div key={g.name} className={`gate ${g.pass ? 'pass' : 'fail'}`} title={g.value}>
                    <span>{g.pass ? '✅' : '❌'}</span> <span className="gname">{g.name}</span>
                    <span className="gval">{g.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {profile && (
            <div className="card" id="card-profile">
              <h3>Core memory · learned profile</h3>
              <div className="profile">{profile.body}</div>
            </div>
          )}

          <div className="card" id="card-recall">
            <h3>Recall (PPR activation)</h3>
            <div className="search-row">
              <input placeholder="ask the memory…" value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
              <button className="primary" onClick={() => runSearch()}>recall</button>
            </div>
            <label className="deeptoggle" title="Also search the cold tier (forgotten / archived). Decay demotes memories, it doesn't delete them.">
              <input type="checkbox" checked={deepRecall} onChange={(e) => { setDeepRecall(e.target.checked); }} />
              deep recall <span className="muted">— reach forgotten / archived memories</span>
            </label>
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
                  <div key={c.id} className="cand" title={c.content}>
                    <div className="candhead">
                      <span className={c.included ? 'inc' : 'drop'}>{c.included ? '✓ kept' : '· dropped'}</span>
                      <span className="muted">{c.kind} · {c.tokens}t · score {c.score.toFixed(2)}</span>
                    </div>
                    <div className="dims">
                      {([['rel', c.relevance], ['rec', c.recency], ['imp', c.importance], ['div', c.diversity]] as const).map(([k, v]) => (
                        <span key={k} className="dim" title={`${k} ${(v ?? 0).toFixed(2)}`}>
                          {k}<i style={{ width: `${Math.round((v ?? 0) * 100)}%` }} />
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="card" id="card-docs">
            <h3>Documents (RAG)</h3>
            <input ref={fileRef} type="file" accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
              disabled={uploading || !tenant}
              onChange={(e) => onUpload(e.target.files?.[0])}
              style={{ width: '100%', marginBottom: 8 }} />
            {uploadMsg && <div className="trace" style={{ marginBottom: 8 }}>{uploadMsg}</div>}
            {documents.length === 0
              ? <div className="empty">no documents yet — upload a .txt, .md, or .pdf the agent can answer from</div>
              : documents.map((d) => (
                  <div key={d.name} className="mem"><span className="pill">{d.chunks} chunks</span> {d.name}</div>
                ))}
          </div>

          <div className="card" id="card-sleep">
            <h3>Sleep cycles (REM)</h3>
            <button className="primary" disabled={dreaming || !tenant} onClick={runDream}
              style={{ width: '100%', marginBottom: 8 }}>
              {dreaming ? '💤 dreaming…' : '💤 Dream now (run sleep cycle)'}
            </button>
            {dreamMsg && <div className="trace" style={{ marginBottom: 8 }}>{dreamMsg}</div>}
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

        {view === 'chat' ? (
          <div className="chatpane">
            <div className="chathead">
              <span className="muted">💬 <b>{tenant || '—'}</b> · the transcript is just a view — memory lives in Engram</span>
              <span className="chatctrls">
                <label className="modelpick" title="Which Qwen model writes the reply. Internal memory work (consolidation, extraction) still routes qwen-max / qwen-turbo by task.">
                  model
                  <select value={chatModel} onChange={(e) => setChatModel(e.target.value)}>
                    <option value="qwen-max">qwen-max</option>
                    <option value="qwen-plus">qwen-plus</option>
                    <option value="qwen-turbo">qwen-turbo</option>
                  </select>
                </label>
                <button className="clearchat" disabled={chatMsgs.length === 0}
                  title="Clears the on-screen transcript only. Engram memory is untouched — ask again and it still recalls."
                  onClick={clearChat}>🗑 Clear chat</button>
              </span>
            </div>
            <div className="chatlog" id="chatlog">
              {chatMsgs.length === 0 && (
                <div className="empty" style={{ paddingTop: 40, maxWidth: 520, margin: '0 auto' }}>
                  👋 Chat with the memory system live on tenant <b>{tenant || '—'}</b>.<br /><br />
                  Tell it facts about yourself, 📎 upload a PDF/txt, then ask it things — it remembers across turns
                  via Engram, not a giant prompt. Switch to 🧠 <b>Brain</b> and hit 💤 <b>Dream</b> to watch what you
                  taught consolidate into the graph. Use <b>＋ new</b> up top for a clean session.
                  <div style={{ textAlign: 'center', marginTop: 20 }}>
                    <button className="demo-btn" onClick={() => startDemo('chat')}>▶ Play the demo as a conversation</button>
                  </div>
                </div>
              )}
              {chatMsgs.map((m, i) => <div key={i} className={`bubble ${m.role}`}>{m.content}</div>)}
              {chatBusy && <div className="bubble assistant busy">…thinking, with memory</div>}
            </div>
            {chatRecalled.length > 0 && (
              <div className="recalledstrip">
                <span className="muted">🧠 recalled from memory:</span>
                {chatRecalled.slice(0, 5).map((c, i) => (
                  <span key={i} className="pill" title={c}>{c.length > 46 ? c.slice(0, 46) + '…' : c}</span>
                ))}
              </div>
            )}
            <div className="chatinput">
              <button className="attach" title="play the guided demo as a conversation" disabled={demo.active} onClick={() => startDemo('chat')}>▶</button>
              <button className="attach" title="upload a file (PDF, txt, md)" disabled={!tenant} onClick={() => chatFileRef.current?.click()}>📎</button>
              <input ref={chatFileRef} type="file" accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
                style={{ display: 'none' }} onChange={(e) => onChatUpload(e.target.files?.[0])} />
              <input placeholder={tenant ? `message ${tenant}…` : 'pick or create a session first (＋ new)'} value={chatInput}
                disabled={!tenant || chatBusy}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendChat()} />
              <button className="primary" disabled={!tenant || chatBusy} onClick={() => sendChat()}>{chatBusy ? '…' : 'send'}</button>
            </div>
          </div>
        ) : view === 'files' ? (
          <FilesView core={core} notes={notes} episodes={episodes} entities={graph.nodes} cycles={cycles} />
        ) : (
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
              minZoom={0.4}
              maxZoom={6}
            />
          )}
          {graph.nodes.length > 0 && (
            <button className="recenter" title="Recenter / fit the graph to view"
              onClick={() => fgRef.current?.zoomToFit(400, 80)}>⤢ fit</button>
          )}
          <div className="legend">
            <span><i style={{ background: '#5eead4' }} /> entity</span>
            <span><i style={{ background: '#a78bfa' }} /> person</span>
            <span><i style={{ background: '#f0abfc' }} /> activated</span>
            <span><i style={{ background: '#3a4154' }} /> invalidated</span>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

/**
 * Files view — the brain's contents browsed as a folder tree. Same memory as the
 * graph, a different lens: core profile, semantic notes, entities, raw episodes,
 * and sleep-cycle reports become files you can open and read.
 */
interface VFile { path: string; content: string; meta?: string }

/** Reassemble uploaded documents (stored as doc-kind note chunks) into one file each. */
function groupDocs(notes: Note[]): VFile[] {
  const docs = new Map<string, { body: string }[]>();
  for (const n of notes) {
    if (n.kind !== 'document') continue;
    const name = n.title.split(' · part ')[0]!;
    if (!docs.has(name)) docs.set(name, []);
    docs.get(name)!.push({ body: n.body });
  }
  return [...docs.entries()].map(([name, parts]) => ({
    path: name,
    content: parts.map((p) => p.body).join('\n\n'),
    meta: `${parts.length} chunks`,
  }));
}

function FilesView({ core, notes, episodes, entities, cycles }: {
  core: CoreBlock[]; notes: Note[]; episodes: Episode[]; entities: GraphNode[]; cycles: SleepCycle[];
}) {
  const slug = (s: string) => (s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const folders: Array<{ name: string; files: VFile[] }> = [
    { name: 'core', files: core.map((b) => ({ path: `${b.label}.md`, content: b.body, meta: b.pinned ? 'pinned' : b.readOnly ? 'read-only' : '' })) },
    { name: 'documents', files: groupDocs(notes) },
    { name: 'notes', files: notes.filter((n) => n.kind !== 'document').map((n) => ({ path: `${slug(n.title)}.md`, content: `# ${n.title}\n\n${n.body}`, meta: `${n.kind ?? 'note'} · importance ${n.importance}` })) },
    { name: 'entities', files: entities.map((e) => ({ path: `${slug(e.name)}`, content: `${e.name}\ntype: ${e.type}\nsalience: ${(e.val - 1).toFixed(2)}`, meta: e.type })) },
    { name: 'episodes', files: episodes.map((ep) => ({ path: `${ep.createdAt.slice(0, 10)}-${ep.id.slice(0, 6)}.txt`, content: ep.content, meta: `${ep.sourceChannel} · ${ep.status}` })) },
    { name: 'sleep-cycles', files: cycles.map((c) => ({ path: `${c.startedAt.slice(0, 16).replace('T', ' ')}.json`, content: JSON.stringify(c.stats, null, 2), meta: c.status })) },
  ];
  const [sel, setSel] = useState<VFile | null>(null);

  return (
    <div className="files">
      <div className="filetree">
        {folders.map((f) => (
          <div key={f.name} className="folder">
            <div className="foldername">{f.name}/ <span className="muted">{f.files.length}</span></div>
            {f.files.length === 0 && <div className="filerow muted">(empty)</div>}
            {f.files.map((file) => (
              <div key={f.name + file.path} className={`filerow ${sel?.path === file.path && sel?.content === file.content ? 'on' : ''}`} onClick={() => setSel(file)} title={file.meta}>
                {file.path}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="filecontent">
        {sel ? (
          <>
            <div className="filehead">{sel.path}{sel.meta ? <span className="pill">{sel.meta}</span> : null}</div>
            <pre>{sel.content}</pre>
          </>
        ) : (
          <div className="empty" style={{ paddingTop: 60 }}>Pick a file to read what the brain knows.</div>
        )}
      </div>
    </div>
  );
}

// Human label + glyph for each dream step, in execution order.
const STEP_META: Record<string, { glyph: string; label: string }> = {
  enter: { glyph: '🌙', label: 'Enter REM' },
  forget: { glyph: '①', label: 'Forget — decay stale memories' },
  cluster: { glyph: '②', label: 'Cluster — group related episodes' },
  consolidate: { glyph: '③', label: 'Consolidate — write durable notes' },
  graph: { glyph: '④', label: 'Graph-merge — entities & relationships' },
  reconcile: { glyph: '⑤', label: 'Reconcile — resolve contradictions' },
  synthesize: { glyph: '⑥', label: 'Synthesize — find new connections' },
  profile: { glyph: '⑦', label: 'Profile — rewrite learned profile' },
  wake: { glyph: '🌅', label: 'Wake' },
};
const STEP_ORDER = Object.keys(STEP_META);

function CycleDetail({ cycle }: { cycle: SleepCycle }) {
  const s = cycle.stats as any;
  const trace = cycle.checkpoint?.trace ?? [];
  // Group the narration lines by step, preserving execution order.
  const groups = STEP_ORDER
    .map((step) => ({ step, ...STEP_META[step]!, lines: trace.filter((t) => t.step === step) }))
    .filter((g) => g.lines.length > 0);

  return (
    <div className="cycledetail">
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

      {groups.length > 0 ? (
        <div className="steps">
          <div className="muted" style={{ margin: '10px 0 6px' }}>
            What the brain did, step by step
            {s.tokensUsed ? <span className="pill" style={{ marginLeft: 6 }}>{s.tokensUsed} tokens · {(s.costCents ?? 0).toFixed(3)}¢</span> : null}
          </div>
          {groups.map((g) => <StepGroup key={g.step} glyph={g.glyph} label={g.label} lines={g.lines} />)}
        </div>
      ) : (
        <div className="empty" style={{ padding: '10px 0', fontSize: 12 }}>
          No step trace for this cycle (it predates trace capture — run a new sleep cycle to see the breakdown).
        </div>
      )}
    </div>
  );
}

function StepGroup({ glyph, label, lines }: { glyph: string; label: string; lines: SleepTraceEntry[] }) {
  const [open, setOpen] = useState(true);
  // The first line is the step headline; the rest are per-item details (• …).
  const [head, ...details] = lines;
  return (
    <div className="step">
      <div className="stephead" onClick={() => setOpen((o) => !o)}>
        <span className="stepglyph">{glyph}</span>
        <span className="steplabel">{label}</span>
        {details.length > 0 && <span className="pill">{details.length}</span>}
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="stepbody">
          {head && <div className="stepline">{head.msg}</div>}
          {details.map((d, i) => <div key={i} className="stepline detail">{d.msg}</div>)}
        </div>
      )}
    </div>
  );
}
