import {
  CUSTOMER_STATES,
  Kind,
  SEATS,
  decodeItem,
  matItems,
  type Action,
  type CustomerState,
  type SeatView,
  type StationView,
  type SushiStateView,
  type Work,
  type WorldView,
} from '@rally/game-sushi-server';

/**
 * The synced state as the shared rules' `WorldView` (interact.ts), so the client highlights exactly the target the
 * server will act on, and labels the button with what a tap or a hold will do.
 */
export function worldOf(st: SushiStateView, beltS = st.beltS): WorldView {
  const owned = new Set(st.owned.split(',').map((s) => s.split(':')[0]));
  const crewStations = st.crew >= 3;
  // Who waits for what, by seat.
  const wants = new Map<number, Kind>();
  st.customers.forEach((c) => {
    if (CUSTOMER_STATES[c.state] !== 'wait') return;
    const k = [c.o0, c.o1, c.o2][c.course] ?? Kind.None;
    wants.set(c.seat, k as Kind);
  });
  return {
    day: st.day,
    zones: st.zones,
    board2: owned.has('board2') || crewStations,
    mat2: owned.has('mat2') || crewStations,
    dishes: st.dishes,
    beltS,
    slot(i) {
      const s = st.slots[i];
      return { item: s ? decodeItem(s.item) : null, stale: s?.stale ?? false };
    },
    station(id): StationView {
      const s = st.stations[id];
      if (!s) return { item: null, mat: [], state: 0, count: 0 };
      return { item: decodeItem(s.item), mat: matItems(s.mat), state: s.state, count: s.count };
    },
    seat(id): SeatView {
      const s = st.seats[id];
      return { open: !!SEATS[id], wants: wants.get(id) ?? Kind.None, dirty: s?.dirty ?? 0 };
    },
  };
}

export const customerState = (code: number): CustomerState => CUSTOMER_STATES[code] ?? 'walkIn';

/** The button's label and icon for what a tap (or a hold) would do. */
export function actionLabel(act: Action | null, work: Work | null): { label: string; icon: string } {
  if (work === 'chop') return { label: 'Chop', icon: '🔪' };
  if (work === 'roll') return { label: 'Roll', icon: '🍣' };
  if (work === 'wash') return { label: 'Wash', icon: '🧽' };
  switch (act) {
    case 'crate':
    case 'take':
    case 'matTake':
    case 'cookTake':
    case 'beltTake':
    case 'dropTake':
      return { label: 'Pick up', icon: '✋' };
    case 'cookStart':
      return { label: 'Cook', icon: '🔥' };
    case 'bus':
      return { label: 'Clear', icon: '🍽️' };
    case 'put':
    case 'matAdd':
      return { label: 'Put', icon: '⬇️' };
    case 'plate':
      return { label: 'Plate', icon: '🍽️' };
    case 'beltPut':
      return { label: 'On belt', icon: '➰' };
    case 'bin':
      return { label: 'Bin', icon: '🗑️' };
    case 'sinkPut':
      return { label: 'Sink', icon: '🚰' };
    case 'serve':
      return { label: 'Serve', icon: '🛎️' };
    case 'restock':
      return { label: 'Restock', icon: '📦' };
  }
  if (work === 'stir') return { label: 'Stir', icon: '🥄' };
  return { label: '', icon: '' };
}
