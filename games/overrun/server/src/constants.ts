/**
 * Tuning for Overrun. Units are "world units" (a player is 0.9 wide); time is in seconds. Simulation axes: x right,
 * y down the screen (towards the camera). Shared by the server (authoritative simulation) and the client (rendering,
 * prediction of the local player's movement). The README lists the ones worth tuning.
 */

/** Server simulation rate (fixed timestep). The synced `tick` counts these steps: server time = tick × DT. */
export const TICK_HZ = 30;
/** State patches go out at Colyseus' default 20 Hz on their own timer: a patch carries 1 or 2 ticks. */
export const PATCH_MS = 50;
/** Fixed step in seconds. */
export const DT = 1 / TICK_HZ;

// --- arena ---------------------------------------------------------------------------------------------------
/** The arena spans x ∈ [-ARENA_HALF_W, ARENA_HALF_W], y ∈ [-ARENA_HALF_H, ARENA_HALF_H] (48 × 32 units). */
export const ARENA_HALF_W = 24;
export const ARENA_HALF_H = 16;
/** Flow-field cell size (a 48 × 32 grid). */
export const FLOW_CELL = 1;
/** Ticks between flow-field recomputations (5 Hz). */
export const FLOW_TICKS = 6;

// --- players ---------------------------------------------------------------------------------------------------
export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 4;
export const PLAYER_RADIUS = 0.45;
/** Top speed at full stick, units/s. */
export const PLAYER_SPEED = 5.2;
/** Crawling speed while down. */
export const DOWN_SPEED = 0.9;
/** Velocity response time constant (snappy but not instant). */
export const PLAYER_ACCEL_TAU = 0.07;
export const PLAYER_HP = 100;
/** A teammate within this distance of a downed player revives them... */
export const REVIVE_RADIUS = 1.6;
/** ...after standing there this long (progress drains twice as fast when they step away). */
export const REVIVE_TIME = 3;
/** HP after a revive (and the "second wind" when a wave is cleared). */
export const REVIVE_HP = 50;

// --- scoring -----------------------------------------------------------------------------------------------------
/** Kills within this many seconds of the previous team kill grow the combo. */
export const COMBO_WINDOW = 1.5;
/** The multiplier is the chain length, capped here (x1 … x8). */
export const MAX_COMBO = 8;
/** Points per kill before the multiplier. */
export const KILL_POINTS = 10;

// --- zombies -------------------------------------------------------------------------------------------------
export const MAX_ALIVE_ZOMBIES = 120;
/** Zombie kinds (the synced `kind`). */
export const ZombieKind = { walker: 0, brute: 1, spitter: 2 } as const;
export type ZombieKind = (typeof ZombieKind)[keyof typeof ZombieKind];

export interface ZombieSpec {
  name: string;
  hp: number;
  /** Base speed, units/s (scaled by the wave's speed multiplier). */
  speed: number;
  radius: number;
  /** Melee damage per hit. */
  damage: number;
  attackCooldown: number;
  /** 0 = full knockback, 1 = immovable. */
  knockResist: number;
  /** Separation weight against other zombies (heavier zombies shove lighter ones). */
  mass: number;
}

export const ZOMBIES: readonly ZombieSpec[] = [
  { name: 'shambler', hp: 100, speed: 2.1, radius: 0.42, damage: 10, attackCooldown: 0.9, knockResist: 0, mass: 1 },
  { name: 'brute', hp: 600, speed: 1.45, radius: 0.75, damage: 24, attackCooldown: 1.2, knockResist: 0.85, mass: 5 },
  { name: 'spitter', hp: 70, speed: 2.3, radius: 0.42, damage: 6, attackCooldown: 1.0, knockResist: 0, mass: 1 },
];

