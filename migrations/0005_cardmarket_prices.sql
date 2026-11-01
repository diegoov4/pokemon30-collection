-- Precios de Cardmarket en euros, tomados de TCGdex por el cron horario
ALTER TABLE cards ADD COLUMN cm_trend REAL;
ALTER TABLE cards ADD COLUMN cm_mid REAL;           -- "avg" de Cardmarket: precio medio de venta
ALTER TABLE cards ADD COLUMN cm_updated TEXT;       -- fecha de los datos en Cardmarket
ALTER TABLE cards ADD COLUMN cm_checked_at INTEGER; -- última comprobación nuestra
