/**
 * Every gameplay number of Northdale, in one place, with what each curve does (README "Tuning" mirrors the tables).
 * Shared by the server (the authoritative rules) and the client (HUD, labels, prediction). Units: world units (a
 * survivor is ≈ 1.6 tall), seconds, HP.
 *
 * The rhythm of a run: Day (scavenge) → Dusk (a 20 s warning) → Night N (the horde) → Dawn (heal, revive, respawn,
 * restock) → Day … From Night 4 a repaired truck can be started: a 60 s holdout, then the drive out through the
 * Northdale gantry wins the run. Or keep going for the nights-survived record.
 */

// =================================================================================================================
// The day/night cycle
// =================================================================================================================

/** Seconds of daylight: few, slow shamblers; the time to roam and loot. */
export const DAY_TIME = 150;
/** The first day is shorter: the group starts at the safehouse with little to do but go out. */
export const FIRST_DAY_TIME = 120;
/** Seconds of dusk: the sky shifts, the street lights flicker on, the siren and banner warn of the night. */
export const DUSK_TIME = 20;
/** Seconds of night: the horde spawns at the edges of what you can see and converges on you and the safehouse. */
export const NIGHT_TIME = 105;
/** Every this-many-th night is a Blood Moon (red sky, a double horde at the next night's strength). */
export const BLOOD_MOON_EVERY = 5;

/**
 * The clock the HUD shows, in minutes after midnight, for a phase and how far into it (0…1): the day runs 6:00 → 18:00,
 * dusk 18:00 → 19:30, the night 19:30 → 5:30 (wrapping past midnight). The holdout and escape keep the time they
 * started at.
 */
export function clockMinutes(phase: string, progress: number): number {
  const u = Math.max(0, Math.min(1, progress));
  switch (phase) {
    case 'day':
      return 6 * 60 + u * 12 * 60;
    case 'dusk':
      return 18 * 60 + u * 90;
    case 'night':
      return (19.5 * 60 + u * 10 * 60) % (24 * 60);
    default:
      return 12 * 60;
  }
}

// =================================================================================================================
// The night-strength curve: monsters get stronger every night
// =================================================================================================================

/** Multipliers on a zombie kind's base stats (`ZOMBIES`). */
export interface Strength {
  hp: number;
  damage: number;
  speed: number;
}

/** Night n's zombie HP grows linearly: +22 % per night (night 1 ×1, night 5 ×1.88, night 10 ×2.98). */
export const HP_PER_NIGHT = 0.22;
/** Damage grows more gently: +12 % per night (night 5 ×1.48), so a hit never becomes a one-shot. */
export const DAMAGE_PER_NIGHT = 0.12;
/** Speed: +4 % per night… */
export const SPEED_PER_NIGHT = 0.04;
/** …capped at +30 % (reached on night 9): faster still and a survivor could no longer outrun a basic zombie. */
export const SPEED_CAP = 0.3;
/** Day zombies follow the same curve at this rate (half): the day stays a breather, but day 6 is not day 1. */
export const DAY_RATE = 0.5;

/**
 * Night `n`'s strength (n ≥ 1, fractional allowed for the day rate):
 *   hp = 1 + 0.22 (n − 1), damage = 1 + 0.12 (n − 1), speed = 1 + min(0.30, 0.04 (n − 1)).
 */
export function nightStrength(n: number): Strength {
  const k = Math.max(0, n - 1);
  return {
    hp: 1 + HP_PER_NIGHT * k,
    damage: 1 + DAMAGE_PER_NIGHT * k,
    speed: 1 + Math.min(SPEED_CAP, SPEED_PER_NIGHT * k),
  };
}

/**
 * The strength day zombies have on day `day` (day 1 is before night 1, day d follows night d − 1): the night curve at
 * half the rate, so day d is like night 1 + (d − 1) / 2.
 */
export function dayStrength(day: number): Strength {
  return nightStrength(1 + DAY_RATE * Math.max(0, day - 1));
}

