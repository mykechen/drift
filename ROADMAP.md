# ROADMAP.md — Drift

Build order. The order matters. Every phase gates the next. Do not skip ahead to shinier work — the first two phases are load-bearing and the piece cannot recover from cutting corners on them.

Timelines are illustrative — this is an ongoing project with no deadline. Use them as internal expectations, not commitments.

---

## Phase 0 — Environment and skeleton (2–3 days)

The floor. Everything else stands on this.

- [ ] Vite + TypeScript strict project, `pnpm` for packages.
- [ ] Prettier + ESLint configured per `CLAUDE.md`.
- [ ] Repo structure per `CLAUDE.md`.
- [ ] Empty canvas rendering (OGL scene, background color `#F4F0E8`).
- [ ] Keyboard input handler capturing typing.
- [ ] Frame loop with `requestAnimationFrame` and a fixed-timestep physics accumulator.
- [ ] Basic `debug()` no-op wrapper.
- [ ] Deployed to Cloudflare Pages under a preview URL. First deploy on day one.

**Exit criteria:** blank canvas is live at a URL; typing in it does nothing but is captured.

---

## Phase 1 — The property model (2–3 weeks)

**This is the phase that decides whether Drift works.** Do this before touching physics or rendering meaningfully. If the ML doesn't feel right, no amount of downstream polish saves the piece.

### 1a. Dataset generation (~3 days)

- [ ] Assemble a word list of ~50k common English words (Google Ngram top 50k is a reasonable start; filter aggressively).
- [ ] Design 6 semantic property axes with clear anchor examples per axis (in `/model/axes.md`):
  - `mass` (feather → boulder)
  - `drag` (stone → leaf)
  - `restitution` (clay → rubber)
  - `warmth` (ice → ember)
  - `age` (fresh → ancient)
  - `intensity` (quiet → scream)
- [ ] Write an LLM labeling pipeline in `/model/generate_dataset.py`. Use structured output, prompt engineering, and batch requests. For each word: return 6 scores in [-1, 1].
- [ ] Cost estimate before running: keep it under $200. Cache aggressively.
- [ ] Manually spot-check 200 random labels for obvious errors. Fix your prompt, re-run outliers.
- [ ] Freeze the dataset. Version it.

### 1b. Model training (~4–5 days)

- [ ] Small MLP architecture in `/model/train.py`:
  - Char-level tokenization (26 letters + 4 special tokens) + word-lookup branch (top 20k words as an embedding table)
  - Combined embedding fed to 2 hidden layers (256 → 128)
  - Output: 6 sigmoid-scaled scores in [-1, 1]
  - Total params: aim for ~200k
- [ ] 90/10 train/eval split.
- [ ] Train to convergence. Overfitting is fine here — this is a memorization problem more than a generalization one, and unseen words go through the char branch anyway.
- [ ] Report eval MAE per axis. Aim for < 0.15 on average.
- [ ] Manually inspect predictions on: `boulder, feather, stone, silence, ember, whisper, hush, crimson, ancient, scream, dust, ocean, glass`. All must feel right. If they don't, revisit dataset or axes.

### 1c. Export and in-browser inference (~3 days)

- [ ] Export to ONNX in `/model/export_onnx.py`.
- [ ] Quantize to int8. Verify predictions still feel right after quantization.
- [ ] Set up ONNX Runtime Web in the project. WebGPU backend, WASM fallback.
- [ ] Build a debug page (`/debug/properties`) that shows scores for any word typed. Ship this internally; do not link publicly.
- [ ] Measure inference latency. Must be under 5ms on a mid-range laptop.
- [ ] Add LRU cache keyed by word string, cap at ~5000 entries.

**Exit criteria:** typing any word into the debug page returns 6 believable scores in under 5ms, offline, in the browser.

---

## Phase 2 — Words as physics bodies (1.5–2 weeks)

Now that words have properties, make them things.

- [ ] Glyph outline extraction with opentype.js. Load Söhne Breit; extract outlines for any word.
- [ ] Convex decomposition of glyph paths. Verify manually on `o`, `e`, `p`, `d`, `g` — these are the failure cases.
- [ ] SDF atlas generation (build-time or first-load).
- [ ] SDF rendering shader in OGL. Crisp glyphs at any scale.
- [ ] Wire variable font axes (`wght`, `opsz`) to property scores. Verify on a static test page — a boulder and a feather side by side, rendered by their scores.
- [ ] Rapier 2D world set up. Gravity down. Canvas boundaries as walls (bottom + sides), open top.
- [ ] Commit pipeline: word → outlines → convex hulls → Rapier compound body with mass/drag/restitution from properties.
- [ ] Physics substepping and density-aware framerate management.
- [ ] Sleep management with tuned thresholds.
- [ ] Angular velocity damping.

