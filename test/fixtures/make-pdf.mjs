// Writes test/fixtures/two-pages.pdf: a minimal hand-built PDF (two pages of
// text in Helvetica), so the tests need no external download. Run with
// `node test/fixtures/make-pdf.mjs` after changing it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pages = ["Hello from page one", "Second page text"];
const objects = [];
const add = (body) => objects.push(body) && objects.length;

const catalog = add(""); // filled in below
const pagesObj = add("");
const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
const kids = pages.map((text) => {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  return add(
    `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
  );
});
objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

let out = "%PDF-1.4\n";
const offsets = objects.map((body, i) => {
  const at = out.length;
  out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  return at;
});
const xref = out.length;
out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), "two-pages.pdf");
fs.writeFileSync(dest, out, "latin1");
console.log(`wrote ${dest} (${out.length} bytes)`);
