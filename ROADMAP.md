# ROADMAP.md — Drift

Build order. The order matters. Every phase gates the next. Do not skip ahead to shinier work — the first two phases are load-bearing and the piece cannot recover from cutting corners on them.

Timelines are illustrative — this is an ongoing project with no deadline. Use them as internal expectations, not commitments.

Phases are annotated as they complete, including where the plan turned out to be wrong. The annotations are the point: `docs/build-log.md` carries the full reasoning, this file carries what changed and why.

---

## State of play

| Phase | State |
| --- | --- |
| 0 — Environment and skeleton | **done** |
| 1 — The property model | **done**, all exit criteria met |
| 2 — Words as physics bodies | **feel test 1 passes.** SDF not started; rotation open |
| 2.5 — Payload | **not started** (added after Phase 2 — see below) |
| 3–9 | not started |

**Actual build order, revised.** Two changes from the original sequence:

1. **Phase 2.5 (payload) is new**, and sits immediately after Phase 2. Lighthouse 100 on performance is a Phase 8 exit criterion and the piece currently ships roughly 3MB compressed. Every fix is architectural, so discovering it at Phase 8 means rewriting loading with a launch date in view.
2. **Phase 5a runs before Phase 4.** Semantic gravity interacts with the physics core — specifically with the freezing behaviour Phase 2 introduced — and that question sits underneath Phase 3's and Phase 4's work. Sound interacts with nothing and can wait.

So: `2 → 2.5 → 3 → 5a → 4 → 5b → 6 → 7 → 8 → 9`.

---

## Phase 0 — Environment and skeleton (2–3 days) — **done**

The floor. Everything else stands on this.

- [x] Vite + TypeScript strict project, `pnpm` for packages.
- [x] Prettier + ESLint configured per `CLAUDE.md`. — guardrails verified by deliberately introducing an `any` and a `console.log` and watching the lint fail.
- [x] Repo structure per `CLAUDE.md`.
- [x] Empty canvas rendering (OGL scene, background color `#F4F0E8`).
- [x] Keyboard input handler capturing typing.
- [x] Frame loop with `requestAnimationFrame` and a fixed-timestep physics accumulator.
- [x] Basic `debug()` no-op wrapper. — verified absent from the production bundle.
- [x] Deployed to Vercel under a preview URL. First deploy on day one. — moved from Cloudflare Pages partway through; caching rules live in `vercel.json`.

**Exit criteria:** blank canvas is live at a URL; typing in it does nothing but is captured. — **met.**

> **TypeScript is pinned to 6.x, not 7.** `typescript-eslint` refuses to load against the TS 7 native compiler. The lint guardrail wins over the newer compiler. Revisit when upstream support ships.

---

## Phase 1 — The property model (2–3 weeks) — **done**

**This is the phase that decides whether Drift works.** Do this before touching physics or rendering meaningfully. If the ML doesn't feel right, no amount of downstream polish saves the piece.

### 1a. Dataset generation (~3 days) — **done**

- [x] Assemble a word list of ~50k common English words. — used `wordfreq` rather than Google Ngram, unioned with a curated seed list drawn from the design documents. **10,750 words were labeled, not 50k** — the run was budget-limited and stopped deliberately; the character branch covers everything past the lookup table by design.
- [x] Design 6 semantic property axes with clear anchor examples per axis (in `/model/axes.md`).
- [x] Write an LLM labeling pipeline in `/model/generate_dataset.py`. — **two passes**, because `drag` is a residual and needs `mass` to exist first. Resumable, provenance-stamped per row.
- [x] Cost estimate before running: keep it under $200. — came in far under.
- [x] Manually spot-check labels. — done as three 24-word pilots plus a 48-word cross-provider calibration, all before bulk spend.
- [x] Freeze the dataset. Version it. — `model/data/dataset.csv`, 10,750 words. Committed rather than treated as a rebuildable cache: LLM output is not deterministic and the labeling budget is spent.

> **The axes were nearly redundant and it was caught for free.** Three chatbot pilots plus correlation arithmetic found `mass × drag` at −0.90 and `mass × intensity` at +0.74 before a cent was spent. Reframing `drag` as a *residual* — does this word fall faster or slower than its weight predicts — fixed it by construction. On the real corpus no pair now correlates above 0.49. That residual framing later turned out to be exactly the quantity the physics needed.

