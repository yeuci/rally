-- Default avatars: every profile gets one of the bundled pictures at signup, and existing profiles are
-- backfilled. Files live in the public `avatars` bucket under defaults/ (uploaded by `pnpm db:avatars`
-- from packages/db/supabase/assets/avatars). avatar_url stores the bucket-relative path for defaults;
-- the app resolves non-absolute values with storage.getPublicUrl('avatars', path), which keeps the
-- rows portable between the local stack and hosted projects.

create table public.default_avatars (
  path text primary key,
  sort int not null unique
);
alter table public.default_avatars enable row level security;
-- No client access; only the picker function (security definer) reads it.
revoke all on table public.default_avatars from anon, authenticated;

insert into public.default_avatars (path, sort) values
  ('defaults/avatar-01.webp', 1),
  ('defaults/avatar-02.webp', 2),
  ('defaults/avatar-03.webp', 3),
  ('defaults/avatar-04.webp', 4),
  ('defaults/avatar-05.webp', 5),
  ('defaults/avatar-06.webp', 6),
  ('defaults/avatar-07.webp', 7),
  ('defaults/avatar-08.webp', 8),
  ('defaults/avatar-09.webp', 9),
  ('defaults/avatar-10.webp', 10)
on conflict do nothing;

create or replace function public.random_default_avatar()
returns text language sql volatile security definer set search_path = public as $$
  select path from public.default_avatars order by random() limit 1;
$$;
revoke all on function public.random_default_avatar() from public;

-- Signup: honour an avatar_url passed in metadata (OAuth providers), else pick a default.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.profiles (id, username, birth_date, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', 'user_' || substr(replace(new.id::text, '-', ''), 1, 8)),
    (new.raw_user_meta_data ->> 'birth_date')::date,
    coalesce(nullif(new.raw_user_meta_data ->> 'avatar_url', ''), public.random_default_avatar())
  );
  return new;
end $$;

-- Backfill: everyone who signed up before defaults existed gets one now (random() is evaluated per row).
update public.profiles set avatar_url = public.random_default_avatar() where avatar_url is null or avatar_url = '';
