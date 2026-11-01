import type { GameSetting, MenuPlayer, Rect } from '@rally/protocol';
import { GRAPHICS_CHOICES, type GameValues, type PlatformSettings, type SettingsPatch } from './settings.ts';

/**
 * The shell's game menu, in plain HTML for the harness (apps/mobile/src/game-host/game-menu.tsx is the real one):
 * a corner button over the running game (Escape in the game does the same, through `menu.open`), and a panel with
 * Settings (volume, graphics, haptics, touch controls, then the game's own), How to play and People, Resume and
 * Leave. Also the shell's connection banner ("Reconnecting…" / "Connection lost") and the menu's ping. Every control
 * has a `data-role` / `data-setting` so the games' e2e can drive it.
 */

export interface MenuNet {
  state: 'connected' | 'reconnecting' | 'disconnected';
  rttMs?: number;
}

export interface MenuState {
  platform: PlatformSettings;
  game: GameValues;
  settings: GameSetting[];
  help: { title: string; text: string }[];
  players: MenuPlayer[];
  net: MenuNet | null;
}

export interface HarnessMenuOptions {
  title: string;
  /** Where the corner button sits (the launch context's `device.menuButton`). */
  button: Rect;
  state: () => MenuState;
  onOpen: () => void;
  onClose: () => void;
  /** A control changed: `final` false while a range input is dragged, true when it settles. */
  onChange: (patch: SettingsPatch, final: boolean) => void;
  onLeave: () => void;
}

const CSS = `
:host { all: initial; }
.button { position: fixed; z-index: 2147483644; width: 36px; height: 36px; border-radius: 50%; display: flex;
  align-items: center; justify-content: center; background: rgba(0,0,0,.42); border: 1px solid rgba(255,255,255,.22);
  cursor: pointer; padding: 0; }
.button[hidden], .menu[hidden], .banner[hidden] { display: none; }
.menu { position: fixed; inset: 0; z-index: 2147483645; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.55); font: 14px/1.35 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #fff; }
.panel { width: min(680px, calc(100vw - 24px)); max-height: calc(100vh - 24px); display: flex; flex-direction: column;
  border-radius: 22px; background: rgba(18,18,18,.95); border: 1px solid rgba(255,255,255,.14); overflow: hidden; }
.head { display: flex; align-items: center; gap: 12px; padding: 12px 14px; flex-wrap: wrap; }
.title { flex: 1; font-size: 17px; font-weight: 800; letter-spacing: -.3px; min-width: 120px; }
.tabs { display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: #262626; }
.tabs button, .foot button, .close { font: inherit; color: inherit; border: 0; cursor: pointer; }
.tabs button { padding: 5px 12px; border-radius: 999px; background: transparent; color: #a1a1a1; font-weight: 600; font-size: 12px; }
.tabs button[aria-selected="true"] { background: #171717; color: #fff; box-shadow: inset 0 0 0 1px rgba(255,255,255,.12); }
.close { width: 30px; height: 30px; border-radius: 50%; background: rgba(255,255,255,.1); font-size: 16px; }
.body { overflow-y: auto; padding: 14px 16px; border-top: 1px solid rgba(255,255,255,.1); border-bottom: 1px solid rgba(255,255,255,.1); }
.section { margin-bottom: 16px; } .section h3 { margin: 0 0 8px; font-size: 11px; letter-spacing: .6px; text-transform: uppercase; opacity: .5; }
.row { display: flex; align-items: center; gap: 12px; min-height: 34px; }
.row label { width: 150px; font-weight: 500; } .row input[type=range] { flex: 1; accent-color: #fff; }
.row output { width: 44px; text-align: right; opacity: .55; font-variant-numeric: tabular-nums; }
.row select { flex: 1; font: inherit; background: #262626; color: #fff; border: 1px solid #363636; border-radius: 8px; padding: 4px 8px; }
.row input[type=checkbox] { margin-left: auto; width: 18px; height: 18px; accent-color: #fff; }
.help { padding: 12px; border-radius: 12px; background: rgba(255,255,255,.06); margin-bottom: 8px; }
.help b { display: block; margin-bottom: 2px; } .help span { opacity: .75; }
.empty { padding: 20px 0; text-align: center; opacity: .6; }
.player { display: flex; align-items: center; gap: 10px; min-height: 40px; }
.player .you { font-size: 11px; font-weight: 800; color: #0a0a0a; background: #fff; border-radius: 8px; padding: 0 6px; }
.player .detail { margin-left: auto; opacity: .55; font-variant-numeric: tabular-nums; }
.foot { display: flex; gap: 10px; padding: 10px 14px; align-items: center; }
.foot button { height: 38px; padding: 0 16px; border-radius: 19px; background: rgba(255,255,255,.1); font-weight: 700; }
.foot .resume { margin-left: auto; background: #fff; color: #0a0a0a; }
.ping { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.bars { display: flex; align-items: flex-end; gap: 2px; height: 15px; } .bars i { width: 3px; border-radius: 1px; background: rgba(255,255,255,.2); }
.banner { position: fixed; z-index: 2147483644; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
  height: 36px; padding: 0 6px 0 14px; border-radius: 18px; background: rgba(0,0,0,.72); border: 1px solid rgba(255,255,255,.2);
  color: #fff; font: 600 14px/1 system-ui, sans-serif; }
.banner button { height: 26px; padding: 0 12px; border-radius: 13px; border: 0; background: #fff; color: #0a0a0a; font: 700 13px system-ui, sans-serif; cursor: pointer; }
`;

