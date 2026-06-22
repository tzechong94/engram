// Thin typed client for the read-only viewer API (same-origin).

const token = new URLSearchParams(location.search).get('token') || '';
const auth = (): HeadersInit => (token ? { Authorization: `Bearer ${token}` } : {});

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: auth() });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: auth() });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body?.error || `${path} → ${res.status}`);
  return body as T;
}

export interface GraphNode { id: string; name: string; type: string; val: number }
export interface GraphLink { source: string; target: string; relation: string; weight: number; invalidated: boolean }
export interface Stats { activeEpisodes: number; notes: number; entities: number; edges: number; forgotten: number }
export interface SleepCycle {
  id: string; startedAt: string; finishedAt: string | null; status: string;
  stats: Record<string, number | Record<string, number>>;
}
export interface Note { id: string; title: string; body: string; kind?: string; importance: number; supersededBy: string | null; createdAt: string }
export interface Episode { id: string; content: string; sourceChannel: string; importance: number; status: string; createdAt: string }
export interface PackCandidate { kind: string; id: string; content: string; tokens: number; relevance: number; recency: number; importance: number; diversity: number; score: number; included: boolean }
export interface SearchResult { memories: Array<{ kind: string; id: string; content: string }>; trace: { tokenBudget: number; tokensUsed: number; weights: Record<string, number>; candidates: PackCandidate[] } }
export interface CoreBlock { label: string; body: string; sizeLimit: number; pinned: boolean; readOnly: boolean }

export const api = {
  tenants: () => get<{ tenants: string[] }>(`/tenants`),
  overview: (t: string) => get<{ stats: Stats; latestCycle: SleepCycle | null }>(`/${encodeURIComponent(t)}/overview`),
  graph: (t: string) => get<{ nodes: GraphNode[]; links: GraphLink[] }>(`/${encodeURIComponent(t)}/graph`),
  notes: (t: string) => get<{ notes: Note[] }>(`/${encodeURIComponent(t)}/notes`),
  episodes: (t: string) => get<{ episodes: Episode[] }>(`/${encodeURIComponent(t)}/episodes`),
  cycles: (t: string) => get<{ cycles: SleepCycle[] }>(`/${encodeURIComponent(t)}/cycles`),
  core: (t: string) => get<{ blocks: CoreBlock[] }>(`/${encodeURIComponent(t)}/core`),
  search: (t: string, q: string, budget = 1500) =>
    get<SearchResult>(`/${encodeURIComponent(t)}/search?q=${encodeURIComponent(q)}&budget=${budget}`),
  sleep: (t: string) =>
    post<{ report: SleepCycle; before: Stats; after: Stats }>(`/${encodeURIComponent(t)}/sleep`),
  uploadDoc: async (t: string, file: File) => {
    const res = await fetch(`/api/${encodeURIComponent(t)}/upload`, {
      method: 'POST',
      headers: { ...auth(), 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    const body = (await res.json().catch(() => ({}))) as { filename: string; chunks: number; embedded: number; error?: string };
    if (!res.ok) throw new Error(body?.error || `upload → ${res.status}`);
    return body;
  },
};
