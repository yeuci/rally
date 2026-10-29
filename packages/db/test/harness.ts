/**
 * PGlite harness: applies the Supabase migrations to an in-memory Postgres with the Supabase-specific
 * schemas (auth, storage) and roles stubbed, so migrations and RPCs can be tested without Docker.
 */
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url);

export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { citext, pgcrypto } });

  // Supabase scaffolding that the migrations assume exists.
  await db.exec(`
    create schema if not exists extensions;
    create schema if not exists auth;
    create schema if not exists storage;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    end $$;
    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create or replace function auth.role() returns text language sql stable as $$
      select nullif(current_setting('request.jwt.claim.role', true), '')
    $$;
    create table storage.buckets (
      id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, created_at timestamptz default now()
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text, owner uuid, created_at timestamptz default now()
    );
    alter table storage.objects enable row level security;
    grant usage on schema public, extensions to anon, authenticated, service_role;
    -- Supabase puts the extensions schema on the default search_path.
    select set_config('search_path', 'public, extensions', false);
  `);

  const dir = new URL(MIGRATIONS_DIR).pathname;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  return db;
}

/** Run `fn` as a signed-in user (sets the JWT claims PostgREST would set). */
export async function asUser<T>(db: PGlite, userId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false), set_config('request.jwt.claim.role', 'authenticated', false)`);
  try {
    return await fn();
  } finally {
    await db.exec(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)`);
  }
}

/** Simulate a Supabase signup: inserting into auth.users fires handle_new_user. */
export async function signUp(db: PGlite, meta: { username: string; birth_date: string }): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
    [`${meta.username}@example.com`, JSON.stringify(meta)],
  );
  return res.rows[0]!.id;
}
