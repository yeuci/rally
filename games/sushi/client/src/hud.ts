import {
  CLOSE_HOUR,
  DAY_NAMES,
  type Kind,
  MAX_STARS,
  OPEN_HOUR,
  WEEK_DAYS,
  cardById,
  kindName,
  recipeFor,
  type DaySummary,
  type ResultMessage,
  type SushiStateView,
} from '@rally/game-sushi-server';
import { SLOT_COLORS } from './colors.ts';
import type { Icons } from './icons.ts';
import { resultLine } from './result.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The day's name (Overtime after Sunday). */
export function dayName(day: number): string {
  if (day <= WEEK_DAYS) return DAY_NAMES[day - 1] ?? `Day ${day}`;
  return `Overtime ${day - WEEK_DAYS}`;
}

/** The restaurant's clock for a day fraction: 11:00 → 21:00. */
export function clockText(u: number): string {
  const minutes = Math.round((OPEN_HOUR + Math.max(0, Math.min(1, u)) * (CLOSE_HOUR - OPEN_HOUR)) * 60);
  const h = Math.floor(minutes / 60);
  const m = Math.floor((minutes % 60) / 15) * 15;
  return `${h}:${String(m).padStart(2, '0')}`;
}

export const yen = (n: number) => `¥${Math.round(n).toLocaleString('en-US')}`;

/** One short lesson per mechanic, shown the first morning it appears. */
export const LESSONS: Record<string, { title: string; text: string }> = {
  belt: {
    title: 'The belt opens',
    text: 'Fish from a <b>crate</b> → hold to <b>chop</b> on the board → <b>rice</b> from the pot → hold to <b>roll</b> on the mat → tap the <b>plates</b> → set it on the <b>belt</b>. Customers grab what they ordered as it rides past.',
  },
  rolls: {
    title: 'Rolls on the menu',
    text: '<b>Rolls</b>: nori + rice + a filling on the mat. Red plates pay more than white ones.',
  },
  tables: {
    title: 'The dining room opens',
    text: 'Table customers want <b>hot dishes</b>: start a pot, the steamer or the gyoza pan, then carry the dish to their table. <b>Gyoza burns</b> if you leave it!',
  },
  dishes: {
    title: 'Dirty dishes',
    text: 'Eaten plates pile up at the seats: carry them to the <b>sink</b> and hold to <b>wash</b> before the clean plates run out.',
  },
  vip: {
    title: 'A VIP is coming',
    text: 'The <b>VIP</b> orders an omakase: three plates, in order, for a big tip.',
  },
  delivery: {
    title: 'The fish truck',
    text: 'Crates run out today: carry the <b>delivery box</b> from the back door to any crate to restock them all.',
  },
  festival: {
    title: 'Festival Sunday!',
    text: 'The terrace is open and the crowd is the biggest of the week. Keep a star and the week is yours.',
  },
  stale: { title: 'Stale plate', text: 'A plate went <b>stale</b> (grey): pull it off the belt and <b>bin</b> it.' },
  burnt: { title: 'Burnt!', text: 'Burnt gyoza is only good for the <b>bin</b>. Take it out of the pan sooner.' },
  angry: {
    title: 'An angry customer',
    text: 'Every angry exit costs a <b>★</b>. A perfect day wins one back; lose all five and the restaurant closes.',
  },
};

export interface Hud {
  render(st: SushiStateView, me: string, result: ResultMessage | 'pending' | null): void;
  setMessage(title: string | null, sub?: string): void;
  toast(text: string, kind?: 'good' | 'bad' | 'gold'): void;
  /** Show a lesson (once each per session unless `force`). */
  teach(key: string, force?: boolean): void;
  stars(kind: 'hit' | 'gain'): void;
  setAction(label: string, icon: string, progress: number, idle: boolean): void;
  hideHint(): void;
  onStart(fn: () => void): void;
  onVote(fn: (i: number) => void): void;
  setIcons(icons: Icons): void;
  readonly icons: Icons;
}

