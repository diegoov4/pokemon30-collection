// Genera migrations/0002_seed.sql a partir de data/cards.json
// Uso: node scripts/build-seed.mjs
import { readFileSync, writeFileSync } from "node:fs";

const data = JSON.parse(readFileSync(new URL("../data/cards.json", import.meta.url)));
const ASSETS = "https://assets.tcgdex.net/es/me";

// Colecciones locales -> set de TCGdex (para imágenes y sincronización)
const SETS = {
  cel30: { tcgdex: "30th", kind: "expansion", order: 1, pad: true },
  cel30c: { tcgdex: "30th-c", kind: "subset", order: 2, pad: true },
  promo30: { tcgdex: null, kind: "promo", order: 3 },
};

const q = (v) => (v === null || v === undefined || v === "" ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

let noImage = 0;
const lines = ["-- Generado por scripts/build-seed.mjs a partir de data/cards.json. No editar a mano.", ""];
for (const set of data.sets) {
  const cfg = SETS[set.id];
  lines.push(
    `INSERT INTO sets (id, name, kind, release_date, official, tcgdex_id, sort_order) VALUES (${q(set.id)}, ${q(set.name)}, ${q(cfg.kind)}, ${q(set.releaseDate)}, ${set.official ?? "NULL"}, ${q(cfg.tcgdex)}, ${cfg.order});`,
  );
  for (const c of set.cards) {
    if (/no es estrictamente/.test(c.product ?? "")) continue;
    let number = c.number;
    let image = null;
    let imageAlt = c.imageAlt ?? null;
    let sort = parseInt(number.match(/\d+/)?.[0] ?? "9999", 10);
    if (cfg.pad) {
      const rgb = number.match(/^([RGB])\/RGB$/);
      // En TCGdex los números van con ceros (001) y los Mew RGB son R, G y B
      const localId = rgb ? rgb[1] : number.padStart(3, "0");
      number = rgb ? number : localId;
      if (rgb) sort = 200 + "RGB".indexOf(rgb[1]);
      image = `${ASSETS}/${cfg.tcgdex}/${localId}`;
    } else if (/^MEP \d+$/.test(number)) {
      image = `${ASSETS}/mep/${number.slice(4)}`;
      // Candidata extra; el Worker comprueba si existe antes de usarla
      imageAlt ??= `https://images.scrydex.com/pokemon/mep-${parseInt(number.slice(4), 10)}/large`;
    } else if (number === "051/162") {
      image = "https://assets.tcgdex.net/es/sv/sv05/051";
    }
    const note = [
      c.illustrator && `Ilus. ${c.illustrator}`,
      c.originalSet && `Original: ${c.originalSet}${c.originalNumber ? ` ${c.originalNumber}` : ""}`,
      c.product,
    ]
      .filter(Boolean)
      .join(" · ");
    if (!image && !imageAlt) noImage++;
    lines.push(
      `INSERT INTO cards (id, set_id, number, sort_key, name, rarity, note, image, image_alt, source) VALUES (${q(`${set.id}-${number}`)}, ${q(set.id)}, ${q(number)}, ${sort}, ${q(c.name)}, ${q(c.rarity)}, ${q(note)}, ${q(image)}, ${q(imageAlt)}, 'seed');`,
    );
  }
  lines.push("");
}
writeFileSync(new URL("../migrations/0002_seed.sql", import.meta.url), lines.join("\n"));
console.log(`OK: ${lines.filter((l) => l.startsWith("INSERT INTO cards")).length} cartas`);
// Todas las cartas deben tener al menos una fuente de imagen
if (noImage) {
  console.error(`ERROR: ${noImage} cartas sin ninguna fuente de imagen`);
  process.exit(1);
}
