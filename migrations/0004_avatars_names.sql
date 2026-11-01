-- Avatar elegido de la lista cerrada de data/avatars.json (número de Pokédex; NULL = inicial del nombre)
ALTER TABLE users ADD COLUMN avatar INTEGER;

-- Nombres con la primera letra en mayúscula
UPDATE users SET name = upper(substr(name, 1, 1)) || substr(name, 2);

-- El administrador no colecciona cartas
DELETE FROM collection WHERE user_id IN (SELECT id FROM users WHERE is_admin = 1);
