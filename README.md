# Pokémon 30 · Colección compartida

App colaborativa en un **Cloudflare Worker** para llevar el control de las cartas oficiales en español del **30.º aniversario de Pokémon**. Cada persona entra con su **usuario y contraseña**, marca las cartas que tiene (y cuántas copias) y todos ven la colección de todos en una **vista única**.

**Acceso inicial: usuario `admin`, contraseña `1234`.** Cámbiala nada más entrar (Miembros → Cambiar mi contraseña). Desde Miembros, el admin crea un usuario para cada persona del grupo. El admin solo gestiona: no colecciona cartas ni aparece en las estadísticas.

**Avatares:** cada persona elige el suyo tocando su avatar arriba a la derecha, de una lista cerrada de 50 Pokémon populares (`data/avatars.json`, sprites de [PokeAPI](https://github.com/PokeAPI/sprites) en `public/avatars/`).

- **Cartas incluidas** (209 en total):
  - **Celebración 30.º Aniversario** (16/09/2026): 128 cartas numeradas, 33 secretas (ilustración, ilustración especial, futuristas de YOSHIROTTEN) y los tres Mew RGB.
  - **Colección Clásica**: las 30 reimpresiones históricas.
  - **Promos 30.º Aniversario**: MEP 094–110 de los productos especiales (póster, latas, Caja de Entrenador Élite, colecciones Ultra-Premium…) y el Pikachu de la Colección Día de Pokémon 2026.
- **Cartas futuras**:
  - Un **cron diario** sincroniza con [TCGdex](https://tcgdex.dev), una base de datos abierta con nombres e imágenes en español. Da de alta las cartas que falten en cualquier expansión cuyo nombre sea del 30.º aniversario (y en las que pongas en `SYNC_EXTRA_SETS`).
  - Desde la web, cualquiera del grupo puede **añadir cartas o colecciones** a mano, como promos nuevas o productos que aún no estén en TCGdex.
- **Vista única**:
  - **Cuadrícula de cartas**: cada carta muestra los avatares de quién la tiene y cuántas copias. Las tuyas salen en color y las demás atenuadas.
  - **Tabla**: una fila por carta y una columna por persona.
  - **Filtros**: me faltan, repetidas, «la tiene alguien y yo no» (para cambios), lo que le falta a cada uno…
  - **Progreso**: el de cada coleccionista y el del grupo entero.
  - **Refresco automático** cada 20 s.

## Vista de álbum

El botón **Vista de álbum** abre un álbum en 3D con la portada del binder del 30.º aniversario y 9 fundas por página, en orden de colección y número. Deslizar pasa las páginas con un efecto de papel ondulado; en el móvil se ve una página cada vez. Las cartas que no se tienen dejan su funda vacía con el número impreso. Se puede ver el álbum propio, el de otra persona o el de todo el grupo.

## Precios de Cardmarket

Cada carta muestra en una esquina su precio de Cardmarket en euros. Cada persona elige en su menú (la pokéball de arriba) si ve Trend, que es el predeterminado, o Mid, y también puede ocultar los precios. Ese menú muestra además el valor de las cartas de cada miembro: copias × precio actual, sin descontar lo que costaron, porque la app no guarda precios de compra. Los precios salen de la API de TCGdex y se pueden filtrar por rango:

- **Trend**: `trend` de Cardmarket.
- **Mid**: `avg` de Cardmarket, el precio medio de venta. Cardmarket no tiene ningún campo llamado «mid».

El cron horario actualiza 25 cartas en cada pasada, así que el catálogo se renueva unas tres veces al día.

## Imágenes (obligatorias)

Todas las cartas tienen imagen, y el Worker guarda una **copia propia en R2**, de modo que no depende de webs externas.

1. **Primera vez que alguien ve una carta**, `/img/<carta>` busca su imagen en este orden y la copia en R2:
   1. TCGdex en **español**.
   2. TCGdex en inglés.
   3. Scrydex (imagen oficial en inglés).
2. **Cada hora**, un cron precarga en R2 las imágenes que aún no estén copiadas.
3. **Si alguna no aparece en ninguna fuente**, la web avisa («N cartas sin imagen») y cualquiera del grupo puede subir una foto o escaneo desde la propia carta. También se puede **cambiar** la imagen de cualquier carta.
4. **Al dar de alta una carta nueva**, la imagen (archivo o URL) es **obligatoria**: si no hay una imagen válida, el alta se rechaza.

Comprobaciones:

- `npm run seed` falla si alguna carta del listado no tiene ninguna fuente de imagen.
- `npm run check:images` descarga cada imagen candidata y comprueba que todas las cartas tienen al menos una válida (necesita conexión a internet).

## Stack

- Un único Worker (`src/index.ts`) con la API, el login con usuario y contraseña (PBKDF2, sesiones en cookie) y los crons.
- **D1** (SQLite) para usuarios, sesiones, cartas y colecciones.
- **R2** para la copia propia de las imágenes de las cartas.
- **Static Assets** (`public/`) para el frontend, en HTML/CSS/JS sin paso de build.

## Despliegue

Guía completa paso a paso: **[deploy.md](deploy.md)**. Resumen:

```bash
npm install
npx wrangler login

# 1. Base de datos
npx wrangler d1 create pokemon30          # copia el database_id en wrangler.jsonc
npx wrangler d1 migrations apply pokemon30 --remote

npx wrangler r2 bucket create pokemon30-images

# 2. Publicar
npx wrangler deploy
```

## Desarrollo local

```bash
npx wrangler d1 migrations apply pokemon30 --local
npm run dev                               # http://localhost:8787 → admin / 1234
```

## Versión en claude.ai

`artifact/` contiene una versión de la misma app publicable como página de claude.ai (sin Cloudflare): mismo catálogo y diseño, datos compartidos en la base de datos de la página y fotos de las cartas en su almacén de archivos. `node scripts/build-artifact.mjs` genera `artifact/pokemon30.html`.

## Datos

- `data/cards.json` es el listado de partida, con nombres oficiales en español, rareza, ilustrador y el producto de cada promo. Sale de la base de datos abierta de TCGdex, contrastada con fuentes públicas.
- `node scripts/build-seed.mjs` regenera `migrations/0002_seed.sql` a partir de ese JSON.
- Para añadir cartas en una base ya desplegada, crea una migración nueva o usa el botón **＋ Añadir carta**.

Notas sobre la numeración:

- **Mew RGB**: van numerados `R/RGB`, `G/RGB` y `B/RGB`, como en la carta impresa.
- **Colección Clásica**: usa el orden 1–30 de TCGdex. Cada carta conserva impreso su número original, que aparece en «Detalles».

---

App de fans sin afiliación. Pokémon y sus marcas son © de Nintendo, Creatures, GAME FREAK y The Pokémon Company.
