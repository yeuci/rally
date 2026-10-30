import {
  MATCH_TIME_LIMIT,
  PALETTE,
  WINS_TO_MATCH,
  type SumoPlayerView,
  type SumoStateView,
} from '@rally/game-sumo-server';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface Hud {
  /** Redraw from the latest state. `me` = our session id. */
  render(state: SumoStateView, me: string, rttMs: number | null): void;
  /** Overrides the computed banner (errors, "Joining…"); null returns to the game's own banner. */
  setMessage(title: string | null, sub?: string): void;
  /** Big, animated one-shot title (GO!). */
  flashTitle(text: string, ms: number): void;
  hideHint(): void;
}

function pips(score: number): string {
  const n = Math.max(WINS_TO_MATCH, score);
  return '●'.repeat(score) + '○'.repeat(Math.max(0, n - score));
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** DOM HUD: score strip with names and colours, round/clock/ping, centre banner, per-puck name labels (in main). */
export function createHud(): Hud {
  const scoresEl = $('scores');
  const roundEl = $('round');
  const clockEl = $('clock');
  const pingEl = $('ping');
  const banner = $('banner');
  const title = $('banner-title');
  const sub = $('banner-sub');
  const hint = $('hint');
  let override: { title: string; sub: string } | null = null;
  let flash: { text: string; until: number } | null = null;
  let lastTitle = '';
  let lastScores = '';

  /** `t` is plain text; `s` is HTML built from escaped parts. */
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

  return {
    render(state, me, rttMs) {
      const players: [string, SumoPlayerView][] = [];
      state.players.forEach((p, id) => players.push([id, p]));
      players.sort((a, b) => b[1].score - a[1].score || a[1].color - b[1].color);

      // Score strip (rebuilt only when something visible changed).
      const playing = state.phase === 'playing' || state.phase === 'roundOver';
      const html = players
        .map(([id, p]) => {
          const cls = [
            'chip',
            id === me ? 'me' : '',
            playing && p.inRound && !p.alive ? 'out' : '',
            !p.connected ? 'off' : '',
            state.phase !== 'waiting' && !p.inRound ? 'spec' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return `<div class="${cls}" data-id="${esc(id)}" data-name="${esc(p.name)}"><i style="background:${PALETTE[p.color % PALETTE.length]}"></i><span class="name">${esc(p.name)}${id === me ? ' (you)' : ''}</span>${state.phase === 'waiting' ? '' : `<span class="pips">${pips(p.score)}</span>`}</div>`;
        })
        .join('');
      if (html !== lastScores) {
        scoresEl.innerHTML = html;
        lastScores = html;
      }

      roundEl.textContent = state.round > 0 ? `Round ${state.round}` : `${players.length}/${state.maxPlayers}`;
      const left = Math.max(0, MATCH_TIME_LIMIT - state.matchTime);
      clockEl.textContent =
        state.round > 0 ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}` : '';
      pingEl.textContent = rttMs === null ? 'ping —' : `ping ${rttMs} ms`;

      if (override) return show(override.title, override.sub);
      const now = performance.now();
      if (flash && now < flash.until) return show(flash.text, '', true);
      flash = null;

      const mine = state.players.get(me);
      const name = (id: string) => (id === me ? 'You' : (state.players.get(id)?.name ?? 'Someone'));
      switch (state.phase) {
        case 'waiting': {
          const code = state.code
            ? `<div>Share this code with a friend</div><div class="code" data-role="code">${esc(state.code)}</div>`
            : '<div>Open Sumo on another phone or tab to play</div>';
          return show('Waiting for players', code);
        }
        case 'countdown':
          return show(
            String(Math.max(1, Math.ceil(state.timer))),
            `Round ${state.round} · first to ${WINS_TO_MATCH}`,
            true,
          );
        case 'playing':
          if (mine && mine.inRound && !mine.alive) return show("You're out", 'Watch the rest of the round');
          if (mine && !mine.inRound) return show('', 'You join next round');
          return show('', '');
        case 'roundOver': {
          const w = state.roundWinner;
          if (!w) return show('Draw', 'Nobody stayed on');
          return show(w === me ? 'You win the round!' : `${name(w)} wins the round`, '');
        }
        case 'matchOver': {
          const w = state.matchWinner;
          const next = `Next match in ${Math.max(1, Math.ceil(state.timer))}`;
          if (!w) return show('Match over', next);
          return show(w === me ? 'You win!' : `${name(w)} wins the match`, next, w === me);
        }
      }
    },
    setMessage(t, s = '') {
      override = t === null ? null : { title: t, sub: esc(s) };
      if (override) show(override.title, override.sub);
    },
    flashTitle(text, ms) {
      flash = { text, until: performance.now() + ms };
    },
    hideHint() {
      hint.classList.add('gone');
    },
  };
}
