// Copies the anime.js browser bundle into public/vendor so the sandboxed preview page can load it
// as a plain script. Runs after `npm install`.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const src = "node_modules/animejs/dist/bundles/anime.umd.min.js";
if (!existsSync(src)) {
  console.warn("copy-vendor: animejs is not installed yet, skipping.");
} else {
  mkdirSync("public/vendor", { recursive: true });
  copyFileSync(src, "public/vendor/anime.umd.min.js");
}
