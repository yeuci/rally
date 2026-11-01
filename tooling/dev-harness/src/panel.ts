import type { HostEvent } from '@rally/protocol';
import type { LoadingState } from './loading.ts';
import type { RoomListing } from './matchmake.ts';

/** What the loading screen shows besides the state: the game's title and art. */
export interface LoadingScreen {
  title: string;
  art: string | null;
}

export type LogLevel = 'info' | 'ok' | 'warn' | 'error';

export interface PanelOptions {
  hostOn: boolean;
  /** false hides the control card; the exit overlay still works. */
  visible: boolean;
  onHostEvent: (event: HostEvent) => void;
  onToggleHost: () => void;
  onClearSaves: () => void;
  /**
   * Display name of the harness player: the launch context's `user.username`. Not sent in matchmaking; a game
   * passes it on in the `profile` room message, which the server accepts for guests (as `guest-<name>`).
   */
  name?: string;
  /** Save a new display name and reload. Omit to hide the name row. */
  onSetName?: (name: string) => void;
  /** `GET /rooms/<room>`; polled every {@link ROOMS_POLL_MS} while the panel is open. Omit to hide the room list. */
  listRooms?: () => Promise<RoomListing[]>;
  /** The room this page is in, marked in the list. */
  currentRoomId?: () => string | null;
  /** A room row was clicked: join it by id (with its code if it has one). */
  onJoinRoom?: (row: RoomRow) => void;
  /**
   * The live rejoin record (read every second): while there is one, a "reload with ?resume" button with a countdown
   * shows (the record lasts until the game reports another room, an exit, a failed resume or expiry).
   */
  rejoin?: { current: () => { roomId: string; expiresAt: number } | null; onRejoin: () => void };
}

/** How often the open panel refreshes its room list (the shell's server browser uses the same interval). */
export const ROOMS_POLL_MS = 5000;

/** One line of the panel's room list. */
export interface RoomRow {
  roomId: string;
  name: string;
  /** Seated players (metadata, which counts seats inside their reconnection grace), else the listing's clients. */
  players: number;
  /** Seats with a live socket (metadata `connected`; older servers: all of them). */
  connected: number;
  /** Seats held for the reconnection grace (a refreshed or closed tab): `players − connected`. */
  reconnecting: number;
  /** "2 playing · 1 reconnecting" when someone is reconnecting, else null. */
  status: string | null;
  maxPlayers: number;
  /** From the game's `phase` metadata (Sumo): `waiting` → Waiting, any other phase → In match; none → null. */
  phase: 'Waiting' | 'In match' | null;
  private: boolean;
  /** Private rooms: the join code from the metadata (needed by `joinById`). */
  code?: string;
  serverVersion: number | null;
  /** Full or locked: not joinable. */
  joinable: boolean;
  /** This page's room. */
  current: boolean;
}

