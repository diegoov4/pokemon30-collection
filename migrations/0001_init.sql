-- Esquema inicial de Pokémon 30

CREATE TABLE users (
  id          TEXT PRIMARY KEY,           -- nombre de usuario (minúsculas)
  name        TEXT NOT NULL,
  pass_salt   TEXT NOT NULL,
  pass_hash   TEXT NOT NULL,              -- PBKDF2-SHA256, 100.000 iteraciones
  is_admin    INTEGER NOT NULL DEFAULT 0,
  color       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE sets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'expansion',  -- expansion | subset | promo
  release_date  TEXT,
  official      INTEGER,                            -- número impreso (p.ej. /128)
  logo          TEXT,
  tcgdex_id     TEXT UNIQUE,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE cards (
  id          TEXT PRIMARY KEY,                     -- "<set>-<número>"
  set_id      TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  number      TEXT NOT NULL,
  sort_key    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  rarity      TEXT,
  note        TEXT,                                 -- ilustrador, set original, producto...
  image       TEXT,                                 -- URL base de TCGdex (sin extensión)
  image_alt   TEXT,                                 -- URL alternativa (Scrydex, en inglés)
  image_key   TEXT,                                 -- copia propia en R2 (fuente de verdad)
  image_status TEXT,                                -- NULL sin comprobar | ok | missing
  image_checked_at INTEGER,
  source      TEXT NOT NULL DEFAULT 'seed',         -- seed | tcgdex | manual
  added_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (set_id, number)
);
CREATE INDEX cards_set ON cards(set_id, sort_key);

CREATE TABLE collection (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, card_id)
);
CREATE INDEX collection_card ON collection(card_id);
