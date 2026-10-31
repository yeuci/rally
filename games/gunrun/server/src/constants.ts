/**
 * Tuning for Gun Run. Units are "world units" (a player is 0.9 wide); time is in seconds. Simulation axes: x right,
 * y down the screen (towards the camera). Shared by the server (authoritative simulation) and the client (rendering,
 * prediction of the local player's movement, the HUD). The README lists the ones worth tuning.
 */

/** Server simulation rate (fixed timestep). The synced `tick` counts these steps: server time = tick × DT. */
export const TICK_HZ = 30;
/** State patches go out at Colyseus' default 20 Hz on their own timer: a patch carries 1 or 2 ticks. */
export const PATCH_MS = 50;
/** Fixed step in seconds. */
export const DT = 1 / TICK_HZ;

// --- arena -------------------------------------------------------------------------------------------------------
/** The yard spans x ∈ [-ARENA_HALF_W, ARENA_HALF_W], y ∈ [-ARENA_HALF_H, ARENA_HALF_H] (40 × 28 units). */
export const ARENA_HALF_W = 20;
export const ARENA_HALF_H = 14;

// --- players -----------------------------------------------------------------------------------------------------
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
/** Quick-play rooms are topped up with bots to this many players while fewer humans are in. */
export const BOT_FILL = 4;
export const PLAYER_RADIUS = 0.45;
/** Top speed at full stick, units/s. */
export const PLAYER_SPEED = 5.4;
/** Speed multiplier on the knife tier (the classic: the last tier runs faster). */
export const KNIFE_SPEED = 1.15;
/** Velocity response time constant (snappy but not instant). */
export const PLAYER_ACCEL_TAU = 0.07;
export const PLAYER_HP = 100;
/** Seconds dead before respawning. */
export const RESPAWN_TIME = 2;
/** Seconds of invulnerability after a respawn (ends early when you attack). */
export const SPAWN_PROTECTION = 1.5;
/** A player who joins a match under way spawns this long after joining. */
export const JOIN_SPAWN_TIME = 1;

// --- the match ---------------------------------------------------------------------------------------------------
/** "Get ready": everyone spawned, moving, not shooting yet. */
export const STARTING_TIME = 3;
/** The winner banner and scoreboard, then the next match. */
export const OVER_TIME = 10;
/** A match nobody finished is decided by the ladder after this long (an idle room never runs forever). */
export const TIME_LIMIT = 600;
/** Kills on one tier that promote you to the next gun. */
export const KILLS_PER_TIER = 3;

// --- weapons -----------------------------------------------------------------------------------------------------
export type WeaponId = 'pistol' | 'revolver' | 'smg' | 'shotgun' | 'ak' | 'sniper' | 'grenade' | 'rocket' | 'knife';

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  /** HUD and kill feed. */
  icon: string;
  /**
   * `hitscan`: rays, lag-compensated; `rocket`: a straight projectile that bursts on contact; `grenade`: lobbed to
   * where you aim (at most `range` away) and bursts where it lands; `melee`: a stab in an arc in front of you.
   */
  kind: 'hitscan' | 'rocket' | 'grenade' | 'melee';
  /** Seconds between shots. */
  cooldown: number;
  /** Per ray (hitscan), per direct hit (rocket), per stab (melee); the blast's centre damage for explosives. */
  damage: number;
  /** Rays per shot (the shotgun's fan). */
  pellets: number;
  /** Total fan angle of the pellets, radians. */
  spread: number;
  /** Random aim error per ray, ± radians (seeded). */
  jitter: number;
  /** Ray length, the rocket's flight, the grenade's longest throw, the knife's reach. */
  range: number;
  /** Projectiles: ground speed, units/s. */
  speed: number;
  /** Explosives: splash radius. */
  blast: number;
  /** Melee: half the arc in front of you that a stab reaches, radians. */
  arc: number;
}

const gun = (spec: Partial<WeaponSpec> & Pick<WeaponSpec, 'id' | 'name' | 'icon' | 'kind'>): WeaponSpec => ({
  cooldown: 0.3,
  damage: 0,
  pellets: 1,
  spread: 0,
  jitter: 0,
  range: 15,
  speed: 0,
  blast: 0,
  arc: 0,
  ...spec,
});

