# CLAUDE.md — Drift

You are helping build **Drift**, a browser-based interactive piece where typed words become physical objects with mass, drag, and semantic behavior determined by a small ML model running client-side. Read this file at the start of every session. Read `DESIGN.md`, `brand-guidelines.md`, and `ROADMAP.md` before making decisions in their domains.

---

## What this project is

A single-page interactive piece. One route. No CMS, no auth, no case study, no about page, no navigation. The URL loads and the user is immediately in the room.

The user types words. Each word becomes a physics body whose properties are inferred by a small MLP that runs in the browser via ONNX Runtime Web. Words fall, land, and accumulate. Related words drift toward each other via a learned force field. The room is warm, off-white, quiet, playful.

This is a portfolio piece, not a product. It ships when it feels right, not when a checklist is done.

## What this project is NOT

- Not a case study site. There is no `/notes`, `/about`, or writeup route in this repo.
- Not a spatial 3D piece. Physics is 2D side-view. No Three.js. No camera controls.
- Not a mobile-first experience. Desktop-only interaction; mobile shows a static example image and a note.
- Not a product with analytics, sign-in, or user accounts.
- Not a generative-art SPA with dozens of features. One idea, executed with total commitment.

If a proposed feature does not directly serve *"typed word becomes a physical body with semantic behavior,"* it does not belong in v1.

---

## Tech stack (locked)

