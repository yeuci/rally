# apps/game-server

The single Colyseus deployment (architecture §6). One Room class per game, registered in
`src/registry.ts`. M0 ships only the `hello` room used by `games/spike`.

```bash
pnpm --filter @rally/game-server dev     # tsx watch, http://localhost:2567 (playground at /, monitor at /monitor)
pnpm --filter @rally/game-server test    # mocha + @colyseus/testing
pnpm --filter @rally/game-server build   # -> build/, what Colyseus Cloud runs via ecosystem.config.cjs
npx @colyseus/cloud deploy               # deploy (needs a Colyseus Cloud app + token)
```

Matchmaking is done by the Rally shell over HTTP (`POST /matchmake/joinOrCreate/<room>`); the
game bundle receives the seat reservation through the bridge and opens the WebSocket itself.
