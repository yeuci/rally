import { schema, t, type SchemaType } from '@colyseus/schema';

export const HelloState = schema(
  {
    /** Incremented at the simulation rate; lets the client observe patch cadence. */
    tick: t.number().default(0),
    players: t.number().default(0),
  },
  'HelloState',
);
export type HelloState = SchemaType<typeof HelloState>;
