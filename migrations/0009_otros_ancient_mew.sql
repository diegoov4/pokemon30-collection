-- Grupo aparte para cartas que no son del 30.º aniversario (p. ej. para gradear). No cuenta en la colección base.
INSERT INTO sets (id, name, kind, release_date, official, sort_order) VALUES ('otros', 'Otros · Para Gradear', 'other', NULL, NULL, 900)
  ON CONFLICT(id) DO NOTHING;
-- Ancient Mew: promo de cine de «Pokémon 2: El poder de uno» (2000). Sin imagen de origen: se sube una foto desde la app.
INSERT INTO cards (id, set_id, number, sort_key, name, rarity, note, source) VALUES
  ('otros-ancient-mew', 'otros', 'Promo 2000', 1, 'Ancient Mew', 'Promo', 'Promo de cine de «Pokémon 2: El poder de uno» (2000), regalada en los cines · Para Gradear', 'seed')
  ON CONFLICT(id) DO NOTHING;
