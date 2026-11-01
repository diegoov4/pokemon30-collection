-- Preferencias de cada usuario sobre los precios de las cartas
ALTER TABLE users ADD COLUMN price_metric TEXT NOT NULL DEFAULT 'cm_trend'; -- cm_trend | cm_mid
ALTER TABLE users ADD COLUMN hide_prices INTEGER NOT NULL DEFAULT 0;
