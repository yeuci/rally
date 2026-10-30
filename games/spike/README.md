# games/spike

The M0 spike (architecture §10): a PlayCanvas stress scene that runs inside the Rally
WebView, completes the bridge handshake, pings the host, matchmakes through the host
into the Colyseus `hello` room and shows FPS / frame time / draw calls / bridge RTT /
socket RTT in an on-screen HUD. It also reports those numbers to the host every 5 s
via `telemetry.report`, so the shell can show them after exit.

```bash
pnpm --filter @rally/game-spike dev         # desktop browser, standalone (no host bridge)
pnpm --filter @rally/game-spike build       # -> client/dist, upload to Supabase Storage for the phone test
```

Standalone mode: without `window.__rally` the game still renders. Add
`?colyseus=ws://localhost:2567` to the URL to join the hello room directly
(bypassing the host matchmaker) while the game server runs locally.

Stress knobs in the HUD: 100 / 300 / 1000 cubes.

Testing pause/resume on a phone: serve the built bundle (`pnpm --filter @rally/game-spike build` then
`preview`) or run the dev server with `VITE_NO_HMR=1`. Vite's hot-reload client reconnects after iOS suspends
the app in the background and forces a full page reload, which looks like the game restarting. The big number
in the middle of the screen counts seconds since load: it keeps counting across pause/resume and resets to 0
on a reload.