/** Whether night `n` is a Blood Moon (every 5th: 5, 10, 15…). */
export function isBloodMoon(n: number): boolean {
  return n >= BLOOD_MOON_EVERY && n % BLOOD_MOON_EVERY === 0;
}

/** The night whose strength curve night `n` uses: a Blood Moon fights at the next night's strength (5 → 6). */
export function effectiveNight(n: number): number {
  return isBloodMoon(n) ? n + 1 : n;
}

/** Zombies a solo night 1 sends (the base of the horde curve). */
export const BASE_HORDE = 32;
/**
 * Concurrent zombies on the map at most (day wanderers and the horde together): phones draw every one of them, and
 * the rest of a horde waits in the queue until some die.
 */
export const MAX_ZOMBIES = 70;

/**
 * Night `n`'s horde for `players` survivors:
 *   size = BASE_HORDE × (0.55 + 0.45 p) × (1 + 0.3 (n − 1)), doubled on a Blood Moon.
 * Solo night 1 = 32, four players' night 1 = 75; solo night 4 = 61; four players' night 4 = 143. At most
 * `MAX_ZOMBIES` are alive at once (the rest queue).
 */
export function hordeSize(n: number, players: number): number {
  const p = Math.max(1, Math.min(4, players));
  const base = BASE_HORDE * (0.55 + 0.45 * p) * (1 + 0.3 * Math.max(0, n - 1));
  return Math.round(base * (isBloodMoon(n) ? 2 : 1));
}

/** The horde arrives over the first part of the night (the rest is the fight). */
export const HORDE_ARRIVAL = 0.7;

/** Seconds between two horde spawns: the queue spread over `HORDE_ARRIVAL` of the night (at least 0.15 s). */
export function spawnInterval(n: number, players: number): number {
  return Math.max(0.15, (NIGHT_TIME * HORDE_ARRIVAL) / Math.max(1, hordeSize(n, players)));
}

/** The kinds a horde is made of (fractions of its size; the rest are basic zombies). */
export interface HordeMix {
  crawler: number;
  chubby: number;
  /** Brutes are counted, not a fraction. */
  brutes: number;
}

/** Nights from which the specials join: crawlers from 2, chubbies from 3, the brute from 4. */
export const CRAWLER_FROM = 2;
export const CHUBBY_FROM = 3;
export const BRUTE_FROM = 4;

/**
 * Night `n`'s mix: night 1 basic only; crawlers (fast, low, fragile) from night 2 at 15 %, +3 % a night up to 30 %;
 * chubby tanks from night 3 at 8 %, +2 % a night up to 18 %; brutes from night 4: one, and one more every two nights
 * (a Blood Moon adds one).
 */
export function hordeMix(n: number): HordeMix {
  const crawler = n >= CRAWLER_FROM ? Math.min(0.3, 0.15 + 0.03 * (n - CRAWLER_FROM)) : 0;
  const chubby = n >= CHUBBY_FROM ? Math.min(0.18, 0.08 + 0.02 * (n - CHUBBY_FROM)) : 0;
  const brutes = n >= BRUTE_FROM ? 1 + Math.floor((n - BRUTE_FROM) / 2) + (isBloodMoon(n) ? 1 : 0) : 0;
  return { crawler, chubby, brutes };
}

/**
 * Day wanderers kept on the map for `players` on day `day`: 8 + 3 per player, +1 per day after the first, capped at
 * 24. They spawn out of sight (35–70 units from everyone), more of them far from the safehouse.
 */
export function dayPopulation(day: number, players: number): number {
  const p = Math.max(1, Math.min(4, players));
  return Math.min(24, 8 + 3 * p + Math.max(0, day - 1));
}

// =================================================================================================================
// Zombies
// =================================================================================================================

/** Zombie kinds (the synced `kind`), in the order of the models (scripts/models.ts). */
export const ZombieKind = { basic: 0, crawler: 1, chubby: 2, brute: 3 } as const;
export type ZombieKind = (typeof ZombieKind)[keyof typeof ZombieKind];

