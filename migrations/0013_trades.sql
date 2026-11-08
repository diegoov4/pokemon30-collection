-- Intercambios entre miembros. Estados: proposed → accepted → done, o rejected / cancelled / countered.
CREATE TABLE IF NOT EXISTS trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- quien propone
  to_user     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- a quien se le propone
  status      TEXT NOT NULL DEFAULT 'proposed',
  message     TEXT,
  parent_id   INTEGER,                                                -- propuesta a la que contraoferta
  done_by     TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS trades_from ON trades(from_user);
CREATE INDEX IF NOT EXISTS trades_to ON trades(to_user);
-- Una fila por carta: quién la da y en qué idioma
CREATE TABLE IF NOT EXISTS trade_items (
  trade_id    INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  giver       TEXT NOT NULL,
  lang        TEXT NOT NULL DEFAULT 'es'
);
CREATE INDEX IF NOT EXISTS trade_items_trade ON trade_items(trade_id);