> **A curated seed list must be labeled first.** Curated words were merged in at their frequency rank, so `ember` (rank 30k) and `zounds` (rank 151k) sorted into the tail and the budget-limited run never reached them. The words the piece is judged on were exactly the ones missing.

### 1b. Model training (~4–5 days) — **done**

- [x] Small MLP architecture in `/model/train.py`.
- [x] 90/10 train/eval split. — retained as a diagnostic; the shipped checkpoint trains on everything (`--ship`), since the deployed model memorises the whole vocabulary by design.
- [x] Train to convergence.
- [x] Report eval MAE per axis. Aim for < 0.15 on average. — train MAE **0.018** in ship mode. The `< 0.15` target applies to memorised vocabulary, which is what ships; genuinely unseen words have no ground truth to hit.
- [x] Manually inspect predictions on the anchor list. — all read correctly.

> **Deviations from the plan.** Total params are ~570k, not the ~200k target — the word-lookup table for 10,750 words dominates. And the character branch is a **mean-pool, not order-aware**: a bidirectional GRU was tried and made held-out error *worse* (0.31 vs 0.24), because a word's physical feel is semantic, not orthographic. Nothing in the letters of `grief` says heavy.

### 1c. Export and in-browser inference (~3 days) — **done**

- [x] Export to ONNX in `/model/export_onnx.py`.
- [x] Quantize to int8. Verify predictions still feel right after quantization. — 2.29MB → 583KB, max per-word delta 0.022 over all 10,750 words, zero sign flips, boulder–feather mass gap holds at 1.47. The script applies a printed selection rule and refuses to write a model that fails feel test 1.
- [x] Set up ONNX Runtime Web in the project. ~~WebGPU backend, WASM fallback.~~ **WASM only** — WebGPU measured 15× slower and 1.2MB heavier on this model; see the ML runtime entry in `CLAUDE.md`.
- [x] Build a debug page (`/debug/properties`) that shows scores for any word typed. Ship this internally; do not link publicly. — built into the deploy, `noindex`, disallowed in `robots.txt`, linked from nowhere.
- [x] Measure inference latency. Must be under 5ms on a mid-range laptop. — p50 0.10ms, p95 0.20ms, max 0.30ms over 299 distinct cache-missing words. 25× inside budget.
- [x] Add LRU cache keyed by word string, cap at ~5000 entries.

**Exit criteria:** typing any word into the debug page returns 6 believable scores in under 5ms, offline, in the browser. — **met.**

---

## Phase 2 — Words as physics bodies (1.5–2 weeks) — **exit criteria met, two items open**

Now that words have properties, make them things.

- [x] Glyph outline extraction with fontkit. Load Archivo variable; extract outlines for any word at arbitrary `wght`/`wdth`.
- [x] Convex decomposition of glyph paths via earcut, classifying contours by winding. Verify manually on `o`, `e`, `p`, `d`, `g`, `a`, `b`, `q` — and on `i`, whose two contours are both outer, which is the case a naive implementation gets wrong. — verified by eye at `/debug/glyphs`, which draws hulls as translucent fills over the true outline.
- [ ] SDF atlas generation (build-time or first-load). **Not started.** Words currently draw as flat fills of the same triangulation their colliders were cut from, which makes it impossible for the picture to disagree with the simulation.
- [ ] SDF rendering shader in OGL. Crisp glyphs at any scale. **Not started.**
- [x] Wire variable font axes (`wght` ← mass, `wdth` ← intensity) to property scores.
- [x] Rapier 2D world set up. Gravity down. Canvas boundaries as walls (bottom + sides), open top.
- [x] Commit pipeline: word → outlines → convex hulls → Rapier compound body with mass/drag/restitution from properties.
- [x] Physics substepping and density-aware framerate management. — 120Hz below 100 bodies, 60Hz above, sampled once per frame so the timestep is never variable *within* a frame.
- [x] Sleep management with tuned thresholds. — **not by tuning thresholds.** Rapier's JS bindings do not expose them, and sleeping is island-based so a full pile never qualifies. Settled words are converted to *static* bodies instead. A full 200-word room steps in 10.5ms p50 against a 16.7ms budget and reaches 200/200 frozen.
- [x] Angular velocity damping. — implemented, but see the open item below: damping alone does not produce the specified outcome.
- [ ] **Words settle at arbitrary angles.** Median rotation 98.6°, max 179.4° in a settled room — half of them sideways or upside down. `CLAUDE.md` asks for "tumble slightly and settle flat" and a room of unreadable words fights the premise of the piece. This is a feel decision, not a tuning one: lock rotation, add a restoring torque toward upright, or accept a jumble and clamp only the extremes. Note that a restoring torque applied every step would prevent freezing, which is what keeps a full room inside budget.
- [x] In-progress word rendered at the cursor at neutral axes. — not originally listed; added because the piece cannot be judged without seeing what you are typing.

