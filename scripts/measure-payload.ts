/**
 * What a cold visit actually costs, per asset, over the wire.
 *
 * Run after `pnpm build`. Brotli-compresses every file in `dist/` at quality 11
 * — what a CDN serves — and reports the subset a first-time visitor on each
 * route actually downloads.
 *
 * The cold set is derived, not declared. Starting from a route's HTML, every
 * referenced path is followed recursively through the JS and CSS it pulls in.
 * Vite emits asset URLs as literal strings, so the `.wasm` and `.onnx` that are
 * fetched at runtime rather than imported statically are found the same way the
 * browser finds them. A hand-maintained list would drift; this cannot.
 *
 * **Desktop and mobile are told apart by the import kind, not by a list.** The
 * two routes are the same HTML — what differs is that mobile takes the branch
 * that never calls `import("./boot")`. So the mobile set is the closure over
 * *static* edges only, and the desktop set is the closure over all of them. That
 * distinction is readable straight out of the bundle: a dynamic import is the
 * one whose specifier is preceded by `(`. It survives further code-splitting,
 * because anything moved behind a dynamic import leaves the mobile set by
 * construction.
 *
 * **One known over-count, and it is deliberate.** The fallback still is
 * referenced from the entry chunk, which both routes download, so it is
 * attributed to desktop as well — though a desktop visit never requests it
 * (verified in the browser: 13 requests, no `.webp`). Reachability is all a
 * static walk can see; it cannot see that the branch is never taken. The error
 * is ~20 KB and it over-states the number this phase is trying to reduce, which
 * is the safe direction for it to be wrong in.
 *
 * Usage:
 *   pnpm measure
 *   pnpm measure --json     machine-readable, for diffing against a baseline
 */

import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DIST = resolve(import.meta.dirname, "..", "dist");

interface Route {
  readonly entry: string;
  /**
   * Whether this route follows dynamic imports. Mobile does not: it is shown
   * the fallback and never reaches the `import("./boot")` that pulls in the
   * physics runtime, the glyph pipeline, the ONNX runtime and the model.
   */
  readonly followsDynamicImports: boolean;
}

/** The routes a visitor can land on. Debug pages are excluded deliberately. */
const ROUTES: Readonly<Record<string, Route>> = {
  desktop: { entry: "index.html", followsDynamicImports: true },
  mobile: { entry: "index.html", followsDynamicImports: false },
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

interface Reference {
  /** Path relative to `dist/`. */
  readonly path: string;
  /** Reached through `import(…)` rather than a static import or markup. */
  readonly dynamic: boolean;
}

/** Resolve a reference against the directory of the file that made it. */
function resolveReference(from: string, reference: string): string {
  if (reference.startsWith("/")) return reference.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const segment of reference.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/**
 * Every in-repo path referenced by a file, tagged by how it is reached.
 *
 * Deliberately greedy: it matches any quoted path with an extension, rooted or
 * relative, which catches `<script src>`, `<link href>`, chunk-to-chunk
 * imports, and the bare URL strings Vite inlines for `?url` imports alike.
 *
 * A reference counts as dynamic only when a literal `import(` sits in front of
 * it. Matching on the adjacent delimiter instead is the obvious shortcut and it
 * is wrong: the bundler emits template literals, so the character next to the
 * path is the backtick and every dynamic import reads as static.
 *
 * **`url(` is accepted unquoted, and that was a real miss.** A quote was
 * originally required before the path, which is true of every reference in HTML
 * and JS — but Vite minifies CSS to `url(/fonts/x.woff2)` with the quotes
 * stripped, so the mono subset was invisible to this script while being
 * genuinely downloaded by the mobile route. The failure mode is the dangerous
 * direction: it under-reports, and these numbers are the ones the roadmap
 * treats as a budget.
 */
function referencesIn(from: string, source: string): Reference[] {
  const PATH =
    /(import\s*\(\s*)?(?:["'`]|url\(\s*)((?:\/|\.{1,2}\/)[\w./-]+\.\w+)/g;
  const found = new Map<string, boolean>();
  for (const match of source.matchAll(PATH)) {
    const path = resolveReference(from, match[2]!);
    const dynamic = match[1] !== undefined;
    // A path reached both ways is static: the static edge is the one that
    // decides whether it is downloaded before the branch is taken.
    found.set(path, (found.get(path) ?? true) && dynamic);
  }
  return [...found].map(([path, dynamic]) => ({ path, dynamic }));
}

/** Transitive closure of what a route downloads, in discovery order. */
function coldSetFor(route: Route, available: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const queue = [route.entry];

  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path) || !available.has(path)) continue;
    seen.add(path);
    if (!TEXTUAL.has(extensionOf(path))) continue;

    const source = readFileSync(join(DIST, path), "utf8");
    for (const reference of referencesIn(path, source)) {
      if (reference.dynamic && !route.followsDynamicImports) continue;
      if (!seen.has(reference.path)) queue.push(reference.path);
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
  const routes = Object.entries(ROUTES).map(([name, route]) => {
    const paths = coldSetFor(route, available)
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