export interface ZombieSpec {
  name: string;
  /** Base HP (× the strength curve). */
  hp: number;
  /** Shambling speed of day wanderers and of anything not chasing (units/s, × the curve). */
  walk: number;
  /** Chasing speed (units/s, × the curve). */
  run: number;
  radius: number;
  /** Damage per hit on a survivor (× the curve). */
  damage: number;
  attackCooldown: number;
  /** Reach beyond the touching distance. */
  reach: number;
  /** 0 = full knockback, 1 = immovable. */
  knockResist: number;
  /** Separation weight (heavy zombies shove light ones). */
  mass: number;
  /** Damage multiplier against barricades. */
  smash: number;
  /** Drawn this much bigger than the model. */
  scale: number;
}

export const ZOMBIES: readonly ZombieSpec[] = [
  // Basic: the green shambler. Two pistol shots, two bat swings at night 1.
  {
    name: 'Zombie',
    hp: 60,
    walk: 1.0,
    run: 2.6,
    radius: 0.4,
    damage: 10,
    attackCooldown: 1.0,
    reach: 0.35,
    knockResist: 0,
    mass: 1,
    smash: 1,
    scale: 1.15,
  },
  // Crawler (Zombie_Ribcage): fast, low and fragile; arrives first.
  {
    name: 'Crawler',
    hp: 28,
    walk: 1.4,
    run: 4.0,
    radius: 0.32,
    damage: 7,
    attackCooldown: 0.7,
    reach: 0.3,
    knockResist: 0,
    mass: 0.6,
    smash: 0.6,
    scale: 1.2,
  },
  // Chubby: a slow, spongy tank that bursts into a slowing goo pool.
  {
    name: 'Chubby',
    hp: 240,
    walk: 0.8,
    run: 1.7,
    radius: 0.62,
    damage: 18,
    attackCooldown: 1.3,
    reach: 0.4,
    knockResist: 0.7,
    mass: 4,
    smash: 2,
    scale: 1.15,
  },
  // The Brute (Zombie_Arm): huge, throws rocks, smashes barricades.
  {
    name: 'Brute',
    hp: 900,
    walk: 1.0,
    run: 1.9,
    radius: 0.95,
    damage: 32,
    attackCooldown: 1.6,
    reach: 0.5,
    knockResist: 0.95,
    mass: 12,
    smash: 5,
    scale: 1.75,
  },
];

/** A day wanderer notices a survivor this close (with a clear line); a night zombie sees this far. */
export const DAY_SIGHT = 9;
export const NIGHT_SIGHT = 22;
/** A chasing day zombie gives up beyond this. */
export const DAY_LOSE = 16;

/** The brute's rock: thrown from this far (not closer, not further), after a telegraphed wind-up. */
export const ROCK_MIN = 5;
export const ROCK_MAX = 15;
/** Wind-up (the target ring shows where it will land), flight, splash radius, damage (× the curve), cooldown. */
export const ROCK_WINDUP = 1.1;
export const ROCK_FLIGHT = 0.9;
export const ROCK_RADIUS = 1.6;
export const ROCK_DAMAGE = 24;
export const ROCK_COOLDOWN = 5.5;

/** A chubby's goo pool: radius, how long it lasts, and the speed it leaves a survivor wading through it. */
export const GOO_RADIUS = 2.1;
export const GOO_TIME = 8;
export const GOO_SLOW = 0.5;

// =================================================================================================================
// Survivors
// =================================================================================================================

export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 4;
export const PLAYER_RADIUS = 0.4;
export const PLAYER_HP = 100;
/** Running speed at full stick (crossing the town takes about a minute). */
export const PLAYER_SPEED = 4.6;
/** Speed multiplier while carrying a truck part (heavy: and no guns). */
export const CARRY_SPEED = 0.62;
/** Crawling speed multiplier while down. */
export const DOWN_SPEED = 0.18;
/** Velocity response time constant (snappy but not instant). */
export const PLAYER_ACCEL_TAU = 0.08;
/** A teammate within this distance holding the context button for REVIVE_TIME gets a downed survivor up. */
export const REVIVE_RADIUS = 1.6;
export const REVIVE_TIME = 3;
/** HP after a revive or a second wind. */
export const REVIVE_HP = 40;
/** A downed survivor nobody revives bleeds out after this long, and waits for dawn at the safehouse. */
export const BLEED_OUT = 40;
/** Dawn: the living heal this much; the downed get up at REVIVE_HP; the dead respawn at full health. */
export const DAWN_HEAL = 25;
/** Armor soaks this share of every hit until its points run out. */
export const ARMOR_SOAK = 0.5;
export const ARMOR_MAX = 60;

