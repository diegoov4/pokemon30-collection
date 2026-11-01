-- Idioma de la carta que tiene cada usuario; español salvo que lo cambie (data/languages.json)
ALTER TABLE collection ADD COLUMN lang TEXT NOT NULL DEFAULT 'es';
