import {
  AMMO,
  BUILDINGS,
  GUNS,
  ITEMS,
  Item,
  LIFE,
  LOOT_SPOTS,
  MELEE,
  PALETTE,
  PART_SPOTS,
  SAFE,
  TOWN_HALF,
  ESCAPE_FROM_NIGHT,
  TRUCK_FUEL,
  TRUCK_SCRAP,
  TRUCK_WHEELS,
  clockMinutes,
  type NorthdalePlayerView,
  type NorthdaleStateView,
  type ResultMessage,
} from '@rally/game-northdale-server';
import { resultLine } from './result.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Minutes after midnight as a 12-hour clock ("6:00 AM", "11:30 PM"). */
export function formatClock(minutes: number): string {
  const m = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Seconds as m:ss. */
export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The big label of the moment: "Day 2", "Dusk", "Night 3", "Holdout", … and its sub-line. */
export function phaseLabel(st: Pick<NorthdaleStateView, 'phase' | 'day' | 'night' | 'timer' | 'blood' | 'isPrivate'>): {
  title: string;
  sub: string;
  icon: string;
} {
  switch (st.phase) {
    case 'day':
      return { title: `Day ${st.day}`, sub: `Night ${st.night + 1} in ${formatSeconds(st.timer)}`, icon: '☀️' };
    case 'dusk':
      return { title: 'Dusk', sub: `The dead come in ${formatSeconds(st.timer)}`, icon: '🌆' };
    case 'night':
      return {
        title: st.blood ? `Blood Moon · Night ${st.night}` : `Night ${st.night}`,
        sub: `Dawn in ${formatSeconds(st.timer)}`,
        icon: st.blood ? '🌕' : '🌙',
      };
    case 'holdout':
      return { title: 'Hold out!', sub: `The truck warms up: ${formatSeconds(st.timer)}`, icon: '🚚' };
    case 'escape':
      return { title: 'Escape!', sub: 'Through the Northdale gantry', icon: '🚚' };
    case 'over':
      return { title: 'Run over', sub: '', icon: '🏁' };
    default:
      return { title: st.isPrivate ? 'Private room' : 'Safehouse', sub: '', icon: '🏠' };
  }
}

/** The short stat for the host menu's People list ("23 kills", "Downed", "Dead"). */
export function peopleDetail(p: Pick<NorthdalePlayerView, 'life' | 'kills' | 'connected'>): string {
  if (!p.connected) return 'Reconnecting';
  if (p.life === LIFE.down) return 'Downed';
  if (p.life === LIFE.dead) return 'Out until dawn';
  return `${p.kills} kill${p.kills === 1 ? '' : 's'}`;
}

const colorOf = (slot: number) => PALETTE[slot % PALETTE.length]!;
const ammoOf = (p: NorthdalePlayerView, gun: number) => {
  const g = GUNS[gun];
  if (!g) return 0;
  return [p.a0, p.a1, p.a2, p.a3][g.ammo] ?? 0;
};

export interface ContextView {
  label: string;
  /** 0…1 while held. */
  progress: number;
}

export interface Hud {
  render(
    state: NorthdaleStateView,
    me: string,
    ctx: ContextView | null,
    result: ResultMessage | 'pending' | null,
  ): void;
  setMessage(title: string | null, sub?: string): void;
  banner(title: string, sub: string, kind?: 'night' | 'blood' | 'dusk' | 'dawn' | 'good'): void;
  toast(text: string, kind?: 'good' | 'bad' | 'part'): void;
  hurt(strength: number): void;
  ping(x: number, y: number): void;
  hideHint(): void;
  onStart(fn: () => void): void;
  /** Keep the top-left corner clear for the host's game-menu button (CSS px). */
  reserveCorner(width: number, height: number): void;
  setMinimap(on: boolean): void;
}

export function createHud(): Hud {
  const clockEl = $('clock');
  const phaseEl = $('phase');
  const phaseSub = $('phase-sub');
  const phaseIcon = $('phase-icon');
  const hpBar = $('hp-bar');
  const armorBar = $('armor-bar');
  const scrapEl = $('scrap');
  const killsEl = $('kills');
  const gunSlot = $('slot-gun');
  const meleeSlot = $('slot-melee');
  const itemSlots = [$('slot-0'), $('slot-1')];
  const actBtn = $('act');
  const actLabel = $('act-label');
  const actRing = $('act-ring');
  const truckEl = $('truck');
  const teamEl = $('team');
  const toasts = $('toasts');
  const bannerEl = $('banner');
  const bannerTitle = $('banner-title');
  const bannerSub = $('banner-sub');
  const centerEl = $('center');
  const centerTitle = $('center-title');
  const centerSub = $('center-sub');
  const startBtn = $<HTMLButtonElement>('start');
  const hint = $('hint');
  const vignette = $('vignette');
  const minimap = $<HTMLCanvasElement>('minimap');
  const mapCtx = minimap.getContext('2d');
  let override: { title: string; sub: string } | null = null;
  let bannerUntil = 0;
  let lastCenter = '';
  let lastTeam = '';
  let lastTruck = '';
  let lastSlots = '';
  let mapAt = 0;
  const pings: { x: number; y: number; t: number }[] = [];

  // The minimap's town, drawn once: streets light, blocks dark, the safehouse blue.
  const MAP = 132;
  const k = MAP / (TOWN_HALF * 2);
  const mx = (x: number) => (x + TOWN_HALF) * k;
  const base = document.createElement('canvas');
  base.width = base.height = MAP;
  const g = base.getContext('2d');
  if (g) {
    g.fillStyle = 'rgba(70,72,80,0.9)';
    g.fillRect(0, 0, MAP, MAP);
    g.fillStyle = 'rgba(22,24,30,0.95)';
    for (const b of BUILDINGS) g.fillRect(mx(b.x0), mx(b.y0), (b.x1 - b.x0) * k, (b.y1 - b.y0) * k);
    g.fillStyle = 'rgba(80,150,230,0.75)';
    g.fillRect(mx(SAFE.x0), mx(SAFE.y0), (SAFE.x1 - SAFE.x0) * k, (SAFE.y1 - SAFE.y0) * k);
    g.fillStyle = 'rgba(160,110,240,0.9)';
    for (const s of LOOT_SPOTS) if (s.kind === 'special') g.fillRect(mx(s.x) - 1, mx(s.y) - 1, 2.5, 2.5);
  }

  function center(t: string, s: string) {
    const key = `${t}|${s}`;
    if (key === lastCenter) return;
    lastCenter = key;
    centerEl.hidden = t === '' && s === '';
    centerTitle.textContent = t;
    centerSub.innerHTML = s;
  }

  const slotHtml = (icon: string, name: string, meta: string, bar?: number) =>
    `<span class="icon">${icon}</span><span class="txt"><b>${esc(name)}</b><i>${meta}</i></span>` +
    (bar === undefined ? '' : `<span class="bar"><s style="width:${Math.round(bar * 100)}%"></s></span>`);

  return {
    render(st, me, ctx, result) {
      const mine = st.players.get(me);
      const now = performance.now();
      // Clock and the phase.
      const progress = st.length > 0 ? 1 - st.timer / st.length : 0;
      const label = phaseLabel(st);
      phaseEl.textContent = label.title;
      phaseIcon.textContent = label.icon;
      phaseSub.textContent = label.sub;
      clockEl.textContent = ['day', 'dusk', 'night'].includes(st.phase)
        ? formatClock(clockMinutes(st.phase, progress))
        : '';
      document.body.classList.toggle('is-night', st.phase === 'night' || st.phase === 'holdout');
      document.body.classList.toggle('is-blood', st.blood && st.phase === 'night');
      // You.
      if (mine) {
        hpBar.style.width = `${mine.life === LIFE.alive ? mine.hp : 0}%`;
        armorBar.style.width = `${Math.min(100, (mine.armor / 60) * 100)}%`;
        scrapEl.textContent = `${st.scrap}`;
        killsEl.textContent = `${mine.kills}`;
        const gun = ITEMS[mine.gun];
        const melee = ITEMS[mine.melee];
        const spec = MELEE[mine.melee];
        const ammo = ammoOf(mine, mine.gun);
        const slotsKey = `${mine.gun}|${ammo}|${mine.melee}|${mine.dur}|${mine.i0}|${mine.i1}|${mine.carry}`;
        if (slotsKey !== lastSlots) {
          lastSlots = slotsKey;
          gunSlot.innerHTML = gun
            ? slotHtml(gun.icon, gun.name, `${ammo} <small>${AMMO[GUNS[mine.gun]!.ammo]!.name}</small>`)
            : slotHtml('✋', 'No gun', '—');
          gunSlot.classList.toggle('empty', !gun || ammo === 0);
          meleeSlot.innerHTML =
            melee && spec
              ? slotHtml(melee.icon, melee.name, `${mine.dur} swings`, mine.dur / spec.durability)
              : slotHtml('👊', 'Fists', '');
          [mine.i0, mine.i1].forEach((code, i) => {
            const it = ITEMS[code];
            itemSlots[i]!.innerHTML = it
              ? `<span class="icon">${it.icon}</span><i>${esc(it.name)}</i>`
              : '<i class="none">empty</i>';
            itemSlots[i]!.classList.toggle('filled', !!it);
          });
          document.body.classList.toggle('carrying', mine.carry !== Item.none);
        }
      }
      // The context button.
      if (ctx && mine && mine.life !== LIFE.dead) {
        actBtn.hidden = false;
        if (actLabel.textContent !== ctx.label) actLabel.textContent = ctx.label;
        actRing.style.setProperty('--p', `${Math.round(ctx.progress * 360)}deg`);
      } else {
        actBtn.hidden = true;
      }
      // The truck checklist.
      const truck =
        `<b>🚚 Truck</b><span class="${st.wheels >= TRUCK_WHEELS ? 'done' : ''}">🛞 ${st.wheels}/${TRUCK_WHEELS}</span>` +
        `<span class="${st.fuel >= TRUCK_FUEL ? 'done' : ''}">🛢️ ${st.fuel}/${TRUCK_FUEL}</span>` +
        `<span class="${st.truckScrap >= TRUCK_SCRAP ? 'done' : ''}">🔩 ${st.truckScrap}/${TRUCK_SCRAP}</span>` +
        (st.phase === 'holdout'
          ? '<em>Warming up: hold out!</em>'
          : st.phase === 'escape'
            ? '<em>On the road!</em>'
            : st.wheels >= TRUCK_WHEELS && st.fuel >= TRUCK_FUEL && st.truckScrap >= TRUCK_SCRAP
              ? st.night >= ESCAPE_FROM_NIGHT
                ? '<em>Ready: start it!</em>'
                : `<em>Ready from night ${ESCAPE_FROM_NIGHT}</em>`
              : '');
      if (truck !== lastTruck) {
        truckEl.innerHTML = truck;
        lastTruck = truck;
      }
      // Teammates.
      const team: string[] = [];
      st.players.forEach((p, id) => {
        if (id === me) return;
        const state = p.life === LIFE.down ? '<em>DOWN</em>' : p.life === LIFE.dead ? '<em>OUT</em>' : '';
        team.push(
          `<div class="mate${p.connected ? '' : ' off'}"><i style="background:${colorOf(p.slot)}"></i>${esc(p.name)} ${state}` +
            `<span class="hp"><s style="width:${p.life === LIFE.alive ? p.hp : 0}%"></s></span></div>`,
        );
      });
      const teamHtml = team.join('');
      if (teamHtml !== lastTeam) {
        teamEl.innerHTML = teamHtml;
        lastTeam = teamHtml;
      }
      // Minimap (5 times a second).
      if (mapCtx && now - mapAt > 200) {
        mapAt = now;
        mapCtx.clearRect(0, 0, MAP, MAP);
        mapCtx.drawImage(base, 0, 0);
        // Truck parts still out in town.
        st.pickups.forEach((pk) => {
          if (pk.kind === Item.wheel || pk.kind === Item.fuel) {
            mapCtx.fillStyle = '#ffc23f';
            mapCtx.beginPath();
            mapCtx.arc(mx(pk.x), mx(pk.y), 2.6, 0, Math.PI * 2);
            mapCtx.fill();
          }
        });
        void PART_SPOTS;
        if (st.dogState > 0 || (mine && Math.hypot(mine.x - st.dogX, mine.y - st.dogY) < 40)) {
          mapCtx.fillStyle = '#d9a066';
          mapCtx.fillRect(mx(st.dogX) - 2, mx(st.dogY) - 2, 4, 4);
        }
        for (let i = pings.length - 1; i >= 0; i--) {
          const p = pings[i]!;
          const age = (now - p.t) / 1000;
          if (age > 2.5) {
            pings.splice(i, 1);
            continue;
          }
          mapCtx.strokeStyle = `rgba(255,70,60,${1 - age / 2.5})`;
          mapCtx.lineWidth = 2;
          mapCtx.beginPath();
          mapCtx.arc(mx(p.x), mx(p.y), 3 + age * 6, 0, Math.PI * 2);
          mapCtx.stroke();
        }
        st.players.forEach((p, id) => {
          if (p.life === LIFE.dead) return;
          mapCtx.fillStyle = id === me ? '#ffffff' : colorOf(p.slot);
          mapCtx.beginPath();
          mapCtx.arc(mx(p.x), mx(p.y), id === me ? 3.4 : 2.8, 0, Math.PI * 2);
          mapCtx.fill();
        });
      }

      startBtn.hidden = !(st.phase === 'waiting' && st.isPrivate);
      if (now < bannerUntil) bannerEl.hidden = false;
      else bannerEl.hidden = true;
      if (override) return center(override.title, override.sub);
      if (st.phase === 'waiting' && st.isPrivate) {
        const code = st.code
          ? `<div>Share this code with your friends</div><div class="code" data-role="code">${esc(st.code)}</div>`
          : '';
        return center('Private room', `${code}<div>Start when everyone is in (1–${st.maxPlayers} survivors).</div>`);
      }
      if (st.phase === 'over') {
        const rows: string[] = [];
        const list: [string, NorthdalePlayerView][] = [];
        st.players.forEach((p, id) => list.push([id, p]));
        list.sort((a, b) => b[1].kills - a[1].kills);
        for (const [id, p] of list) {
          rows.push(
            `<tr class="${id === me ? 'me' : ''}"><td><i style="background:${colorOf(p.slot)}"></i>${esc(id === me ? 'You' : p.name)}</td><td>${p.kills}</td></tr>`,
          );
        }
        const line = result && (result !== 'pending' || mine?.guest === false) ? resultLine(result) : null;
        const escaped = st.truckY < -TOWN_HALF;
        const title = escaped
          ? 'You escaped Northdale!'
          : st.nights > 0
            ? `Overrun after ${st.nights} night${st.nights === 1 ? '' : 's'}`
            : 'Overrun';
        return center(
          title,
          `<div class="stats">Nights survived <b>${st.nights}</b> · Zombies killed <b>${st.kills}</b></div>` +
            `<table class="standings"><thead><tr><th></th><th>kills</th></tr></thead><tbody>${rows.join('')}</tbody></table>` +
            (line ? `<div class="result" data-role="result" data-kind="${line.kind}">${esc(line.text)}</div>` : '') +
            `<div class="next">Next run in ${Math.max(1, Math.ceil(st.timer))}</div>`,
        );
      }
      if (mine && mine.life === LIFE.down) {
        return center(
          "You're down",
          mine.wind
            ? 'Hold ✋ to get up (second wind)'
            : `A teammate can revive you · bleeding out in ${Math.max(0, 40 - mine.downFor)} s`,
        );
      }
      if (mine && mine.life === LIFE.dead)
        return center('Out until dawn', 'You come back at the safehouse when the sun rises');
      return center('', '');
    },
    setMessage(t, s = '') {
      override = t === null ? null : { title: t, sub: esc(s) };
      if (override) center(override.title, override.sub);
    },
    banner(title, sub, kind = 'good') {
      bannerTitle.textContent = title;
      bannerSub.textContent = sub;
      bannerEl.className = `banner ${kind}`;
      bannerEl.hidden = false;
      void bannerEl.offsetWidth;
      bannerEl.classList.add('pop');
      bannerUntil = performance.now() + 3200;
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
    ping(x, y) {
      pings.push({ x, y, t: performance.now() });
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
    reserveCorner(width, height) {
      document.documentElement.style.setProperty('--menu-w', `${Math.round(width)}px`);
      document.documentElement.style.setProperty('--menu-h', `${Math.round(height)}px`);
    },
    setMinimap(on) {
      minimap.hidden = !on;
    },
  };
}