/** Player colours, by slot (rings, labels, the minimap). */
export const PALETTE = ['#ff5a5f', '#3fa7ff', '#ffc23f', '#46d37a'] as const;

// =================================================================================================================
// Weapons and items (one numbering for inventory, pickups and the wire)
// =================================================================================================================

/** Item codes. 0 is "nothing". */
export const Item = {
  none: 0,
  pistol: 1,
  smg: 2,
  shotgun: 3,
  rifle: 4,
  knife: 5,
  axe: 6,
  bat_barbed: 7,
  bat_saw: 8,
  spear: 9,
  guitar: 10,
  bandage: 11,
  medkit: 12,
  kit1: 13,
  kit2: 14,
  kit3: 15,
  kit4: 16,
  armor: 17,
  ammo_pistol: 18,
  ammo_smg: 19,
  ammo_shells: 20,
  ammo_rifle: 21,
  scrap: 22,
  wheel: 23,
  fuel: 24,
} as const;
export type Item = (typeof Item)[keyof typeof Item];

export type ItemKind = 'gun' | 'melee' | 'use' | 'kit' | 'armor' | 'ammo' | 'scrap' | 'part';

export interface ItemSpec {
  id: string;
  name: string;
  icon: string;
  kind: ItemKind;
}

const it = (id: string, name: string, icon: string, kind: ItemKind): ItemSpec => ({ id, name, icon, kind });

/** Every item by code. */
export const ITEMS: Readonly<Record<number, ItemSpec>> = {
  [Item.pistol]: it('pistol', 'Pistol', '🔫', 'gun'),
  [Item.smg]: it('smg', 'SMG', '💨', 'gun'),
  [Item.shotgun]: it('shotgun', 'Shotgun', '💥', 'gun'),
  [Item.rifle]: it('rifle', 'Rifle', '🎯', 'gun'),
  [Item.knife]: it('knife', 'Knife', '🔪', 'melee'),
  [Item.axe]: it('axe', 'Axe', '🪓', 'melee'),
  [Item.bat_barbed]: it('bat_barbed', 'Barbed bat', '🏏', 'melee'),
  [Item.bat_saw]: it('bat_saw', 'Saw bat', '⚙️', 'melee'),
  [Item.spear]: it('spear', 'Spear', '🔱', 'melee'),
  [Item.guitar]: it('guitar', 'Guitar', '🎸', 'melee'),
  [Item.bandage]: it('bandage', 'Bandage', '🩹', 'use'),
  [Item.medkit]: it('medkit', 'Medkit', '⛑️', 'use'),
  [Item.kit1]: it('kit1', 'Plastic barrier kit', '🚧', 'kit'),
  [Item.kit2]: it('kit2', 'Traffic barrier kit', '🚧', 'kit'),
  [Item.kit3]: it('kit3', 'Pallet wall kit', '🪵', 'kit'),
  [Item.kit4]: it('kit4', 'Cinder block kit', '🧱', 'kit'),
  [Item.armor]: it('armor', 'Armor vest', '🦺', 'armor'),
  [Item.ammo_pistol]: it('ammo_pistol', 'Pistol ammo', '•', 'ammo'),
  [Item.ammo_smg]: it('ammo_smg', 'SMG ammo', '••', 'ammo'),
  [Item.ammo_shells]: it('ammo_shells', 'Shells', '▪', 'ammo'),
  [Item.ammo_rifle]: it('ammo_rifle', 'Rifle rounds', '▮', 'ammo'),
  [Item.scrap]: it('scrap', 'Scrap', '🔩', 'scrap'),
  [Item.wheel]: it('wheel', 'Wheel', '🛞', 'part'),
  [Item.fuel]: it('fuel', 'Fuel barrel', '🛢️', 'part'),
};

