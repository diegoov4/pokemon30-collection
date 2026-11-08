-- Producto guardado sellado (solo ETB y UPC): idioma y valor actual estimado por unidad, que suma al beneficio.
ALTER TABLE purchases ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN lang TEXT;   -- es | en
ALTER TABLE purchases ADD COLUMN value REAL;  -- € por unidad si se vendiera hoy (a mano)
