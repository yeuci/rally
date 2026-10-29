/**
 * Every game's Room class, keyed by the `server.room` name from its game.json.
 *
 * M0: hand-maintained. M1 generates this file from games/*\/game.json so that
 * "drop a folder, run publish" also registers the room.
 */
import { defineRoom } from 'colyseus';
import { HelloRoom } from './rooms/HelloRoom.js';

export const rooms = {
  hello: defineRoom(HelloRoom),
};

export type RoomRegistry = typeof rooms;