/** Room listings → panel rows, most connected players first (ties keep the server's order: fullest first). */
export function roomRows(listings: RoomListing[], currentRoomId: string | null): RoomRow[] {
  const rows = listings.map((r): RoomRow => {
    const m = r.metadata ?? {};
    const int = (v: unknown, fallback: number) =>
      typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback;
    const players = int(m.players, r.clients);
    const connected = Math.min(players, int(m.connected, players));
    const reconnecting = players - connected;
    const maxPlayers = int(m.maxPlayers, r.maxClients);
    const phase = typeof m.phase === 'string' && m.phase ? (m.phase === 'waiting' ? 'Waiting' : 'In match') : null;
    const code = typeof m.code === 'string' && m.code ? m.code : undefined;
    return {
      roomId: r.roomId,
      name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : r.roomId,
      players,
      connected,
      reconnecting,
      status: reconnecting > 0 ? `${connected} playing · ${reconnecting} reconnecting` : null,
      maxPlayers,
      phase,
      private: m.private === true,
      ...(code ? { code } : {}),
      serverVersion: typeof m.serverVersion === 'number' ? m.serverVersion : null,
      joinable: !r.locked && (maxPlayers === 0 || players < maxPlayers),
      current: r.roomId === currentRoomId,
    };
  });
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => b.row.connected - a.row.connected || a.i - b.i)
    .map((x) => x.row);
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
.rooms { margin-bottom: 6px; border-top: 1px solid rgba(240, 246, 252, 0.1); padding-top: 4px; }
.rooms .title { display: flex; justify-content: space-between; color: #9da7b3; margin-bottom: 2px; }
.rooms .list { max-height: 110px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.rooms .room { display: flex; gap: 6px; align-items: center; text-align: left; width: 100%; }
.rooms .room .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rooms .room .badge { color: #9da7b3; }
.rooms .room.current { border-color: #3fb950; }
.rooms .room.current:disabled { opacity: 1; cursor: default; }
.rooms .empty { color: #9da7b3; }
.rooms .empty.error { color: #ff7b72; }
button.rejoin { border-color: #58a6ff; margin-bottom: 4px; }
button[hidden] { display: none; }
.overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; background: rgba(1, 4, 9, 0.85); color: #e6edf3; font: 16px/1.4 system-ui, sans-serif; }
.overlay button { font-size: 14px; padding: 6px 14px; }
.boot { position: fixed; inset: 0; z-index: 2147483645; display: flex; align-items: center; justify-content: center; overflow: hidden;
  background: #0a0a0a linear-gradient(135deg, #262626, #121212 55%, #0a0a0a); color: #fff;
  font: 14px/1.35 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; transition: opacity 250ms ease; user-select: none; }
.boot.hide { opacity: 0; pointer-events: none; }
.boot-art { position: absolute; inset: -48px; background: center / cover no-repeat; filter: blur(28px); opacity: 0; transition: opacity 450ms; }
.boot-art.shown { opacity: 1; }
.boot-scrim { position: absolute; inset: 0; background: linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0) 30%, rgba(0, 0, 0, 0) 62%, rgba(0, 0, 0, 0.55)); }
.boot.art .boot-scrim { background-color: rgba(0, 0, 0, 0.4); }
.boot-brand { position: absolute; top: max(18px, env(safe-area-inset-top)); left: max(20px, env(safe-area-inset-left)); display: flex;
  align-items: center; gap: 6px; font-size: 20px; font-weight: 800; letter-spacing: -0.5px; }
.boot-center { position: relative; width: min(340px, calc(100vw - 64px)); display: flex; flex-direction: column; align-items: center; }
.boot-title { font-size: 28px; line-height: 34px; font-weight: 800; letter-spacing: -0.6px; margin-bottom: 22px; text-align: center;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.35); }
.boot-bar { width: 100%; height: 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.16); overflow: hidden; }
.boot-bar > i { display: block; height: 100%; width: 0; border-radius: 3px; background: #fafafa; transition: width 500ms cubic-bezier(0.33, 1, 0.68, 1); }
.boot-status { width: 100%; margin-top: 12px; display: flex; justify-content: space-between; gap: 12px; font-weight: 500; }
.boot-status [data-role="loading-detail"] { opacity: 0.55; font-variant-numeric: tabular-nums; white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .boot-bar > i { transition: none; } }
`;

/** The Rally mark (apps/mobile/src/lib/brand.ts MARK), white. */
const MARK_SVG =
  '<svg width="26" height="26" viewBox="0 0 100 100" aria-hidden="true"><g stroke="#fff" stroke-width="16" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M28.5 16 L28.5 84" fill="none"/><path d="M28.5 16 L28.5 56 L71.5 36 Z" fill="#fff"/><path d="M52.5 68 L69.5 84" fill="none"/></g></svg>';

/** Floating, collapsible control panel in a shadow root so neither side's CSS leaks into the other. */
export class Panel {
  private hostEl: HTMLElement | null = null;
  /** Set by destroy(); a mount still pending on DOMContentLoaded then does nothing. */
  private destroyed = false;

  /** Remove the panel entirely (used when the harness stands down inside the real shell). */
  destroy(): void {
    this.destroyed = true;
    this.stopRooms();
    if (this.rejoinTimer) clearInterval(this.rejoinTimer);
    this.rejoinTimer = null;
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
  private roomsEl: HTMLElement | null = null;
  private roomsTitleEl: HTMLElement | null = null;
  private rows: RoomRow[] = [];
  private roomsTimer: ReturnType<typeof setInterval> | null = null;
  private roomsInFlight = false;
  private rejoinTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: PanelOptions) {
    this.opts = opts;
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', () => this.mount(), { once: true });
    else this.mount();
  }

  private mount(): void {
    if (this.destroyed) return;
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
    ${
      this.opts.listRooms
        ? `<div class="rooms" data-role="rooms-section">${
            this.opts.rejoin
              ? `<button class="rejoin" data-action="rejoin" hidden title="Reload and reconnect with the stored reconnection token, like a relaunch within the grace"></button>`
              : ''
          }
      <div class="title"><span data-role="rooms-title">rooms</span><span title="Click a room to join it by id; refreshed every ${ROOMS_POLL_MS / 1000} s while the panel is open">click to join</span></div>
      <div class="list" data-role="rooms"></div>
    </div>`
        : ''
    }
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

    this.roomsEl = root.querySelector('[data-role="rooms"]');
    this.roomsTitleEl = root.querySelector('[data-role="rooms-title"]');

    const panel = root.querySelector<HTMLElement>('.panel')!;
    root.querySelector('[data-role="head"]')!.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      const isCollapsed = panel.classList.contains('collapsed');
      writeFlag(COLLAPSED_KEY, isCollapsed);
      if (isCollapsed) this.stopRooms();
      else this.startRooms();
    });
    if (this.opts.visible && !collapsed) this.startRooms();
    this.startRejoinCountdown();
    root.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action!;
      if (action === 'join-room') {
        const row = this.rows.find((r) => r.roomId === btn.dataset.roomId);
        if (row) this.opts.onJoinRoom?.(row);
      } else if (action === 'rejoin') this.opts.rejoin?.onRejoin();
      else if (action === 'toggle-host') this.opts.onToggleHost();
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
    // The loading screen as it stands now (the game may have reported before the page finished parsing).
    if (this.bootState) this.setLoadingScreen(this.bootState.state, this.bootState.screen);
  }

  /** Fetch the room list now (e.g. right after this page joined a room), if the list is showing. */
  refreshRooms(): void {
    if (this.roomsTimer !== null) void this.loadRooms();
  }

  private startRooms(): void {
    if (!this.opts.listRooms || !this.roomsEl || this.roomsTimer !== null) return;
    void this.loadRooms();
    this.roomsTimer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void this.loadRooms();
    }, ROOMS_POLL_MS);
  }

  private stopRooms(): void {
    if (this.roomsTimer !== null) clearInterval(this.roomsTimer);
    this.roomsTimer = null;
  }

  private async loadRooms(): Promise<void> {
    if (!this.opts.listRooms || this.roomsInFlight) return;
    this.roomsInFlight = true;
    try {
      this.rows = roomRows(await this.opts.listRooms(), this.opts.currentRoomId?.() ?? null);
      this.renderRooms(null);
    } catch (err) {
      this.rows = [];
      this.renderRooms(err instanceof Error ? err.message : String(err));
    } finally {
      this.roomsInFlight = false;
    }
  }

  private renderRooms(error: string | null): void {
    const list = this.roomsEl;
    if (!list) return;
    if (this.roomsTitleEl) this.roomsTitleEl.textContent = error ? 'rooms' : `rooms (${this.rows.length})`;
    const nodes: HTMLElement[] = this.rows.map((r) => {
      const btn = document.createElement('button');
      btn.className = `room${r.current ? ' current' : ''}`;
      btn.dataset.action = 'join-room';
      btn.dataset.roomId = r.roomId;
      btn.disabled = r.current || !r.joinable;
      btn.title = `${r.roomId}${r.private ? ' (private)' : ''}${r.serverVersion !== null ? ` · server v${r.serverVersion}` : ''}${
        r.current ? ' · you are here' : r.joinable ? ' · click to join by id' : ' · full or locked'
      }`;
      const name = document.createElement('span');
      name.className = 'n';
      name.textContent = `${r.private ? 'private · ' : ''}${r.name}`;
      const count = document.createElement('span');
      count.textContent = `${r.players}/${r.maxPlayers}`;
      if (r.status) {
        count.textContent += ` (${r.status})`;
        count.title = 'seats held for the reconnection grace (a refreshed or closed tab, or one opened with ?hold)';
      }
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = r.current ? 'you' : (r.phase ?? '');
      btn.append(name, count, badge);
      return btn;
    });
    if (nodes.length === 0) {
      const empty = document.createElement('div');
      empty.className = error ? 'empty error' : 'empty';
      empty.textContent = error ?? 'no open rooms (quick play starts one)';
      nodes.push(empty);
    }
    list.replaceChildren(...nodes);
  }

  private startRejoinCountdown(): void {
    const rejoin = this.opts.rejoin;
    const btn = this.root?.querySelector<HTMLButtonElement>('button[data-action="rejoin"]');
    if (!rejoin || !btn) return;
    const tick = () => {
      const rec = rejoin.current();
      const left = rec ? Math.round((rec.expiresAt - Date.now()) / 1000) : 0;
      btn.hidden = left <= 0;
      if (rec && left > 0) {
        btn.textContent = `reload with ?resume · ${rec.roomId} (${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')})`;
      }
    };
    tick();
    this.rejoinTimer = setInterval(tick, 1000);
  }

  setStatus(text: string): void {
    this.status = text;
    if (this.statusEl) this.statusEl.textContent = text;
  }

  setLoading(progress: number): void {
    if (this.progressEl) this.progressEl.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
  }

  private boot: { el: HTMLElement; bar: HTMLElement; label: HTMLElement; detail: HTMLElement } | null = null;
  private bootState: { state: LoadingState; screen: LoadingScreen } | null = null;

  /**
   * The shell's loading screen over the page (simpler: the blurred art, the Rally mark, the title, the bar and the
   * game's words with a percentage), following the hold contract in src/loading.ts. Below the panel, so the panel
   * stays usable; fades out when the game is shown.
   */
  setLoadingScreen(state: LoadingState, screen: LoadingScreen): void {
    this.bootState = { state, screen };
    if (!this.root) return;
    if (!this.boot) {
      if (!state.visible) return;
      const el = document.createElement('div');
      el.className = `boot${screen.art ? ' art' : ''}`;
      el.dataset.role = 'loading-overlay';
      const art = document.createElement('div');
      art.className = 'boot-art';
      if (screen.art) {
        // Shown once decoded, like the shell's cross-fade.
        const img = new Image();
        img.onload = () => art.classList.add('shown');
        img.src = screen.art;
        art.style.backgroundImage = `url("${screen.art.replace(/"/g, '%22')}")`;
      }
      const scrim = document.createElement('div');
      scrim.className = 'boot-scrim';
      const brand = document.createElement('div');
      brand.className = 'boot-brand';
      brand.innerHTML = `${MARK_SVG}<span>Rally</span>`;
      const center = document.createElement('div');
      center.className = 'boot-center';
      const title = document.createElement('div');
      title.className = 'boot-title';
      title.textContent = screen.title;
      const barWrap = document.createElement('div');
      barWrap.className = 'boot-bar';
      const bar = document.createElement('i');
      barWrap.append(bar);
      const status = document.createElement('div');
      status.className = 'boot-status';
      const label = document.createElement('span');
      label.dataset.role = 'loading-label';
      const detail = document.createElement('span');
      detail.dataset.role = 'loading-detail';
      status.append(label, detail);
      center.append(title, barWrap, status);
      el.append(art, scrim, brand, center);
      // Keep the game's input handlers from seeing clicks on the screen while it is up.
      for (const type of ['pointerdown', 'mousedown', 'touchstart'])
        el.addEventListener(type, (ev) => ev.stopPropagation());
      this.root.appendChild(el);
      this.boot = { el, bar, label, detail };
    }
    const b = this.boot;
    b.bar.style.width = `${Math.round(state.progress * 100)}%`;
    b.label.textContent = state.label ?? `Getting ${screen.title} ready…`;
    b.detail.textContent = `${Math.floor(state.progress * 100)}%`;
    if (!state.visible && !b.el.classList.contains('hide')) {
      b.el.classList.add('hide');
      setTimeout(() => b.el.remove(), 300);
    }
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