/** Every weapon by id. Damage is against 100 HP. */
export const WEAPONS: Readonly<Record<WeaponId, WeaponSpec>> = {
  pistol: gun({ id: 'pistol', name: 'Pistol', icon: '🔫', kind: 'hitscan', cooldown: 0.3, damage: 34, jitter: 0.02 }),
  revolver: gun({
    id: 'revolver',
    name: 'Revolver',
    icon: '🤠',
    kind: 'hitscan',
    cooldown: 0.6,
    damage: 55,
    jitter: 0.01,
    range: 18,
  }),
  smg: gun({
    id: 'smg',
    name: 'SMG',
    icon: '💨',
    kind: 'hitscan',
    cooldown: 0.085,
    damage: 13,
    jitter: 0.09,
    range: 12,
  }),
  shotgun: gun({
    id: 'shotgun',
    name: 'Shotgun',
    icon: '💥',
    kind: 'hitscan',
    cooldown: 0.85,
    damage: 17,
    pellets: 7,
    spread: 0.38,
    jitter: 0.04,
    range: 8,
  }),
  ak: gun({
    id: 'ak',
    name: 'Assault rifle',
    icon: '⚡',
    kind: 'hitscan',
    cooldown: 0.12,
    damage: 21,
    jitter: 0.045,
    range: 17,
  }),
  sniper: gun({ id: 'sniper', name: 'Sniper', icon: '🎯', kind: 'hitscan', cooldown: 1.25, damage: 100, range: 32 }),
  grenade: gun({
    id: 'grenade',
    name: 'Grenade launcher',
    icon: '💣',
    kind: 'grenade',
    cooldown: 1,
    damage: 100,
    range: 11,
    speed: 13,
    blast: 2.6,
  }),
  rocket: gun({
    id: 'rocket',
    name: 'Rocket launcher',
    icon: '🚀',
    kind: 'rocket',
    cooldown: 1.1,
    damage: 110,
    range: 26,
    speed: 16,
    blast: 2.4,
  }),
  knife: gun({
    id: 'knife',
    name: 'Knife',
    icon: '🔪',
    kind: 'melee',
    cooldown: 0.45,
    damage: 55,
    range: 1.5,
    arc: 1.05,
  }),
};

/**
 * The ladder: everyone starts on the first gun, `KILLS_PER_TIER` kills promote you to the next, and one kill with the
 * last (the knife) wins the match. Edit freely: any order, any subset (the knife last).
 */
export const LADDER: readonly WeaponId[] = [
  'pistol',
  'revolver',
  'smg',
  'shotgun',
  'ak',
  'sniper',
  'grenade',
  'rocket',
  'knife',
];
export const TIERS = LADDER.length;
export const FINAL_TIER = TIERS - 1;

/** The weapon of tier `t` (clamped to the ladder). */
export function tierWeapon(t: number): WeaponSpec {
  return WEAPONS[LADDER[Math.max(0, Math.min(FINAL_TIER, Math.floor(t)))]!];
}

/** Weapons as wire numbers (effects): the index in this list (`WEAPONS` in declaration order). */
export const WEAPON_IDS = Object.keys(WEAPONS) as readonly WeaponId[];
export const weaponIndex = (id: WeaponId) => WEAPON_IDS.indexOf(id);

/**
 * Everyone carries a knife on every tier (a separate button): a knife kill demotes the victim one tier, the classic
 * rule. On the last tier the knife is the gun.
 */
export const MELEE: WeaponSpec = WEAPONS.knife;
/** Your own blast hurts you this much (and a self-kill costs your progress on the tier). */
export const SELF_DAMAGE = 0.5;

// --- the yard's explosives and pickups -----------------------------------------------------------------------------
export const BARREL_RADIUS = 0.5;
export const BARREL_BLAST = 3.2;
export const BARREL_DAMAGE = 130;
/** A shot barrel goes off this long after (a visible chain through neighbours). */
export const BARREL_FUSE = 0.1;
export const CHAIN_DELAY = 0.15;
/** Seconds before a barrel that went off stands again. */
export const BARREL_RESPAWN = 20;
/** Splash damage keeps this fraction at the blast's edge (full inside 40 % of the radius). */
export const BLAST_EDGE = 0.35;
/** Pickup reach (centre distance) and what a med kit gives. */
export const MED_REACH = 1.0;
export const MED_HEAL = 40;
export const MED_RESPAWN = 15;

// --- lag compensation --------------------------------------------------------------------------------------------
/** Hitscan and stabs rewind the other players at most this far (ms) to what the shooter saw. */
export const MAX_REWIND_MS = 350;
/** Positions kept per player (ticks): more than the rewind limit. */
export const HISTORY_TICKS = 16;

// --- input -------------------------------------------------------------------------------------------------------
/** Clients send at most this many input messages per second (only when something changed). */
export const INPUT_HZ = 20;
/** Server-side ceiling on input messages per second per client; extra messages are dropped. */
export const MAX_INPUTS_PER_SECOND = 30;
/** Move-stick magnitudes below this are treated as zero. */
export const INPUT_DEADZONE = 0.08;

/** Player colours by slot (8: one per seat), worn on each character's main material. */
export const PALETTE = [
  '#ff4d4d',
  '#3d8bff',
  '#ffd23f',
  '#3ddc84',
  '#b56cff',
  '#ff8c2e',
  '#2fe0e0',
  '#ff6fb5',
] as const;

/** Synced position range (16-bit quantized on the wire, ≈0.0008 u). */
export const POS_LIMIT = 25;
/** Synced velocity range. */
export const VEL_LIMIT = 12;
