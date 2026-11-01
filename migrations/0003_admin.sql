-- Usuario administrador inicial: admin / 1234 (cámbiala desde la web: Miembros → Cambiar mi contraseña)
INSERT INTO users (id, name, pass_salt, pass_hash, is_admin, color)
VALUES ('admin', 'Admin', 'p30-admin-salt-1', 'f564ce60302da575380c45b0b62764a68131e74583cbbd3c3c27f1edc9ed585d', 1, '#ef4444');
