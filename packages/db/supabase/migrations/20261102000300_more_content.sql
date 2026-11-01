-- More content for the economy (data only: no schema change). Pinned by test/more-content.test.ts, with the catalog
-- and template counts in test/coins.test.ts and test/progress.test.ts; the app side is in docs/coins.md and
-- docs/progress.md.
--
--   * shop_items: 26 more data-drawn cosmetics across the four kinds, on a price ladder: 12 cheap (100-500), 8 mid
--     (800-2,000) and 6 prestige (5,000-25,000). `sort` places each one by price inside its kind, among the v1 items
--     (the shop's "Featured" order). Besides the v1 keys, some use optional look keys the app draws (older app builds
--     ignore them and draw the plain look; the shop_items_validate trigger allows extra keys):
--       name_color      glow: true            a soft halo in the name's colour
--       avatar_frame    spin: true            the gradient ring slowly turns (still under Reduce Motion)
--                       dotted: true          the ring is a string of beads
--       profile_banner  pattern: 'stripes' | 'dots' | 'grid' | 'stars'   a faint white texture over the gradient
--                       shine: true           a sheen sweeps across every few seconds (none under Reduce Motion)
--       badge           fill: '#RRGGBB'       a second colour inside the icon (two-tone)
--     New badge icons (lucide names) need the app build that knows them; an older build draws a star instead.
--     The app tags the latest batch "New" for 30 days (the newest created_at among the items on sale).
--   * challenge_templates: 12 more, in six of the kinds private.challenge_event already counts (play_matches,
--     friend_match, play_games, play_game, score, solo_runs). Same rewards per tier as the v1 pool (20 / 35 / 50 coins,
--     30 / 50 / 70 XP), so every day still pays 105 coins and 150 XP; targets stay at 5 or less. Templates that name a
--     game are only picked while it is published and playable (owns_game), as before.
--
-- Re-running is safe: existing rows are left alone (on conflict do nothing), so a price or look tuned in the SQL editor
-- survives a replay.

-- ---------------------------------------------------------------------------
-- Shop items
-- ---------------------------------------------------------------------------

