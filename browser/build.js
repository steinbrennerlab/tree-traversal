#!/usr/bin/env node
/**
 * Build script for PhyloScope standalone bundle.
 * Bundles ES modules into a single file and copies assets to docs/.
 */

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const DIST = path.join(__dirname, "..", "docs");
const STATIC = path.join(__dirname, "static");

// Clean and create dist/
if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true });
}
fs.mkdirSync(DIST, { recursive: true });

async function build() {
  // Bundle JS modules starting from app.js
  await esbuild.build({
    entryPoints: [path.join(STATIC, "app.js")],
    bundle: true,
    format: "iife",
    outfile: path.join(DIST, "app.bundle.js"),
    minify: true,
    sourcemap: false,
    target: ["es2020"],
  });

  // Copy static assets
  const assets = ["style.css", "logo.png", "jspdf.umd.min.js", "svg2pdf.umd.min.js"];
  for (const asset of assets) {
    fs.copyFileSync(path.join(STATIC, asset), path.join(DIST, asset));
  }

  // Read source index.html and rewrite script tag for bundled output
  const srcHtml = fs.readFileSync(path.join(STATIC, "index.html"), "utf-8");
  const distHtml = srcHtml
    .replace(
      '<script type="module" src="./app.js"></script>',
      '<script src="./app.bundle.js"></script>'
    );
  fs.writeFileSync(path.join(DIST, "index.html"), distHtml);

  console.log("Built to docs/");
  console.log("  index.html");
  console.log("  app.bundle.js");
  for (const a of assets) console.log(`  ${a}`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