**Exit criteria:** feel test #1 passes — typing `boulder` and `feather` produces undeniably different physical behavior. — **met.** Boulder accelerates to the floor in ~1133ms; feather descends near-linearly at terminal velocity in ~1863ms. The difference is the *shape* of the fall, not only its speed.

> **The soft cap is a constraint on word size.** At the first word scale tried, 200 words asked for ~400 square units of bounding box in a room with 134. The symptom was not visual crowding but that nothing ever slept — an overflowing pile stays permanently pressurised. Sizing words so 200 genuinely fit took the step cost from 72ms to 17.7ms.

> **Flattening tolerance is not a performance lever.** Halving the collider count in a full room (7,993 → 5,253) moved the step cost by 0.8ms, which is noise. The cost of a crowded room is the constraint solver working over a large island of awake bodies. Do not try this again.

---

## Phase 2.5 — Payload (~2–3 days) — **new, not started**

Not in the original plan. Added because Phase 8 asks for Lighthouse 100 on performance and the piece currently ships roughly 3MB compressed for a single canvas. Every fix here is structural, which is exactly why it cannot wait for Phase 8.

Do this **before** the SDF work, because baking outlines at build time changes what the SDF pipeline reads from — otherwise the shader gets written twice.

- [ ] Measure the real transfer cost of a cold visit, per asset, brotli-compressed. Write the numbers down before changing anything.
- [ ] **Drop fontkit from the runtime.** ~155KB gzipped today. Bake glyph outlines at build time in `scripts/build-sdf-atlas.ts` and interpolate at runtime — Phase 2 established that outlines are point-compatible across axis values, which is what makes this safe.
- [ ] **Move Rapier off the `-compat` build.** It inlines its WebAssembly as base64 inside the JS bundle, which both inflates it and prevents the wasm being cached as its own file. Needs the ESM build plus whatever Vite configuration external wasm requires.
- [ ] **Decide what mobile downloads.** The mobile fallback is a static image and one line of text. A phone should not pull ~2MB of ONNX Runtime to be told to come back on a desktop. Detect before loading anything heavy — this also changes where the Phase 3 mobile-fallback item lives.
- [ ] Re-run the measurement. Record what each change actually bought.

**Exit criteria:** a cold desktop visit is under a defensible budget with the numbers written down, and a cold mobile visit downloads almost nothing. Lighthouse performance is checked here, not left as a surprise for Phase 8.

---

## Phase 3 — The room's design (1 week)

The visible design layer. At this point the piece should already be functional but ugly. Now make it beautiful.

- [ ] Palette per `DESIGN.md`. Time-of-day shift.
- [ ] Procedural grain shader.
- [ ] Shadows: mass-scaled blur radius and offset.
- [ ] Semantic tint mapping (warmth score → ink hue).
- [ ] Commit spring animation on variable font axes.
  - **Do not rebuild colliders during the spring.** Build them once at the *target* axes and spring only the rendered axes. Re-decomposing every frame for 180ms is expensive, and a collision shape changing under a settling body invites instability. The 180ms mismatch between drawn and simulated shape is invisible; the alternative is not.
- [ ] Cursor render + pulse. Accent `#D94F1E`, 2s sine, opacity 60% → 100%.
- [ ] Word aging: soft cap at 200, fade-out of oldest. — note that frozen bodies are static; removal is fine, but any upward drift during fade-out needs them unfrozen first.
- [ ] Clear (Cmd/Ctrl+K).
- [ ] Focus/defocus handling.
- [ ] Mobile fallback screen. — may already be partly handled by Phase 2.5's early detection.
- [ ] **Choose the mono face.** Still undecided since the typeface change. Only used at 10–12pt for the footer, credit line and export watermark, so this is low-stakes — but `DESIGN.md` and `brand-guidelines.md` both say "the mono face" and need filling in.
- [ ] **Judge the character branch now that warmth is visible.** Nonsense reads mildly warm (`asdf` warmth +0.66) and neutral-mass rather than light, which is not what `DESIGN.md`'s "light, drifty, unstable" describes. Deferred from Phase 1c specifically so it could be judged as colour and motion rather than as numbers.
- [ ] **Decide whether `age` gets a visual consequence.** Open since Phase 1a. Either give it one here or accept that it is a gravity-only input and record that in `axes.md`.

