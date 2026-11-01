/**
 * Fixed numbers of Sushi Shift (the curves that change by day and crew size live in tuning.ts). Units are world units
 * (a counter is 2 wide and 0.95 tall, a chef 1.7 tall); time is in seconds. Simulation axes: x right, y down the
 * screen (toward the camera, from the kitchen at the back to the dining room at the front). Shared by the server (the
 * authoritative simulation) and the client (rendering, prediction of the local chef's movement, the HUD).
 */

/** Server simulation rate (fixed timestep). The synced `tick` counts these steps: server time = tick × DT. */
export const TICK_HZ = 20;
/** State patches go out at Colyseus' default 20 Hz: one per tick. */
export const PATCH_MS = 50;
export const DT = 1 / TICK_HZ;

// --- chefs -------------------------------------------------------------------------------------------------------
export const MAX_PLAYERS = 4;
export const PLAYER_RADIUS = 0.3;
/** Top speed at full stick, units/s (the sandals upgrade multiplies it). */
export const PLAYER_SPEED = 4.2;
/** Velocity response time constant: snappy, a little weight. */
export const PLAYER_ACCEL_TAU = 0.06;
/**
 * How far a station can be from the chef's centre and still be used (to its interaction point, the middle of the
 * counter top). Generous: a chef pressed against a counter is ≈ 0.75 from the middle of its top.
 */
export const INTERACT_RANGE = 1.25;
/** The server accepts the client's highlighted target this much further away (latency, prediction error). */
export const TARGET_SLACK = 0.7;
/** Stations in front of the chef win over ones beside or behind (see `pickTarget`): this much range per unit of dot. */
export const FACING_BIAS = 0.45;
/**
 * A press on a station that can be worked waits this long to tell a tap (pick the item up) from a hold (work it).
 * Everywhere else a press acts at once.
 */
export const HOLD_DELAY = 0.2;
/** Input dead zone (stick magnitude). */
export const INPUT_DEADZONE = 0.12;
/** Inputs are sent at most this often (on change). */
export const INPUT_HZ = 20;
/** A client sending more inputs than this per second is ignored beyond it. */
export const MAX_INPUTS_PER_SECOND = 40;

// --- stations ----------------------------------------------------------------------------------------------------
/** Seconds of holding to chop one ingredient (sharper knives divide it). */
export const CHOP_TIME = 1.6;
/** Seconds of holding to roll a recipe on the mat. */
export const ROLL_TIME = 1.3;
/** Seconds of holding to wash one dirty plate. */
export const WASH_TIME = 1.0;
/** The rice pot: seconds to cook a batch and how many scoops it holds. */
export const RICE_COOK_TIME = 6;
export const RICE_PORTIONS = 4;
/** The ramen and udon pots: seconds per batch, bowls per batch. */
export const POT_COOK_TIME = 7;
export const POT_PORTIONS = 2;
/** The steamer: seconds per batch, buns per batch. */
export const STEAM_TIME = 7;
export const STEAM_PORTIONS = 3;
/** Gyoza: seconds in the pan until done; then smoke after SMOKE, burnt after BURN (both counted from done). */
export const GYOZA_COOK_TIME = 6;
export const GYOZA_SMOKE_AFTER = 3;
export const GYOZA_BURN_AFTER = 6;
/** Holding the button at a cooking station (stirring, tossing the pan) speeds it up this much. */
export const STIR_SPEEDUP = 1.6;
/** The sink holds this many dirty plates; a chef carries a stack of at most this many. */
export const SINK_CAPACITY = 12;
export const CARRY_PLATES = 6;
/** The mat holds at most this many ingredients (a California roll has four). */
export const MAT_CAPACITY = 4;
/** A seat with this many dirty plates piled up takes no new customer until it is bussed. */
export const SEAT_PILE = 3;
/** Clean plates in the restaurant once dishes matter (Thursday on); the plates upgrade adds PLATES_UPGRADE. */
export const PLATE_POOL = 10;
export const PLATES_UPGRADE = 6;

// --- the belt ----------------------------------------------------------------------------------------------------
/** Plates the belt carries at once (its slots, evenly spaced along the loop). */
export const BELT_SLOTS = 18;
/** Belt speed, units/s (the faster-belt upgrade multiplies it). One lap is ≈ 27 units: ≈ 30 s. */
export const BELT_SPEED = 0.9;
/** A customer takes a plate passing within this distance (along the belt) of their seat. */
export const GRAB_WINDOW = 0.35;

// --- customers ---------------------------------------------------------------------------------------------------
export const CUSTOMER_SPEED = 2.3;
/** Sitting down before the order shows (the Sitting_Start clip), eating, standing up. */
export const SIT_TIME = 0.9;
export const EAT_TIME = 2.6;
export const STAND_TIME = 1.1;
/** How long a reaction (Yes / No) plays before the customer walks out. */
export const REACT_TIME = 1.2;
/** Waving (the Wave clip) once patience is below this fraction. */
export const WAVE_BELOW = 0.45;

// --- the day -----------------------------------------------------------------------------------------------------
/** Real seconds of an open restaurant (the clock runs 11:00 → 21:00 in this time). */
export const DAY_LENGTH = 120;
export const OPEN_HOUR = 11;
export const CLOSE_HOUR = 21;
/** No new customers after this fraction of the day ("last orders", 20:00). */
export const LAST_ORDERS = 0.9;
/** Prep time before the doors open: the day's banner and its lesson; chefs can already work. */
export const MORNING_TIME = 7;
/** After closing, the last customers finish; anyone still waiting after this long leaves without a penalty. */
export const CLOSING_MAX = 35;
/** The night: the day's summary and the upgrade vote. Ends early once every chef voted. */
export const VOTE_TIME = 16;
/** The restaurant closed (no stars left): the banner, then a new run. */
export const OVER_TIME = 12;
/** A public room starts its first run this long after the first chef joins. */
export const LOBBY_TIME = 2;
export const MAX_STARS = 5;
/** The week: Monday is day 1, Sunday (the festival) day 7; after that, Overtime. */
export const WEEK_DAYS = 7;
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

// --- deliveries (Saturday on) ----------------------------------------------------------------------------------
/** Each crate's stock at the start of a delivery day, the most it holds, and what one delivery box adds. */
export const STOCK_START = 3;
export const STOCK_MAX = 6;
export const DELIVERY_AMOUNT = 3;
/** Seconds between the truck's boxes (one waits at the back door at a time). */
export const DELIVERY_EVERY = 22;