/** Spitters keep between these distances from their target when they can see it. */
export const SPIT_KEEP_MIN = 5.5;
export const SPIT_KEEP_MAX = 9;
export const SPIT_RANGE = 11;
export const SPIT_COOLDOWN = 2.6;
/** Ground speed of a spit glob (slow enough to step out of its landing ring). */
export const SPIT_SPEED = 6;
export const SPIT_DAMAGE = 14;
/** Splash radius where it lands. */
export const SPIT_RADIUS = 1.0;
/** Peak height of the lob. */
export const SPIT_APEX = 2.4;
/** A zombie this close (centre distance minus both radii) to a standing player hits them. */
export const MELEE_REACH = 0.3;

// --- waves -------------------------------------------------------------------------------------------------------
/** Seconds of quiet between waves ("Wave N" banner). */
export const BREATHER_TIME = 5;
/** The first breather of a run (time for friends to drop in). */
export const FIRST_BREATHER_TIME = 6;
/** Seconds the run-over screen stays up before the next run. */
export const RUN_OVER_TIME = 10;
/** Waves from which brutes / spitters join the mix. */
export const BRUTE_FROM_WAVE = 4;
export const SPITTER_FROM_WAVE = 6;

export interface WaveSpec {
  /** Zombies in the wave, all kinds (8 + 5N). */
  total: number;
  brutes: number;
  spitters: number;
  /** Speed multiplier (+4 % per wave, capped at +40 %). */
  speedMul: number;
  /** HP multiplier (+6 % per wave, capped at 2.5×). */
  hpMul: number;
  /** Seconds between two spawns. */
  spawnInterval: number;
}

/** The wave curve. */
export function waveSpec(wave: number): WaveSpec {
  const n = Math.max(1, Math.floor(wave));
  const total = 8 + 5 * n;
  const brutes = n >= BRUTE_FROM_WAVE ? 1 + Math.floor((n - BRUTE_FROM_WAVE) / 2) : 0;
  const spitters = n >= SPITTER_FROM_WAVE ? 2 + Math.floor((n - SPITTER_FROM_WAVE) / 2) : 0;
  return {
    total,
    brutes: Math.min(brutes, Math.floor(total / 4)),
    spitters: Math.min(spitters, Math.floor(total / 4)),
    speedMul: Math.min(1.4, 1 + 0.04 * (n - 1)),
    hpMul: Math.min(2.5, 1 + 0.06 * (n - 1)),
    spawnInterval: Math.max(0.12, 0.6 - 0.04 * n),
  };
}

// --- weapons -----------------------------------------------------------------------------------------------------
export interface WeaponSpec {
  id: 'pistol' | 'uzi' | 'shotgun' | 'barrel' | 'mine';
  name: string;
  /** `gun`: hitscan rays; `place`: drops an explosive at your feet. */
  kind: 'gun' | 'place';
  /** Seconds between shots / placements. */
  cooldown: number;
  /** Damage per ray. */
  damage: number;
  /** Rays per shot (shotgun pellets). */
  pellets: number;
  /** Total fan angle of the pellets, radians. */
  spread: number;
  /** Random aim error per ray, ± radians (seeded). */
  jitter: number;
  range: number;
  /** Knockback speed given to a zombie per hit, units/s. */
  knock: number;
  /** Team kills that unlock the weapon (0 = always). */
  unlockKills: number;
  /** Ammo everyone gets when it unlocks (and at a respawn), and per ammo pickup. Pistol: infinite. */
  startAmmo: number;
  pickupAmmo: number;
  maxAmmo: number;
  icon: string;
}

