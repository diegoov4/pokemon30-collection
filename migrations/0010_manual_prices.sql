-- Precio de Cardmarket apuntado a mano (cartas que TCGdex no tiene, p. ej. Ancient Mew). El cron no lo sobrescribe.
ALTER TABLE cards ADD COLUMN cm_manual INTEGER NOT NULL DEFAULT 0;
