# Despliegue en Cloudflare

Guía paso a paso para publicar **Pokémon 30** en tu cuenta de Cloudflare. Unos 10 minutos la primera vez.

Al terminar tendrás:

- La web en `https://pokemon30.<tu-subdominio>.workers.dev`.
- Una base de datos **D1** con las 209 cartas y el usuario `admin`.
- Un bucket **R2** donde se guarda una copia de la imagen de cada carta.
- Dos tareas programadas:
  - cada día busca cartas nuevas;
  - cada hora copia en R2 las imágenes que falten.

---

## 0. Requisitos

| Necesitas | Cómo comprobarlo |
|---|---|
| **Node.js 20 o superior** | `node -v` (descárgalo de https://nodejs.org si no lo tienes) |
| **Cuenta de Cloudflare** (el plan gratuito vale) | https://dash.cloudflare.com/sign-up |
| **R2 activado en la cuenta** | Panel de Cloudflare → **R2 Object Storage** → *Purchase R2 Plan* / *Activar*. Es gratis hasta 10 GB, pero Cloudflare pide una tarjeta para activarlo. Las imágenes de las cartas ocupan unos 30 MB. |

Todos los comandos se ejecutan en una terminal **dentro de la carpeta del proyecto**.

---

## 1. Descomprimir e instalar

```bash
unzip pokemon30.zip
cd pokemon30
npm install
```

## 2. Conectar wrangler con tu cuenta

```bash
npx wrangler login
```

Se abre el navegador. Acepta los permisos y vuelve a la terminal. Para comprobarlo:

```bash
npx wrangler whoami
```

Tiene que salir tu email y el *Account ID*.

> Si tienes varias cuentas de Cloudflare, wrangler te preguntará cuál usar en cada comando. Para no tener que elegir cada vez, añade `"account_id": "<tu account id>"` en `wrangler.jsonc`, justo debajo de `"name"`.

## 3. Crear la base de datos D1

```bash
npx wrangler d1 create pokemon30
```

La salida incluye un bloque como este:

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "pokemon30",
      "database_id": "a1b2c3d4-...."
    }
  ]
}
```

Copia el valor de **`database_id`** y pégalo en `wrangler.jsonc`, sustituyendo `00000000-0000-0000-0000-000000000000`:

```jsonc
"database_id": "a1b2c3d4-....",
```

> Si wrangler te pregunta si quieres añadir la configuración automáticamente a `wrangler.jsonc`, contesta **no**: el bloque ya existe y solo hay que cambiar el id.

## 4. Crear las tablas y cargar las cartas

```bash
npx wrangler d1 migrations apply pokemon30 --remote
```

Confirma con `y`. Se aplican tres migraciones:

| Migración | Qué hace |
|---|---|
| `0001_init.sql` | Crea las tablas |
| `0002_seed.sql` | Carga las 209 cartas: Celebración 30.º Aniversario, Colección Clásica y promos |
| `0003_admin.sql` | Crea el usuario **admin** con una contraseña inicial |

Para comprobarlo:

```bash
npx wrangler d1 execute pokemon30 --remote --command "SELECT count(*) AS cartas FROM cards"
```

Tiene que devolver `209`.

## 5. Crear el bucket R2 para las imágenes

```bash
npx wrangler r2 bucket create pokemon30-images
```

> Si da el error *"Please enable R2 through the Cloudflare Dashboard"*, actívalo como se explica en el paso 0 y repite el comando.

## 6. Publicar

```bash
npx wrangler deploy
```

Al final verás la URL:

```
Deployed pokemon30 triggers
  https://pokemon30.<tu-subdominio>.workers.dev
  schedule: 17 6 * * *
  schedule: 41 * * * *
```

> La primera vez que usas Workers, wrangler te pide elegir un subdominio `*.workers.dev`. Cualquiera libre vale.

## 7. Primer acceso

1. Abre la URL en el navegador o el móvil.
2. Entra con **usuario `admin`** y la contraseña inicial, y cámbiala enseguida.
3. **Cambia la contraseña enseguida:** botón **Miembros** (👥 en el móvil) → *Cambiar mi contraseña*.
4. En **Miembros → Nuevo usuario**, crea un usuario para cada persona del grupo y pásale su usuario y contraseña. Cada uno puede cambiar la suya después.

### Imágenes de las cartas

- **Primera vez que alguien ve una carta:** el Worker descarga su imagen y la guarda en R2. Prueba primero TCGdex en español, luego TCGdex en inglés y por último Scrydex. Por eso la primera carga tarda un poco más.
- **Precarga:** el cron horario va copiando las imágenes pendientes, 8 por hora.
- **Si una carta no tiene imagen en ninguna fuente:** la web muestra el aviso «N cartas sin imagen» y cualquiera puede subir una foto desde la propia carta.

---

## Actualizar a una versión nueva

```bash
npx wrangler d1 migrations apply pokemon30 --remote   # solo aplica las migraciones nuevas
npx wrangler deploy
```

Los usuarios, las colecciones y las imágenes se conservan.

## Desarrollo local (opcional)

```bash
npx wrangler d1 migrations apply pokemon30 --local
npm run dev
```

Abre http://localhost:8787 y entra con el usuario `admin`. La base de datos y el R2 locales son independientes de los de producción.

## Dominio propio (opcional)

1. En el panel de Cloudflare, ve a **Workers & Pages → pokemon30 → Settings → Domains & Routes → Add → Custom domain**.
2. Escribe, por ejemplo, `pokemon30.tudominio.com`. El dominio tiene que estar gestionado en esa misma cuenta de Cloudflare.

## Ver logs

```bash
npx wrangler tail
```

Muestra en directo las peticiones, los errores y el resultado de los crons (`sync` e `images`).

## Problemas frecuentes

| Síntoma | Solución |
|---|---|
| `wrangler deploy` falla con *"database_id … is not valid"* o *"Couldn't find a D1 DB"* | No has puesto el `database_id` del paso 3 en `wrangler.jsonc`. |
| `binding IMAGES … bucket not found` | Falta el paso 5 (`wrangler r2 bucket create pokemon30-images`). |
| La web dice «Error interno» al entrar | Comprueba que el paso 4 se aplicó con `--remote` (sin él las tablas solo existen en local). |
| «Usuario o contraseña incorrectos» con admin | Ya se cambió la contraseña. Para restablecer la inicial, ejecuta el comando que hay justo debajo de esta tabla. |
| Muchas cartas «sin imagen» al principio | Normal hasta que se visitan o pasa el cron horario. Si una sigue sin imagen al cabo de un día, súbela a mano desde la carta. |

Restablecer la contraseña de `admin` a la inicial (cámbiala justo después):

```bash
npx wrangler d1 execute pokemon30 --remote --command "UPDATE users SET pass_salt='p30-admin-salt-1', pass_hash='f564ce60302da575380c45b0b62764a68131e74583cbbd3c3c27f1edc9ed585d' WHERE id='admin'"
```

## Coste

Con un grupo de amigos, todo cabe en los planes gratuitos:

- **Workers:** 100.000 peticiones al día.
- **D1:** 5 GB.
- **R2:** 10 GB, con las operaciones incluidas.
