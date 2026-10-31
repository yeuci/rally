import {
  PALETTE,
  WEAPONS,
  type OverrunPlayerView,
  type OverrunStateView,
  type ResultMessage,
} from '@rally/game-overrun-server';
import { ComboDisplay, formatScore } from './combo.ts';
import { resultLine } from './result.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Ammo of weapon `w` for a player view (the pistol: Infinity). */
export function ammoOf(p: Pick<OverrunPlayerView, 'a1' | 'a2' | 'a3' | 'a4'>, w: number): number {
  return w === 0 ? Infinity : ([p.a1, p.a2, p.a3, p.a4][w - 1] ?? 0);
}

export interface Hud {
  /**
   * Redraw from the latest state. `me` = our session id; `result`: this player's `result` for the run on screen
   * (`RunResultView.current()`), shown as one line of the run-over banner.
   */
  render(state: OverrunStateView, me: string, rttMs: number | null, result?: ResultMessage | 'pending' | null): void;
  /** Overrides the computed banner (errors, "Joining…"); null returns to the game's own banner. */
  setMessage(title: string | null, sub?: string): void;
  /** A short notice under the top bar ("Uzi unlocked"). */
  toast(text: string, kind?: 'unlock' | 'good' | 'bad'): void;
  /** Red edge flash (you got hurt). */
  hurt(strength: number): void;
  hideHint(): void;
  /** The weapon button was pressed. */
  onWeaponButton(fn: () => void): void;
  /** The start button (private rooms) was pressed. */
  onStart(fn: () => void): void;
}

