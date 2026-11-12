-- Compras sin precio (cuentan para sobres y pull rate, no para gastos) y gastos en privado por usuario.
ALTER TABLE purchases ADD COLUMN priced INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN spend_private INTEGER NOT NULL DEFAULT 0;