export const itemKind = (code: number): ItemKind | null => ITEMS[code]?.kind ?? null;

/** Ammo types: index into a survivor's `ammo` (the synced a0…a3). */
export const AmmoType = { pistol: 0, smg: 1, shells: 2, rifle: 3 } as const;
export type AmmoType = (typeof AmmoType)[keyof typeof AmmoType];

/**
 * Ammo is scarce on purpose (melee matters, guns feel precious at night): what you carry at most, what a pickup gives,
 * what a new survivor starts with.
 */
export const AMMO = [
  { name: 'pistol', item: Item.ammo_pistol, max: 48, pickup: 10, start: 18 },
  { name: 'smg', item: Item.ammo_smg, max: 120, pickup: 24, start: 0 },
  { name: 'shells', item: Item.ammo_shells, max: 20, pickup: 5, start: 0 },
  { name: 'rifle', item: Item.ammo_rifle, max: 24, pickup: 5, start: 0 },
] as const;

export interface GunSpec {
  item: Item;
  ammo: AmmoType;
  /** Seconds between shots (auto-fire while the right stick is held). */
  cooldown: number;
  /** Per pellet (× nothing: zombies get tougher, guns don't). */
  damage: number;
  pellets: number;
  /** Total fan of the pellets (radians). */
  spread: number;
  /** Random aim error per pellet (± radians, seeded). */
  jitter: number;
  range: number;
  /** Knockback speed per hit (units/s). */
  knock: number;
  /** Zombies one pellet passes through (the rifle's 2). */
  pierce: number;
}

export const GUNS: Readonly<Record<number, GunSpec>> = {
  [Item.pistol]: {
    item: Item.pistol,
    ammo: AmmoType.pistol,
    cooldown: 0.32,
    damage: 30,
    pellets: 1,
    spread: 0,
    jitter: 0.02,
    range: 14,
    knock: 2,
    pierce: 1,
  },
  [Item.smg]: {
    item: Item.smg,
    ammo: AmmoType.smg,
    cooldown: 0.09,
    damage: 15,
    pellets: 1,
    spread: 0,
    jitter: 0.08,
    range: 12,
    knock: 1,
    pierce: 1,
  },
  [Item.shotgun]: {
    item: Item.shotgun,
    ammo: AmmoType.shells,
    cooldown: 0.85,
    damage: 18,
    pellets: 6,
    spread: 0.42,
    jitter: 0.03,
    range: 8,
    knock: 3.5,
    pierce: 1,
  },
  [Item.rifle]: {
    item: Item.rifle,
    ammo: AmmoType.rifle,
    cooldown: 0.75,
    damage: 75,
    pellets: 1,
    spread: 0,
    jitter: 0.005,
    range: 20,
    knock: 3,
    pierce: 2,
  },
};

export interface MeleeSpec {
  item: Item;
  /** Survivor animation: a sweeping slash, a thrust, or fists. */
  style: 'slash' | 'stab' | 'punch';
  damage: number;
  cooldown: number;
  /** Reach from the survivor's centre. */
  range: number;
  /** Half the arc in front (radians). */
  arc: number;
  /** Knockback speed per hit (units/s): the guitar's is the joke. */
  knock: number;
  /** Zombies one swing can hit. */
  maxHits: number;
  /** Swings that connect before it breaks (Infinity: fists). */
  durability: number;
}

/** Fists: what you swing without a melee weapon (or once it breaks). */
export const FISTS: MeleeSpec = {
  item: Item.none,
  style: 'punch',
  damage: 12,
  cooldown: 0.45,
  range: 1.25,
  arc: 0.9,
  knock: 1.5,
  maxHits: 1,
  durability: Infinity,
};