const MARK =
  '<svg width="22" height="22" viewBox="0 0 100 100" aria-hidden="true"><g stroke="#fff" stroke-width="16" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M28.5 16 L28.5 84" fill="none"/><path d="M28.5 16 L28.5 56 L71.5 36 Z" fill="#fff"/><path d="M52.5 68 L69.5 84" fill="none"/></g></svg>';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Ping bars like the shell's (settings.ts `netBars`). */
export function netBars(net: MenuNet): { bars: number; color: string; label: string } {
  if (net.state === 'disconnected') return { bars: 0, color: '#f87171', label: 'Offline' };
  if (net.state === 'reconnecting') return { bars: 1, color: '#fbbf24', label: 'Reconnecting' };
  const rtt = net.rttMs;
  if (rtt === undefined) return { bars: 4, color: '#4ade80', label: 'Connected' };
  const label = `${Math.round(rtt)} ms`;
  return rtt < 80
    ? { bars: 4, color: '#4ade80', label }
    : rtt < 150
      ? { bars: 3, color: '#4ade80', label }
      : rtt < 250
        ? { bars: 2, color: '#fbbf24', label }
        : { bars: 1, color: '#f87171', label };
}

export class HarnessMenu {
  private readonly opts: HarnessMenuOptions;
  private root: ShadowRoot | null = null;
  private host: HTMLElement | null = null;
  private tab: 'settings' | 'help' | 'people' = 'settings';
  private buttonShown = false;
  private openNow = false;

  constructor(opts: HarnessMenuOptions) {
    this.opts = opts;
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', () => this.mount(), { once: true });
    else this.mount();
  }

  get isOpen(): boolean {
    return this.openNow;
  }

  private mount(): void {
    const host = document.createElement('div');
    host.id = 'rally-harness-menu';
    document.documentElement.appendChild(host);
    this.host = host;
    const root = host.attachShadow({ mode: 'open' });
    this.root = root;
    const b = this.opts.button;
    root.innerHTML = `<style>${CSS}</style>
<button class="button" data-role="menu-button" aria-label="Game menu" style="left:${b.x}px;top:${b.y}px" hidden>${MARK}</button>
<div class="banner" data-role="net-banner" style="top:${b.y}px" hidden></div>
<div class="menu" data-role="menu" hidden></div>`;
    root.querySelector('[data-role="menu-button"]')!.addEventListener('click', () => this.opts.onOpen());
    // Keep the game's input handlers from seeing clicks on the menu.
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
    this.showButton(this.buttonShown);
    if (this.openNow) this.render();
    this.renderNet();
  }

  /** The corner button: over a running game only (not over the loading screen, not after exit). */
  showButton(on: boolean): void {
    this.buttonShown = on;
    const el = this.root?.querySelector<HTMLElement>('[data-role="menu-button"]');
    if (el) el.hidden = !on || this.openNow;
  }

  open(): void {
    this.openNow = true;
    this.tab = this.opts.state().players.length > 1 ? 'people' : 'settings';
    this.render();
    this.showButton(this.buttonShown);
  }

  close(): void {
    this.openNow = false;
    const menu = this.root?.querySelector<HTMLElement>('[data-role="menu"]');
    if (menu) menu.hidden = true;
    this.showButton(this.buttonShown);
  }

