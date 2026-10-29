import { rally } from '@rally/sdk';
import { createScene } from './scene.ts';
import { FrameMetrics, jsHeapMb, round } from './metrics.ts';
import { connect, type NetHandle } from './net.ts';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const statusEl = $('#status');
const statsEl = $('#stats');
const setStatus = (s: string) => {
  statusEl.textContent = s;
};

const bootStart = performance.now();
const canvas = $<HTMLCanvasElement>('#application-canvas');
const scene = createScene(canvas);
scene.setCubeCount(300);

const metrics = new FrameMetrics(2000);
scene.app.on('frameend', () => metrics.tick());

let bridgeRtt: number | null = null;
let readyMs: number | null = null;
let net: NetHandle | null = null;
let roomLabel = '—';
let exiting = false;

// Stress knobs
for (const btn of document.querySelectorAll<HTMLButtonElement>('button[data-count]')) {
  btn.addEventListener('click', () => {
    scene.setCubeCount(Number(btn.dataset.count));
    for (const b of document.querySelectorAll('button[data-count]')) b.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-pressed', 'true');
  });
}
$('#exit').addEventListener('click', () => void exit('button'));

async function exit(reason: string) {
  if (exiting) return;
  exiting = true;
  setStatus('leaving…');
  try {
    await net?.leave();
  } catch {
    /* ignore */
  }
  if (rally.isHosted) await rally.exit(reason).catch(() => {});
  else setStatus('exited (standalone)');
}

rally.on('exitRequested', () => void exit('host'));
rally.on('pause', () => {
  scene.app.timeScale = 0;
  setStatus('paused');
});
rally.on('resume', () => {
  scene.app.timeScale = 1;
  setStatus('resumed');
});
rally.on('lowMemory', () => scene.setCubeCount(Math.min(scene.cubeCount, 100)));

async function boot() {
  if (rally.isHosted) {
    setStatus('handshake…');
    const ctx = await rally.ready();
    readyMs = round(performance.now() - bootStart, 0);
    setStatus(`hello ${ctx.user.username} · ${ctx.intent}`);

    // Bridge RTT probe, then keep it fresh.
    const probe = async () => {
      try {
        bridgeRtt = round((await rally.ping()).rttMs);
      } catch {
        bridgeRtt = null;
      }
    };
    await probe();
    setInterval(() => void probe(), 2000);

    // Matchmake via the host; the socket itself is opened from here.
    setStatus('joining room…');
    const { endpoint, seatReservation } = await rally.session.join();
    net = await connect(endpoint, { seatReservation });
    roomLabel = `${net.room.roomId.slice(0, 6)}…/${net.room.sessionId.slice(0, 4)}`;
    setStatus('in room');
    net.room.onLeave((code) => {
      roomLabel = `left (${code})`;
      setStatus('room left');
    });
  } else {
    readyMs = round(performance.now() - bootStart, 0);
    const endpoint = new URLSearchParams(location.search).get('colyseus');
    if (endpoint) {
      setStatus('standalone · joining hello…');
      net = await connect(endpoint, { roomName: 'hello' });
      roomLabel = `${net.room.roomId.slice(0, 6)}…`;
      setStatus('standalone · in room');
    } else {
      setStatus('standalone (no host bridge)');
    }
  }
}

boot().catch((err) => {
  console.error(err);
  setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
  rally.reportError(err);
});

// HUD + telemetry
function collect() {
  const f = metrics.snapshot();
  const gd = scene.app.graphicsDevice;
  const heap = jsHeapMb();
  return {
    fps: f.fps,
    frameMs: f.frameMs,
    p95Ms: f.p95Ms,
    worstMs: f.worstMs,
    drawCalls: scene.app.stats.drawCalls.total,
    cubes: scene.cubeCount,
    dpr: round(gd.maxPixelRatio, 2),
    width: gd.width,
    height: gd.height,
    api: gd.isWebGPU ? 'webgpu' : gd.isWebGL2 ? 'webgl2' : 'webgl1',
    readyMs: readyMs ?? -1,
    bridgeRttMs: bridgeRtt ?? -1,
    wsRttMs: net?.rttMs ?? -1,
    serverTick: net?.serverTick ?? -1,
    heapMb: heap ?? -1,
  };
}

setInterval(() => {
  const m = collect();
  statsEl.textContent =
    `${m.fps} fps  ${m.frameMs} ms  p95 ${m.p95Ms}  worst ${m.worstMs}\n` +
    `${m.drawCalls} draws  ${m.cubes} cubes  ${m.width}x${m.height}@${m.dpr}  ${m.api}\n` +
    `ready ${fmt(m.readyMs)} ms  bridge ${fmt(m.bridgeRttMs)} ms  ws ${fmt(m.wsRttMs)} ms\n` +
    `room ${roomLabel}  tick ${fmt(m.serverTick)}${m.heapMb >= 0 ? `  heap ${m.heapMb} MB` : ''}`;
}, 500);

setInterval(() => rally.telemetry.report('spike', collect()), 5000);

function fmt(n: number) {
  return n < 0 ? '—' : String(n);
}
