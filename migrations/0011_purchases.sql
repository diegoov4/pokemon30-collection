-- Lo que ha pagado cada uno por producto (ETB, sobres, cartas sueltas...). Productos en data/products.json.
CREATE TABLE IF NOT EXISTS purchases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product     TEXT NOT NULL,                        -- id de data/products.json
  name        TEXT,                                 -- solo para «Carta suelta» / «Otro producto»
  qty         INTEGER NOT NULL,
  unit_price  REAL NOT NULL,                        -- € pagados por unidad
  source      TEXT,                                 -- tienda | wallapop | cardmarket | otro
  bought_on   TEXT,                                 -- AAAA-MM-DD, opcional
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS purchases_user ON purchases(user_id);
