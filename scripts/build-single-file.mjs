import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const htmlPath = path.join(root, "index.html");
const cssPath = path.join(root, "styles.css");
const jsPath = path.join(root, "app.js");
const iconPath = path.join(root, "assets", "vowcue-icon.png");
const outDir = path.join(root, "dist");
const outPath = path.join(outDir, "VowCue.html");
const tauriIndexPath = path.join(outDir, "index.html");

const [html, css, js, icon] = await Promise.all([
  readFile(htmlPath, "utf8"),
  readFile(cssPath, "utf8"),
  readFile(jsPath, "utf8"),
  readFile(iconPath),
]);

const iconDataUrl = `data:image/png;base64,${icon.toString("base64")}`;
const bundled = html
  .replaceAll("assets/vowcue-icon.png", iconDataUrl)
  .replace('<link rel="stylesheet" href="styles.css" />', `<style>\n${css}\n</style>`)
  .replace('<script src="app.js"></script>', `<script>\n${js}\n</script>`);

await mkdir(outDir, { recursive: true });
await writeFile(outPath, bundled);
await writeFile(tauriIndexPath, bundled);
console.log(`Wrote ${path.relative(root, outPath)}`);
console.log(`Wrote ${path.relative(root, tauriIndexPath)}`);
