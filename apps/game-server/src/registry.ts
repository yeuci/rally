/**
 * Every game's Room class, keyed by the `server.room` name from its game.json.
 *
 * Hand-maintained for now (generating it from games/*\/game.json is on the M3 list). Definition options override
 * what a client sends to `onCreate`, so `gameId` and `maxClients` here are authoritative.
 */
import { defineRoom } from 'colyseus';
import { HelloRoom } from './rooms/HelloRoom.js';
import { SumoRoom } from './rooms/SumoRoom.js';

export const rooms = {
  hello: defineRoom(HelloRoom),
  sumo: defineRoom(SumoRoom, { gameId: 'sumo', maxClients: 8 }),
};

export type RoomRegistry = typeof rooms;