export const MELEE: Readonly<Record<number, MeleeSpec>> = {
  [Item.knife]: {
    item: Item.knife,
    style: 'stab',
    damage: 30,
    cooldown: 0.38,
    range: 1.45,
    arc: 0.8,
    knock: 1.5,
    maxHits: 1,
    durability: 60,
  },
  [Item.axe]: {
    item: Item.axe,
    style: 'slash',
    damage: 60,
    cooldown: 0.72,
    range: 1.75,
    arc: 1.15,
    knock: 3.5,
    maxHits: 2,
    durability: 40,
  },
  [Item.bat_barbed]: {
    item: Item.bat_barbed,
    style: 'slash',
    damage: 45,
    cooldown: 0.6,
    range: 1.8,
    arc: 1.25,
    knock: 4.5,
    maxHits: 3,
    durability: 45,
  },
  [Item.bat_saw]: {
    item: Item.bat_saw,
    style: 'slash',
    damage: 52,
    cooldown: 0.62,
    range: 1.8,
    arc: 1.2,
    knock: 4,
    maxHits: 3,
    durability: 40,
  },
  [Item.spear]: {
    item: Item.spear,
    style: 'stab',
    damage: 42,
    cooldown: 0.55,
    range: 2.5,
    arc: 0.45,
    knock: 2.5,
    maxHits: 2,
    durability: 50,
  },
  // The joke weapon: modest damage, a huge swing and knockback that sends a horde flying.
  [Item.guitar]: {
    item: Item.guitar,
    style: 'slash',
    damage: 34,
    cooldown: 0.78,
    range: 2.1,
    arc: 1.5,
    knock: 13,
    maxHits: 5,
    durability: 30,
  },
};

/** Healing items: HP restored. */
export const HEAL: Readonly<Record<number, number>> = { [Item.bandage]: 25, [Item.medkit]: 60 };

/** Scrap one scrap pickup is worth (scrap is a team resource: barricades and the truck). */
export const SCRAP_PER_PICKUP = 5;

// =================================================================================================================
// The safehouse: barricades and the truck
// =================================================================================================================

/** Barricade tiers (1–4): the prop drawn, its HP, and the team scrap to build it without a kit. */
export const BARRICADES = [
  { tier: 1, name: 'Plastic barrier', hp: 160, cost: 10 },
  { tier: 2, name: 'Traffic barrier', hp: 320, cost: 20 },
  { tier: 3, name: 'Pallet wall', hp: 520, cost: 35 },
  { tier: 4, name: 'Cinder block wall', hp: 820, cost: 50 },
] as const;
export const kitTier = (code: number): number => (code >= Item.kit1 && code <= Item.kit4 ? code - Item.kit1 + 1 : 0);

/** The armored truck needs this to run: two wheels, two fuel barrels and a scrap total. */
export const TRUCK_WHEELS = 2;
export const TRUCK_FUEL = 2;
export const TRUCK_SCRAP = 60;
/** The escape opens from this night on (once the truck is repaired). */
export const ESCAPE_FROM_NIGHT = 4;
/** Starting the truck: a holdout at the full horde while it warms up, then the drive out (a short scripted exit). */
export const HOLDOUT_TIME = 60;
export const ESCAPE_TIME = 8;

// =================================================================================================================
// Scavenging
// =================================================================================================================

/** Zones by distance from the safehouse: loot quality and zombie density rise with distance. */
export const ZONE_INNER = 62;
export const ZONE_MIDDLE = 118;

/** Hold the context button this long to open / search (seconds). */
export const OPEN_TIME = { chest: 1.0, special: 2.0, search: 1.5 } as const;

/**
 * What a container gives, by zone (0 inner, 1 middle, 2 outer). Rolls: how many items; each roll picks a line by
 * weight. Common chests always give something; searching trash or a wreck can come up empty. Chest_Special only stands
 * in the outer zone and always has a gun among its rolls; outer containers restock at dawn.
 */
