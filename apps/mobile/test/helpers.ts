import type { BridgeEnvelope, LaunchContext } from '@rally/protocol';

export const NONCE = '0123456789abcdef0123456789abcdef';
export const BUNDLE = 'https://cdn.example.com/games/spike/0.1.0/index.html';

let seq = 0;
export function req(method: string, params?: unknown, nonce = NONCE): string {
  seq += 1;
  return JSON.stringify({ v: 1, nonce, id: `g-${seq}`, kind: 'req', method, params });
}
export function evt(method: string, params?: unknown): string {
  seq += 1;
  return JSON.stringify({ v: 1, nonce: NONCE, id: `e-${seq}`, kind: 'evt', method, params });
}

/** Collects what the host delivers into the WebView and resolves responses by id. */
export class Outbox {
  readonly sent: BridgeEnvelope[] = [];
  deliver = (json: string) => {
    this.sent.push(JSON.parse(json) as BridgeEnvelope);
  };
  /** Wait for the response to the most recent request id in `raw`. */
  async response(raw: string): Promise<BridgeEnvelope> {
    const id = (JSON.parse(raw) as { id: string }).id;
    for (let i = 0; i < 50; i++) {
      const hit = this.sent.find((e) => e.kind === 'res' && e.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error(`no response for ${id}`);
  }
}

export const device: LaunchContext['device'] = {
  safeArea: { top: 47, right: 0, bottom: 34, left: 0 },
  orientation: 'landscape',
  pixelRatio: 3,
  locale: 'en-US',
};

export const launchContext: LaunchContext = {
  game: { id: 'spike', version: '0.1.0' },
  user: { id: 'u1', username: 'tester', avatarUrl: null },
  intent: 'solo',
  device,
};

/** Manual clock for rate limits and playtime. */
export function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
