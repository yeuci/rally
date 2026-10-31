import type { LumberScene } from './scene.ts';
import {
  CASH_ZONE,
  MILL_CAP,
  MILL_TRAYS,
  REGISTER_ZONE,
  dist,
  inZone,
  queueSlot,
  type LumberSim,
  type Vec2,
} from './sim.ts';

const FLOAT_MS = 900;

export interface Labels {
  /** Reposition / update every label from the sim (every frame). */
  sync(sim: LumberSim): void;
  /** A rising "+$n" at a world point. */
  float(text: string, at: Vec2, cls?: string): void;
  clear(): void;
}

/**
 * World-anchored DOM labels over the canvas: pad prices, customers' orders and patience, "FULL" over a stalled mill,
 * "MAX" over a full stack, the register hint, and floating money. Elements are pooled by key; anything not touched in
 * a frame is hidden.
 */
export function createLabels(container: HTMLElement, scene: LumberScene): Labels {
  const pool = new Map<string, HTMLElement>();
  const touched = new Set<string>();
  const floats: { el: HTMLElement; at: Vec2; born: number }[] = [];
  const out = { x: 0, y: 0 };

  function get(key: string, cls: string): HTMLElement {
    let el = pool.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = `label ${cls}`;
      container.appendChild(el);
      pool.set(key, el);
    }
    touched.add(key);
    return el;
  }

  const ANCHORS = { above: 'translate(-50%, -100%)', right: 'translate(0, -50%)', centre: 'translate(-50%, -50%)' };

  /** Anchor a label at a world point: centred above it (default), vertically centred to its right, or centred on it. */
  function put(el: HTMLElement, x: number, y: number, z: number, anchor: keyof typeof ANCHORS = 'above') {
    scene.project(x, y, z, out);
    el.style.transform = `translate(${out.x.toFixed(1)}px, ${out.y.toFixed(1)}px) ${ANCHORS[anchor]}`;
  }

  function html(el: HTMLElement, s: string) {
    if (el.dataset.html !== s) {
      el.innerHTML = s;
      el.dataset.html = s;
    }
  }

  return {
    sync(sim) {
      touched.clear();
      const a = sim.alpha;

      for (const p of sim.visiblePads) {
        const el = get(`pad-${p.def.id}`, 'pad');
        // On the pad itself (pads can sit close together), with how much of it is paid off.
        const paid = Math.round((p.paid / p.def.cost) * 100);
        html(el, `<b>$${p.def.cost - p.paid}</b><span>${p.def.title}</span><u style="width:${paid}%"></u>`);
        put(el, p.def.x, 0, p.def.z, 'centre');
      }

      sim.mills.forEach((m, i) => {
        if (!m.built || m.stock < MILL_CAP) return;
        const t = MILL_TRAYS[i]!;
        const el = get(`full-${i}`, 'warn');
        html(el, 'FULL');
        put(el, t.x, 2.4, t.z - 0.35);
      });

      const p = sim.player;
      const px = p.px + (p.x - p.px) * a;
      const pz = p.pz + (p.z - p.pz) * a;
      if (p.carry >= p.cap && sim.phase === 'playing') {
        const el = get('max', 'max');
        html(el, 'MAX');
        put(el, px, 1.75 + p.carry * 0.11, pz);
      }

      // Nobody at the till while a customer waits: point at the register.
      const front = sim.queue[0];
      if (
        !sim.cashierHired &&
        front &&
        dist(front, queueSlot(0)) < 0.3 &&
        sim.counter > 0 &&
        !inZone(p, REGISTER_ZONE) &&
        sim.phase === 'playing'
      ) {
        const el = get('till', 'till');
        html(el, '⬇');
        put(el, REGISTER_ZONE.x, 1.6, REGISTER_ZONE.z);
      }

      for (const c of sim.queue) {
        // Only once they are in line (not while walking in from the road, half off screen).
        if (c.slot > 3 || dist(c, queueSlot(c.slot)) > 1) continue;
        const el = get(`c-${c.id}`, 'order');
        const left = c.wants - c.got;
        const mood = c.got > 0 ? 1 : Math.max(0, c.patience / c.maxPatience);
        html(
          el,
          `<b>${left}</b><i class="plank-icon"></i><u style="width:${Math.round(mood * 100)}%" class="${mood < 0.3 ? 'low' : ''}"></u>`,
        );
        const cx = c.px + (c.x - c.px) * a;
        const cz = c.pz + (c.z - c.pz) * a;
        // Beside them, not above: the queue runs down the screen and bubbles above would overlap.
        put(el, cx + (c.kind === 'cart' ? 0.65 : 0.4), 1.0, cz, 'right');
      }

      const now = performance.now();
      for (let i = floats.length - 1; i >= 0; i--) {
        const f = floats[i]!;
        const t = (now - f.born) / FLOAT_MS;
        if (t >= 1) {
          f.el.remove();
          floats.splice(i, 1);
          continue;
        }
        put(f.el, f.at.x, 1.2 + t * 1.2, f.at.z);
        f.el.style.opacity = String(1 - t * t);
      }

      for (const [key, el] of pool) {
        const on = touched.has(key);
        if (el.hidden === on) el.hidden = !on;
        if (!on && key.startsWith('c-')) {
          el.remove();
          pool.delete(key);
        }
      }
    },
    float(text, at = CASH_ZONE, cls = 'money') {
      const el = document.createElement('div');
      el.className = `label float ${cls}`;
      el.textContent = text;
      container.appendChild(el);
      floats.push({ el, at, born: performance.now() });
    },
    clear() {
      for (const el of pool.values()) el.remove();
      pool.clear();
      for (const f of floats) f.el.remove();
      floats.length = 0;
    },
  };
}