insert into public.shop_items (id, kind, name, description, price, data, sort) values
  -- Name colours (v1 sorts: Mint 10, Sky 20, Rose 30, Violet 40, Gold 50).
  ('name-coral', 'name_color', 'Coral', 'Warm, like a reef at noon.', 150, '{"color": "#FF8A7A", "light": "#C2410C"}', 22),
  ('name-lime', 'name_color', 'Lime', 'A bright, zesty green.', 150, '{"color": "#A3E635", "light": "#4D7C0F"}', 24),
  ('name-silver', 'name_color', 'Silver', 'Quietly metallic.', 300, '{"color": "#CBD5E1", "light": "#475569"}', 45),
  ('name-orchid', 'name_color', 'Orchid', 'A rare pink-violet bloom.', 900, '{"color": "#E879F9", "light": "#A21CAF"}', 60),
  ('name-copper', 'name_color', 'Copper', 'Burnished and warm.', 1500, '{"color": "#F4A26B", "light": "#9A3412"}', 70),
  ('name-moonlit', 'name_color', 'Moonlit', 'Your name in silver, with a soft glow around it.', 5000,
   '{"color": "#F1F5F9", "light": "#334155", "glow": true}', 80),

  -- Avatar frames (v1 sorts: Ember 10, Ocean 20, Aurora 30, Gilded 40).
  ('frame-graphite', 'avatar_frame', 'Graphite', 'Brushed charcoal, understated.', 150, '{"colors": ["#A1A1AA", "#3F3F46"]}', 5),
  ('frame-citrus', 'avatar_frame', 'Citrus', 'Lemon into tangerine.', 300, '{"colors": ["#FDE047", "#FB923C"]}', 22),
  ('frame-beads', 'avatar_frame', 'Beads', 'A string of tiny pearls in pink and lilac.', 400,
   '{"colors": ["#F472B6", "#A78BFA"], "dotted": true}', 24),
  ('frame-iris', 'avatar_frame', 'Iris', 'Petal blues and violets.', 900, '{"colors": ["#818CF8", "#C084FC", "#F0ABFC"]}', 26),
  ('frame-twilight', 'avatar_frame', 'Twilight', 'The whole evening sky in one ring.', 1800,
   '{"colors": ["#F59E0B", "#EC4899", "#6366F1", "#0EA5E9"]}', 35),
  ('frame-prism', 'avatar_frame', 'Prism', 'Light split four ways, always turning.', 12000,
   '{"colors": ["#F472B6", "#FBBF24", "#34D399", "#60A5FA"], "spin": true}', 50),
  ('frame-eclipse', 'avatar_frame', 'Eclipse', 'A golden corona that circles your avatar. The rarest ring in Rally.', 25000,
   '{"colors": ["#FFFBEB", "#F59E0B", "#0A0A0A"], "spin": true}', 60),

  -- Profile banners (v1 sorts: Dusk 10, Lagoon 20, Sunset 30).
  ('banner-slate', 'profile_banner', 'Slate', 'Cool grey stone.', 150, '{"colors": ["#334155", "#64748B"]}', 5),
  ('banner-peach', 'profile_banner', 'Peach', 'Soft orange melting into pink.', 300, '{"colors": ["#FDBA74", "#FB7185"]}', 12),
  ('banner-pinstripe', 'profile_banner', 'Pinstripe', 'Charcoal with a fine diagonal stripe.', 500,
   '{"colors": ["#27272A", "#52525B"], "pattern": "stripes"}', 15),
  ('banner-confetti', 'profile_banner', 'Confetti', 'A party in pink and lilac.', 800,
   '{"colors": ["#F472B6", "#A78BFA"], "pattern": "dots"}', 25),
  ('banner-blueprint', 'profile_banner', 'Blueprint', 'Deep blue with a drafting grid.', 1200,
   '{"colors": ["#1E3A8A", "#2563EB"], "pattern": "grid"}', 35),
  ('banner-obsidian', 'profile_banner', 'Obsidian', 'Polished black glass. Light glides across it.', 8000,
   '{"colors": ["#09090B", "#3F3F46", "#09090B"], "pattern": "stripes", "shine": true}', 50),
  ('banner-nebula', 'profile_banner', 'Nebula', 'A star field in violet and magenta, catching the light.', 15000,
   '{"colors": ["#1E1B4B", "#7C3AED", "#DB2777"], "pattern": "stars", "shine": true}', 60),

  -- Badges (v1 sorts: Star 10, Flame 20, Crown 30).
  ('badge-leaf', 'badge', 'Leaf', 'Fresh growth.', 100, '{"icon": "leaf", "color": "#4ADE80", "light": "#15803D"}', 5),
  ('badge-spark', 'badge', 'Spark', 'Quick on the draw.', 250, '{"icon": "zap", "color": "#FDE047", "light": "#CA8A04"}', 12),
  ('badge-moon', 'badge', 'Moon', 'For the late-night sessions.', 300, '{"icon": "moon", "color": "#C4B5FD", "light": "#6D28D9"}', 14),
  ('badge-shield', 'badge', 'Shield', 'Steady under pressure.', 1000,
   '{"icon": "shield", "color": "#93C5FD", "light": "#1D4ED8", "fill": "#3B82F6"}', 25),
  ('badge-duel', 'badge', 'Duel', 'Always ready for a rematch.', 2000,
   '{"icon": "swords", "color": "#FCA5A5", "light": "#B91C1C", "fill": "#EF4444"}', 28),
  ('badge-diamond', 'badge', 'Diamond', 'Cut, polished and very rare.', 6000,
   '{"icon": "gem", "color": "#E0F2FE", "light": "#0369A1", "fill": "#67E8F9"}', 40)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Daily challenge templates
-- ---------------------------------------------------------------------------

-- Kinds and what counts (private.challenge_event): solo_runs = valid solo runs of any game (one per play session);
-- play_game = counted matches or valid solo runs of game_id; score = the best valid score today on board_key;
-- play_matches / friend_match = counted multiplayer matches (with an accepted friend); play_games = distinct games.
insert into public.challenge_templates (key, kind, game_id, board_key, target, title, tier, coins, xp) values
  ('solo_2', 'solo_runs', null, null, 2, 'Finish 2 solo runs', 1, 20, 30),
  ('stack_10', 'score', 'stack', 'height', 10, 'Build a {target}-block tower in {game}', 1, 20, 30),
  ('topple_1', 'play_game', 'topple', null, 1, 'Play a game of {game}', 1, 20, 30),
  ('lumber_1', 'play_game', 'lumber', null, 1, 'Work a shift at {game}', 1, 20, 30),
  ('sawline_1', 'play_game', 'sawline', null, 1, 'Work a shift in {game}', 1, 20, 30),
  ('play_4', 'play_matches', null, null, 4, 'Play 4 matches', 2, 35, 50),
  ('solo_3', 'solo_runs', null, null, 3, 'Finish 3 solo runs', 2, 35, 50),
  ('sushi_1', 'play_game', 'sushi', null, 1, 'Play a round of {game}', 2, 35, 50),
  ('northdale_1', 'play_game', 'northdale', null, 1, 'Play a round of {game}', 2, 35, 50),
  ('solo_5', 'solo_runs', null, null, 5, 'Finish 5 solo runs', 3, 50, 70),
  ('variety_4', 'play_games', null, null, 4, 'Play 4 different games', 3, 50, 70),
  ('friend_2', 'friend_match', null, null, 2, 'Play 2 matches with a friend', 3, 50, 70)
on conflict (key) do nothing;
