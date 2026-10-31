import type { SawlineScene } from './scene.ts';
import { DEBARKER_Z, LINE_X, PILE, TRUNK_RADIUS, type SawlineSim } from './sim.ts';

const FLOAT_MS = 900;

export interface Labels {
  sync(sim: SawlineSim): void;
  /** Rising text at a world point. */
  float(text: string, x: number, y: number, z: number, cls: string): void;
  clear(): void;
}

/**
 * World-anchored DOM labels: each truck's order (planks still wanted, patience bar, angry face when it is about to
 * leave), "HOLD" over a debarker that is holding up the line, the pile's size, and floating feedback (cut verdicts,
 * money). Elements are pooled by key; anything not touched in a frame is hidden.
 */
export function createLabels(container: HTMLElement, scene: SawlineScene): Labels {
  const pool = new Map<string, HTMLElement>();
  const touched = new Set<string>();
  const floats: { el: HTMLElement; x: number; y: number; z: number; born: number }[] = [];
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

  function put(el: HTMLElement, x: number, y: number, z: number) {
    scene.project(x, y, z, out);
    el.style.transform = `translate(${out.x.toFixed(1)}px, ${out.y.toFixed(1)}px) translate(-50%, -100%)`;
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

      if (sim.phase === 'playing' && sim.debarkerBlocked && !sim.ringRunning) {
        const el = get('hold', 'hold');
        html(el, 'HOLD');
        put(el, LINE_X, TRUNK_RADIUS + 1.9, DEBARKER_Z);
      }

      if (sim.pile > 0) {
        const el = get('pile', 'pile');
        html(el, `${sim.pile}<i class="plank-icon"></i>`);
        put(el, PILE.x, 1.5 + Math.min(sim.pile, 400) * 0.002, PILE.z);
      }

      for (const t of sim.trucks) {
        if (t.state === 'leaving') {
          if (!t.angry) continue;
          const el = get(`t-${t.id}`, 'truck angry');
          html(el, '😠');
          put(el, t.px + (t.x - t.px) * a, 1.9, t.pz + (t.z - t.pz) * a);
          continue;
        }
        const el = get(`t-${t.id}`, 'truck');
        const left = t.want - t.loaded;
        const mood = t.state === 'bay' ? 1 : Math.max(0, t.patience / t.maxPatience);
        const face = mood < 0.35 ? '<em>😠</em>' : '';
        html(
          el,
          `${face}<b>${left}</b><i class="plank-icon"></i><u style="width:${Math.round(mood * 100)}%" class="${mood < 0.35 ? 'low' : ''}"></u>`,
        );
        put(el, t.px + (t.x - t.px) * a, 1.9, t.pz + (t.z - t.pz) * a);
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
        put(f.el, f.x, f.y + t * 1.4, f.z);
        f.el.style.opacity = String(1 - t * t);
      }

      for (const [key, el] of pool) {
        const on = touched.has(key);
        if (el.hidden === on) el.hidden = !on;
        if (!on && key.startsWith('t-')) {
          el.remove();
          pool.delete(key);
        }
      }
    },
    float(text, x, y, z, cls) {
      const el = document.createElement('div');
      el.className = `label float ${cls}`;
      el.textContent = text;
      container.appendChild(el);
      floats.push({ el, x, y, z, born: performance.now() });
    },
    clear() {
      for (const el of pool.values()) el.remove();
      pool.clear();
      for (const f of floats) f.el.remove();
      floats.length = 0;
    },
  };
}