**Exit criteria:** feel test #4 passes — a still export the next morning still looks composed and considered.

---

## Phase 5a — Semantic gravity baseline: cosine similarity (~3 days)

**Moved ahead of Phase 4.** This is where the freezing question gets resolved, and that sits underneath everything else in the physics core. Sound interacts with nothing and can wait.

- [ ] **Resolve freezing versus drift.** Phase 2 converts settled words to static bodies to keep a full room inside its frame budget. A frozen word cannot drift, and feel test 2 is entirely about drift. Options: unfreeze bodies the force field wants to move, keep the top of the pile permanently live, or apply gravity only above a depth. Decide this first — it constrains everything below it.
- [ ] **Try the property model's penultimate layer as an embedding.** This experiment can be run now against the existing checkpoint, offline, before any of the rest of this phase. If the 128-unit hidden layer separates related words usefully, semantic gravity gets its embeddings for free and ships nothing extra. If it does not, better to know before designing 5b.
- [ ] For each active word, compute cosine similarity to every other active word within a radius.
- [ ] Apply weak attractive force scaled by similarity, weak repulsive force below a threshold.
- [ ] Cap total force. Damp hard.
- [ ] Ship this on a feature-flagged branch. It works but it's boring — expected.
- [ ] Turn semantic gravity on at ~20 words in the room (per the "90-second test" mitigation). Below that, disable.

**Exit criteria for 5a:** `stone` then `rock` drift measurably toward each other, even if the effect is dull.

---

## Phase 4 — Sound (3–4 days)

- [ ] ~~Tone.js set up.~~ **Web Audio API directly**, per `CLAUDE.md`: a `Sampler` plus a `Bed`, roughly 150 lines. Tone.js is a framework for procedural synthesis and sequencing; Drift is neither, and the ~40KB is unjustified. Samples ship as small mp3s from `/public/audio/`.
- [ ] All sound events per `DESIGN.md`.
- [ ] Ambient bed tuning. Get this right — reference `Andor` ambient scenes.
- [ ] Sound toggle in footer. Muted state persists across the session but not across refreshes (no storage).
- [ ] Volume normalization: nothing louder than -20dB peak.

**Exit criteria:** with headphones on, the piece feels present and physical. With headphones off, no one nearby knows what you're using.

---

## Phase 5b — The learned force field (~2 weeks)

- [ ] Design the training objective. Sketch out desired behavior:
  - Related words cluster loosely, don't collapse
  - Antonyms repel with distinctive character
  - Function words behave differently from content words
