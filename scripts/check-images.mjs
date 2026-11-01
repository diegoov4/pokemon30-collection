// Comprueba que TODAS las cartas de la semilla tienen al menos una imagen descargable.
// Uso: node scripts/check-images.mjs   (necesita acceso a internet)
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../migrations/0002_seed.sql", import.meta.url), "utf8");
const rows = [...sql.matchAll(/^INSERT INTO cards .*? VALUES \('([^']+)', .*?, (NULL|'https:[^']*'), (NULL|'https:[^']*'), 'seed'\);$/gm)];

const unq = (v) => (v === "NULL" ? null : v.slice(1, -1));
const candidates = (image, alt) => {
  const out = [];
  if (image) {
    out.push(`${image}/high.webp`);
    if (image.includes("tcgdex.net/es/")) out.push(`${image.replace("tcgdex.net/es/", "tcgdex.net/en/")}/high.webp`);
  }
  if (alt) out.push(alt);
  return out;
};

async function works(url) {
  try {
    const res = await fetch(url);
    const type = res.headers.get("content-type") ?? "";
    const size = (await res.arrayBuffer()).byteLength;
    return res.ok && type.startsWith("image/") && size > 2048;
  } catch {
    return false;
  }
}

const missing = [];
const stats = { es: 0, en: 0, alt: 0 };
await Promise.all(
  rows.map(async ([, id, image, alt], i) => {
    await new Promise((r) => setTimeout(r, i * 40));
    for (const url of candidates(unq(image), unq(alt))) {
      if (await works(url)) {
        stats[url.includes("/es/") ? "es" : url.includes("tcgdex") ? "en" : "alt"]++;
        return;
      }
    }
    missing.push(id);
  }),
);
console.log(`${rows.length} cartas · imagen en español: ${stats.es} · TCGdex inglés: ${stats.en} · alternativa: ${stats.alt}`);
if (missing.length) {
  console.error(`SIN IMAGEN (${missing.length}): ${missing.join(", ")}`);
  process.exit(1);
}
console.log("OK: todas las cartas tienen imagen");
