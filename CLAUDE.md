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
- **Glyph rendering:** SDF-rendered. Use [fontkit](https://github.com/foliojs/fontkit) for outlines. Fontkit is preferred over opentype.js for better OpenType feature support — ligatures, contextual alternates, and variable font axis handling all work out of the box, which matters because Söhne Breit's ligatures carry design intent. SDF atlas generated at build time or first-load and cached.
- **Physics:** [Rapier2D](https://rapier.rs/) via WASM. NOT Matter.js.
- **Convex decomposition:** required for glyph collision shapes. Use [decomp.js](https://github.com/pshihn/decomp.js) — a modern rewrite of poly-decomp with better output quality (fewer, cleaner hulls) on the specific shapes glyphs produce. Non-convex glyphs (o, e, p, a, d, g, q, b, etc.) will misbehave without decomposition — non-negotiable.
- **ML runtime:** [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) with WebGPU backend where available, WASM fallback.
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
│   ├── main.ts               (entry, sets up canvas, loop, input)
│   ├── /engine
│   │   ├── physics.ts        (Rapier world, body management)
│   │   ├── renderer.ts       (OGL/regl scene, SDF glyph rendering)
│   │   ├── input.ts          (keyboard state, word buffer, commit logic)
│   │   ├── loop.ts           (frame loop, physics substepping, sleep mgmt)
│   │   └── glyphs.ts         (opentype.js → outlines → convex hulls → SDF)
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
│   │   └── behaviors.ts      (special word behaviors — color words, onomatopoeia, etc.)
│   └── /util
├── /model                    (Python, PyTorch, dataset generation, training)
│   ├── generate_dataset.py
│   ├── train.py
│   ├── eval.py
│   ├── export_onnx.py
│   └── /data                 (word lists, labels, embeddings — gitignored if large)
├── /public
│   ├── /fonts                (Söhne Breit + Söhne Mono, licensed)
│   ├── og.png                (1200×630 OG image, static)
│   └── favicon.svg
└── /scripts
    ├── build-sdf-atlas.ts    (build-time SDF atlas generation)
    └── prepare-fonts.ts
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

- **Words are their own glyph outlines as physics bodies.** Not textured quads. Not sprites. Use opentype.js to extract the actual Bézier outlines of the current word, decompose into convex hulls, feed those to Rapier as compound colliders. Render the same outlines via SDF for crispness at any scale.
- **Variable font axes are driven by physics state.** Weight and optical size are wired to the ML property scores. A word predicted heavy renders heavier. This is the "the word IS the body" move. Do not skip it.
- **Physics runs at a target of 120Hz below 100 bodies, 60Hz between 100 and 200.** Density-aware. Automatic. Invisible to the user.
- **Bodies sleep aggressively.** Rapier's sleep thresholds tuned so a settled word stops simulating within ~500ms of coming to rest.
- **Angular velocity is damped hard.** Words should tumble slightly and settle flat. They should not spin like propellers.

---

## The ML contract

- **Property model:** a small MLP (~200k params) mapping a word (character-tokenized + optional word-lookup) to 6 semantic property scores: `mass`, `drag`, `restitution`, `warmth`, `age`, `intensity`. Trained offline in PyTorch, quantized to int8, exported to ONNX, loaded and run in-browser via ONNX Runtime Web.
- **Force field:** a small model (start with an MLP over local neighborhood; escalate to a tiny GNN or transformer only if needed) that outputs a 2D force vector for each active word based on nearby words' identities. Trained to produce clustering-without-collapse behavior. Baseline for comparison: cosine similarity in embedding space.
- **OOV fallback:** the property model has a character-level branch so any string, including nonsense, produces plausible properties. Never refuse to commit a word because the model hasn't seen it. Refuse only on numbers, empty strings, or > 24 chars.
- **Latency budget:** every keystroke must complete inference in under 5ms on a mid-range laptop. Batch when possible. Cache aggressively (a LRU by word string).
- **Model files live in `/src/ml/models/`.** Version them. `properties.v1.onnx`, `gravity.v1.onnx`. Never overwrite a shipped model in place.

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
