/**
 * PGlite harness: applies the Supabase migrations to an in-memory Postgres with the Supabase-specific
 * schemas (auth, storage), roles and default privileges stubbed, so migrations, RLS and RPCs can be
 * tested without Docker.
 *
 * Fidelity notes (what a real Supabase project does, and what we copy):
 * - Roles: anon, authenticated (nologin, RLS applies), service_role (bypassrls). PostgREST switches to
 *   one of them per request with `set local role`, after setting the JWT claims.
 * - Claims: PostgREST >= v10 sets ONLY `request.jwt.claims` (the whole JWT payload as JSON). The legacy
 *   per-claim GUCs (`request.jwt.claim.sub`, `request.jwt.claim.role`, ...) are no longer set. Supabase's
 *   auth.uid()/auth.role()/auth.jwt() read both forms, and so do the stubs below. `asRole` sets the
 *   modern form by default; pass `legacyClaims: true` to also set the per-claim GUCs.
 * - Privileges: Supabase's default privileges grant all on new public tables, functions and sequences
 *   to anon, authenticated and service_role. That is why `revoke ... from public` alone does not stop
 *   anon from executing a function: anon holds its own grant.
 */
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SUPABASE_DIR = new URL('../supabase/', import.meta.url).pathname;
const MIGRATIONS_DIR = join(SUPABASE_DIR, 'migrations');
export const SEED_FILE = join(SUPABASE_DIR, 'seed.sql');

export type SupabaseRole = 'anon' | 'authenticated' | 'service_role';

export async function createTestDb(opts: { seed?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite({ extensions: { citext, pgcrypto } });

  // Supabase scaffolding that the migrations assume exists.
  await db.exec(`
    create schema if not exists extensions;
    create schema if not exists auth;
    create schema if not exists storage;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
      -- GoTrue writes auth.users as this role, so signup triggers fire with its privileges.
      if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin noinherit; end if;
    end $$;

    -- auth: the columns handle_new_user reads, plus the helper functions as Supabase defines them.
    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb,
      raw_app_meta_data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create or replace function auth.uid() returns uuid language sql stable as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::uuid
    $$;
    create or replace function auth.role() returns text language sql stable as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
      )::text
    $$;
    create or replace function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
      )::jsonb
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant usage on schema auth to supabase_auth_admin;
    grant all on auth.users to supabase_auth_admin;
    grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

    -- storage: the subset of columns and helpers that policies and bucket inserts touch.
    create table storage.buckets (
      id text primary key,
      name text not null,
      owner uuid,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[],
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text references storage.buckets (id),
      name text,
      owner uuid,
      owner_id text,
      metadata jsonb,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
    alter table storage.objects enable row level security;
    alter table storage.buckets enable row level security;
    create or replace function storage.foldername(name text) returns text[] language plpgsql as $$
    declare _parts text[];
    begin
      select string_to_array(name, '/') into _parts;
      return _parts[1:array_length(_parts, 1) - 1];
    end $$;
    create or replace function storage.filename(name text) returns text language plpgsql as $$
    declare _parts text[];
    begin
      select string_to_array(name, '/') into _parts;
      return _parts[array_length(_parts, 1)];
    end $$;
    grant usage on schema storage to anon, authenticated, service_role;
    grant all on storage.objects, storage.buckets to anon, authenticated, service_role;

    -- public/extensions: Supabase's default privileges.
    grant usage on schema public, extensions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

    -- Supabase puts the extensions schema on the default search_path.
    select set_config('search_path', 'public, extensions', false);
  `);

  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  if (opts.seed) await applySeed(db);
  return db;
}

export async function applySeed(db: PGlite): Promise<void> {
  await db.exec(readFileSync(SEED_FILE, 'utf8'));
}

/**
 * Run `fn` the way PostgREST runs a request: JWT claims set, then `set role <role>` so grants and RLS
 * policies are evaluated for that role. Always restores the superuser session afterwards.
 */
export async function asRole<T>(
  db: PGlite,
  role: SupabaseRole,
  fn: () => Promise<T>,
  opts: { sub?: string; legacyClaims?: boolean } = {},
): Promise<T> {
  // Same payload shape as a Supabase access token (the claims policies can see).
  const claims: Record<string, unknown> = { role };
  if (opts.sub) Object.assign(claims, { sub: opts.sub, aud: 'authenticated' });
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  if (opts.legacyClaims) {
    await db.query(
      `select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false)`,
      [opts.sub ?? '', role],
    );
  }
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec(`
      reset role;
      select set_config('request.jwt.claims', '', false),
             set_config('request.jwt.claim.sub', '', false),
             set_config('request.jwt.claim.role', '', false);
    `);
  }
}

/** Run `fn` as a signed-in user (role authenticated, `sub` = userId). */
export async function asUser<T>(
  db: PGlite,
  userId: string,
  fn: () => Promise<T>,
  opts: { legacyClaims?: boolean } = {},
): Promise<T> {
  return asRole(db, 'authenticated', fn, { ...opts, sub: userId });
}

/** Run `fn` as a signed-out client using the anon key. */
export async function asAnon<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
  return asRole(db, 'anon', fn);
}

/** Run `fn` with the service-role key (publish tool, game server). */
export async function asService<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
  return asRole(db, 'service_role', fn);
}

/**
 * Simulate a Supabase signup: GoTrue inserts into auth.users as supabase_auth_admin, which fires
 * handle_new_user. `meta` is the `options.data` the client passes to `auth.signUp`.
 */
export async function signUp(
  db: PGlite,
  meta: { username?: string; birth_date?: string },
  email = `${meta.username ?? crypto.randomUUID()}@example.com`,
): Promise<string> {
  await db.exec(`set role supabase_auth_admin`);
  try {
    const res = await db.query<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
      [email, JSON.stringify(meta)],
    );
    return res.rows[0]!.id;
  } finally {
    await db.exec(`reset role`);
  }
}

/** Insert a game (as superuser, like the publish tool with the service role). */
export async function insertGame(
  db: PGlite,
  id: string,
  status: 'draft' | 'published' | 'hidden' = 'published',
): Promise<void> {
  await db.query(`insert into public.games (id, title, engine, status) values ($1, $2, 'playcanvas', $3)`, [id, id, status]);
}
