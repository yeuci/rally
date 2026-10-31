import {
  KILLS_PER_TIER,
  PALETTE,
  TIERS,
  WEAPONS,
  tierWeapon,
  type GunRunPlayerView,
  type GunRunStateView,
  type ResultMessage,
} from '@rally/game-gunrun-server';
import { resultLine } from './result.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Seconds as m:ss. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Players by the ladder (rung, kills on it, kills, fewer deaths, slot), with their session ids. */
export function ladderStandings(state: Pick<GunRunStateView, 'players'>): [string, GunRunPlayerView][] {
  const out: [string, GunRunPlayerView][] = [];
  state.players.forEach((p, id) => out.push([id, p]));
  return out.sort(
    ([, a], [, b]) => b.tier - a.tier || b.tk - a.tk || b.kills - a.kills || a.deaths - b.deaths || a.slot - b.slot,
  );
}

/** "3/9" rungs, and the pips of kills toward the next one (●●○); the knife rung has none. */
export function rungText(p: Pick<GunRunPlayerView, 'tier' | 'tk'>): { rung: string; pips: string } {
  const final = p.tier >= TIERS - 1;
  return {
    rung: `${Math.min(TIERS, p.tier + 1)}/${TIERS}`,
    pips: final ? '' : '●'.repeat(p.tk) + '○'.repeat(Math.max(0, KILLS_PER_TIER - p.tk)),
  };
}

const colorOf = (slot: number) => PALETTE[slot % PALETTE.length]!;

export interface FeedEntry {
  killer: GunRunPlayerView | null;
  victim: GunRunPlayerView;
  /** Index into `WEAPON_IDS`, -1 for a barrel. */
  weapon: number;
  demote: boolean;
}

export interface Hud {
  /**
   * Redraw from the latest state. `me` = our session id; `result`: this player's `result` for the match on screen
   * (`MatchResultView.current()`), shown as one line of the banner.
   */
  render(state: GunRunStateView, me: string, rttMs: number | null, result?: ResultMessage | 'pending' | null): void;
  /** Overrides the computed banner (errors, "Joining…"); null returns to the game's own banner. */
  setMessage(title: string | null, sub?: string): void;
  /** A short notice under the top bar ("Promoted: Shotgun"). */
  toast(text: string, kind?: 'up' | 'good' | 'bad'): void;
  /** A kill in the feed (top right, under the scoreboard). */
  feed(entry: FeedEntry): void;
  /** Red edge flash (you got hurt). */
  hurt(strength: number): void;
  hideHint(): void;
  /** The start button (private rooms) was pressed. */
  onStart(fn: () => void): void;
}

