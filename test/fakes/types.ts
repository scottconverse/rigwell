export interface FakeToolCall { id?: string; name: string; input: Record<string, unknown> }

export interface FakeTurnSpec {
  text?: string;
  thinking?: string;
  toolCalls?: FakeToolCall[];
  /** Non-2xx status: respond with errorBody (JSON) instead of a stream. */
  status?: number;
  errorBody?: any;
  /** Extra response headers (e.g. retry-after). */
  headers?: Record<string, string>;
  /** Send a partial stream, then drop the connection before the final event. */
  breakMidStream?: boolean;
  usage?: { input?: number; output?: number; cacheRead?: number };
}

export type FakeTurn = FakeTurnSpec | ((body: any, index: number) => FakeTurnSpec);

export interface FakeServer {
  url: string;
  /** Parsed JSON request bodies, in order. */
  requests: any[];
  /** Lower-cased request headers, in order. */
  headers: Record<string, string>[];
  stop(): void;
}

export const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function splitChunks(s: string, parts = 2): string[] {
  if (s.length < 2) return [s];
  const n = Math.min(parts, s.length);
  const size = Math.ceil(s.length / n);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/**
 * Shared Bun.serve scaffolding. `render` returns SSE frames for a turn; with breakMidStream the
 * server sends only the first half of the frames, then errors the stream.
 */
export async function startFake(
  script: FakeTurn[],
  render: (turn: FakeTurnSpec, idx: number) => string[],
  defaultError: (status: number, msg: string) => any,
): Promise<FakeServer> {
  const requests: any[] = [];
  const headers: Record<string, string>[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json().catch(() => ({}));
      const idx = requests.length;
      requests.push(body);
      const h: Record<string, string> = {};
      req.headers.forEach((v, k) => (h[k] = v));
      headers.push(h);
      const entry = script[idx];
      if (!entry) {
        return new Response(JSON.stringify(defaultError(500, `fake server: script exhausted (request #${idx + 1}, script has ${script.length} turns)`)), {
          status: 500, headers: { "content-type": "application/json" },
        });
      }
      const turn = typeof entry === "function" ? entry(body, idx) : entry;
      if (turn.status && turn.status >= 400) {
        return new Response(JSON.stringify(turn.errorBody ?? defaultError(turn.status, `fake error ${turn.status}`)), {
          status: turn.status, headers: { "content-type": "application/json", ...(turn.headers ?? {}) },
        });
      }
      const frames = render(turn, idx);
      const send = turn.breakMidStream ? frames.slice(0, Math.max(2, Math.ceil(frames.length / 2))) : frames;
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(c) {
          for (const f of send) {
            c.enqueue(enc.encode(f));
            await Bun.sleep(0);
          }
          c.close(); // with breakMidStream the stream simply ends before the final event
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", ...(turn.headers ?? {}) } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, headers, stop: () => void server.stop(true) };
}
