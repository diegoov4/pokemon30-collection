-- Copias por idioma cuando un usuario tiene la misma carta en varios idiomas, en JSON: {"es":2,"en":1}.
-- NULL = todas las copias están en `lang`. `qty` sigue siendo el total y `lang` el idioma con más copias.
ALTER TABLE collection ADD COLUMN langs TEXT;
