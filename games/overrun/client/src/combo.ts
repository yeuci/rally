/** The combo readout top-centre (pure, unit-tested): what to show for the synced `combo` / `comboLeft`. */
export interface ComboView {
  visible: boolean;
  /** "x3". */
  text: string;
  /** Window left, 0…1 (the draining bar). */
  left: number;
  /** 0…3: colour steps (x2–3, x4–5, x6–7, x8). */
  level: number;
  /** The multiplier went up since the last frame (replay the pop animation). */
  pop: boolean;
}

export class ComboDisplay {
  private last = 1;

  /** Feed the synced values every frame. */
  update(combo: number, comboLeft: number): ComboView {
    const m = Math.max(1, Math.min(8, Math.floor(combo)));
    const pop = m > this.last && m >= 2;
    this.last = m;
    if (m < 2) return { visible: false, text: '', left: 0, level: 0, pop: false };
    return {
      visible: true,
      text: `x${m}`,
      left: Math.max(0, Math.min(1, comboLeft / 100)),
      level: m >= 8 ? 3 : m >= 6 ? 2 : m >= 4 ? 1 : 0,
      pop,
    };
  }
}

/** Team score with thin spaces as thousands separators ("12 340"). */
export function formatScore(n: number): string {
  return Math.max(0, Math.floor(n))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
