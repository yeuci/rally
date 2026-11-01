/**
 * Every game's Room class, keyed by the `server.room` name from its game.json.
 *
 * Hand-maintained for now (generating it from games/*\/game.json is on the M3 list). Definition options override
 * what a client sends to `onCreate`, so `gameId` and `maxClients` here are authoritative.
 */
import { defineRoom } from 'colyseus';
import { GunRunRoom } from './rooms/GunRunRoom.js';
import { HelloRoom } from './rooms/HelloRoom.js';
import { NorthdaleRoom } from './rooms/NorthdaleRoom.js';
import { OverrunRoom } from './rooms/OverrunRoom.js';
import { SumoRoom } from './rooms/SumoRoom.js';
import { SushiRoom } from './rooms/SushiRoom.js';

export const rooms = {
  hello: defineRoom(HelloRoom),
  sumo: defineRoom(SumoRoom, { gameId: 'sumo', maxClients: 8 }),
  overrun: defineRoom(OverrunRoom, { gameId: 'overrun', maxClients: 4 }),
  gunrun: defineRoom(GunRunRoom, { gameId: 'gunrun', maxClients: 8 }),
  northdale: defineRoom(NorthdaleRoom, { gameId: 'northdale', maxClients: 4 }),
  sushi: defineRoom(SushiRoom, { gameId: 'sushi', maxClients: 4 }),
};

export type RoomRegistry = typeof rooms;
