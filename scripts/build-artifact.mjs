// Genera artifact/pokemon30.html (versión publicable en claude.ai) con el catálogo
// de migrations/0002_seed.sql embebido. Uso: node scripts/build-artifact.mjs
import { readFileSync, writeFileSync } from "node:fs";

const sql = readFileSync(new URL("../migrations/0002_seed.sql", import.meta.url), "utf8");

// Separa los valores de un VALUES (...) de SQL respetando comillas
function values(line) {
  const body = line.slice(line.indexOf("VALUES (") + 8, line.lastIndexOf(");"));
  const out = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === "'") {
      let s = "";
      i++;
      while (i < body.length) {
        if (body[i] === "'" && body[i + 1] === "'") { s += "'"; i += 2; }
        else if (body[i] === "'") { i++; break; }
        else s += body[i++];
      }
      out.push(s);
    } else {
      const end = body.indexOf(",", i);
      const raw = body.slice(i, end < 0 ? undefined : end).trim();
      out.push(raw === "NULL" ? null : Number(raw));
      i = end < 0 ? body.length : end;
    }
    while (body[i] === "," || body[i] === " ") i++;
  }
  return out;
}

const sets = [];
const cards = [];
for (const line of sql.split("\n")) {
  if (line.startsWith("INSERT INTO sets")) {
    const [id, name, kind, release, official] = values(line);
    sets.push({ id, name, kind, release, official });
  } else if (line.startsWith("INSERT INTO cards")) {
    const [id, set, number, sort, name, rarity, note] = values(line);
    cards.push({ id, set, number, sort, name, rarity, note });
  }
}
const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
// Misma hoja de estilos que la web del Worker, ajustada para claude.ai
const css = read("../public/styles.css")
  .replace(".topbar {\n  position: sticky; top: 0;", ".topbar {\n  position: sticky; top: env(safe-area-inset-top, 0px);")
  .replace(".login { min-height: 100vh;", ".login { min-height: 90vh;");
const js = read("../artifact/app.js").replace("/*CATALOG*/null", JSON.stringify({ sets, cards }));
const html = `<title>Pokémon 30</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>
${css}
${read("../artifact/extra.css")}
</style>
${read("../artifact/markup.html")}
<script>
${js}
</script>
`;
writeFileSync(new URL("../artifact/pokemon30.html", import.meta.url), html);
console.log(`artifact/pokemon30.html: ${sets.length} colecciones, ${cards.length} cartas, ${(html.length / 1024).toFixed(0)} KB`);