  /** The page defined (or redefined) its settings / help, or the players changed: redraw if open. */
  refresh(): void {
    if (this.openNow) this.render();
  }

  /** The connection changed: banner over the game, ping in the menu. */
  renderNet(): void {
    const banner = this.root?.querySelector<HTMLElement>('[data-role="net-banner"]');
    if (!banner) return;
    const net = this.opts.state().net;
    if (!net || net.state === 'connected' || !this.buttonShown) {
      banner.hidden = true;
    } else {
      banner.hidden = false;
      banner.dataset.state = net.state;
      banner.innerHTML =
        net.state === 'reconnecting'
          ? '<span>Reconnecting…</span>'
          : '<span>Connection lost</span><button data-role="net-leave">Leave</button>';
      banner.querySelector('[data-role="net-leave"]')?.addEventListener('click', () => this.opts.onLeave());
    }
    const ping = this.root?.querySelector<HTMLElement>('[data-role="menu-ping"]');
    if (ping) ping.outerHTML = this.pingHtml();
  }

  destroy(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
  }

  private pingHtml(): string {
    const net = this.opts.state().net;
    if (!net) return '<span data-role="menu-ping" hidden></span>';
    const { bars, color, label } = netBars(net);
    const is = [1, 2, 3, 4].map(
      (i) => `<i style="height:${3 + i * 3}px;${i <= bars ? `background:${color}` : ''}"></i>`,
    );
    return `<span class="ping" data-role="menu-ping" title="Connection"><span class="bars">${is.join('')}</span><span>${esc(label)}</span></span>`;
  }

  private render(): void {
    const menu = this.root?.querySelector<HTMLElement>('[data-role="menu"]');
    if (!menu) return;
    const s = this.opts.state();
    const multiplayer = s.players.length > 0;
    if (this.tab === 'people' && !multiplayer) this.tab = 'settings';
    const tab = (id: string, label: string) =>
      `<button role="tab" data-tab="${id}" data-role="menu-tab-${id}" aria-selected="${this.tab === id}">${label}</button>`;
    menu.hidden = false;
    menu.innerHTML = `<div class="panel" role="dialog" aria-label="Game menu">
  <div class="head">${MARK}<span class="title">${esc(this.opts.title)}</span>${this.pingHtml()}
    <div class="tabs" role="tablist">${multiplayer ? tab('people', 'People') : ''}${tab('settings', 'Settings')}${tab('help', 'How to play')}</div>
    <button class="close" data-role="menu-close" aria-label="Close menu">✕</button></div>
  <div class="body">${this.tab === 'settings' ? this.settingsHtml(s) : this.tab === 'help' ? this.helpHtml(s) : this.peopleHtml(s)}</div>
  <div class="foot"><button data-role="menu-leave">Leave game</button><button class="resume" data-role="menu-resume">Resume</button></div>
</div>`;
    menu.onclick = (ev) => {
      const t = ev.target as HTMLElement;
      if (t === menu) return this.opts.onClose();
      const tabId = t.closest<HTMLElement>('[data-tab]')?.dataset.tab;
      if (tabId) {
        this.tab = tabId as typeof this.tab;
        this.render();
      } else if (t.closest('[data-role="menu-close"], [data-role="menu-resume"]')) this.opts.onClose();
      else if (t.closest('[data-role="menu-leave"]')) this.opts.onLeave();
    };
    const fire = (el: HTMLInputElement | HTMLSelectElement, final: boolean) => {
      const patch = this.patchOf(el, s.settings);
      if (!patch) return;
      const out = el.parentElement?.querySelector('output');
      if (out && el instanceof HTMLInputElement && el.type === 'range')
        out.textContent = el.dataset.pct ? pct(Number(el.value)) : el.value;
      this.opts.onChange(patch, final);
    };
    menu.oninput = (ev) => {
      const el = ev.target as HTMLInputElement;
      if (el.type === 'range') fire(el, false);
    };
    menu.onchange = (ev) => fire(ev.target as HTMLInputElement | HTMLSelectElement, true);
  }

