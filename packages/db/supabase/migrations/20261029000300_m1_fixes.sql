-- Fixes for two defects in 20261029000000_m1_init.sql found by the PGlite suite.

-- 1. profiles_protect_immutable: PostgREST >= v10 sets request.jwt.claims (JSON), not request.jwt.claim.role,
--    so the old WHEN clause never fired on hosted Supabase. auth.role() reads both forms.
drop trigger if exists profiles_protect_immutable on public.profiles;
create trigger profiles_protect_immutable before update on public.profiles
  for each row when (auth.role() = 'authenticated')
  execute function public.profiles_protect_immutable();

-- 2. contains_banned_word: the metacharacter escaping assumed E'' strings. With standard_conforming_strings on,
--    this version escapes regex metacharacters in each banned word before building the whole-word pattern.
create or replace function public.contains_banned_word(input text)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.banned_words b
    where input ~* ('(^|[^[:alnum:]])' || regexp_replace(b.word::text, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g') || '($|[^[:alnum:]])')
  );
$$;