- **Language:** TypeScript, strict mode, no `any` in checked-in code
- **Framework:** [Vite](https://vitejs.dev/) + vanilla TS. No React, no Vue, no Svelte. The piece has no component tree worth managing.
- **Rendering:** WebGL via [OGL](https://github.com/oframe/ogl) (preferred) or [regl](https://github.com/regl-project/regl). NOT Three.js.
  - *Future note:* WebGPU is viable in 2026 (Chrome, Edge, Safari; Firefox still lagging). If v2 introduces compute-shader work — for example, moving the semantic-gravity force field onto the GPU — migrating to WebGPU via `webgpu-utils` becomes worthwhile. For v1, WebGL is correct: broader support, less setup, and no compute shaders in scope.
- **Display typeface:** [Archivo](https://github.com/Omnibus-Type/Archivo) variable (`wght 100–900`, `wdth 62–125`), SIL OFL, in `/public/fonts/Archivo.ttf`. Replaced Söhne Breit in Phase 2 because Klim ships Söhne static-only and the variable-axis wiring is load-bearing — see the note in `DESIGN.md`. Archivo is TrueType, so outlines are quadratic curves only; there are no cubics to flatten.
- **Glyph rendering:** SDF-rendered. [fontkit](https://github.com/foliojs/fontkit) reads the outlines, but **at build time only — it is a devDependency and never ships.** Phase 2.5 took the "if that becomes a problem" escape hatch this entry used to describe: `scripts/build-glyph-outlines.ts` samples `font.getVariation({ wght, wdth })` over a 6×3 axis grid and writes `src/engine/glyph-outlines.bin`; the runtime interpolates between samples. Point-compatibility is what makes that safe, and the script *checks* it per glyph rather than trusting it. Two things to know before touching this: what is baked is the **raw quadratic control points**, not flattened polygons, so the flattening tolerance stays a runtime knob and the SDF has true curves to read; and the grid must **land on the font's masters** — `wdth 100` is one, and a grid that misses it measures nine times the interpolation error. Ligatures (`ff fi fl ffi ffl`) are baked as their own entries because dropping fontkit means dropping `layout()`, which is what applied them.
- **Physics:** [Rapier2D](https://rapier.rs/) via WASM. NOT Matter.js. Use `@dimforge/rapier2d`, **not** `-compat`: the compat build base64-inlines its WebAssembly into the JS, which costs 121KB brotli over the raw binary and prevents the engine being cached as its own file. It must be listed in `optimizeDeps.exclude` — the dependency pre-bundle breaks its `__wbg_set_wasm` hand-off, and it fails *only in dev*, at the first `createRigidBody`.
- **Convex decomposition:** required for glyph collision shapes. Use [earcut](https://github.com/mapbox/earcut) to tessellate, then merge triangles into convex hulls.
  - This originally specified `decomp.js`, described as "a modern rewrite of poly-decomp." **That package does not exist** — the linked repository 404s and there is no such npm package. The real alternative, `poly-decomp`, does not handle holes, which is precisely the stated problem. earcut handles holes natively, is ~2KB, and is battle-tested in Mapbox GL.
  - **Contour count does not tell you about holes.** `i` has two contours that are both outer (stem and tittle); `o` has two where the second is a hole; `g` has three. Classify by signed area to get winding, then assign each hole to the outer contour containing it. Getting this wrong makes `i` a solid blob or `o` a solid disc, and both look fine until something has to land in the counter.
  - Non-convex glyphs (o, e, p, a, d, g, q, b) will misbehave without decomposition — non-negotiable.
- **ML runtime:** [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/), **WebAssembly backend only** — import the `onnxruntime-web/wasm` entry, single-threaded. This originally specified WebGPU with a WASM fallback; Phase 1c measured both and WebGPU lost on every axis. On an Apple Metal-3 adapter the property model runs at p50 0.10ms / p95 0.20ms on WASM against p50 1.50ms / p95 2.30ms on WebGPU, with a 326ms cold first inference, and ORT's WebGPU build needs the 23MB Asyncify binary where the plain build needs 13MB (3.28MB vs 2.05MB brotli). Both causes are structural: a 570k-parameter model with a batch of one has nothing to parallelise, so per-dispatch overhead is the entire cost. Note that the wasm binary is coupled to the entry point — each ORT build binds only to its matching `.wasm`, and a mismatch fails deep inside the runtime with a mangled-name `TypeError`. Phase 5's force field is a different shape and gets measured on its own terms rather than inheriting this.
- **Model training (offline):** PyTorch. Training code lives in `/model` and is checked in.
- **Audio:** Web Audio API directly. Drift's audio needs are small — sample playback with pitch/volume variance, an ambient bed with slow modulation, a master mute. A ~150-line `Sampler` + `Bed` implementation covers everything. Tone.js is a musical framework built for procedural synthesis and sequencing — Drift is neither, and the ~40KB it costs is unjustified. Ship samples as small mp3s from `/public/audio/`.
- **Build:** Vite. `pnpm` for packages.
- **Hosting:** Vercel. No backend at runtime — no serverless functions, no edge functions, no middleware. All ML is client-side. All assets static.
- **Caching:** ONNX model files are versioned (`properties.v1.onnx`, `gravity.v1.onnx`) and served with `Cache-Control: public, max-age=31536000, immutable`. Same for the SDF atlas and font files. Configure in `vercel.json` at the repo root via its `headers` array. This is important — the property model will be a few MB after int8 quantization, and cold visits should hit the edge cache, not the origin. Note that Vercel fingerprints Vite's own build output under `/assets/` and caches it immutably by default; the rule is for the hand-placed files in `/public/`, which Vercel does not fingerprint.
- **Domain:** `drift.[TBD]`

Do not introduce dependencies not on this list without asking. Every additional runtime dependency is a liability.

---

## Repo structure

```
/
├── CLAUDE.md                 (this file)
├── DESIGN.md                 (design + interaction spec)
├── brand-guidelines.md       (identity)
├── ROADMAP.md                (build order)
├── README.md                 (minimal, public-facing)
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
├── /src
│   ├── main.ts               (entry; detects mobile, then dynamic-imports boot.ts)
│   ├── boot.ts               (the piece: canvas, loop, input — desktop only)
│   ├── /engine
│   │   ├── physics.ts        (Rapier world, body management)
│   │   ├── renderer.ts       (OGL/regl scene, SDF glyph rendering)
│   │   ├── input.ts          (keyboard state, word buffer, commit logic)
│   │   ├── loop.ts           (frame loop, physics substepping, sleep mgmt)
│   │   ├── glyphs.ts         (baked outlines → convex hulls → SDF)
│   │   └── glyph-outlines.bin (baked by /scripts, imported with ?url)
│   ├── /ml
│   │   ├── properties.ts     (word → 6 property scores, ONNX inference)
│   │   ├── gravity.ts        (semantic gravity force field)
│   │   ├── fallback.ts       (char-level fallback for OOV words)
│   │   └── /models           (ONNX files, quantized int8)
│   ├── /design
│   │   ├── palette.ts        (colors, time-of-day shift)
│   │   ├── motion.ts         (spring configs, easing curves)
│   │   └── sound.ts          (audio events, ambient bed)
│   ├── /world
│   │   ├── room.ts           (composition, camera, background, density mgmt)
│   │   ├── fallback.ts       (mobile detection + the fallback screen)
│   │   └── behaviors.ts      (special word behaviors — color words, onomatopoeia, etc.)
│   └── /util
├── /model                    (Python, PyTorch, dataset generation, training)
│   ├── generate_dataset.py
│   ├── train.py
│   ├── eval.py
│   ├── export_onnx.py
│   └── /data                 (word lists, labels, embeddings — gitignored if large)
├── /public
│   ├── /fonts                (Archivo variable, SIL OFL — build input, not served to visitors)
│   ├── mobile-fallback.webp  (still of a composition, for the mobile screen)
│   ├── og.png                (1200×630 OG image, static)
│   └── favicon.svg
└── /scripts
    ├── build-glyph-outlines.ts (bakes the axis grid — `pnpm bake:glyphs`)
    ├── measure-payload.ts    (per-asset brotli cost of a cold visit — `pnpm measure`)
    └── build-sdf-atlas.ts    (build-time SDF atlas generation — Phase 3)
```

---

## Coding conventions

- **TypeScript strict.** No `any`. If you need `any`, add a `// TODO` and a comment explaining the type problem.
- **Explicit over clever.** This is a piece that will be read by design engineers reviewing the author's work. Code readability is a design decision. Prefer named functions over anonymous callbacks in hot loops. Prefer clear variable names to short ones.
- **No magic numbers.** Every constant that has a design meaning lives in `/src/design`. Physics constants live in `/src/engine/physics.ts` grouped at the top of the file.
- **One-line JSDoc on non-obvious functions.** Especially anything in `/src/ml`.
- **Never use browser storage APIs** — no localStorage, no sessionStorage, no IndexedDB. Sessions are ephemeral. This is a design decision, not a technical one.
- **Never add analytics or telemetry.** Not Plausible, not Fathom, nothing. Silence.
- **No console.log left in shipped code.** Use a small `debug(namespace, ...)` wrapper that is a no-op in prod.
- **Formatting:** Prettier defaults. ESLint with typescript-eslint recommended, plus `@typescript-eslint/no-explicit-any: error`.

---

## The rendering / physics contract

The single most important architectural decision:

- **Words are their own glyph outlines as physics bodies.** Not textured quads. Not sprites. Take the actual outlines of the current word at its predicted axis values — interpolated from the baked grid, no font parsing at runtime — decompose into convex hulls, feed those to Rapier as compound colliders. Render the same outlines via SDF for crispness at any scale.
- **Variable font axes are driven by physics state.** Weight and optical size are wired to the ML property scores. A word predicted heavy renders heavier. This is the "the word IS the body" move. Do not skip it.
- **Physics runs at a target of 120Hz below 100 bodies, 60Hz between 100 and 200.** Density-aware. Automatic. Invisible to the user.
- **Bodies sleep aggressively.** Rapier's sleep thresholds tuned so a settled word stops simulating within ~500ms of coming to rest.
- **Angular velocity is damped hard.** Words should tumble slightly and settle flat. They should not spin like propellers.

---

## The ML contract

- **Property model:** a small MLP (~200k params) mapping a word (character-tokenized + optional word-lookup) to 6 semantic property scores: `mass`, `drag`, `restitution`, `warmth`, `age`, `intensity`. Trained offline in PyTorch, quantized to int8, exported to ONNX, loaded and run in-browser via ONNX Runtime Web.
- **Force field:** a small model (start with an MLP over local neighborhood; escalate to a tiny GNN or transformer only if needed) that outputs a 2D force vector for each active word based on nearby words' identities. Trained to produce clustering-without-collapse behavior. Baseline for comparison: cosine similarity in embedding space.
- **OOV fallback:** the property model has a character-level branch so any string, including nonsense, produces plausible properties. Never refuse to commit a word because the model hasn't seen it. Refuse only on numbers, empty strings, or > 24 chars.
- **Latency budget:** every keystroke must complete inference in under 5ms on a mid-range laptop. Batch when possible. Cache aggressively (a LRU by word string). `session.run()` is always asynchronous — "synchronously" in `DESIGN.md`'s commit spec means *within one frame*, not literally blocking. Warm every session with a throwaway inference at load: the first run through a fresh session costs ~25ms of one-time kernel setup and the first word a visitor types must not be the one that pays it.
- **Model files live in `/src/ml/models/`.** Version them. `properties.v1.onnx`, `gravity.v1.onnx`. Never overwrite a shipped model in place. They are imported with Vite's `?url` suffix, which fingerprints them into `/assets/` where Vercel already caches immutably — so they need no `vercel.json` rule, unlike the hand-placed files in `/public`. `.onnx` must stay listed in `assetsInclude`.
- **Word-to-id lookup stays in JavaScript.** The exported graph is pure arithmetic — integer tensors in, float tensor out, no string ops — which is what keeps it quantizable and portable across backends. The vocabulary ships beside the model as a newline-delimited word list whose line number *is* the id; `export_onnx.py` asserts that contiguity rather than trusting it. The character encoding in `src/ml/properties.ts` mirrors `model/data.py` exactly: a mismatch does not throw, it silently returns some other word's properties.

Training pipeline in `/model/` is checked in and reproducible. `python model/generate_dataset.py && python model/train.py && python model/export_onnx.py` should build the shipping models from scratch.

---

## Build order

Follow `ROADMAP.md`. Do not build the shiny rendering before the property model works end-to-end. This is a real risk on this project and the reason ROADMAP.md exists.

## What "done" looks like for v1

- User can type words, they commit on space or enter, they fall, they accumulate.
- Property model predicts believable mass/drag/etc for the ~200 words in the curated demo set. "Boulder thuds, feather drifts" test passes.
- Semantic gravity is on. Related words drift toward each other. Antonyms don't. Baseline vs. learned ablation is documented in `/model/eval.py` output.
- Density management works: soft cap at 200 words, oldest fades. No jitter at density.
- Palette, type, sound, time-of-day light shift all implemented per `DESIGN.md`.
- Special behaviors: 4–6 of the ones listed in `DESIGN.md`, no more.
- Still-image export works (renders current composition to PNG).
- Session replay URL works (encodes word sequence + timings into URL, replays on load).
- Mobile fallback screen renders correctly.
- OG image is set.
- Lighthouse score: 100 on performance, accessibility, best practices, SEO. The site is a single canvas — this is achievable.

## What is explicitly out of scope for v1

- Multilingual support
- User accounts, saved rooms, galleries
- Case study / notes / about pages
- Dark mode
- Any additional visual modes beyond the one designed
- Comments, sharing to specific platforms (native share sheet is fine), analytics
- A CMS or blog

If you find yourself building any of these, stop and ask.

## When you are uncertain

Ask. Do not silently choose a direction that changes the character of the piece. Small implementation choices (which npm package to use for a leaf utility, how to structure a helper) are yours. Choices that touch design, ML architecture, interaction model, or scope come back to the author.

## Credit

Piece by [YOUR NAME]. Built with Claude Code.