export function createHud(): Hud {
  const dayEl = $('day-name');
  const clockEl = $('clock');
  const starsEl = $('stars');
  const moneyEl = $('money');
  const tipsEl = $('tips');
  const crewEl = $('crew');
  const toasts = $('toasts');
  const banner = $('banner');
  const bTitle = $('banner-title');
  const bSub = $('banner-sub');
  const teachEl = $('teach');
  const actionEl = $('action');
  const actionIcon = $('action-icon');
  const actionLabel = $('action-label');
  const actionRing = $('action-ring');
  const hint = $('hint');
  const night = $('night');
  const nightTitle = $('night-title');
  const nightStats = $('night-stats');
  const nightSub = $('night-sub');
  const cardsEl = $('cards');
  const nightFoot = $('night-foot');
  const lobby = $('lobby');
  const lobbyCode = $('lobby-code');
  const startBtn = $<HTMLButtonElement>('start');
  let override: { title: string; sub: string } | null = null;
  let icons: Icons = new Map();
  let lastStars = '';
  let lastCrew = '';
  let lastCards = '';
  let lastTitle = '';
  const taught = new Set<string>();
  let teachTimer: ReturnType<typeof setTimeout> | undefined;
  let voteFn: (i: number) => void = () => {};

  cardsEl.addEventListener('click', (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>('.card');
    if (card?.dataset.i) voteFn(Number(card.dataset.i));
  });

  const show = (t: string, s: string) => {
    banner.hidden = t === '' && s === '';
    if (t !== lastTitle) {
      bTitle.textContent = t;
      bTitle.classList.remove('pop');
      void bTitle.offsetWidth;
      bTitle.classList.add('pop');
      lastTitle = t;
    }
    if (bSub.innerHTML !== s) bSub.innerHTML = s;
  };

  const summaryStats = (s: DaySummary) =>
    `<div><b>${s.served}</b>served</div><div><b>${yen(s.earned)}</b>earned</div>` +
    `<div><b>${yen(s.tips)}</b>tips</div><div><b>${s.angry}</b>angry</div><div><b>${s.stale}</b>stale</div>`;

  const hud: Hud = {
    get icons() {
      return icons;
    },
    setIcons(i) {
      icons = i;
    },
    render(st, me, result) {
      const mine = st.players.get(me);
      dayEl.textContent = dayName(st.day);
      clockEl.textContent =
        st.phase === 'morning'
          ? `Opens in ${Math.ceil(st.timer)}`
          : st.phase === 'open'
            ? clockText(st.clock)
            : st.phase === 'closing'
              ? 'Closing…'
              : st.phase === 'lobby'
                ? 'Not open yet'
                : st.phase === 'night'
                  ? 'Night'
                  : 'Closed';
      const starKey = `${st.stars}`;
      if (starKey !== lastStars) {
        starsEl.innerHTML = Array.from(
          { length: MAX_STARS },
          (_, i) => `<i class="${i < st.stars ? '' : 'off'}">★</i>`,
        ).join('');
        lastStars = starKey;
      }
      moneyEl.textContent = yen(st.money);
      tipsEl.textContent = `today ${yen(st.tips)} tips · ${st.served} served`;
      const rows: string[] = [];
      st.players.forEach((p, id) => {
        const cls = ['row', id === me ? 'me' : '', p.connected ? '' : 'off'].filter(Boolean).join(' ');
        rows.push(
          `<div class="${cls}" data-slot="${p.slot}"><i style="background:${SLOT_COLORS[p.slot % 4]}"></i>` +
            `${esc(id === me ? 'You' : p.name)}${p.bot ? ' <span class="tag">BOT</span>' : ''}</div>`,
        );
      });
      const crew = rows.sort().join('');
      if (crew !== lastCrew) {
        crewEl.innerHTML = crew;
        lastCrew = crew;
      }

      // Lobby (private rooms).
      lobby.hidden = !(st.phase === 'lobby' && st.isPrivate);
      if (!lobby.hidden && lobbyCode.textContent !== st.code) lobbyCode.textContent = st.code;

      // The night: the day's summary and the vote; closed: the summary and the run's end.
      const summary = st.summary ? (JSON.parse(st.summary) as DaySummary) : null;
      night.hidden = !((st.phase === 'night' || st.phase === 'over') && summary);
      if (!night.hidden && summary) {
        const closed = st.phase === 'over';
        const week = summary.week;
        nightTitle.textContent = closed
          ? 'The restaurant closed'
          : week
            ? 'You survived the week! 🎏'
            : `${dayName(summary.day)} is done`;
        const stats = summaryStats(summary);
        if (nightStats.innerHTML !== stats) nightStats.innerHTML = stats;
        const line = result && (result !== 'pending' || mine?.guest === false) ? resultLine(result) : null;
        const sub =
          (closed
            ? `You reached ${dayName(summary.day)} with ${yen(st.money)} earned.`
            : summary.perfect
              ? 'A perfect day: no angry customers' + (summary.stars >= MAX_STARS ? '.' : ', a ★ back.')
              : `${summary.angry} angry customer${summary.angry === 1 ? '' : 's'}.`) +
          (line ? ` <span data-role="result" data-kind="${line.kind}">${esc(line.text)}</span>` : '');
        if (nightSub.innerHTML !== sub) nightSub.innerHTML = sub;
        const cards = closed ? [] : st.cards ? st.cards.split(',') : [];
        const votes = new Map<number, string[]>();
        st.players.forEach((p) => {
          if (p.vote >= 0) votes.set(p.vote, [...(votes.get(p.vote) ?? []), SLOT_COLORS[p.slot % 4]!]);
        });
        const myVote = mine?.vote ?? -1;
        const html = cards
          .map((id, i) => {
            const c = cardById(id);
            if (!c) return '';
            const cls = [
              'card',
              c.edge ? 'edge' : '',
              myVote === i ? 'mine' : '',
              st.chosen === i ? 'chosen' : st.chosen >= 0 ? 'lost' : '',
            ]
              .filter(Boolean)
              .join(' ');
            const dots = (votes.get(i) ?? []).map((col) => `<i style="background:${col}"></i>`).join('');
            return (
              `<button class="${cls}" type="button" data-i="${i}" data-card="${c.id}">` +
              `<div class="kind">${c.edge ? 'Double-edged' : c.today ? 'Tomorrow' : 'Upgrade'}</div>` +
              `<h3>${esc(c.title)}</h3><p>${esc(c.text)}</p><div class="votes">${dots}</div></button>`
            );
          })
          .join('');
        if (html !== lastCards) {
          cardsEl.innerHTML = html;
          lastCards = html;
        }
        nightFoot.textContent = closed
          ? `A new run starts in ${Math.max(1, Math.ceil(st.timer))}`
          : st.chosen >= 0
            ? `Tomorrow: ${dayName(st.day + 1)}`
            : `Vote for tonight's upgrade · ${Math.max(1, Math.ceil(st.timer))} s`;
      }

      if (override) return show(override.title, override.sub);
      if (st.phase === 'morning') return show(dayName(st.day), `Doors open in ${Math.ceil(st.timer)}`);
      return show('', '');
    },
    setMessage(t, s = '') {
      override = t === null ? null : { title: t, sub: esc(s) };
      if (override) show(override.title, override.sub);
      else show('', '');
    },
    toast(text, kind = 'good') {
      const el = document.createElement('div');
      el.className = `toast ${kind}`;
      el.textContent = text;
      toasts.appendChild(el);
      while (toasts.childElementCount > 3) toasts.firstElementChild?.remove();
      setTimeout(() => el.classList.add('gone'), 1800);
      setTimeout(() => el.remove(), 2300);
    },
    teach(key, force = false) {
      const l = LESSONS[key];
      if (!l || (taught.has(key) && !force)) return;
      taught.add(key);
      teachEl.innerHTML = `<b>${esc(l.title)}:</b> ${l.text}`;
      teachEl.hidden = false;
      hint.classList.add('gone');
      clearTimeout(teachTimer);
      teachTimer = setTimeout(() => (teachEl.hidden = true), 9000);
    },
    stars(kind) {
      starsEl.classList.remove('hit', 'gain');
      void starsEl.offsetWidth;
      starsEl.classList.add(kind);
    },
    setAction(label, icon, progress, idle) {
      if (actionLabel.textContent !== label) actionLabel.textContent = label;
      if (icon.startsWith('data:')) {
        actionIcon.textContent = '';
        actionIcon.style.backgroundImage = `url(${icon})`;
      } else {
        actionIcon.style.backgroundImage = '';
        if (actionIcon.textContent !== icon) actionIcon.textContent = icon;
      }
      actionRing.style.setProperty('--p', String(Math.round(progress * 100)));
      actionEl.classList.toggle('idle', idle);
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
    onVote(fn) {
      voteFn = fn;
    },
  };
  return hud;
}

// --- labels over the world --------------------------------------------------------------------------------------
export type LabelLayer = ReturnType<typeof createLabels>;

/** Pooled DOM labels keyed by id, positioned each frame (order bubbles, names, progress rings, chips). */
export function createLabels(root: HTMLElement) {
  const live = new Map<string, HTMLElement>();
  const seen = new Set<string>();
  return {
    begin() {
      seen.clear();
    },
    /** The element for `key` (created with `className` on first use), placed at (x, y) CSS px, anchored bottom-centre. */
    get(key: string, className: string, x: number, y: number): HTMLElement {
      let el = live.get(key);
      if (!el) {
        el = document.createElement('div');
        el.className = className;
        root.appendChild(el);
        live.set(key, el);
      }
      seen.add(key);
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
      return el;
    },
    end() {
      for (const [key, el] of live) {
        if (seen.has(key)) continue;
        el.remove();
        live.delete(key);
      }
    },
    /** A one-off rising label (coins, moods) that removes itself. */
    pop(className: string, html: string, x: number, y: number, ms = 1400) {
      const el = document.createElement('div');
      el.className = className;
      el.innerHTML = html;
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
      root.appendChild(el);
      setTimeout(() => el.remove(), ms);
    },
    get size() {
      return live.size;
    },
  };
}

/** Patience colour: green, then amber, then red. */
export function patienceColor(p: number): string {
  return p > 0.55 ? '#5cc46a' : p > 0.28 ? '#f2b324' : '#e0453a';
}

/** An order bubble's inner HTML (dish icons, the recipe hint, the patience bar). */
export function orderHtml(
  icons: Icons,
  orders: readonly Kind[],
  course: number,
  patience: number,
  hints: boolean,
): string {
  const dish = (k: Kind, cls: string) => {
    const url = icons.get(k);
    return url
      ? `<span class="dish ${cls}" style="background-image:url(${url})" title="${esc(kindName(k))}"></span>`
      : `<span class="dish ${cls}" style="font-size:9px;line-height:1.1;color:#3a2414">${esc(kindName(k))}</span>`;
  };
  const dishes = orders
    .map((k, i) => dish(k, orders.length > 1 ? (i < course ? 'done' : i === course ? 'next' : '') : ''))
    .join('');
  const current = orders[course];
  const recipe = hints && current !== undefined ? recipeFor(current) : undefined;
  const hint = recipe?.needs.length
    ? `<div class="recipe">${recipe.needs
        .map((k) => (icons.get(k) ? `<span style="background-image:url(${icons.get(k)})"></span>` : ''))
        .join('')}</div>`
    : '';
  return `<div class="dishes">${dishes}</div>${hint}<div class="bar"><i style="--p:${patience.toFixed(3)}"></i></div>`;
}
