import type { HostEvent } from '@rally/protocol';

export type LogLevel = 'info' | 'ok' | 'warn' | 'error';

export interface PanelOptions {
  hostOn: boolean;
  /** false hides the control card; the exit overlay still works. */
  visible: boolean;
  onHostEvent: (event: HostEvent) => void;
  onToggleHost: () => void;
  onClearSaves: () => void;
  /** Display name of the harness player (sent as the matchmaking `username`). */
  name?: string;
  /** Save a new display name and reload. Omit to hide the name row. */
  onSetName?: (name: string) => void;
}

const HOST_EVENTS: HostEvent[] = ['pause', 'resume', 'exitRequested', 'lowMemory', 'partyUpdated'];
const MAX_LINES = 80;
const COLLAPSED_KEY = 'rally-harness:collapsed';

const CSS = `
:host { all: initial; }
.panel { position: fixed; right: 12px; bottom: 12px; z-index: 2147483646; width: 300px; max-width: calc(100vw - 24px);
  font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #e6edf3;
  background: rgba(13, 17, 23, 0.9); border: 1px solid rgba(240, 246, 252, 0.15); border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35); backdrop-filter: blur(6px); user-select: none; touch-action: auto; }
.panel[hidden] { display: none; }
.head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: pointer; }
.head b { font-weight: 600; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #6e7681; flex: none; }
.dot.on { background: #3fb950; } .dot.off { background: #d29922; }
.status { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9da7b3; }
.body { padding: 0 8px 8px; }
.collapsed .body { display: none; }
.row { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
button { font: inherit; color: inherit; background: #21262d; border: 1px solid #363b42; border-radius: 4px; padding: 2px 6px; cursor: pointer; }
button:hover:not(:disabled) { background: #30363d; }
button:disabled { opacity: 0.4; cursor: default; }
button.toggle.on { border-color: #3fb950; } button.toggle.off { border-color: #d29922; }
.name { display: flex; gap: 4px; margin-bottom: 6px; }
.name input { flex: 1; min-width: 0; font: inherit; color: inherit; background: #0d1117; border: 1px solid #363b42;
  border-radius: 4px; padding: 2px 6px; user-select: text; }
.progress { height: 2px; background: #30363d; margin-bottom: 6px; border-radius: 1px; overflow: hidden; }
.progress > i { display: block; height: 100%; width: 0; background: #58a6ff; transition: width 0.2s; }
.log { max-height: 140px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; user-select: text;
  border-top: 1px solid rgba(240, 246, 252, 0.1); padding-top: 4px; }
.log .ok { color: #7ee787; } .log .warn { color: #e3b341; } .log .error { color: #ff7b72; } .log .info { color: #c9d1d9; }
.overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; background: rgba(1, 4, 9, 0.85); color: #e6edf3; font: 16px/1.4 system-ui, sans-serif; }
.overlay button { font-size: 14px; padding: 6px 14px; }
`;

/** Floating, collapsible control panel in a shadow root so neither side's CSS leaks into the other. */
export class Panel {
  private hostEl: HTMLElement | null = null;

  /** Remove the panel entirely (used when the harness stands down inside the real shell). */
  destroy(): void {
    this.hostEl?.remove();
    this.hostEl = null;
  }

  private readonly opts: PanelOptions;
  private root: ShadowRoot | null = null;
  private logEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private pending: { text: string; level: LogLevel; key?: string }[] = [];
  private lastKey: string | null = null;
  private lastCount = 0;
  private status = '';

  constructor(opts: PanelOptions) {
    this.opts = opts;
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', () => this.mount(), { once: true });
    else this.mount();
  }