**Exit criteria:** feel test #1 passes — typing `boulder` and `feather` produces undeniably different physical behavior.

---

## Phase 3 — The room's design (1 week)

The visible design layer. At this point the piece should already be functional but ugly. Now make it beautiful.

- [ ] Palette per `DESIGN.md`. Time-of-day shift.
- [ ] Procedural grain shader.
- [ ] Shadows: mass-scaled blur radius and offset.
- [ ] Semantic tint mapping (warmth score → ink hue).
- [ ] Commit spring animation on variable font axes.
- [ ] Cursor render + pulse.
- [ ] Word aging: soft cap at 200, fade-out of oldest.
- [ ] Clear (Cmd/Ctrl+K).
- [ ] Focus/defocus handling.
- [ ] Mobile fallback screen.

**Exit criteria:** feel test #4 passes — a still export the next morning still looks composed and considered.

---

## Phase 4 — Sound (3–4 days)

- [ ] Tone.js set up.
- [ ] All sound events per `DESIGN.md`.
- [ ] Ambient bed tuning. Get this right — reference `Andor` ambient scenes.
- [ ] Sound toggle in footer. Muted state persists across the session but not across refreshes (no storage).
- [ ] Volume normalization: nothing louder than -20dB peak.

**Exit criteria:** with headphones on, the piece feels present and physical. With headphones off, no one nearby knows what you're using.

---

## Phase 5 — Semantic gravity (2–3 weeks)

The second-order mechanic. The one that turns "typed words fall" into "a room that has been listening."

### 5a. Baseline: cosine similarity (~3 days)

- [ ] For each active word, compute cosine similarity to every other active word within a radius (use the property model's embedding, or a separate cached embedding lookup — see if the property model's penultimate layer gives usable embeddings first).
- [ ] Apply weak attractive force scaled by similarity, weak repulsive force below a threshold.
- [ ] Cap total force. Damp hard.
- [ ] Ship this on a feature-flagged branch. It works but it's boring — expected.

### 5b. The learned force field (~2 weeks)

- [ ] Design the training objective. Sketch out desired behavior:
  - Related words cluster loosely, don't collapse
  - Antonyms repel with distinctive character
  - Function words behave differently from content words
- [ ] Generate training data: sequences of words with target positions/forces. Consider synthesizing from small labeled sets.
- [ ] Architecture: start with an MLP over local neighborhood (each active body sees ~8 nearest neighbors' property scores + distances, outputs a 2D force). Escalate to a tiny GNN only if MLP is insufficient.
- [ ] Train, export to ONNX, quantize, wire in.
- [ ] Ablation: log a side-by-side comparison video of cosine similarity vs. learned model with the same input sequence. Save both for your own records — you'll use them when someone asks how the piece works.
- [ ] Turn semantic gravity on at ~20 words in the room (per the "90-second test" mitigation). Below that, disable.

**Exit criteria:** feel test #2 passes — `stone` then `rock` produces visible drift.

---

## Phase 6 — Special behaviors (1 week)

The six categories from `DESIGN.md`. No more.

- [ ] Curated word lists in `/src/world/behaviors.ts`.
- [ ] Color word tint.
- [ ] Onomatopoeia effects.
- [ ] Silence handler.
- [ ] Ancient words treatment.
- [ ] Weight words micro-thud.
- [ ] Convex decomposition validation on hole-glyphs.

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
- [ ] OG image render.
- [ ] Favicon.
- [ ] Domain purchased and pointed.
- [ ] Lighthouse audit. All four scores at 100.
- [ ] Cross-browser test: latest Chrome, Safari, Firefox, Arc, Edge. WebGPU on where available, WASM fallback on where not.
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

## After launch

- Fix bugs quietly. No public changelog.
- Do not add features. If you feel the urge, start Rain or Half-Life instead.
- Semantic gravity's learned model can be retrained periodically as you learn what feels right.
- The Tier 3 stretch (in-browser generative anticipation model, where the room predicts what you might type next) is a viable v2 project after Rain and Half-Life ship.

---

## Credit

Roadmap by [YOUR NAME] and Claude.
