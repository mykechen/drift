/**
 * What a cold visit actually costs, per asset, over the wire.
 *
 * Run after `pnpm build`. Brotli-compresses every file in `dist/` at quality 11
 * — what a CDN serves — and reports the subset a first-time visitor on each
 * route actually downloads.
 *
 * The cold set is derived, not declared. Starting from a route's HTML, every
 * `/assets/…` and `/…` reference is followed recursively through the JS and CSS
 * it pulls in. Vite emits asset URLs as literal strings, so the `.wasm` and
 * `.onnx` that are fetched at runtime rather than imported statically are found
 * the same way the browser finds them. A hand-maintained list would drift; this
 * cannot.
 *
 * Usage:
 *   pnpm measure
 *   pnpm measure --json     machine-readable, for diffing against a baseline
 */

import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DIST = resolve(import.meta.dirname, "..", "dist");

/** The routes a visitor can land on. Debug pages are excluded deliberately. */
const ROUTES: Readonly<Record<string, string>> = {
  desktop: "index.html",
};

/** Extensions worth scanning for further asset references. */
const TEXTUAL = new Set([".html", ".js", ".css", ".mjs"]);

interface Asset {
  readonly path: string;
  readonly raw: number;
  readonly brotli: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(DIST, full));
  }
  return out;
}

function brotliSize(bytes: Buffer): number {
  return brotliCompressSync(bytes, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  }).length;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

/**
 * Every in-repo path referenced by a file. Deliberately greedy: it matches any
 * quoted `/…`-rooted path with an extension, which catches `<script src>`,
 * `<link href>`, `import(…)`, and the bare URL strings Vite inlines for
 * `?url` imports alike.
 */
function referencesIn(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/["'`(](\/[\w./-]+\.\w+)["'`)]/g)) {
    found.add(match[1]!.slice(1));
  }
  return [...found];
}

/** Transitive closure of what a route downloads, in discovery order. */
function coldSetFor(entry: string, available: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path) || !available.has(path)) continue;
    seen.add(path);
    if (!TEXTUAL.has(extensionOf(path))) continue;

    const source = readFileSync(join(DIST, path), "utf8");
    for (const reference of referencesIn(source)) {
      if (!seen.has(reference)) queue.push(reference);
    }
  }
  return [...seen];
}

function kb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

function main(): void {
  const files = walk(DIST);
  const sizes = new Map<string, Asset>();
  for (const path of files) {
    const bytes = readFileSync(join(DIST, path));
    sizes.set(path, { path, raw: bytes.length, brotli: brotliSize(bytes) });
  }

  const available = new Set(files);
  const routes = Object.entries(ROUTES).map(([name, entry]) => {
    const paths = coldSetFor(entry, available)
      .map((path) => sizes.get(path)!)
      .sort((a, b) => b.brotli - a.brotli);
    return {
      name,
      assets: paths,
      total: paths.reduce((sum, asset) => sum + asset.brotli, 0),
    };
  });

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ routes }, null, 2)}\n`);
    return;
  }

  const lines: string[] = [];
  for (const route of routes) {
    lines.push(`\ncold ${route.name} visit`);
    lines.push("| Asset | Brotli | Raw |");
    lines.push("|---|---|---|");
    for (const asset of route.assets) {
      lines.push(
        `| ${asset.path} | ${kb(asset.brotli)} KB | ${kb(asset.raw)} KB |`,
      );
    }
    lines.push(`| **TOTAL** | **${kb(route.total)} KB** | |`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
