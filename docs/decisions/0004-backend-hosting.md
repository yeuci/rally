# ADR 0004 — Backend and hosting: Supabase + Colyseus, fully managed

**Status:** Accepted · 2026-10

## Context

Rally needs auth, a relational source of truth with row-level security, realtime fan-out for presence/chat/invites, file storage with a CDN for game bundles, push notifications, and server-authoritative multiplayer rooms (2–8 players, ~20 Hz, matchmaking, reconnection). A solo developer must run it all with the fewest moving parts.

Options considered:

1. **Supabase** (Auth, Postgres + RLS, Storage/CDN, Realtime, Edge Functions) **+ Colyseus** (rooms, matchmaking, state sync, reconnection) on **Colyseus Cloud**.
2. **Firebase** + a custom WebSocket game server.
3. **Custom Node/Postgres backend** on a VPS or Fly.io, including a hand-written room server.
4. **Nakama** or **PlayFab** as an all-in-one game backend.

## Decision

Supabase Cloud for social truth and content delivery; one Colyseus Cloud deployment (one Room class per game) for gameplay truth. Everything managed: Supabase Cloud, Colyseus Cloud, Expo EAS, Supabase Storage CDN for bundles. Postgres + Realtime own presence, parties, chat and invites; Colyseus owns rooms and seats and mirrors them into `game_rooms`. Colyseus verifies Supabase JWTs via JWKS; only Colyseus, Edge Functions and CI hold the service-role key. All multiplayer outcomes are written server-side.

Realtime fan-out uses Broadcast-from-database (`realtime.send()` in triggers) into one private channel per user plus one per party, avoiding `postgres_changes` RLS cost and the 100-value filter cap.

## Consequences

- Postgres with RLS gives a single, inspectable source of truth, SQL migrations under version control, and Supabase Studio as the initial admin console (needed for 4.7.1 moderation duties).
- Colyseus provides matchmaking routes, seat reservations, schema state sync, reconnection and (0.18) prediction helpers out of the box, so each new multiplayer game is "one Room subclass". The party seat-reservation flow is the one piece of custom matchmaking logic.
- Single Colyseus process and single region to start: deploys restart live rooms and distant users see higher latency. Accepted for MVP; mitigated by deploying only when server code changes, graceful drains and low-traffic windows.
- Supabase Realtime connections/messages and Storage egress are plan-capped; friend count is capped (~200) to bound trigger fan-out. Checked once there is traffic.
- Firebase was rejected for weaker relational modelling and security rules versus RLS; a custom backend costs ops time the solo developer does not have; Nakama/PlayFab bundle features Rally does not need and would still require a web-compatible room protocol.