- [ ] Generate training data: sequences of words with target positions/forces. Consider synthesizing from small labeled sets.
- [ ] Architecture: start with an MLP over local neighborhood (each active body sees ~8 nearest neighbors' property scores + distances, outputs a 2D force). Escalate to a tiny GNN only if MLP is insufficient.
- [ ] Train, export to ONNX, quantize, wire in. — `export_onnx.py`'s verify-then-ship pattern is worth reusing: score every candidate against the checkpoint and refuse to write one that fails.
- [ ] Ablation: log a side-by-side comparison video of cosine similarity vs. learned model with the same input sequence. Save both for your own records — you'll use them when someone asks how the piece works.
- [ ] Measure its latency and payload against the same budgets the property model met. Do not assume this model wants a GPU backend — measure, the way Phase 1c did.

**Exit criteria:** feel test #2 passes — `stone` then `rock` produces visible drift.

---

## Phase 6 — Special behaviors (1 week)

The six categories from `DESIGN.md`. No more.

- [ ] Curated word lists in `/src/world/behaviors.ts`. — source them from `model/data/curated.txt`, which exists for this.
- [ ] Color word tint.
- [ ] Onomatopoeia effects.
- [ ] Silence handler.
- [ ] Ancient words treatment.
- [ ] Weight words micro-thud.
- [x] Convex decomposition validation on hole-glyphs. — done in Phase 2; `/debug/glyphs` is the standing check.

**Exit criteria:** each behavior tested by hand. Nothing is announced. Each is discoverable in exploration.

---

## Phase 7 — Sharing (4–5 days)

- [ ] Still-image export.
- [ ] Session replay URL encoding/decoding.
- [ ] Replay playback with disabled input.
- [ ] Watermark on exported images.
- [ ] Footer icons.

**Exit criteria:** you can save a beautiful image and share a URL that replays a room.

---

## Phase 8 — Polish and pre-launch (2–3 weeks)

The "no deadline" phase, done with restraint.

- [ ] 30-second screen captures every 2–3 days. Watch cold. Fix what feels wrong.
- [ ] Tune, tune, tune. Palette. Springs. Damping. Sound levels. Nothing is too small.
- [ ] **Corpus hygiene pass.** `wordfreq` brought in proper nouns (`freddie`, `california`) and unfiltered offensive words, and they are in the shipped vocabulary today. A cheap row-drop plus a re-export of `properties.v1.onnx`. This is not optional polish — a slur falling into the room is a launch-ending bug.
- [ ] OG image render.
- [ ] Favicon.
- [ ] Domain purchased and pointed. Still TBD.
- [ ] Lighthouse audit. All four scores at 100. — performance should already be handled by Phase 2.5; this is confirmation, not discovery.
- [ ] Cross-browser test: latest Chrome, Safari, Firefox, Arc, Edge. — the WebGPU/WASM matrix no longer applies; the piece is WASM-only by measurement.
- [ ] Five soft-launch testers. Watch them use it. Iterate on what they say for one week.
- [ ] Feel tests 1–5 all pass with fresh eyes.

**Exit criteria:** the piece is boring to work on because you can't find anything to fix. Ship.

---

## Phase 9 — Launch (1 week active, ongoing after)

Per the launch plan discussed earlier. In order:

- [ ] Post to Are.na, unlisted or minimally captioned.
- [ ] Post to your own site if applicable.
- [ ] Post one 20-second recording to Twitter / Bluesky, no explanation.
- [ ] Wait 48 hours.
- [ ] Post the case study on your portfolio site as a follow-up (case study lives on portfolio, not in this repo).
- [ ] Show HN / Lobsters after 72 hours if organic circulation is stalling and you want a boost.

Do not post to design subreddits. Do not run ads.

---

## Standing debts

Carried items that belong to no single phase. Each is recorded in `docs/build-log.md` with its reasoning; this is the list so none of them are discovered late.

| Debt | Where it lands | Why it matters |
| --- | --- | --- |
| Words settle at arbitrary angles | Phase 2 | A room of unreadable words fights the premise |
| Freezing prevents drift | Phase 5a | Feel test 2 is entirely about drift |
| ~3MB payload | Phase 2.5 | Lighthouse 100 is an exit criterion |
| Proper nouns and slurs in the vocabulary | Phase 8 | Launch-ending if missed |
| Mono face undecided | Phase 3 | Two spec documents say "the mono face" |
| `age` axis has no visual consequence | Phase 3 | Open since Phase 1a |
| Character branch reads warm, not light | Phase 3 | Judge as colour, not as numbers |
| Every word spawns at x=0 | Phase 3 / 5a | Cursor safe-zone and gravity are the intended answers — verify they are |
| Domain TBD | Phase 8 | Watermark and OG image need it |

---

## A note on how this file has gone wrong

Three entries in the original plan named tools that did not survive contact with reality: `decomp.js` (no such package), Söhne's variable axes (Klim ships it static-only), and Tone.js (`CLAUDE.md` rejects it outright). All three were written before the tools were checked, and two of them were marked non-negotiable.

Verify a dependency exists and does what you think *before* writing it into a plan, and before writing code against the plan. Twenty minutes of checking package registries and font metadata caught two of these; the third sat here until someone re-read both documents side by side.

---

## After launch

- Fix bugs quietly. No public changelog.
- Do not add features. If you feel the urge, start Rain or Half-Life instead.
- Semantic gravity's learned model can be retrained periodically as you learn what feels right.
- The Tier 3 stretch (in-browser generative anticipation model, where the room predicts what you might type next) is a viable v2 project after Rain and Half-Life ship.

---

## Credit

Roadmap by [YOUR NAME] and Claude.
