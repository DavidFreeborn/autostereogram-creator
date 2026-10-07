import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const options = {
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  target: "es2022",
  legalComments: "none",
};
const worker = await build({
  ...options,
  entryPoints: [path.join(root, "src/worker.js")],
});
const workerCode = worker.outputFiles[0].text;
const source = (await readFile(path.join(root, "src/app.js"), "utf8"))
  .replace(
    /new URL\(["']\.\/worker\.js["'],\s*import\.meta\.url\)/,
    () =>
      `URL.createObjectURL(new Blob([${JSON.stringify(workerCode)}], {type:'text/javascript'}))`,
  )
  // File-origin module workers are restricted in some browsers. The bundled
  // worker has no imports, so a classic blob worker remains fully offline.
  .replace(/type:\s*["']module["']/, 'type: "classic"');
const app = await build({
  ...options,
  stdin: {
    contents: source,
    resolveDir: path.join(root, "src"),
    sourcefile: "app.js",
  },
});
const css = await readFile(path.join(root, "src/style.css"), "utf8");
const script = app.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = (await readFile(path.join(root, "index.html"), "utf8"))
  .replace(
    /<link rel="stylesheet" href="\/src\/style\.css"\s*\/?\s*>/,
    () => `<style>${css}</style>`,
  )
  .replace(/<script type="module" src="\/src\/app\.js"><\/script>/, "")
  .replace("</body>", () => `<script>${script}</script>\n</body>`);
await mkdir(path.join(root, "dist"), { recursive: true });
await writeFile(path.join(root, "dist/autostereogram-studio.html"), html);
await writeFile(path.join(root, "dist/index.html"), html);
await writeFile(path.join(root, "dist/.nojekyll"), "");
await writeFile(path.join(root, "dist/EB-GARAMOND-OFL.txt"), await readFile(path.join(root, "EB-GARAMOND-OFL.txt")));
console.log(
  "Built dist/autostereogram-studio.html. Open it directly in a browser; no server needed. Optional photo depth estimation downloads its model on first use.",
);