export type LootLine = readonly [item: Item | 'ammo' | 'nothing', weight: number];
export const LOOT: Record<'search' | 'chest' | 'special', { rolls: readonly number[]; table: readonly LootLine[][] }> =
  {
    search: {
      rolls: [1, 1, 2],
      table: [
        [
          ['ammo', 30],
          [Item.scrap, 30],
          [Item.bandage, 14],
          [Item.knife, 6],
          ['nothing', 20],
        ],
        [
          ['ammo', 32],
          [Item.scrap, 30],
          [Item.bandage, 14],
          [Item.bat_barbed, 6],
          [Item.knife, 4],
          ['nothing', 14],
        ],
        [
          ['ammo', 34],
          [Item.scrap, 32],
          [Item.bandage, 12],
          [Item.bat_saw, 6],
          [Item.axe, 4],
          ['nothing', 12],
        ],
      ],
    },
    chest: {
      rolls: [2, 2, 3],
      table: [
        [
          ['ammo', 34],
          [Item.scrap, 26],
          [Item.bandage, 14],
          [Item.knife, 8],
          [Item.bat_barbed, 6],
          [Item.kit1, 8],
          [Item.pistol, 4],
        ],
        [
          ['ammo', 32],
          [Item.scrap, 26],
          [Item.medkit, 8],
          [Item.bat_saw, 6],
          [Item.axe, 6],
          [Item.spear, 5],
          [Item.kit2, 8],
          [Item.smg, 5],
          [Item.pistol, 4],
        ],
        [
          ['ammo', 30],
          [Item.scrap, 26],
          [Item.medkit, 10],
          [Item.axe, 6],
          [Item.spear, 6],
          [Item.kit3, 8],
          [Item.smg, 6],
          [Item.shotgun, 4],
          [Item.armor, 4],
        ],
      ],
    },
    special: {
      rolls: [3, 3, 3],
      table: [
        [
          [Item.shotgun, 30],
          [Item.rifle, 26],
          [Item.smg, 20],
          [Item.armor, 30],
          [Item.medkit, 20],
          [Item.kit4, 14],
          [Item.guitar, 12],
          ['ammo', 24],
        ],
        [
          [Item.shotgun, 30],
          [Item.rifle, 26],
          [Item.smg, 20],
          [Item.armor, 30],
          [Item.medkit, 20],
          [Item.kit4, 14],
          [Item.guitar, 12],
          ['ammo', 24],
        ],
        [
          [Item.shotgun, 30],
          [Item.rifle, 26],
          [Item.smg, 20],
          [Item.armor, 30],
          [Item.medkit, 20],
          [Item.kit4, 14],
          [Item.guitar, 12],
          ['ammo', 24],
        ],
      ],
    },
  };

/** A kill drops something this often (ammo or scrap), more at night: the horde pays for your bullets, barely. */
export const DROP_CHANCE_DAY = 0.08;
export const DROP_CHANCE_NIGHT = 0.12;
/** Pickups lying on the ground disappear after this long (truck parts never do). */
export const PICKUP_TTL = 150;
export const MAX_PICKUPS = 48;
/** Walking within this of ammo, scrap, a heal, a kit or armor picks it up; weapons and parts take the context button. */
export const PICKUP_RADIUS = 1.1;

// =================================================================================================================
// The dog
// =================================================================================================================

export const DOG_HP = 150;
export const DOG_RADIUS = 0.35;
/** Trots behind the group, runs to catch up. */
export const DOG_WALK = 3.2;
export const DOG_RUN = 6.8;
/** Keeps about this far from the survivor it follows. */
export const DOG_FOLLOW = 2.4;
/** Bites a zombie in reach for this (× nothing), this often. */
export const DOG_BITE = 14;
export const DOG_BITE_CD = 0.9;
export const DOG_BITE_RANGE = 1.3;
/** Barks (and pings the minimap) when a zombie comes this close, at most every DOG_BARK_CD seconds. */
export const DOG_ALERT = 16;
export const DOG_BARK_CD = 4;
/** A survivor holding the context button this long gets a downed dog up (or it gets up by itself at dawn). */
export const DOG_REVIVE_TIME = 2;
/** Survivors this close when the dog joins count as having found it (the Good Boy achievement). */
export const DOG_FINDERS = 12;