  /** `data-setting="volume.master"` / `controls.stickSize` / `graphics` / `haptics`, or `data-game="key"`, as a patch. */
  private patchOf(el: HTMLInputElement | HTMLSelectElement, defs: GameSetting[]): SettingsPatch | null {
    const value =
      el instanceof HTMLInputElement && el.type === 'checkbox'
        ? el.checked
        : el instanceof HTMLInputElement && el.type === 'range'
          ? Number(el.value)
          : el.value;
    const key = el.dataset.setting;
    if (key) {
      const [group, field] = key.split('.') as [string, string | undefined];
      if (group === 'volume' && field) return { volume: { [field]: value } };
      if (group === 'controls' && field) return { controls: { [field]: value } };
      if (group === 'graphics') return { graphics: value as SettingsPatch['graphics'] };
      if (group === 'haptics') return { haptics: value as boolean };
      return null;
    }
    const g = el.dataset.game;
    if (!g || !defs.some((d) => d.key === g)) return null;
    return { game: { [g]: value } };
  }

  private settingsHtml(s: MenuState): string {
    const range = (setting: string, label: string, v: number, min: number, max: number, step: number) =>
      `<div class="row"><label>${label}</label><input type="range" data-setting="${setting}" data-pct="1" min="${min}" max="${max}" step="${step}" value="${v}"><output>${pct(v)}</output></div>`;
    const check = (setting: string, label: string, on: boolean) =>
      `<div class="row"><label>${label}</label><input type="checkbox" data-setting="${setting}" ${on ? 'checked' : ''}></div>`;
    const p = s.platform;
    const game = s.settings
      .map((d) => {
        const v = s.game[d.key] ?? d.default;
        if (d.type === 'toggle')
          return `<div class="row"><label>${esc(d.label)}</label><input type="checkbox" data-game="${d.key}" ${v === true ? 'checked' : ''}></div>`;
        if (d.type === 'slider')
          return `<div class="row"><label>${esc(d.label)}</label><input type="range" data-game="${d.key}" min="${d.min}" max="${d.max}" step="${d.step}" value="${Number(v)}"><output>${Number(v)}</output></div>`;
        return `<div class="row"><label>${esc(d.label)}</label><select data-game="${d.key}">${d.options
          .map((o) => `<option value="${esc(o.value)}" ${o.value === v ? 'selected' : ''}>${esc(o.label)}</option>`)
          .join('')}</select></div>`;
      })
      .join('');
    return `<div class="section"><h3>Sound</h3>${range('volume.master', 'Master volume', p.volume.master, 0, 1, 0.05)}${range('volume.music', 'Music', p.volume.music, 0, 1, 0.05)}${range('volume.effects', 'Effects', p.volume.effects, 0, 1, 0.05)}</div>
<div class="section"><h3>Graphics</h3><div class="row"><label>Quality</label><select data-setting="graphics" data-role="setting-graphics">${GRAPHICS_CHOICES.map(
      (g) => `<option value="${g}" ${g === p.graphics ? 'selected' : ''}>${g[0]!.toUpperCase()}${g.slice(1)}</option>`,
    ).join('')}</select></div></div>
<div class="section"><h3>Controls</h3>${check('controls.swapSticks', 'Left-handed (swap sticks)', p.controls.swapSticks)}${range('controls.stickSize', 'Stick size', p.controls.stickSize, 0.75, 1.5, 0.05)}${range('controls.stickOpacity', 'Stick opacity', p.controls.stickOpacity, 0.2, 1, 0.05)}${check('controls.aimAssist', 'Aim assist', p.controls.aimAssist)}</div>
<div class="section"><h3>Haptics</h3>${check('haptics', 'Vibration', p.haptics)}</div>
${game ? `<div class="section"><h3>${esc(this.opts.title)}</h3>${game}</div>` : ''}`;
  }

  private helpHtml(s: MenuState): string {
    if (s.help.length === 0) return '<div class="empty">No guide yet: this game has not added one.</div>';
    return s.help.map((h) => `<div class="help"><b>${esc(h.title)}</b><span>${esc(h.text)}</span></div>`).join('');
  }

  private peopleHtml(s: MenuState): string {
    if (s.players.length === 0) return '<div class="empty">Players show up here once you are in a match.</div>';
    return `<div class="section"><h3>In this match · ${s.players.length}</h3>${s.players
      .map(
        (p) =>
          `<div class="player" data-role="menu-player"><b>${esc(p.name)}</b>${p.you ? '<span class="you">You</span>' : ''}<span class="detail">${esc(p.detail ?? '')}</span></div>`,
      )
      .join('')}</div>`;
  }
}