/** DOM HUD: your rung and gun, the clock and the leader, the scoreboard, the kill feed, banners, toasts. */
export function createHud(): Hud {
  const gunIcon = $('gun-icon');
  const gunName = $('gun-name');
  const rungEl = $('rung');
  const pipsEl = $('pips');
  const pingEl = $('ping');
  const clockEl = $('clock');
  const leaderEl = $('leader');
  const boardEl = $('board');
  const feedEl = $('feed');
  const knifeBtn = $('knife');
  const toasts = $('toasts');
  const banner = $('banner');
  const title = $('banner-title');
  const sub = $('banner-sub');
  const startBtn = $<HTMLButtonElement>('start');
  const hint = $('hint');
  const vignette = $('vignette');
  let override: { title: string; sub: string } | null = null;
  let lastTitle = '';
  let lastBoard = '';
  let lastGun = '';

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

  const name = (p: GunRunPlayerView, id: string, me: string) =>
    `<i style="background:${colorOf(p.slot)}"></i><span class="name">${esc(id === me ? 'You' : p.name)}</span>` +
    (p.bot ? '<span class="tag bot">BOT</span>' : '');

  return {
    render(state, me, rttMs, result = null) {
      const standings = ladderStandings(state);
      const mine = state.players.get(me);
      const phase = state.phase;

      // Top-left: your gun and rung.
      if (mine) {
        const w = tierWeapon(mine.tier);
        const r = rungText(mine);
        const key = `${w.id}|${r.rung}|${r.pips}`;
        if (key !== lastGun) {
          gunIcon.textContent = w.icon;
          gunName.textContent = w.name;
          rungEl.textContent = r.rung;
          pipsEl.textContent = r.pips || 'knife kill wins';
          pipsEl.classList.toggle('final', !r.pips);
          lastGun = key;
        }
      }
      pingEl.textContent = rttMs === null ? 'ping —' : `ping ${rttMs} ms`;

      // Top-centre: the clock and who leads.
      clockEl.textContent =
        phase === 'playing'
          ? formatClock(state.timer)
          : phase === 'starting'
            ? 'Get ready'
            : phase === 'over'
              ? 'Match over'
              : state.isPrivate
                ? 'Lobby'
                : 'Warm-up';
      const lead = standings[0];
      leaderEl.innerHTML =
        lead && phase === 'playing' && lead[1].tier > 0
          ? `👑 ${esc(lead[0] === me ? 'You' : lead[1].name)} · ${esc(tierWeapon(lead[1].tier).name)}`
          : '';

      // Top-right: the scoreboard by the ladder.
      const board = standings
        .map(([id, p]) => {
          const w = tierWeapon(p.tier);
          const cls = ['row', id === me ? 'me' : '', !p.alive ? 'dead' : '', !p.connected ? 'off' : '']
            .filter(Boolean)
            .join(' ');
          return (
            `<div class="${cls}" data-id="${esc(id)}" data-name="${esc(p.name)}">${name(p, id, me)}` +
            `<span class="w" title="${esc(w.name)}">${w.icon}</span><b>${p.tier + 1}</b></div>`
          );
        })
        .join('');
      if (board !== lastBoard) {
        boardEl.innerHTML = board;
        lastBoard = board;
      }

      const alive = !!mine?.alive && phase !== 'over';
      knifeBtn.hidden = !alive;
      startBtn.hidden = !(phase === 'waiting' && state.isPrivate);

      if (override) return show(override.title, override.sub);
      switch (phase) {
        case 'waiting': {
          if (state.isPrivate) {
            const code = state.code
              ? `<div>Share this code with your friends</div><div class="code" data-role="code">${esc(state.code)}</div>`
              : '';
            return show('Private room', `${code}<div>Start when everyone is in (2–${state.maxPlayers} players).</div>`);
          }
          return show('Warm-up', 'Waiting for another player…');
        }
        case 'starting':
          return show(
            `${Math.max(1, Math.ceil(state.timer))}`,
            `Every ${KILLS_PER_TIER} kills: the next gun. A knife kill wins.`,
            true,
          );
        case 'playing': {
          if (mine && !mine.alive) {
            const back = (mine.respawn / 10).toFixed(1);
            return show('You died', `Back in ${back} s`);
          }
          return show('', '');
        }
        case 'over': {
          const winner = state.players.get(state.winner);
          const rows = standings
            .map(
              ([id, p], i) =>
                `<tr class="${id === me ? 'me' : ''}${id === state.winner ? ' win' : ''}"><td>${i + 1}</td>` +
                `<td>${name(p, id, me)}</td><td>${tierWeapon(p.tier).icon} ${p.tier + 1}</td><td>${p.kills}</td><td>${p.deaths}</td></tr>`,
            )
            .join('');
          const table = `<table class="standings"><thead><tr><th></th><th></th><th>rung</th><th>kills</th><th>deaths</th></tr></thead><tbody>${rows}</tbody></table>`;
          // Your Rally stats from this match (server-written): boards, unlocks, or why they were not kept. A guest's
          // line is there from the start; a signed-in player's waits for the write.
          const line = result && (result !== 'pending' || mine?.guest === false) ? resultLine(result) : null;
          const t = winner ? (state.winner === me ? 'You win!' : `${winner.name} wins!`) : 'Match over';
          return show(
            t,
            table +
              (line ? `<div class="result" data-role="result" data-kind="${line.kind}">${esc(line.text)}</div>` : '') +
              `<div class="next">Next match in ${Math.max(1, Math.ceil(state.timer))}</div>`,
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
    feed({ killer, victim, weapon, demote }) {
      const el = document.createElement('div');
      el.className = 'kill';
      const who = (p: GunRunPlayerView) =>
        `<span style="color:${colorOf(p.slot)}">${esc(p.name)}</span>${p.bot ? '<span class="tag bot">BOT</span>' : ''}`;
      el.innerHTML =
        (killer && killer !== victim ? `${who(killer)} ` : '') +
        `<b>${weaponIcon(weapon) ?? '•'}</b> ${who(victim)}${demote ? ' <em>⬇</em>' : ''}`;
      feedEl.prepend(el);
      while (feedEl.childElementCount > 4) feedEl.lastElementChild?.remove();
      setTimeout(() => el.classList.add('gone'), 4500);
      setTimeout(() => el.remove(), 5200);
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
    onStart(fn) {
      startBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        fn();
      });
    },
  };
}

const WEAPON_ICONS = Object.values(WEAPONS).map((w) => w.icon);
/** A weapon index (`WEAPON_IDS`) as its icon; -1 = a barrel. */
export function weaponIcon(index: number): string | null {
  return index < 0 ? '🛢️' : (WEAPON_ICONS[index] ?? null);
}