  private mount(): void {
    const host = document.createElement('div');
    host.id = 'rally-dev-harness';
    document.documentElement.appendChild(host);
    this.hostEl = host;
    const root = host.attachShadow({ mode: 'open' });
    this.root = root;

    const collapsed = readFlag(COLLAPSED_KEY);
    root.innerHTML = `<style>${CSS}</style>
<div class="panel${collapsed ? ' collapsed' : ''}" part="panel"${this.opts.visible ? '' : ' hidden'}>
  <div class="head" data-role="head" title="Rally dev harness (click to collapse)">
    <span class="dot ${this.opts.hostOn ? 'on' : 'off'}"></span><b>rally host</b><span class="status" data-role="status"></span>
  </div>
  <div class="body">
    <div class="progress"><i data-role="progress"></i></div>${
      this.opts.onSetName
        ? `<form class="name" data-role="name-form" title="Display name for matchmaking (also ?name=…); saved in localStorage">
      <input data-role="name" maxlength="20" placeholder="display name" autocomplete="off" spellcheck="false" />
      <button type="submit">set name</button>
    </form>`
        : ''
    }
    <div class="row">${HOST_EVENTS.map((e) => `<button data-action="${e}" ${this.opts.hostOn ? '' : 'disabled'}>${e}</button>`).join('')}</div>
    <div class="row">
      <button class="toggle ${this.opts.hostOn ? 'on' : 'off'}" data-action="toggle-host" title="Reload with or without ?nohost">host: ${this.opts.hostOn ? 'on' : 'off'}</button>
      <button data-action="clear-saves" title="Delete this game's localStorage save slots, leaderboard entries and achievements">clear data</button>
      <button data-action="reload">reload</button>
    </div>
    <div class="log" data-role="log"></div>
  </div>
</div>`;

    const nameInput = root.querySelector<HTMLInputElement>('[data-role="name"]');
    if (nameInput) nameInput.value = this.opts.name ?? '';
    root.querySelector('[data-role="name-form"]')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = nameInput?.value.trim() ?? '';
      if (name) this.opts.onSetName?.(name);
    });
    this.logEl = root.querySelector('[data-role="log"]');
    this.statusEl = root.querySelector('[data-role="status"]');
    this.progressEl = root.querySelector('[data-role="progress"]');
    this.setStatus(this.status);

    const panel = root.querySelector<HTMLElement>('.panel')!;
    root.querySelector('[data-role="head"]')!.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      writeFlag(COLLAPSED_KEY, panel.classList.contains('collapsed'));
    });
    root.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action!;
      if (action === 'toggle-host') this.opts.onToggleHost();
      else if (action === 'clear-saves') this.opts.onClearSaves();
      else if (action === 'reload') location.reload();
      else this.opts.onHostEvent(action as HostEvent);
    });
    // Keep game input handlers (pointer lock, touch controls) from seeing clicks on the panel.
    for (const type of [
      'pointerdown',
      'pointerup',
      'mousedown',
      'mouseup',
      'touchstart',
      'touchend',
      'keydown',
      'keyup',
      'wheel',
    ]) {
      host.addEventListener(type, (ev) => ev.stopPropagation());
    }

    const queued = this.pending;
    this.pending = [];
    this.lastKey = null;
    for (const l of queued) this.log(l.text, l.level, l.key);
  }

  setStatus(text: string): void {
    this.status = text;
    if (this.statusEl) this.statusEl.textContent = text;
  }

  setLoading(progress: number): void {
    if (this.progressEl) this.progressEl.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
  }

  /** Append a log line. Consecutive lines with the same `key` collapse into one with a counter (pings, telemetry). */
  log(text: string, level: LogLevel = 'info', key?: string): void {
    if (!this.logEl) {
      this.pending.push({ text, level, key });
      if (this.pending.length > MAX_LINES) this.pending.shift();
      return;
    }
    const time = new Date().toTimeString().slice(0, 8);
    if (key && key === this.lastKey && this.logEl.lastElementChild) {
      this.lastCount++;
      const line = this.logEl.lastElementChild as HTMLElement;
      line.className = level;
      line.textContent = `${time} ${text}  ×${this.lastCount}`;
    } else {
      const line = document.createElement('div');
      line.className = level;
      line.textContent = `${time} ${text}`;
      this.logEl.appendChild(line);
      while (this.logEl.childElementCount > MAX_LINES) this.logEl.firstElementChild?.remove();
      this.lastCount = 1;
    }
    this.lastKey = key ?? null;
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** What the shell does on `exit()`: the game is gone; offer a reload. */
  showExit(reason: string): void {
    const show = () => {
      if (!this.root) return;
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.dataset.role = 'exit-overlay';
      const msg = document.createElement('div');
      msg.textContent = `game exited (${reason})`;
      const btn = document.createElement('button');
      btn.textContent = 'reload';
      btn.addEventListener('click', () => location.reload());
      overlay.append(msg, btn);
      this.root.appendChild(overlay);
    };
    if (this.root) show();
    else document.addEventListener('DOMContentLoaded', show, { once: true });
  }
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(key, '1');
    else window.localStorage.removeItem(key);
  } catch {
    /* storage blocked */
  }
}