/** DOM HUD: wave and zombies left, combo and team score, team chips, weapon button, banners, toasts. */
export function createHud(): Hud {
  const waveEl = $('wave');
  const leftEl = $('left');
  const pingEl = $('ping');
  const comboEl = $('combo');
  const comboX = $('combo-x');
  const comboBar = $('combo-bar');
  const scoreEl = $('score');
  const teamEl = $('team');
  const weaponBtn = $<HTMLButtonElement>('weapon');
  const weaponIcon = $('weapon-icon');
  const weaponName = $('weapon-name');
  const weaponAmmo = $('weapon-ammo');
  const toasts = $('toasts');
  const banner = $('banner');
  const title = $('banner-title');
  const sub = $('banner-sub');
  const startBtn = $<HTMLButtonElement>('start');
  const hint = $('hint');
  const vignette = $('vignette');
  const combo = new ComboDisplay();
  let override: { title: string; sub: string } | null = null;
  let lastTitle = '';
  let lastTeam = '';
  let lastWeapon = '';
  let lastWave = '';

  function show(t: string, s: string, big = false) {
    banner.hidden = t === '' && s === '';
    if (t !== lastTitle) {
      title.textContent = t;
      title.classList.remove('pop');
      if (big) {
        void title.offsetWidth; // restart the animation
        title.classList.add('pop');
      }
      lastTitle = t;
    }
    title.classList.toggle('big', big);
    if (sub.innerHTML !== s) sub.innerHTML = s;
  }

  const hp = (p: OverrunPlayerView) => (p.down ? 0 : Math.max(0, Math.min(100, p.hp)));

  return {
    render(state, me, rttMs, result = null) {
      const players: [string, OverrunPlayerView][] = [];
      state.players.forEach((p, id) => players.push([id, p]));
      players.sort((a, b) => a[1].slot - b[1].slot);
      const mine = state.players.get(me);
      const phase = state.phase;

      // Top-left: the wave and what is left of it.
      const waveText =
        phase === 'waiting'
          ? state.isPrivate
            ? 'Lobby'
            : 'Warm-up'
          : phase === 'over'
            ? 'Run over'
            : `Wave ${state.wave}`;
      const leftText =
        phase === 'wave'
          ? `${state.remaining} left`
          : phase === 'breather'
            ? `next in ${Math.max(1, Math.ceil(state.timer))}`
            : phase === 'waiting'
              ? `${players.length}/${state.maxPlayers}`
              : `wave ${state.reached}`;
      const waveKey = `${waveText}|${leftText}`;
      if (waveKey !== lastWave) {
        waveEl.textContent = waveText;
        leftEl.textContent = leftText;
        lastWave = waveKey;
      }
      pingEl.textContent = rttMs === null ? 'ping —' : `ping ${rttMs} ms`;

      // Top-centre: combo and team score.
      const c = combo.update(state.combo, state.comboLeft);
      comboEl.hidden = !c.visible;
      if (c.visible) {
        if (comboX.textContent !== c.text) comboX.textContent = c.text;
        comboEl.dataset.level = String(c.level);
        comboBar.style.transform = `scaleX(${c.left.toFixed(3)})`;
        if (c.pop) {
          comboEl.classList.remove('pop');
          void comboEl.offsetWidth;
          comboEl.classList.add('pop');
        }
      }
      scoreEl.textContent = phase === 'waiting' ? '' : formatScore(state.teamScore);

      // Top-right: the crew.
      const team = players
        .map(([id, p]) => {
          const status = !p.connected
            ? 'offline'
            : !p.active
              ? phase === 'over' || phase === 'waiting'
                ? ''
                : 'next wave'
              : p.down
                ? 'down'
                : '';
          const cls = ['mate', id === me ? 'me' : '', p.down ? 'down' : '', !p.connected ? 'off' : '']
            .filter(Boolean)
            .join(' ');
          return (
            `<div class="${cls}" data-id="${esc(id)}" data-name="${esc(p.name)}">` +
            `<i style="background:${PALETTE[p.slot % PALETTE.length]}"></i>` +
            `<span class="name">${esc(p.name)}</span>${id === me ? '<span class="tag">(you)</span>' : ''}` +
            (status ? `<span class="tag st">${status}</span>` : '') +
            `<b class="hp"><s style="width:${hp(p)}%"></s></b></div>`
          );
        })
        .join('');
      if (team !== lastTeam) {
        teamEl.innerHTML = team;
        lastTeam = team;
      }

      // Bottom-right: the weapon button.
      const armed =
        !!mine && mine.active && !mine.down && (phase === 'breather' || phase === 'wave' || phase === 'waiting');
      weaponBtn.hidden = !armed;
      if (mine && armed) {
        const w = WEAPONS[mine.weapon] ?? WEAPONS[0]!;
        const ammo = ammoOf(mine, mine.weapon);
        const key = `${w.id}|${ammo}|${state.unlocked}`;
        if (key !== lastWeapon) {
          weaponIcon.textContent = w.icon;
          weaponName.textContent = w.name;
          weaponAmmo.textContent = Number.isFinite(ammo) ? String(ammo) : '∞';
          weaponBtn.dataset.weapon = w.id;
          weaponBtn.classList.toggle('more', state.unlocked > 1);
          lastWeapon = key;
        }
      }

      startBtn.hidden = !(phase === 'waiting' && state.isPrivate);

      if (override) return show(override.title, override.sub);
      switch (phase) {
        case 'waiting': {
          if (state.isPrivate) {
            const code = state.code
              ? `<div>Share this code with your crew</div><div class="code" data-role="code">${esc(state.code)}</div>`
              : '';
            return show('Private room', `${code}<div>Start when everyone is in (up to ${state.maxPlayers}).</div>`);
          }
          return show('Get ready', '');
        }
        case 'breather': {
          if (mine && !mine.active) return show(`Wave ${state.wave}`, 'You spawn in a moment', true);
          const n = Math.max(1, Math.ceil(state.timer));
          const first = state.wave <= 1 ? 'Hold the depot. ' : 'Wave cleared! ';
          return show(`Wave ${state.wave}`, `${first}Next wave in ${n}`, true);
        }
        case 'wave': {
          if (mine && !mine.active) return show('', 'You join at the next breather');
          if (mine?.down)
            return show("You're down", 'Crawl to a teammate: standing next to you for 3 s, they revive you');
          return show('', '');
        }
        case 'over': {
          const rows = [...players]
            .filter(([, p]) => p.active || p.score > 0)
            .sort((a, b) => b[1].score - a[1].score)
            .map(
              ([id, p]) =>
                `<tr class="${id === me ? 'me' : ''}"><td><i style="background:${PALETTE[p.slot % PALETTE.length]}"></i>${esc(p.name)}</td>` +
                `<td>${formatScore(p.score)}</td><td>${p.kills}</td><td>${p.revives}</td></tr>`,
            )
            .join('');
          const table = rows
            ? `<table class="standings"><thead><tr><th></th><th>score</th><th>kills</th><th>revives</th></tr></thead><tbody>${rows}</tbody></table>`
            : '';
          // Your Rally stats from this run (server-written): boards, unlocks, or why they were not kept. A guest's
          // line is there from the start; a signed-in player's waits for the write.
          const line = result && (result !== 'pending' || mine?.guest === false) ? resultLine(result) : null;
          const next = state.isPrivate ? 'Back to the lobby in' : 'Next run in';
          return show(
            'Overrun!',
            `<div class="summary">Wave ${state.reached} · ${formatScore(state.teamScore)} points · ${state.teamKills} kills</div>` +
              table +
              (line ? `<div class="result" data-role="result" data-kind="${line.kind}">${esc(line.text)}</div>` : '') +
              `<div class="next">${next} ${Math.max(1, Math.ceil(state.timer))}</div>`,
            true,
          );
        }
      }
    },
    setMessage(t, s = '') {
      override = t === null ? null : { title: t, sub: esc(s) };
      if (override) show(override.title, override.sub);
    },
    toast(text, kind = 'good') {
      const el = document.createElement('div');
      el.className = `toast ${kind}`;
      el.textContent = text;
      toasts.appendChild(el);
      while (toasts.childElementCount > 3) toasts.firstElementChild?.remove();
      setTimeout(() => el.classList.add('gone'), 1800);
      setTimeout(() => el.remove(), 2400);
    },
    hurt(strength) {
      vignette.style.opacity = String(Math.min(0.85, 0.35 + strength * 0.02));
      vignette.classList.remove('fade');
      void vignette.offsetWidth;
      vignette.classList.add('fade');
    },
    hideHint() {
      hint.classList.add('gone');
    },
    onWeaponButton(fn) {
      weaponBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        fn();
      });
    },
    onStart(fn) {
      startBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        fn();
      });
    },
  };
}
