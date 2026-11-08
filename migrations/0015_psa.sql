-- Precios aproximados en PSA 8, 9 y 10 (ventas en eBay, vía Pokémon Price Tracker), en USD.
-- JSON: {"8":{"p":123.4,"n":5,"d":"2026-11-07"},"9":{...},"10":{...}}
ALTER TABLE cards ADD COLUMN psa TEXT;
ALTER TABLE cards ADD COLUMN psa_updated INTEGER;