export const WEAPONS: readonly WeaponSpec[] = [
  {
    id: 'pistol',
    name: 'Pistol',
    kind: 'gun',
    cooldown: 0.28,
    damage: 34,
    pellets: 1,
    spread: 0,
    jitter: 0.015,
    range: 15,
    knock: 2.4,
    unlockKills: 0,
    startAmmo: Infinity,
    pickupAmmo: 0,
    maxAmmo: Infinity,
    icon: '🔫',
  },
  {
    id: 'uzi',
    name: 'Uzi',
    kind: 'gun',
    cooldown: 0.085,
    damage: 17,
    pellets: 1,
    spread: 0,
    jitter: 0.07,
    range: 13,
    knock: 1.2,
    unlockKills: 20,
    startAmmo: 150,
    pickupAmmo: 90,
    maxAmmo: 400,
    icon: '⚡',
  },
  {
    id: 'shotgun',
    name: 'Shotgun',
    kind: 'gun',
    cooldown: 0.75,
    damage: 30,
    pellets: 5,
    spread: 0.44,
    jitter: 0.03,
    range: 9,
    knock: 3.6,
    unlockKills: 50,
    startAmmo: 20,
    pickupAmmo: 12,
    maxAmmo: 60,
    icon: '💢',
  },
  {
    id: 'barrel',
    name: 'Barrel',
    kind: 'place',
    cooldown: 0.6,
    damage: 0,
    pellets: 0,
    spread: 0,
    jitter: 0,
    range: 0,
    knock: 0,
    unlockKills: 90,
    startAmmo: 3,
    pickupAmmo: 2,
    maxAmmo: 8,
    icon: '🛢️',
  },
  {
    id: 'mine',
    name: 'Mine',
    kind: 'place',
    cooldown: 0.5,
    damage: 0,
    pellets: 0,
    spread: 0,
    jitter: 0,
    range: 0,
    knock: 0,
    unlockKills: 140,
    startAmmo: 4,
    pickupAmmo: 3,
    maxAmmo: 10,
    icon: '✴️',
  },
];
export const WEAPON_COUNT = WEAPONS.length;

// --- explosives --------------------------------------------------------------------------------------------------
export const ExplosiveKind = { barrel: 0, mine: 1 } as const;
export type ExplosiveKind = (typeof ExplosiveKind)[keyof typeof ExplosiveKind];
/** Barrels are solid for zombies and bullets (a bullet sets them off). */
export const BARREL_RADIUS = 0.45;
export const BARREL_BLAST_RADIUS = 3.6;
export const BARREL_DAMAGE = 280;
export const MINE_RADIUS = 0.35;
export const MINE_BLAST_RADIUS = 3;
export const MINE_DAMAGE = 220;
/** A mine arms this long after it is placed, then a zombie within reach sets it off. */
export const MINE_ARM_TIME = 0.6;
export const MINE_TRIGGER_REACH = 0.5;
/** An explosion sets off other explosives in its radius after this delay (a visible chain). */
export const CHAIN_DELAY = 0.14;
/** Knockback at the centre of a blast, units/s. */
export const BLAST_KNOCK = 9;
/** Explosives on the map at once (placing more is refused). */
export const MAX_EXPLOSIVES = 20;

// --- pickups -----------------------------------------------------------------------------------------------------
/** Pickup kinds: 0 = health, 1…4 = ammo for that weapon index. */
export const PICKUP_HEALTH = 0;
export const PICKUP_RADIUS = 1.0;
export const PICKUP_TTL = 20;
export const MAX_PICKUPS = 12;
/** Chance per kill of an ammo drop (for a random unlocked weapon other than the pistol) and of a health drop. */
export const AMMO_DROP_CHANCE = 0.12;
export const HEALTH_DROP_CHANCE = 0.035;
export const HEALTH_PICKUP_HP = 30;

// --- input -------------------------------------------------------------------------------------------------------
/** Clients send at most this many input messages per second (only when something changed). */
export const INPUT_HZ = 20;
/** Server-side ceiling on input messages per second per client; extra messages are dropped. */
export const MAX_INPUTS_PER_SECOND = 30;
/** Move-stick magnitudes below this are treated as zero. */
export const INPUT_DEADZONE = 0.08;

/** Player colours, by slot. */
export const PALETTE = ['#ff5a5f', '#3fa7ff', '#ffc23f', '#46d37a'] as const;

/** Synced position range (16-bit quantized on the wire, ≈0.0008 u). */
export const POS_LIMIT = 25;
/** Synced velocity range. */
export const VEL_LIMIT = 12;
