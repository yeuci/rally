-- Dev seed. Extended by the M1 DB workstream (full banned-word list, demo catalog).
insert into public.banned_words (word) values ('admin'), ('rally'), ('moderator') on conflict do nothing;

insert into public.games (id, title, description, genres, engine, orientation, min_players, max_players, modes, age_rating, status, featured_rank)
values ('spike', 'Rally Spike', 'The M0 stress scene: a thousand spinning cubes and a hello room.', '{"arcade"}', 'playcanvas', 'landscape', 1, 8, '{quick}', '4+', 'published', 1)
on conflict (id) do nothing;
