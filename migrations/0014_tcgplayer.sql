-- Precio de TCGplayer (el que usa Collectr) para las copias que no son en español. En USD; se pasa a € con el cambio del día.
ALTER TABLE cards ADD COLUMN tp_market REAL;
ALTER TABLE cards ADD COLUMN tp_mid REAL;
ALTER TABLE cards ADD COLUMN tp_updated TEXT;
-- Ajustes sueltos (p. ej. cambio USD→EUR)
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
