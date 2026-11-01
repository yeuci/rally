/**
 * Which body animation a fighter shows (pure, unit-tested; characters.ts plays it):
 * - alive: Idle / Run / Run backwards, or Wave for the winner;
 * - a death plays once, from its first frame, and holds its last frame until the respawn;
 * - a respawn (dead → alive) snaps straight into Idle / Run: no blend out of the death pose, no death frames;
 * - someone never seen alive (joined a match under way, waiting to spawn) is not drawn at all: there is no death to
 *   show.
 */
export type BodyState = 'Idle' | 'Run' | 'Back' | 'Death' | 'Wave';

export interface BodyInput {
  alive: boolean;
  /** Ground speed (units/s). */
  speed: number;
  /** Moving against the aim. */
  back: boolean;
  celebrating: boolean;
}

export interface BodyStep {
  /** Hidden: not drawn this frame. */
  visible: boolean;
  state: BodyState;
  /** Change state this frame (with this blend, s; 0 = snap). */
  change: boolean;
  blend: number;
  /** Start the state from its first frame (a new death). */
  restart: boolean;
}

export class BodyPlan {
  private seenAlive = false;
  private wasAlive: boolean | null = null;
  private current: BodyState = 'Idle';

  next(s: BodyInput): BodyStep {
    const died = !s.alive && this.wasAlive === true;
    const respawned = s.alive && this.wasAlive === false;
    this.wasAlive = s.alive;
    if (!s.alive) {
      if (!this.seenAlive) return { visible: false, state: this.current, change: false, blend: 0, restart: false };
      const change = this.current !== 'Death' || died;
      this.current = 'Death';
      return { visible: true, state: 'Death', change, blend: change ? 0.08 : 0, restart: change };
    }
    this.seenAlive = true;
    const want: BodyState = s.celebrating ? 'Wave' : s.speed > 0.3 ? (s.back ? 'Back' : 'Run') : 'Idle';
    const change = want !== this.current || respawned;
    this.current = want;
    // Out of a death (a respawn) there is nothing to blend from: snap.
    return { visible: true, state: want, change, blend: respawned ? 0 : 0.15, restart: respawned };
  }

  get state(): BodyState {
    return this.current;
  }
}
