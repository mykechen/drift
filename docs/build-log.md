# Drift — build log

A running record of how Drift was built, kept as source material for a later
case study. Newest work at the bottom of each phase. This documents decisions
and the reasoning behind them, not just what changed — the *why* is the part
worth writing up.

This file lives in the repo but is not part of the shipped piece. Per
`brand-guidelines.md` the site has no notes or about route; the case study
lives on a portfolio, not here. This is the raw material for that.

---

## Phase 0 — environment and skeleton

**Goal:** a blank warm-off-white canvas live at a URL, capturing typing but
doing nothing with it. The floor everything else stands on.

### What was built

- Git repo initialized and pushed to `github.com:mykechen/drift`. The repo is
  public.
- Vite + TypeScript (strict) with `pnpm`. `tsconfig` runs the full strict set
  plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
  `erasableSyntaxOnly`.
- Prettier + ESLint with `typescript-eslint`, `no-explicit-any` and
  `no-console` as errors. Verified the guardrails actually fail a build by
  introducing a deliberate `any` and a `console.log`, watching the lint fail,
  then reverting.
- The engine skeleton: an OGL renderer clearing to the paper background, a
  fixed-timestep frame loop decoupled from refresh rate, and a window-level
  keyboard handler with a word buffer that commits on space or enter and
  currently goes nowhere.
- A namespaced `debug()` logger that is a no-op in production, verified absent
  from the built bundle.

### Decisions worth recording

- **TypeScript pinned to 6.x, not 7.** `typescript-eslint` refuses to load
  against the TypeScript 7 native compiler and throws rather than warning.
  CLAUDE.md mandates typescript-eslint, so the lint guardrail wins over the
  newer compiler. Revisit when TS 7 support ships upstream.
- **Markdown excluded from Prettier.** It was rewriting emphasis markers across
  the spec documents and creating diff noise in authored prose.
- **Hosting moved from Cloudflare Pages to Vercel** partway through, at the
  author's request. The caching rules moved from a `_headers` file to
  `vercel.json`. The immutable-cache header targets the hand-placed `/public`
  assets, since Vite already fingerprints its own build output.

### A real bug caught in the browser, not assumed

OGL's `setSize` writes inline `width`/`height` pixel styles onto the canvas
element — including a 300×150 default from its own constructor. That silently
overrode the CSS aspect clamp and pinned the room to 300×150. Found by
verifying the live canvas dimensions in a real browser rather than trusting the
code. The fix clears the inline styles around every resize so the stylesheet
keeps ownership of the element box. Verified afterward: aspect clamp lands
exactly on 16:9 and 4:3 at the extremes, tick rate holds at ~120Hz across
resizes, no scrollbars, no `console.log` in the production bundle.

---

## Phase 1 — the property model

ROADMAP is blunt that this is the phase that decides whether Drift works, and
that it comes before any meaningful physics or rendering. If the model doesn't
feel right, nothing downstream saves the piece.

The core idea: the room needs a number for every word — *how heavy does this
word feel* — and no such lexicon exists. So a small model is trained to guess
six such numbers per word, from a labeled dataset built by having a large
model score a curated corpus once, offline. The trained model then ships inside
the page and runs on the visitor's own machine. Nothing calls an API at
runtime. The one-time labeling is the only external cost, and it never touches
the shipped site.

### The six axes

Each word gets six scores in [-1, 1]:

| axis | -1 | +1 | drives |
|---|---|---|---|
| mass | feather | boulder | fall speed, font weight axis, shadow, landing pitch |
| drag | falls fast for its weight | falls slow for its weight | linear damping |
| restitution | clay | rubber | bounce on landing |
| warmth | ice | ember | ink color |
| age | fresh | ancient | (latent; feeds semantic gravity in Phase 5) |
| intensity | quiet | scream | font optical size axis |

`age` is the one axis with no direct visual consequence yet — an open question
recorded in `axes.md`, to be resolved before the full dataset is frozen.

### Phase 1a — designing and validating the rubric

The rubric was validated with three free chatbot pilots of 24 words each before
any money was spent. Each pilot was analyzed by computing per-axis spread and
the full cross-axis correlation matrix, because the failure mode of a six-axis
rubric is that the axes secretly measure the same thing.

**Pilot 1** passed the disqualifying test — boulder and feather were 1.5 apart
on mass, the anchors landed — but exposed two redundancies:

- `mass × drag` correlated at **-0.90**. Absolute drag was nearly a copy of
  mass with the sign flipped, because in English almost everything that feels
  light also feels floaty.
- `mass × intensity` at **+0.74**. The model was scoring intensity as
  *importance*, not *loudness* — `cathedral` came back more intense than a
  boulder. This one mattered because mass and intensity drive two separate
  variable-font axes, which would otherwise have moved as one.

**Pilot 2** rewrote the word list to attack the correlations (arrow, balloon,
tomb, alarm, and other decorrelating cases) and sharpened two rules: intensity
is acoustic energy not importance; drag is shape not weight. Intensity
decorrelated cleanly (+0.74 → +0.18). Restitution and the other axes populated
both tails. But `mass × drag` barely moved, from -0.90 to -0.85 — the
redundancy was structural in the language, not a wording bug.

**Pilot 3** reframed `drag` as a *residual*: given how heavy a word already
feels, does it fall faster or slower than expected? This forces orthogonality
by construction rather than by asking for it. `stone` becomes 0.0 (it drops
fast, but exactly as its weight predicts); `arrow` becomes negative (drops far
faster than its weight implies). The correlation with mass dropped from -0.86
to **-0.59**, with every heavy word scoring exactly 0.0. The residual framing
became the shipped definition of the axis.

Outcome: no pair of axes correlates above |r| = 0.59. The rubric is `axes.md`
v1, and the three pilot runs are checked in as the evidence behind it.

**Lesson for the writeup:** the entire redundancy problem — which would have
produced a six-column dataset carrying about three real dimensions — was caught
for the price of three free chatbot pastes and some correlation arithmetic,
before a cent was spent on bulk labeling.

### Phase 1a — the word list

The corpus is `wordfreq`, which ranks English by frequency across books,
subtitles, news, and Wikipedia. Frequency order is the right ordering because
the property model memorizes the top ~20k words in a lookup table and
everything else falls through to the character branch — so the list must be
ordered by how likely a visitor is to actually type a word.

Frequency alone was not enough. It cuts `ember` at rank 30,019, which appears
in the OG image, and reaches none of the archaic words a special behavior needs
(`zounds` is rank 151,613 — rarity is the whole point of that behavior).
Meanwhile the tail of a pure-frequency list is corpus residue like `cmc` and
`complainant`. The fix was a union of the frequency head with a curated seed
list drawn from the design documents. 62 words were rescued that frequency
would have missed, for 0.25% more labeling spend, taking all four curated
behavior lists (color, onomatopoeia, weight, archaic) from partial to complete.
`curated.txt` doubles as the source for `behaviors.ts` in Phase 6.

### Phase 1a — the labeling pipeline and provider choice

Two passes, because `drag` is a residual and needs `mass` to exist first. Pass
1 scores the five direct axes; pass 2 scores drag given each word's pass-1 mass.
Both append to JSONL and skip already-labeled words, so an interrupted run over
hundreds of requests resumes for free. Every batch is validated against the
requested words before it is written — a schema-constrained provider should make
that unreachable, but a silently dropped word would leave a hole that only
surfaces during training. Each row is stamped with the model that produced it,
so a run resumed on a different model is detectable; merge warns on mixed
provenance.

The provider is a config flag. The author chose Gemini (`gemini-3.6-flash`).
Before committing to a 500-request bulk run, the same 48 pilot words were
re-scored on Gemini and compared to the Claude pilot scores: mass, warmth, and
age correlated at r ≈ 0.96, the sd ratios sat near 1.0 (no scale
compression), the boulder–feather mass gap was identical at 1.5, and Gemini
actually followed the "intensity is loudness not importance" rule *better* than
the model it was written against (`cathedral` −0.3 vs Claude's +0.5). Only after
that check did the bulk run start.

### Phase 1a — the bulk run, and knowing when to stop

The full run was budgeted at ~$8–40 for 25k words. In practice the project was
on a paid Gemini plan with a spend cap, and the run hit that cap repeatedly —
each raise bought roughly 3,000 more words. Pass 1 reached 10,644 words before
the prepaid balance was exhausted; pass 2 reached 8,144 before credits depleted
entirely.

Rather than keep topping up, the call was to stop and train on what existed.
The reasoning: 8,144 fully-labeled words are the most frequent English
vocabulary, the character branch handles everything past the lookup table by
design, and the whole point of Phase 1 is to find out whether the *approach*
feels right — which 8k words answers as well as 25k. The same discipline that
caught the drag and intensity problems for free: prove the cheap thing before
buying the expensive thing. If the model feels right at 8k, top up the corpus
later against a funded account; if it doesn't, that was learned at a fraction of
the cost.

**One operational lesson worth recording:** an early version of the run script
piped the labeler's output through `tail`, which buffers stderr until the
process exits. A hard `429` spend-cap error was consequently invisible for three
minutes, looking like a silent hang. Removing the pipe made every failure
visible immediately. Probe a provider with a single request before launching a
long loop into it.

### Phase 1a — result

`model/data/dataset.csv`: 8,144 words, six axes, frozen. On the real corpus no
pair of axes correlates above 0.49, `drag × mass` sits at −0.32 (down from
−0.90 before the residual reframe), every axis uses its full range, and 1% of
rows are all-zero function words. This is the frozen artifact Phase 1b trains
on. It cannot be regenerated identically — LLM output is not deterministic and
the labeling budget is spent — so the CSV and its raw per-pass provenance are
committed rather than treated as a rebuildable cache.

**Known follow-ups, deferred:** the corpus contains proper nouns (`freddie`,
`california`) and unfiltered offensive words that `wordfreq` includes; both are
cheap row-drops to apply later and do not block training. The `age` axis still
has no direct visual consequence — the open question in `axes.md`.

### Phase 1a — a coverage gap caught during training

The first training run exposed a bug in the corpus, not the model: `boulder`,
`feather`, `ember`, `crimson`, `hush` and about 100 other curated words had
never been labeled. The cause was ordering. Curated words were merged into the
word list at their frequency rank, and the rare ones — `ember` at rank 30k,
`zounds` at 150k — sorted into the tail, far past where the budget-limited run
stopped. Pass 1 labeled the frequency head and never reached the hand-picked
design vocabulary that curation existed to protect. The words the piece is
judged on were exactly the ones missing.

The fix was to label the 106 missing curated words explicitly by name — three
requests, pennies, and the single highest-value spend in the whole run, since
these are the OG-image words, the behavior lists, and the demo set. Lesson: a
curated seed list has to be labeled *first*, or at least independently of the
frequency queue, not folded into it where frequency can bury it.

### Phase 1b — training the property model

The model has two branches. A word-lookup embedding memorises every training
word — this is where the accuracy lives; a boulder is heavy because it was
labeled heavy, not because the spelling implies it. A character branch gives
any string a representation so nonsense still commits.

**The character branch has a hard ceiling, and finding it was the main result
of this phase.** An order-aware encoder (a bidirectional GRU) was tried on the
theory that letter order would help it generalise to unseen words. It made
held-out error *worse* (MAE 0.31 vs the mean-pool's 0.24). The reason is
fundamental: a word's physical feel is semantic, not orthographic. Nothing in
the letters of `grief` says heavy. A more expressive char model just memorises
training-word spellings that do not transfer, so it overfits. The mean-pool was
kept — it is simpler, and its tendency to fall back toward neutral-light for
unknown strings matches DESIGN.md's brief that nonsense feel "light, drifty,
unstable". This confirms ROADMAP's own framing: "this is a memorisation problem
more than a generalisation one." The `< 0.15` MAE target applies to the
memorised vocabulary, which is what ships in-vocab; genuinely unseen words have
no ground truth to hit.

**Result.** Trained in ship mode (all 10,750 words in the lookup table, no
holdout, as deployed), train MAE is **0.018** — the model reproduces its labels
almost exactly. Every word on ROADMAP's inspection list reads correctly:

- **Feel test 1 (boulder/feather) passes.** boulder mass +0.87, drag 0.00,
  restitution -0.50, intensity 0.00 — heavy, drops straight, lands dead.
  feather mass -0.59, drag +0.48, intensity -0.56 — light, drifts, quiet. A
  mass gap of 1.46.
- ember warmth +0.87, crimson warmth +0.79, silence intensity -0.93, scream
  +0.94, hush quiet and light, mist the lightest and most drifty, anchor heavy
  and dead-landing, ocean heavy and ancient.
- stone and rock both land heavy and old and close together — the raw material
  for feel test 2 (semantic drift) once the gravity model is on in Phase 5.

The dataset grew to 10,750 words in the process (the 8,144 plus the drag-labeled
orphans and the rescued curated words) once the Gemini balance was topped up.
`dataset.csv` is re-frozen at that size.

### Phase 1c — getting the model into the browser

The goal was narrow: take the PyTorch checkpoint, make it something a web page
can run, and prove it still behaves. Three things had to be true at the end —
the quantized model predicts what the checkpoint predicts, inference fits in
5ms, and a word can be typed at it.

#### The export is shaped to be boring

The ONNX graph takes two integer tensors and returns one float tensor. Nothing
else. Turning a word into those integers — lowercasing, stripping trailing
punctuation, looking the word up in the vocabulary — happens in JavaScript.

That was deliberate. ONNX has string operators, and the lookup could have lived
inside the graph. But a graph with no string ops is the one that quantizes
cleanly, runs on every backend, and never surprises you. The cost is that the
character encoding now exists twice, in `model/data.py` and in
`src/ml/properties.ts`, and if the two ever disagree the model does not throw —
it returns some other word's properties. Both copies are commented as mirrors
of each other for exactly that reason.

The vocabulary ships as a newline-delimited word list rather than the training
`vocab.json`. Ids are contiguous from 1, so a word's line number *is* its id;
the JSON was 179KB of punctuation restating an index that position already
implies, and the list is 83KB. The export script asserts the contiguity instead
of assuming it, because if that assumption ever broke the failure would be
silent mismapping rather than a crash.

One small runtime choice: the graph is exported with **int32** inputs even
though PyTorch trains in int64. ONNX Runtime Web maps int64 tensors onto
`BigInt64Array`, so every keystroke would allocate and box 25 BigInts. The
vocabulary is five figures — nowhere near where the wider type earns its keep.

#### Quantization, verified rather than trusted

About 90% of this model's bytes are the word-embedding table. That table is also
where all of its accuracy lives — a boulder is heavy because that row says so.
So int8 quantization lands hardest on precisely the part that matters, which
made it the one step in this phase that could not be taken on faith.

`export_onnx.py` therefore does not just quantize; it scores every candidate
against the PyTorch checkpoint across all 10,750 dataset words and applies a
printed selection rule — smallest candidate whose worst single word on any axis
moves less than 0.05, with zero sign flips among scores above 0.1. Two
candidates were measured:

| candidate | size | mean delta | max delta | sign flips |
|---|---|---|---|---|
| fp32 (export fidelity) | 2.29 MB | 0.00000 | 0.00000 | 0 |
| int8, embedding + matmul | **0.58 MB** | 0.00346 | 0.02203 | 0 |
| int8, matmul only | 2.13 MB | 0.00258 | 0.01903 | 0 |

Quantizing the embedding table costs almost nothing — a worst case of 0.022 on
a scale where the target error is 0.15 — and buys a 4× smaller file. Feel test 1
is then re-run against the file that actually ships, not the checkpoint it came
from: the boulder–feather mass gap survives at 1.47 against a floor of 1.0, and
the script refuses to write the model if it does not.

The threshold matters more than the result. Had int8 blown up the embedding,
the same script would have selected the matmul-only variant automatically and
said so. The decision rule was written before the numbers were known.

#### WebGPU lost, and it was not close

`CLAUDE.md` specified ONNX Runtime Web "with WebGPU backend where available,
WASM fallback." That is the conventional choice and it is wrong here. Measured
on an Apple Metal-3 adapter over 40 distinct cache-missing vocabulary words:

| backend | first run | p50 | p95 | runtime download (brotli) |
|---|---|---|---|---|
| **wasm** | 1.0ms | **0.10ms** | **0.20ms** | **2.05MB** |
| webgpu | 326ms cold, 17.6ms warm | 1.50ms | 2.30ms | 3.28MB |

WebGPU is 15× slower *and* 1.2MB heavier. Both causes are structural rather
than tunable. A model with 570k parameters and a batch size of one has nothing
to parallelise, so per-dispatch overhead is the entire cost — the GPU is pure
latency here. And ONNX Runtime's WebGPU build requires a 23MB Asyncify
WebAssembly binary where the plain build needs 13MB, so the slower option is
also the fatter one.

The 326ms cold first inference is the sharpest edge. It lands on the first word
a visitor types in a fresh session — the single worst moment in the piece to
stall. The first symptom of this was not a number at all: driving the debug page
with WebGPU on, typing seven characters wedged the browser tab hard enough to
need killing, because seven keystrokes at ~300ms each on a blocked main thread
is not something a page recovers from gracefully.

The decision was to drop WebGPU entirely and amend the tech stack. Phase 5's
force field is a different model with a different shape and will be measured on
its own terms rather than inheriting this conclusion.

**Lesson for the writeup:** "use the GPU backend where available" is a default
that sounds like performance work and, at this model size, is the opposite of
it. The measurement took twenty minutes and reversed a locked decision.

#### The failure that named neither file

Wiring ONNX Runtime into Vite produced `TypeError: ke.$b is not a function`
from inside the minified runtime. Two causes, found in order.

The first was Vite's dependency pre-bundler rewriting ORT's inlined WebAssembly
glue, fixed by excluding the package from `optimizeDeps`. The second was the
real one: **the `.wasm` binary is coupled to the ORT entry point you import.**
`onnxruntime-web/webgpu` binds only against `ort-wasm-simd-threaded.asyncify.wasm`;
`onnxruntime-web/wasm` binds only against `ort-wasm-simd-threaded.wasm`. Pairing
the WebGPU entry with the JSEP binary — a reasonable guess, since JSEP is the
build documented as "with WebGPU" — loads successfully and then dies on a
mangled internal name that mentions neither file involved.

Worth recording because the error message is actively unhelpful and the
diagnosis was mechanical once framed correctly: grep each published bundle for
the `.wasm` filename it actually references.

#### Warming the session

The first inference through a fresh session costs ~25ms of one-time kernel
setup; every one after it costs ~0.1ms. So the model now runs one throwaway
inference during load, while the room is still starting. The first word a
visitor types dropped from 24.6ms to 0.70ms. Nothing about the model changed —
the cost simply moved to a moment where nobody is waiting on it.

#### Where this leaves the budget

Final numbers on the shipping configuration, 299 distinct cache-missing words:
p50 **0.10ms**, p95 **0.20ms**, max 0.50ms, against a 5ms budget. A cached word
returns in 0.001ms with no inference at all. Session ready in ~60ms.

The budget is met by a factor of 25, which is worth stating plainly: it means
per-keystroke inference is affordable, not just per-commit. The debug page runs
on every keystroke for that reason — it is heavier than the piece will ever be,
so if it holds there it holds in the room.

`DESIGN.md` says inference runs "synchronously" on commit. ONNX Runtime's
`session.run()` is always asynchronous, so that word is now read as *within one
frame* rather than literally blocking. At 0.1ms with an LRU in front, the
distinction has no observable consequence — a repeated word never touches the
session at all.

#### The debug page

`/debug/properties` is built into the deploy, linked from nowhere, `noindex`ed
and disallowed in `robots.txt`. It shows the six scores as bars centred on zero
— sign is the whole point of these axes, so absolute magnitude alone would make
a heavy word and a weightless one look identical — plus which branch answered,
the latency, and a benchmark button.

Building it into the production deploy rather than keeping it dev-only was a
deliberate call: the questions it answers are about real hardware, and a tool
that only runs on the author's laptop cannot answer them.

#### One thing it immediately revealed

Typing nonsense at it contradicted something recorded in Phase 1b. The claim was
that unknown strings "fall through to neutral-light." They do not, quite:

- `asdf` — mass +0.23, drag +0.28, restitution +0.22, warmth +0.66, intensity +0.48
- `qwertyuiop` — mass +0.03, drag +0.24, restitution +0.18, warmth +0.59

Drag and restitution do read the way `DESIGN.md` asks for — drifty and
unstable. But mass is *neutral*, not light, and warmth carries a consistent
positive bias of around +0.6 that nothing in the brief asks for. The character
branch is not a light-word generator; it is a mild-word generator with a warm
tint.

Deferred to Phase 2 rather than fixed. Mass near zero may read perfectly well
once it is motion on a screen instead of a number in a table, and warmth has no
visual consequence at all until ink colour is wired in Phase 3. Tuning it now
would mean tuning against a number rather than against how it looks, which is
the mistake this project has avoided so far. Recorded here so it is judged
deliberately rather than discovered late.

#### Also worth noting

- `hello,` and `wait?!` correctly strip to word-branch hits; `h3llo` and `...`
  are correctly refused. The three refusal rules are the only three
  `CLAUDE.md` allows.
- Browser predictions differ from the Python ONNX Runtime by up to ~0.004 on the
  same int8 model — different kernel implementations for the same graph. Well
  inside the 0.05 tolerance, but a reminder that "the same model" is not quite
  the same arithmetic across runtimes.
- The model and vocabulary are imported through Vite's `?url`, so they land in
  `/assets/` fingerprinted and Vercel caches them immutably without a
  `vercel.json` rule. The rule stays for the hand-placed `/public` files.

**Exit criteria met.** Typing any word into the debug page returns six
believable scores in under 5ms, offline, in the browser.

---

## Phase 2 — words as physics bodies

The phase that makes a word a thing. Its exit criterion is feel test 1: typing
`boulder` and `feather` produces undeniably different physical behaviour.

### Two specs that did not survive contact with reality

Before writing any Phase 2 code, the dependencies and assets it named were
checked. Two of them did not exist.

**`decomp.js` is not a real package.** `CLAUDE.md` named it as the convex
decomposition library, described it as "a modern rewrite of poly-decomp with
better output quality," linked `github.com/pshihn/decomp.js`, and marked it
**non-negotiable**. The repository 404s and there is no such npm package. The
project's own spec had hallucinated a dependency and then forbidden deviating
from it.

`poly-decomp` is real, but it cannot handle holes — which is precisely the
stated problem, since `DESIGN.md`'s sixth special behaviour is "glyphs with
holes must decompose correctly or they will misbehave." earcut handles holes
natively, is about 2KB, and is load-bearing inside Mapbox GL.

**Söhne has no variable axes.** `DESIGN.md` wires `wght` and `opsz` to model
scores and animates both with a commit spring, and `CLAUDE.md` calls this "the
word IS the body" and says do not skip it. Klim ships Söhne — including Söhne
Breit — as static fonts only: eight weights in roman and italic, no `wght`
axis, no `opsz` axis. A spring animating across eight discrete masters pops
rather than springs. The centrepiece of the rendering contract could not be
built as written.

The author's call was to look for a free replacement rather than emulate the
axes. Verified against the Google Fonts registry rather than from memory, the
candidates with genuine axes were Archivo (`wght 100–900`, `wdth 62–125`),
Roboto Flex (everything, but reads as an Android default), Bricolage Grotesque
(all three axes but no wide setting) and Inter (closest to Söhne, no width
axis). Archivo won: a grotesque in the same Akzidenz lineage, and its width
axis is the closest free equivalent to what "Breit" means.

**`opsz` became `wdth` in the process,** and it is a better mapping than the
original. The stated intent for optical size was "tighter proportional metrics
= more visually assertive glyph shapes" — which describes width. Width also
does more work here: an `o` measures 306 units wide at `wdth 62` and 696 at
`wdth 125` at fixed height, so an intense word becomes a *physically wider
body*, not merely a differently-drawn one. The axis now changes the collision
silhouette, which is exactly what "the word IS the body" is supposed to mean.

**Lesson for the writeup:** the specs in this repo were written before the
tools were checked, and two of them were confidently wrong in ways that would
have cost days if discovered mid-implementation. Twenty minutes of verifying
package existence and font metadata, before writing a line, caught both.

### The spike came before the pipeline

Rather than write four hundred lines against assumed APIs, a throwaway page
answered the questions that could invalidate the whole approach: does fontkit
run in a browser under Vite, does `getVariation` return real interpolated
outlines, does Rapier's wasm packaging work without extra Vite plugins. All
three passed, and the spike also returned three facts that shaped the code:

- **Outlines across axis values are point-compatible** — `o` has exactly 30
  path commands at both `wght 800/wdth 125` and `wght 300/wdth 62`. That means
  collision geometry can be interpolated during a commit spring rather than
  rebuilt, and it means outlines could be baked at a few axis samples at build
  time if fontkit's 371KB ever needs to leave the runtime bundle.
- **Archivo is TrueType**, so outlines are quadratics only. No cubics to flatten.
- **Contour count says nothing about holes.** `i` has two contours and neither
  is a hole — stem and tittle. `o` has two and the second is. `g` has three.
  Signed area gives winding, and winding is the only reliable signal: `o`'s
  contours came back at −301090 and +75371, opposite signs, where `i`'s do not.

The first version of the spike compared the wrong glyphs — glyph index 3 of
"boulder" is `l`, not `o` — and produced a confident, meaningless "outlines are
not point-compatible." Worth recording because it was caught only by the number
looking wrong, not by anything failing.

### The decomposition

Word → fontkit layout → per-glyph outlines at the predicted axis values →
flatten quadratics → simplify → classify contours by winding → assign each hole
to the smallest outer contour containing it → earcut → merge triangles into
convex pieces.

The merge is Hertel–Mehlhorn: repeatedly delete an internal edge shared by two
pieces when the union stays convex. Not optimal, but within 4× of optimal and
fast. Rings are stored as vertex *indices* so shared edges are found by index
pair rather than by comparing floats, which is the kind of thing that works on
every glyph until it silently doesn't.

Verified by eye at `/debug/glyphs`, which draws hulls as translucent fills over
the true outline — the only way to check a hull is to look at it. All eight
counter-bearing glyphs come out hollow, `g` keeps both of its counters, and `i`
resolves to exactly two pieces.

### The collider budget, and a wrong first guess

At the first working version, `boulder` decomposed to **85 convex hulls**.
Times the 200-body soft cap, that is 15,475 colliders for the physics step to
carry, which is not a budget so much as a problem.

The obvious lever was flattening tolerance — coarser curves, fewer reflex
vertices, bigger convex pieces. Sweeping it proved that wrong: 1/8 em and
1/64 em produced *identical* triangle counts. The vertex count was never coming
from curve subdivision. A TrueType outline arrives already dense with points
that exist for hinting and for smooth rendering, and flattening was barely
adding to them.

The actual fix was Ramer–Douglas–Peucker simplification of each contour after
flattening, which made the tolerance a real lever for the first time:

| tolerance | triangles/word | hulls/word | at 200 bodies |
|---|---|---|---|
| 1/8 em | 34.0 | 21.0 | 4,200 |
| 1/16 em | 59.9 | 26.3 | 5,250 |
| 1/32 em | 92.9 | 47.1 | 9,425 |
| 1/64 em | 115.9 | 55.9 | 11,175 |
| 1/128 em | 154.6 | 67.6 | 13,525 |

Left at **1/32 em** for now. At 1/16 the silhouette is visibly faceted — `s`
loses its spine, `o` becomes a heptagon — and while the SDF renders the true
curve regardless, a heptagonal `o` rolls differently from a round one. The
honest position is that this is a *behavioural* question and cannot be settled
from a static picture, so it stays at the faithful setting until the physics
stress test has an opinion. The slider is on the debug page; re-tuning is
seconds.

**Still open for Phase 2:** SDF atlas and shader, the Rapier world and the
commit pipeline, density-aware timestep, sleep thresholds and angular damping,
and feel test 1 itself.

### Phase 2 — the physics, and what the stress test found

ROADMAP lists SDF rendering before physics. That order was inverted deliberately:
physics is what answers the open questions — the flattening tolerance, the
collider budget, whether feel test 1 passes at all — and the SDF is polish on
top of something that has to behave first. Building the shiny rendering before
the thing it renders is exactly the risk ROADMAP warns about elsewhere.

Words are drawn, for now, as flat fills of *the same triangulation the colliders
were cut from*. That is not laziness: it makes it impossible for the picture to
disagree with the simulation. If a counter looks filled on screen, it is filled
in the physics too.

#### Feel test 1 passes, and the trace shows why

Committed at the room's centre and traced at 100ms intervals:

- **boulder** — mass +0.87, damping 0.20: −0.17, −1.27, −3.15, −4.67. Accelerating
  hard, floor in about a second.
- **feather** — mass −0.60, drag +0.48, damping 1.05: −0.16, −0.84, −1.67, −2.59,
  −3.51, −4.47. Almost perfectly *linear* — terminal velocity — reaching the
  floor in roughly twice the time.

The difference is not only speed but the *shape* of the fall, which is the part
that reads as weight. It required modelling the right thing: under gravity alone
every body accelerates identically regardless of mass, so mass cannot separate
them. What separates a feather from a boulder in air is drag relative to weight,
so linear damping is driven mostly by how light the word is and then adjusted by
the `drag` axis — which the dataset already defines as a residual, *how much
faster or slower this word falls than its weight alone predicts*. The axis
designed in Phase 1a turned out to be exactly the quantity the physics needed.

#### A Rapier API whose type signature is a lie

One word, `scream`, threw `Error: expected instance of lA` on commit. Every
time; no other word did.

`ColliderDesc.convexHull(points)` is typed `ColliderDesc | null`, which reads as
"returns null if the hull cannot be built." It does not. It only stores the
vertices — the hull is actually computed later, inside `world.createCollider`,
and a degenerate point set makes *that* throw out of wasm-bindgen with a message
naming neither the collider nor the word nor anything else recognisable. The
null check written against the type signature was dead code from the start.

The culprit was hull 50 of 51: a four-point sliver of area 8.45e-4 em², below
Rapier's internal hull epsilon. The fix is a try/catch around collider creation
that skips the offending piece and logs its point count and area, so one
unusable sliver costs a sliver of silhouette rather than the entire word.

#### The stress test, and a number that was measuring the wrong thing

The first run committed 200 words as fast as possible and reported a step cost
of **1550ms** against a 16.7ms budget. That number was worthless: 200 words
spawned at the same point in 171ms is one enormous interpenetrating pile, a
state no amount of typing can produce.

Re-run at 110ms between commits — faster than anyone types, but with time to
fall — it came back at **72ms**. Still 4× over budget, and with a far more
alarming detail: at every checkpoint, *every* body was awake. 50 of 50, 97 of
100, 150 of 150, 200 of 200. Nothing ever slept.

The cause was geometric. A word at the original scale is about 3.1 × 0.66 world
units, so 200 of them ask for roughly 400 square units of bounding box in a room
that has 134. The room could not hold its own soft cap. An overflowing pile stays
permanently pressurised, every body grinding against its neighbours, and nothing
ever comes to rest. Sizing words so 200 genuinely fit — a scale factor of 0.4
instead of 0.9 — dropped the step cost to **17.7ms** and left the pile topping
out at y = 1.25 in a room whose ceiling is 5.

**Lesson for the writeup:** the soft cap is not a rendering decision or an
aesthetic one. "200 words" is a constraint on how big a word is allowed to be,
and getting it wrong shows up as a physics performance problem three layers away
from the number that caused it.

#### The open problem: island sleeping

Sleep works in normal use — `boulder` and `feather` both settle and sleep within
a second of landing, and a room of twelve words goes fully quiet. It fails only
in the full 200-word pile, and the measurements say why.

After the room settles, 194 of 200 bodies are moving *slower* than the sleep
threshold — median speed 0.0096 against a limit of 0.06 — and 198 are below the
angular limit. They are still. They just do not sleep.

The reason is that Rapier's sleeping is **island-based**: bodies in a connected
contact island sleep together or not at all, so a handful of restless bodies keep
two hundred awake, and calling `sleep()` on individual bodies cannot hold against
it. Rapier's own thresholds would resolve this, but the JavaScript bindings
expose only `canSleep`, `setSleeping`, `sleep()` and `isSleeping()` —
`linear_threshold`, `angular_threshold` and `time_until_sleep` are not reachable
from JS at all.

Recorded rather than papered over. At 200 bodies with everything awake the step
costs 17.7ms against a 16.7ms budget — marginal, and it collapses the moment
sleeping works.

**Still open for Phase 2:** island sleeping, the SDF atlas and shader, and
re-testing the flattening tolerance now that there is behaviour to judge it
against.

### Phase 2 — making a full room cheap, and four measurements that said no

The open defect was that a room at its 200-word soft cap never stopped
simulating. Four candidate fixes were measured. Three failed, and the failures
are more instructive than the fix.

**The hand-rolled settling was causing the problem, not working around it.** The
first implementation tracked each body's speed and called `sleep()` after half a
second of stillness, on the assumption that Rapier's own thresholds were
unreachable from JavaScript. Removing it entirely made small rooms sleep
correctly — twelve words, all asleep. Rapier sleeps by **island**: every body in
a connected set of contacts sleeps together or not at all, and forcing one body
in a live island to sleep resets the activation timer its island logic depends
on. The workaround was the bug.

**Locking rotation did nothing for sleeping.** Worth trying because the settled
pile had a median rotation of 98.6° and a maximum of 179.4° — half the words
lying sideways or upside down, which contradicts CLAUDE.md's "tumble slightly and
settle flat" — and a heap of randomly angled sticks plausibly creeps longer than
a stack of level slabs. With rotations locked (verified: max rotation 0°) the
pile still slept nothing. Reverted, because it cost the tumble and bought
nothing. *The rotation problem itself is still open and is a feel question, not
a performance one.*

**Doubling solver iterations made it worse.** Tried first among the remaining
options precisely because it costs no feel at all, only CPU — the theory being
that contact error in a fifteen-deep pile needs more iterations to propagate to
the bottom. At 8 iterations instead of 4: still nothing asleep, and the step cost
went from 23ms to 41.6ms.

**Halving the collider count changed nothing.** Coarsening the flattening
tolerance from 1/32 to 1/16 em took a full room from 7,993 colliders to 5,253 —
47 per word down to 26 — and moved the step cost from 23ms to 22.2ms, which is
noise. This is the measurement that reframed the problem: **the cost of a
crowded room is the constraint solver working over a large island of awake
bodies, not the number of colliders in it.** The tolerance was reverted to the
value that looks right, since it turns out not to be a performance lever at all.
The deferred question from earlier in the phase is now answered, in the negative.

#### What worked: freezing settled words into static bodies

Sleeping was only ever a means. The end is a full room at 60fps, and there is a
way to get it that sidesteps islands entirely — a *fixed* body is not in one.

A word that has stayed below a small speed threshold for 1.5 seconds is
converted to a static body. Measured on a full 200-word room:

| | before | after |
|---|---|---|
| step p50 | 22–23ms | **10.5ms** |
| step p95 | 25–26ms | **12.2ms** |
| step max | 27ms | **12.8ms** |
| budget at 60Hz | 16.7ms | 16.7ms |

Left alone for ten seconds, the room reaches 200 of 200 frozen and stops
simulating altogether. Feel test 1 is unaffected — boulder still falls in 1133ms
and feather in 1863ms.

**The tradeoff is real and was verified rather than assumed.** A frozen word
holds its position absolutely: committing a new word onto a frozen pile moves it
by exactly 0.0000 units. The pile becomes sediment. That is why the delay is
1.5 seconds rather than tight — the live surface of the pile stays dynamic and
only what is buried turns to rock — but it *is* a change to what the room is,
and it deserves the author's eye rather than a silent commit.

**It also collides with Phase 5.** Semantic gravity's whole premise is feel test
2: type `stone`, wait, type `rock`, and watch `rock` drift toward `stone`. A
frozen word cannot drift. Whatever form the force field takes, it will need
either to unfreeze bodies it wants to move or to leave the top of the pile
permanently live. Recorded now so it is a design decision then, rather than a
surprise.

#### One more change worth flagging

The density range narrowed from 0.15–6 to 0.6–3, a 40:1 mass ratio down to 5:1.
Large mass ratios are a classic cause of solver jitter, and this measurably
improved both settling and step cost. It is defensible on its own terms because
mass's primary expression in the piece is *fall speed*, which comes from linear
damping and is untouched — density only governs how hard words shove each other.
But it does reduce how much a boulder bullies a feather on contact, which is a
feel judgement rather than a technical one.

### Phase 2 — settling words flat, and why the tumble was cut

The open feel defect from the freezing work was that words settle at arbitrary
angles. Measured on a full 200-word room the median tilt was ~69° with 80 of 200
words past 90° — sideways to upside down — and only 13 genuinely upright. That
contradicts CLAUDE.md ("words should tumble slightly and settle flat, never spin
like propellers") and it fights the premise of the piece: a room that
accumulates *language* should not be half-full of unreadable words.

The still is the argument. Before, the words that still read as language were
exactly the near-upright few; everything rotated dissolved into abstract
mark-making (`docs/images/rotation-before.png`). This was looked at cold first,
per feel test 4, rather than decided from the numbers — and the numbers only
confirmed what the picture already said.

**Three directions were on the table**, and the choice was the author's because
it changes the character of the settled room:

1. Lock rotation and commit each word at a small fixed tilt.
2. A restoring torque toward upright — an angular spring.
3. Accept the jumble and clamp only the extremes.

**The torque was the trap.** It is the most literal reading of "tumble slightly
and settle flat" — words tumble on impact, then right themselves — but it fights
the freeze mechanism head-on. Any torque applied every step keeps bodies awake,
and a full room that never freezes goes straight back over the frame budget the
freezing work just bought. A deadband and an un-waking `applyTorqueImpulse` could
mitigate it, but in a dense pile a *buried* word physically cannot rotate upright
anyway — there is no room — so the torque only ever helps the surface, at real
risk to the one number that must not regress. This is the same shape as every
"keep it moving" approach the freezing section already rejected.

**The decision was option 1: lock rotation, small fixed tilt.** It is the only
option that guarantees the readability the piece's premise depends on, and it
costs *nothing* against the freeze mechanism — locking removes the angular
degree of freedom entirely, so there is nothing to damp, keep awake, or pay for
in the solver. What it sacrifices is the dynamic tumble *during* the fall, which
lasts under a second and which feel test 4 — a still — never sees.

**The tilt is deterministic, and that is a design decision, not an
implementation detail.** A fixed ±7° tilt per word keeps a locked pile from
reading as mechanically uniform bricks. But DESIGN.md's session-replay URL
replays a word sequence and must reproduce *the same composition*; a
`Math.random()` tilt would make every replay a different pile. So the tilt is
derived from the word's commit index through a small integer hash — stable,
reproducible under replay, and still varied even for repeated words like
`stone stone stone`. `ANGULAR_DAMPING` was removed in the same change: with
rotation locked it damped a degree of freedom that no longer exists.

**Result** (`docs/images/rotation-after.png`): a settled 200-word room measures
a median tilt of **3.5°** and a maximum of **7.0°** — every word inside the
upright band, none past 15°, against a before of median 69° and 80 words past
90°. The room still reaches **200 / 200 frozen**, so freeze convergence is
untouched. Feel test 1 still passes: boulder falls to the floor faster than
feather (measured 916ms vs 1749ms, boulder accelerating and feather at terminal
velocity), because locking the angular DOF cannot touch the vertical fall, which
is gravity and linear damping.

**The step-cost budget is not regressed, and the argument is structural rather
than a fresh measurement.** Locking rotation strictly *removes* solver work — one
fewer degree of freedom per body — so per-step cost can only fall or stay equal,
never rise; and the budget is delivered by freezing, which is verified intact at
200/200. A clean absolute re-measurement of the 10.5ms p50 was not obtainable
through the Playwright driver: an automated Chrome window that is not the OS
foreground app has its timers clamped and its renderer CPU deprioritised, which
inflates every wall-clock reading, and driving the fill fast enough to dodge that
throttle produces one interpenetrating central pile — the same worthless
measurement the earlier stress-test section warned about — rather than a room the
freeze mechanism has thinned. The rotation and freeze results above are *state*,
not timing, so they are immune to the throttle; the step number is the one thing
that is not, and it is the one defensible by construction.

**One honest interaction, flagged rather than hidden.** Locking rotation removes
the chaotic tumble that used to shove landing words sideways, so words now fall
dead-straight onto the same spawn point and the x=0 spawn column is *tighter*
than before — a settled room occupies an x-slice of about 0.5 units in a 13.3-unit
room. The unreadable-fan look and this tight-column look are two faces of the
same unfixed spawn issue (every word spawns at x=0); the rotation fix did not
cause it, but it does make it more visible, because the tumble was incidentally
masking it. The intended fix is unchanged — DESIGN.md's cursor safe-zone and
Phase 5's semantic gravity spread words horizontally — and the after-still's
central blob is that spawn column, not a rotation artifact. Recorded so the
column is judged as the spawn problem it is, not mistaken for a regression in
this change.

### Phase 2 — the lock comes off: a physics lifecycle, and the spawn column bites

The lock shipped, and the author's reaction was the right one: the settled room
felt *dead*. A locked word never reacts to a shove — it cannot tumble on impact
or shift when something lands on it — and for a piece built on "the word IS the
body," rigid tiles are the wrong answer. Two more asks arrived alongside: make
the physics mechanics *obvious* (a heavy word should visibly plummet, a `ball`
should bounce where a `rock` thuds), and let the settled pile *react* when a
heavy word drops onto it. This entry is that whole pass, and the useful part is
how much the freeze mechanism fought back.

**Bounce and fall were already in the model; the physics layer was hiding them.**
The property model scores `ball` restitution +0.79 and `rock` −0.25 — exactly
right — but a measured drop showed `ball` rebounding 0.014 units and *less* than
`rock`. Three causes, each fixed: the floor had no restitution and Rapier
averages contact surfaces, halving every bounce toward the dead floor (fixed by
combining restitution by **max** on word colliders); the cap compressed the top
(`MAX_RESTITUTION` 0.55 → 0.72); and the mapping ran the full −1..+1 range, so
`rock` still had a little bounce (now positives-only, so anything clay-to-neutral
hard-stops at 0 and only positive scores rebound). Result: `rubber` hops five
times, `ball` twice, `rock`/`boulder`/`anchor` land dead — the ordering the model
always intended. Fall contrast was widened the honest way: the heavy end is
already near free-fall, so `MAX_LINEAR_DAMPING` was raised 3.2 → 5.4 to make the
*light* end drift slower, taking the boulder/feather gap from ~1.8× to ~2.7×
(950ms vs 2600ms) without a mass-scaled-gravity hack.

**Rotation became a lifecycle instead of a lock.** A word now rotates freely
under real physics while it moves (tumble on impact), and once it slows below
`ORIENT_ACTIVE_SPEED` a mass-scaled restoring torque eases it upright, with a
deadband so a nearly-upright word is left alone. This is the restoring-torque
approach the earlier freeze work explicitly rejected — and it rejected it for a
real reason, which came due immediately.

**The freeze fight, in the order it happened.** Every step here was measured, and
three of the four things tried made it worse before the fix landed:

- *The torque kept the pile awake.* A 72-word heap froze only 4 of 72 and never
  went quiet. The freeze condition required angular stillness, and any word the
  torque was still righting had angular velocity — so it never froze. Widening
  the deadband from 3° to 28° barely helped (10/72).
- *Wake-on-impact was re-waking the pile from the inside.* Disabling it jumped
  freezing to 66/72 — the churn was a wake event triggering movement triggering
  another wake event. That named the real culprit.
- *The freeze condition was the lever.* Keying freeze on **linear** stillness
  alone — a word that has stopped *moving* is settled, even if the torque is
  still turning it — reached 72/72, and freed the torque to be *strong* (gain
  0.11) since it no longer blocks freezing. Median tilt settled at ~7–10°, a
  readable, organic lean rather than the lock's pristine 3.5°.
- *The wake threshold was measuring the wrong thing.* A force threshold could not
  tell a hard landing from dead weight: a heavy word's *resting* load on the word
  beneath it (measured: frozen pile ~0 internal force, light landing ~17, heavy
  ~640, heavy *resting* well above the 80 tried) re-woke its neighbour every
  step. The gate had to be the striker's **velocity** (> 2 units/s), which is
  immune to resting load and also damps the cascade, since a knocked word
  re-settles too slowly to re-trigger anything. With that, a 50-word room freezes
  in ~7s and re-freezes ~2.5s after a disturbance.
- *A single woken word is pinned and does nothing.* The struck word is boxed in
  by the pile, so waking only it produced a 0.04-unit twitch. Waking a small
  **radius** (1.3 units) of frozen neighbours gives a visible local *give* —
  measured 0.175-unit shifts, up to 12 words moving at once — that still
  re-freezes almost immediately. Bounded because the woken cluster re-settles
  below the wake speed.

**Then free rotation exposed the spawn column as a hard blocker, not an eyesore.**
Everything above still would not settle at x=0. A 1-D tower of *freely-rotating*
rounded words is an inverted pendulum — it rocks forever and never freezes. The
lock had hidden this: rigid tiles balance in an impossible tower. Confirmed by
giving words a horizontal spread: the same pile that never froze at x=0 froze
120/120 in ~9s once it was a 2-D heap. So free rotation *forces* the spawn
question that Phase 5 was going to answer later.

**The author's answer reshaped the interaction: words land where the cursor is.**
Rather than auto-spreading, the cursor now follows the mouse horizontally, the
word forms there, and on commit it is released from that column and falls.
Placement becomes the composition mechanic and hands the pile its 2-D spread for
free. This overrides DESIGN.md's fixed, centred cursor and its "nothing follows
the mouse" line — both amended, with the reasoning, rather than left to
contradict the build. `commit` now takes a spawn x; the renderer draws the draft
at the cursor; a clamped mouse→world mapping drives both. Verified end to end
through the real event path: mouse at 80% of the canvas → word committed at world
x = 4.0, the expected column.

The composition this produces (`docs/images/physics-cursor-placed.png`) is the
first time the room has looked like the piece — placed stacks of legible words
spread across the floor, leaning slightly where they settled, a heavy `boulder`
sitting where it was dropped. Median tilt ~10° at 120 words placed in clusters,
max ~83° for the odd word buried in the densest spot; it reads, cold, as a
composition rather than a jumble or a blob.

**Two honest edges, flagged not hidden.** Readability is looser than the lock
(median ~10° vs 3.5°, and a thin tail past 30° in dense clusters) — the
deliberate cost of aliveness, and the author's call on feel test 4. And the
absolute step-budget number was again not cleanly re-measurable through the
throttled Playwright driver; the state results (freeze convergence, wake
bounded-ness, re-freeze times) are throttle-immune and hold, but the p50 step
cost wants a foreground-Chrome reading before this is called done against the
16.7ms budget. Everything else — bounce ordering, fall ratio, rotation
convergence, wake give-and-re-freeze, cursor placement — is verified.

### Phase 2 — louder physics: big bounce, leaf drift, and words that crush

With the room finally reading like the piece, the author pushed the physics to be
more *expressive*: bounce much higher, let light words wander like a leaf, and —
the big one — let a heavy word crush the light ones it lands on, to clear the
board. Three features; the crush was the one that fought back and taught the most.

**Bounce, much higher.** `MAX_RESTITUTION` went 0.72 → 0.92, but the real fix was
noticing that the bounciest words are also lightish and therefore heavily damped
— the same drag that makes a feather drift was smothering a ball's rebound. So
bouncy words now shed most of that damping (`BOUNCY_DAMPING_FLOOR`), and `ball`'s
hop went from 0.14 to **0.71 units**, roughly twice its own height, `rubber` to
0.88. The tradeoff, recorded: a very bouncy word takes ~4.5s to stop, so a room
full of them goes fully quiet slower (~15s vs ~9s). Non-bouncy rooms are
unaffected, and freezing keys on linear stillness so a mid-bounce apex never
false-freezes.

**Leaf drift.** Very light words now get a sideways sway while descending, so
`mist` and `feather` wander down instead of dropping straight. The first attempt
was far too weak, and the reason is the same coupling as the bounce: a light word
is heavily damped, and that damping eats a gentle sway. The push had to be
*strong and slow* (`LEAF_FLUTTER_ACCEL` 19, 0.45 Hz) to swing wide before
reversing rather than buzzing in place — after which `mist` wanders ~2 units,
`feather` ~1.3, while `boulder` drops dead straight. It fades out as the word
lands so settling is unaffected.

**Crush: the premise paying off, and two bugs the tests caught.** The mechanic is
that meaning with weight flattens meaning without — a heavy word destroys much
lighter ones — chosen as *squash-then-fade*: the crushed word's body is removed
at once (so a heavy word keeps sinking) while its mesh presses thin and fades over
~0.3s. Physics removal is decoupled from the exit animation through a `drainCrushed`
queue the renderer consumes.

It did not work when the author tested it, and the reason was two stacked bugs
that only a real drop surfaces:

- *Wrong event.* Crush first rode the **contact-force** events that drive wake.
  But a heavy word landing on a light one barely generates force — the light word
  just gives way — so the event never fired. Measured directly: a boulder landing
  0.18 units from a feather, well inside any radius, crushed nothing. Switched
  crush to **collision** events, which fire on any contact regardless of force.
- *Velocity read one step too late.* The gate "is the striker moving?" was checked
  *after* `world.step()` — but that is the very step the solver stops the striker
  in, so its post-step speed is already ~0 and the gate always failed. The room
  had to **snapshot each body's speed before the step** and judge the impact on
  that. This is the same class of bug as the resting-weight wake problem: what
  matters is the state at the moment of contact, not after it resolves.

**Punch-through lost to leaf drift; the area smash won.** Even firing correctly, a
straight-down crush kept missing, because the lightest words — exactly the
crushable ones — leaf-drift and are never sitting in a tidy column under the
cursor. So crush became an **area smash**: a heavy, moving word flattens every
much-lighter word within a mass-scaled radius (`mountain` ~2.6 units, `stone`
~1.9). This is what "flatten everything out" actually meant, and it is robust to
the scatter. Guards hold: a wide mass gap (`CRUSH_MASS_GAP` 0.5) so `boulder`
never crushes `rock`, a striker-mass floor so only genuine heavyweights smash, the
velocity gate so a *resting* heavy word crushes nothing, and a wake of the frozen
neighbourhood so the pile collapses into the cleared space. Verified: every
heavy→light pair crushes, heavy→heavy does not, and a 70-word mixed room still
settles (~5.7s) even as half of it is being flattened during the fill.

**Lesson for the writeup:** all three features are the same story — a light word's
damping is load-bearing for *drift*, and it silently fights *every other* force
you try to apply to a light word (its bounce, its sway). And the crush bugs are a
reminder that impact mechanics must read the world at the instant of contact;
both were invisible in code review and obvious the moment a word was actually
dropped on another.

---

## Phase 2.5 — payload

**Goal:** know what a cold visit costs, and cut it. Lighthouse 100 on
performance is a Phase 8 exit criterion, and every fix available here is
structural — discovering it at Phase 8 means rewriting how the piece loads with
a launch date in view. This phase runs *before* the SDF work because baking
glyph outlines at build time changes what the SDF pipeline reads from, and doing
SDF first means writing that shader twice.

### The measurement comes first

`scripts/measure-payload.ts` walks `dist/`, brotli-compresses every file at
quality 11 — what a CDN actually serves — and reports the subset a first-time
visitor on each route downloads. Run with `pnpm measure`.

**The cold set is derived, not declared.** Starting from a route's HTML, every
`/…`-rooted path referenced in the HTML, JS and CSS is followed recursively.
Vite emits asset URLs as literal strings, so the `.wasm` and `.onnx` that are
*fetched at runtime* rather than statically imported are found the same way the
browser finds them. A hand-maintained list would silently drift from the build;
this cannot. Verified against the real thing: a Playwright load of
`pnpm preview` makes exactly the ten requests the script derives, no more and no
fewer.

### Baseline — cold desktop visit, brotli, before any change

| Asset | Brotli | Raw | What it is |
|---|---|---|---|
| `ort-wasm-simd-threaded.wasm` | 2149.9 KB | 13164.0 KB | ONNX Runtime engine |
| `properties.v1.onnx` | 483.3 KB | 569.7 KB | the model (int8, already compressed) |
| `room.js` | 475.4 KB | 1703.9 KB | engine + Rapier's base64-inlined wasm + OGL |
| `Archivo.ttf` | 191.7 KB | 643.2 KB | the font |
| `typography.js` | 132.6 KB | 360.5 KB | fontkit + the glyph pipeline |
| `properties.v1.vocab.txt` | 32.0 KB | 81.2 KB | the word list |
| `properties.js` | 21.1 KB | 71.9 KB | ORT glue + the property model wiring |
| `modulepreload-polyfill.js` | 0.7 KB | 1.6 KB | |
| `index.html` | 0.3 KB | 0.8 KB | |
| `room.css` | 0.2 KB | 0.4 KB | |
| **TOTAL** | **3487.3 KB** | | |

**Cold mobile visit: identical.** A phone downloads all 3.49 MB — the ONNX
runtime, Rapier, fontkit, the model — in order to be shown a static image and
one line of text telling it to come back on a desktop.

### What the baseline says, before touching anything

The number that reframes the phase: **the ML alone is 75% of the payload**
(2149.9 + 483.3 = 2633.2 KB of 3487.3), and *not one* of the three fixes the
roadmap named touches it. The roadmap's items — drop fontkit, un-inline Rapier's
wasm, gate mobile — were written against an intuition about which files looked
big, and two of the three are real but modest. So the plan changed on contact
with the measurement:

- **Mobile gating is the largest single win available**, and it is a
  90%-plus cut rather than a shave. It was listed third; it goes first.
- **Non-blocking first paint is the real desktop lever.** `main.ts` blocks the
  first render on `Promise.all([createPhysicsRoom, loadGlyphSource,
  loadPropertyModel])` — nothing is on screen until all 3.49 MB has arrived and
  parsed. Lighthouse scores *when pixels appear*, not how many bytes followed.
  This was not on the roadmap at all; it is a deliberate scope addition, taken
  because shaving 130 KB off a 3.49 MB payload cannot move a metric that
  non-blocking paint moves outright.
- **The ML floor is the ML floor.** ORT's WebAssembly binary is not negotiable
  — Phase 1c measured the alternatives and the smaller builds are the slower
  ones, and swapping to an unverified minimal runtime would put the inference
  correctness Phase 1 verified at risk for a fraction of the bytes. The honest
  move is to stop it blocking the paint, not to pretend it can be deleted.

### Mobile gating — 3487 KB down to 21.7 KB

`main.ts` is now nothing but the branch. It detects mobile per DESIGN.md and,
critically, does so *before* the room is imported at all: the room hangs off
`await import("./boot")`, so the bundler puts Rapier, OGL, fontkit, the ONNX
runtime and everything they pull behind an edge a phone never traverses.

| | before | after |
|---|---|---|
| cold mobile | 3487.3 KB | **21.7 KB** |
| requests | 10 | **6** |

Verified in the browser rather than inferred: at a 390×844 viewport the built
preview makes exactly six requests — the HTML, three small scripts, the
stylesheet and the still — and at 1440×900 it makes thirteen, none of which is
the still.

**"Touch-only" is `any-pointer: coarse` with no `any-pointer: fine` anywhere.**
A touchscreen laptop reports both and gets the piece, because it has the
keyboard the piece needs; a tablet reports only coarse and gets the fallback,
because it does not. The check is deliberately not re-evaluated on resize — a
desktop window dragged narrower should not tear down a room full of words.

**The still is captured from the room, and it is a stub.** It is 240 words
committed into the running piece, photographed at 4:3 — the narrowest frame
DESIGN.md allows, chosen because at 16:9 the words are an illegible smudge at
390px wide — then cropped down to the composition, because the room's empty air
above the pile reads as a blank image on a phone. It ships as **lossless** WebP
at 20 KB, which is *less than half* what quality-78 lossy costs (35.8 KB): the
room is flat two-tone vector art, which is the case lossless was made for, and
lossy rings visibly around glyph edges. It must be regenerated once Phase 3
gives the room its SDF, shadows, tint and grain — this one is a picture of the
functional-and-ugly build.

One thing the capture surfaced in passing: filling the room from a mixed
vocabulary, **200 commits settle to about 60 bodies**. The crush is doing far
more clearing than the density cap, which never gets near 200. Recorded as an
observation for Phase 3's density work, not acted on here.

### Non-blocking first paint

Not on the roadmap; added deliberately. `startRoom` awaited all three loads
together and drew its first frame after the last of them, so nothing was on
screen until 2.9 MB of font, ONNX runtime and model had arrived — for a room
that is empty anyway. The two fetches are now started first and left in flight,
the room is built from Rapier alone (local: the `-compat` build carries its
WebAssembly inline), and the frame loop starts against the empty room
immediately. Typing is enabled when the assets typing needs have landed.

**Input waits for the model, not just the font, and that is the conservative
choice on purpose.** A word committed before the model can score it gets neutral
properties, and a `boulder` that falls like a leaf because it was typed early
fails feel test 1. Better a room that is briefly not typeable than one that
briefly lies. The alternative — let the room be typeable as soon as physics and
glyphs are up, roughly 2.6 MB earlier — is a real option on a slow connection
and is the author's call, not one to take silently.

### The finding that actually threatens Phase 8: the canvas never paints

Lighthouse cannot score the piece at all. Not a low score — **no score**:

```
Runtime error encountered: The page did not paint any content. (NO_FCP)
```

`performance.getEntriesByType("paint")` on the room reports `first-paint` and
**no `first-contentful-paint`**, and no LCP entry, *even with words committed
and rendering*. A WebGL canvas does not register as contentful content, and
Drift's entire visible surface is one WebGL canvas.

This was nearly recorded as a false finding. The first Lighthouse runs used the
headless Chromium from the Playwright cache, and headless returned `NO_FCP` for
**every** page including the plain-DOM `/debug/properties` — so the result there
was an artifact of the harness, not a fact about the piece. Re-run against real
headful Chrome, the three routes separate cleanly and the diagnosis holds:

| Route | What it is | Lighthouse performance |
|---|---|---|
| `/debug/properties` | ordinary DOM page | 75 |
| `/` at phone viewport | the fallback: `<img>` + text | **100** |
| `/` at desktop viewport | the room: one WebGL canvas | **no score — NO_FCP** |

Two things follow. The mobile route already meets the Phase 8 bar, which this
phase's work is what earned. And **Lighthouse 100 on performance is currently
unreachable on the room route for a reason payload cannot touch** — shaving
every byte would not change it, because the metric is waiting for a contentful
paint that never comes.

The fix is a contentful element in the DOM, and the piece is already scheduled
to grow one: DESIGN.md's footer — the sound toggle, the save and replay icons,
the credit line — lands in Phases 4 and 7. Phase 3's cursor will *not* do it;
the cursor is drawn into the canvas. This is flagged rather than fixed, because
inventing DOM chrome now would be adding UI to a piece whose specification says
there is none. **Re-run this measurement when the footer exists**, and treat
Phase 8's Lighthouse item as unverified until then rather than as confirmation.

### Dropping fontkit: bake the outlines, keep the pipeline

fontkit existed at runtime to do one thing — turn a character and a pair of axis
values into an outline — and that is a pure function of a font that does not
change between builds. `scripts/build-glyph-outlines.ts` now evaluates it once,
at build time, across a grid of axis samples;
`src/engine/glyphs.ts` interpolates between them. That takes both fontkit
(132.7 KB) *and* `Archivo.ttf` (191.7 KB) off the wire, since nothing at runtime
parses the font any more, and `typography.js` collapses from 132.7 KB to 5.1 KB.

**Bake the control points, not the flattened polygons.** Flattening at build
time was the obvious move and it is wrong. Curve subdivision and the RDP
simplification after it are both driven by a tolerance, so baking past them
freezes that tolerance into the data — and `/debug/glyphs`, whose whole job is
sweeping it to judge the collider budget, stops being able to sweep anything.
Baking control points instead means the runtime loses fontkit's *parsing* and
keeps every line of its own geometry pipeline. It is also smaller: an `o` is 30
commands where its flattened ring is several times that. Phase 3's SDF gets true
curves to read from, which is the other half of why this had to precede it.

**Sampling the masters is the whole game, and one sample point was worth 9×.**
The first grids measured badly — 20 font units of error, where the piece's
flattening tolerance is 31 — and adding weight samples did not help. The
residual was entirely in width, because the grid was sampling `wdth` at 85/105/125
and *missing the master at 100*. Archivo's design space turns out to be linear
between masters, so a grid that lands on them reproduces the font and a grid
that misses one does not:

| Grid | all ASCII | a-z | advance | bytes |
|---|---|---|---|---|
| 2×3 `[85,125]` | 63.03 | 54.76 | 64.97 | 57,918 |
| 3×3 `[85,100,125]` | 16.23 | 14.60 | 14.86 | 126,202 |
| 6×3 `[85,105,125]` | 19.97 | 14.56 | 19.39 | 249,112 |
| **6×3 `[85,100,125]`** | **2.33** | **2.13** | **0.00** | 249,112 |
| 6×4 `[85,100,112,125]` | 2.33 | 2.13 | 0.00 | 331,050 |
| 11×4 | 2.32 | 2.23 | 0.00 | 604,180 |

Sampling harder past 6×3 buys nothing, which says the remaining 2.33 units is
`getVariation`'s own integer rounding rather than interpolation error — the
arithmetic is exact and that is the floor. Advances come out exact.

**Two things the work turned up that would have shipped silently.**

*The point-compatibility check earned its keep on the first run.* `$` is not
point-compatible across the grid — its construction gains eight coordinates at
the heavy end — and interpolating index-by-index between outlines whose point
counts disagree does not throw, it produces garbage geometry. 94 of 95 glyphs
hold; `$` is baked at one setting and marked static, which for a character that
can never appear in a scored word is invisible. The bake names any such glyph in
its output so the exception stays a decision.

*`layout()` was applying ligatures, and dropping it would have turned them off.*
Archivo substitutes `ff`, `fi`, `fl`, `ffi`, `ffl` by default, so baking one
glyph per character would have quietly changed how `fire`, `flint` and `office`
are drawn **and shaped** — a ligature is one compound body, not two. Enumerating
every printable-ASCII pair and triple found exactly those five, so they are baked
as entries of their own and matched greedily; no GSUB implementation needed.

**Verified against the path it replaced**, over 14 words × 6 axis settings:
zero contour-count mismatches, zero point-count differences — the flattening
makes identical decisions — and a worst bounding-box difference of **0.0022 em**
against a flattening tolerance of 1/32 em. `/debug/glyphs` still reports the
counters and `i`'s two outer contours correctly, and its tolerance sweep still
sweeps.

### Rapier off `-compat`: 121 KB, and an engine the browser can cache

The `-compat` build carries its 1.15 MB WebAssembly base64-inlined in the
JavaScript. That is worse than it sounds, because base64 inside JS compresses
far worse than the binary does: **443 KB brotli against 319 KB**. Inlining cost
121 KB *and* denied the browser any chance to cache the engine as its own file.
`boot.js` falls from 475.6 KB to 35.9 KB.

Vite 8 handles the wasm ESM import natively — no plugin was needed, which the
roadmap had flagged as an unknown. What *was* needed is telling the dependency
pre-bundle to leave it alone. Rapier reaches its WebAssembly through
`import * as wasm from "./…_bg.wasm"` and the wasm-bindgen glue beside it expects
to be handed those exports via `__wbg_set_wasm`; the pre-bundle flattens the two
into one file and the hand-off does not survive. The module loads fine and then
the first `createRigidBody` dies reading `.memory` of undefined. **This breaks
only in `pnpm dev`** — the production build was correct throughout, which is
exactly the shape of bug that reaches a deploy. `optimizeDeps.exclude` now names
it, beside `onnxruntime-web`, which is excluded for a related but distinct
reason.

`RAPIER.init()` goes away with the compat build, so `createPhysicsRoom` is
synchronous — the lint's `require-await` caught the alternative, correctly.

### Where it landed

| Asset | Before | After |
|---|---|---|
| `ort-wasm-simd-threaded.wasm` | 2149.9 KB | 2149.9 KB |
| `properties.v1.onnx` | 483.3 KB | 483.3 KB |
| `room.js` / `boot.js` | 475.4 KB | 35.9 KB |
| `rapier_wasm2d_bg.wasm` | — (inlined) | 318.9 KB |
| `Archivo.ttf` | 191.7 KB | — (build input only) |
| `typography.js` | 132.6 KB | 5.1 KB |
| `glyph-outlines.bin` | — | 106.5 KB |
| `properties.v1.vocab.txt` | 32.0 KB | 32.0 KB |
| `properties.js` | 21.1 KB | 20.8 KB |
| `mobile-fallback.webp` | — | 19.7 KB\* |
| everything else | 1.4 KB | 1.9 KB |
| **cold desktop** | **3487.3 KB** | **3174.1 KB** |
| **cold mobile** | **3487.3 KB** | **21.6 KB** |

\* attributed to desktop by the static walk but never actually requested there —
see the note in `measure-payload.ts`. The true desktop figure is ~3154 KB.

What each change bought:

| Change | Desktop | Mobile |
|---|---|---|
| Mobile gating | — | −3465.7 KB |
| Non-blocking first paint | 0 KB (it moves *when*, not *how much*) | — |
| Bake glyph outlines, drop fontkit | −212.8 KB | — |
| Rapier off `-compat` | −120.7 KB | — |

**Cold mobile is a 99.4% cut. Cold desktop is 9%,** and the honest reading of
that second number is the one the baseline predicted: the ONNX runtime and the
model are 83% of what remains, they are not negotiable — Phase 1c measured the
alternatives and the smaller builds are the slower ones — and no amount of
further shaving touches them. The desktop budget is the ML floor plus about
520 KB, and 520 KB is a defensible number for a piece that ships a physics
engine and a typeface.

**Lighthouse**, built preview, real headful Chrome:

| Route | Performance | Accessibility | Best practices | SEO |
|---|---|---|---|---|
| `/` at phone viewport | **100** | **100** | 96 | **100** |
| `/` at desktop viewport | *no score — NO_FCP* | — | — | — |

Accessibility reached 100 by giving the document a `<main>` landmark and the
canvas an `aria-label`; the centring moved from `<body>` to `<main>` to do it,
rather than using `display: contents`, which has a history of dropping elements
out of the accessibility tree — the one place a landmark needs to be. The single
remaining best-practices deduction is the `favicon.ico` 404, which is Phase 8's
item and resolves itself when the favicon lands.

Nothing regressed. Inference p50 0.10ms / p95 0.80ms over 18 cache-missing
words, against a 5ms budget. Feel test 1 holds at 896ms versus 2425ms, the same
2.7× gap. `ball` still bounces higher than `boulder` thuds; `mist` leaf-drifts
0.99 units where `boulder` drifts 0.01; a `mountain` crushes a bed of six light
words and a `boulder` crushes none of six heavy ones; a struck pile wakes,
shifts and re-freezes 7/7. Both debug pages work.

### Phase 2 — the step-cost debt, closed

The 10.5ms p50 predates the physics rework: free rotation, the restoring torque,
collision events, per-step impact snapshots and the crush all landed after it,
and none of them had been measured against the 16.7ms budget. The debt stayed
open because every attempt to re-measure through the Playwright driver produced
a number nobody could trust.

**The trust problem has a clean answer, and it is an argument rather than a
better harness.** A throttled browser inflates wall-clock readings; it never
deflates them. So a *throttled* measurement that comes in under budget is
sufficient proof — the real number can only be better. Only a reading that
*fails* would need foreground Chrome to adjudicate.

The other thing every previous attempt got wrong was measuring the wrong room. A
settled room is cheap by construction, because freezing has already converted
almost everything to static bodies:

| Room state | bodies | awake | step p50 | p95 | max |
|---|---|---|---|---|---|
| Settled (sedimented) | 195 | 5 | 0.8ms | 0.9ms | 1.3ms |
| **Filling, fully awake** | **198** | **199** | **6.2ms** | **6.9ms** | **8.1ms** |

The second row is the real budget question — 199 bodies awake simultaneously
across 7,671 colliders, which is the worst case the piece can produce — and it
sits at **37% of the 16.7ms budget**, with the worst single step in the whole
run at 8.1ms. Freezing is what makes the first row nearly free, but the piece is
inside budget even with freezing contributing nothing at all.

**Debt closed. The physics rework did not cost the budget.**

> **An observation, not acted on: the crush is doing almost all the clearing.**
> Filling this room took **358 commits to reach 198 bodies** — and that was with
> heavyweights deliberately excluded, using only medium-mass words like `stone`,
> `slate` and `gravel`. With a mixed vocabulary it is worse: 200 commits settle
> to about 60. DESIGN.md specifies density management as a soft cap at 200 with
> the oldest word fading out, but at this crush rate the room may never reach
> 200, which would make that mechanism dead on arrival. Either the crush is too
> aggressive or the cap is the wrong instrument. Recorded for Phase 3, where the
> aging work lives; it is a feel judgement and belongs to the author.

---

## Phase 2 (completed) — the SDF

The last two open items in Phase 2. Words were drawn as flat fills of the same
triangulation their colliders were cut from, which was the right call at the
time — the picture could not disagree with the simulation — and the wrong one to
ship, because the facets are visible (`docs/images/sdf-before-after.png`, old on
top, new below).

### One field per word, not an atlas

The usual approach is an MSDF atlas of glyphs, and it does not survive this
piece's premise. `wght` and `wdth` move *per word*, so an atlas would have to
cover the axis grid — 100 glyphs × 18 samples — which puts back a large share of
the payload Phase 2.5 just removed. Worse, blending two rasterised fields only
approximates the shape between them; it is not the same operation as
interpolating outlines, which is what the font actually does.

So: **a field per word, generated on commit, cached exactly as its hulls
already are.** A word is small, it is generated once, and axis values can be
anything.

**The browser rasterises the curves.** `Path2D` takes the baked quadratics
directly and fills them with the nonzero winding rule — which is what makes a
counter a hole — in native code. A hand-written scanline rasteriser would be
longer, slower, and worse at the one thing that has to be exactly right. The
mask then goes through an 8-point signed sequential Euclidean distance
transform, which keeps distances Euclidean rather than the chessboard
approximation a naive two-pass transform produces.

**This is what baking control points in Phase 2.5 was for.** Had the bake stored
flattened polygons, the SDF would be drawing the same faceted silhouette as the
colliders and the whole exercise would be pointless. `glyphs.ts` now returns the
raw curves alongside the flattened contours, built in the same pass off the same
pen position and shifted by the same centre — because a picture and a body that
disagree by a rounding error are very hard to see and very easy to misdiagnose.
Note the bounding box comes from the *flattened* contours deliberately: a
quadratic's control point can sit outside the curve it describes, so a box
fitted to the raw path would be slightly larger and would offset the word from
its body.

### Two performance findings, both measured

The first version took **97ms a word**, which is six dropped frames on a commit.
Two causes, and neither was the distance transform's algorithm:

- **Supersampling at 4× costs four times what 2× does**, because the transform
  scales with mask *area*. What it buys is 0.002 em of precision against 0.004 —
  on a field whose texels are 0.016 em apart, under a shader that softens the
  edge over a whole screen pixel. Invisible; dropped to 2×.
- **Assigning `canvas.width` reallocates the bitmap and resets 2D state**, and
  it was happening on every bake. The canvas now grows and is never shrunk, and
  the word is rasterised into its top-left corner. This was most of the cost of
  a long word: `extraordinary` went from 26ms to 7.6ms.

| | first version | shipped |
|---|---|---|
| p50 | ~97ms | **4.1ms** |
| p95 | — | **8.4ms** |
| worst (16-char word) | 26ms+ | **8.4ms** |

Comfortably inside a 16.7ms frame, and commits are user-paced anyway.

### Antialiasing without derivatives

The conventional SDF shader softens its edge with `fwidth`. This one is handed
the width as a uniform instead, because **the room already knows the answer
exactly** — it knows how many pixels an em covers, having chosen the projection
itself. That is both more portable (derivatives are an extension under GLSL ES
1.00) and more correct than asking the hardware to estimate a quantity we
computed.

### What this gives up, on purpose

The colliders and the drawing are now different shapes. A counter is round on
screen and faceted in the solver. That is the intended end state — it is why the
two pipelines were separated in the first place, and why the flattening
tolerance can stay coarse enough for 200 bodies — but it does mean
`/debug/glyphs` is now the *only* view of what the physics actually sees, which
raises its value rather than lowering it.

---

## Phase 3 — shadows and semantic tint

The two design items the SDF unlocked, done first because they cost almost
nothing once the field exists.

**The shadow is the same texture, read differently.** No second field, no blur
pass, no render target: a shadow is the word's own distance field thresholded
with a wide ramp that starts at the letter's edge and falls away outward, rather
than a narrow one straddling it. That is what makes it read as cast light rather
than as a fattened copy of the word. It costs one extra quad and no extra
memory. `mass` drives both the blur width and the drop, so the shadow and the
letterform thicken together off the same score.

**Two layers, not one.** Every shadow draws beneath every word, not just beneath
its own. With the depth buffer off, draw order *is* stacking order, and a single
layer let a word's shadow fall across the letters of a neighbour committed
earlier.

**The first values were invisible, and the field was why.** `SPREAD_EM` was
0.08, which is the ceiling on how far a shadow can reach — the field simply does
not know about distances beyond it. At roughly 36 pixels to the em that capped
the blur at about one pixel. The mechanism was correct the whole time and could
be proved so by counting pixels in the shadow's brightness range (1,466 of
them), but nothing was visible to the eye. Widening the spread to 0.14 costs
about 15% more texels — the field grows by its margin on each side, not by area
— and buys a shadow that reads.

A related thing worth knowing, and not a bug: **a word resting on the floor has
no visible shadow**, because the floor is the bottom edge of the frame and the
shadow falls below it. Shadows appear on the *pile*, where words rest on other
words. That is physically right and it means the effect is invisible in a
near-empty room, which is worth the author's eye.

**Semantic tint** interpolates `INK_COOLEST` → `INK` → `INK_WARMEST` across
warmth, in two segments so a neutral word lands exactly on `INK` rather than
somewhere between the extremes. It reads exactly as DESIGN.md asks: the room is
monochrome at a glance and `marble` is visibly cooler than `cedar` on
inspection.

The in-progress word gets neutral ink and, per DESIGN.md, **no shadow** — it is
not a physical object yet, and nothing that has not landed should look like it
is resting on anything.

**Cost, measured.** A bake is 4.7ms p50 (from 4.1ms, for the wider field). A
166-word room now issues 332 draw calls and holds **11.3ms p50 / 13.5ms p95**
frames against a 16.7ms budget — measured through the throttled driver, so the
real figure is better.

> **The shadow numbers are the author's to tune.** DESIGN.md fixes the colour
> and opacity (`#000000` at 8%) but not the blur or the drop, and those are
> judgement. The current values were chosen to be *visible* after the first pass
> was not; whether they are now too visible for a piece this quiet is a feel
> question.

---

## Phase 3 — the rest of the room's design

Four questions went to the author before any code was written, because all four
change what gets built rather than how. They are recorded in
`docs/specs/2026-07-27-phase-3-room-design.md`; the reasoning is here.

### The commit spring versus the SDF

`DESIGN.md` springs `wght` and `wdth` from neutral to the model's values over
~180ms. Geometry is cached at a 5-unit axis quantum, so that spring passes
through roughly eleven distinct axis pairs — each one its own SDF bake at 4.7ms
and its own ~15KB texture, none of which is ever read again. Eleven dropped
frames per commit, and 33MB of dead textures across a full room, to animate
180ms. The field cache is keyed on `WordPath` identity with no eviction, so
none of it would ever be reclaimed either.

**Decision: build geometry once at the target axes, spring only uniforms.**

The thing that makes this safe is a distinction worth stating plainly: the axis
**mapping** is the load-bearing move, not the axis **animation**. `CLAUDE.md`'s
"the word IS the body — do not skip it" is about a heavy word rendering heavy,
and that shipped in Phase 2. What springs now is `uScale` for the arrival's
snap, plus the shadow's blur and drop growing in from zero — which `DESIGN.md`'s
commit sequence already asks for in as many words ("shadow appears and blurs to
its target radius"). `ROADMAP.md` already forbade rebuilding colliders during
the spring; this is the same argument applied to the picture.

Two alternatives were considered and rejected. Blending the neutral field into
the target field in the shader costs *no* extra bakes — the neutral field is
already cached, being the draft word that was just on screen — but `wdth` moves
letters by far more than the field's 0.14 em spread, so the blend would
crossfade letters between two positions rather than slide them. Accepting the
churn behind an LRU is truest to the specification and was judged not worth a
dropped frame per commit.

Verified by counting: ten committed words created exactly ten textures.

**Worth knowing before anyone tunes this.** Spring overshoot is a fraction of
the *travel*, not of the target. The commit spring overshoots by 5.8% of
however far it is asked to move, so driving scale from 0.92 to 1.0 peaks at
1.004 — a snap you feel in the arrival, not a visible bounce past full size.
`DESIGN.md`'s "more overshoot" is a comparison between its two spring configs
(5.8% against the default's 1.1%), not a promise of a bounce.

### Two places DESIGN.md disagrees with itself

Both were resolved in favour of the number that describes what a visitor
experiences, and both are recorded rather than silently picked.

**The commit spring's duration.** It asks for "~180ms" *and* for "stiffness 180,
damping 18". Those are different springs: at ζ = 0.671 the first overshoot peak
lands at 308ms and the spring retires at 658ms. The named constants ship,
because they are the explicit instruction; hitting 180ms would mean stiffness
near 1000, which is a different feel rather than a different number. On the
author's list.

**The clear gesture's timing.** It asks for "staggered over 1.5s" *and*
"~30ms apart", which diverge above about fifty bodies — at 200 a 30ms stagger
takes six seconds. The stagger is clamped so the whole gesture always finishes
in 1.5s, which makes 30ms exactly right at fifty and tighter above it. Measured:
30 bodies and 200 bodies both empty in ~1.5s despite a 7× difference in stagger.

### Density versus the crush, and why nothing was tuned

A mixed vocabulary settles at about 60 bodies; it took 358 commits to reach 198.
The soft cap of 200 therefore almost never fires.

**Decision: change nothing.** The initial recommendation here was to retune the
crush so the room would fill, and it was wrong — it imported a density target
from the wording of feel test #4 rather than from what the piece is for. Words
having discoverable physical consequences *is* the piece; a 60-word room with a
crater where a heavy word landed is a better composition than a 200-word
undifferentiated pile. The cap is reclassified from a mechanic to a
long-session safety valve and the standing debt is closed as a finding.

The one thing that was checked rather than assumed: **which words can actually
crush.** `CRUSH_MIN_STRIKER_MASS` is 0.25, and across the 173 curated words that
carry labels, **53 of them (31%) clear that gate.** The gate is not
"heavyweight", it is "top third of the mass distribution", and the list contains
some words `DESIGN.md` would not call heavy:

- Genuinely heavy, as intended: `boulder` +0.90, `glacier` +0.90, `anchor`,
  `granite`, `iron`, `steel`, `ballast`, `vault`, `cathedral`, `tomb`.
- `grief` +0.80 — not a mistake, and arguably the best thing in the list. It is
  the piece's whole thesis arriving on its own.
- Onomatopoeia the model hears as heavy: `rumble` +0.80, `crash`, `thud`,
  `clang`, `boom`, `bang`.
- Colours and gemstones: `coral` +0.50, `sapphire`, `emerald`, `ruby`, `jade`,
  `onyx`, `umber`, `cobalt`, `ochre`, `sienna`, `ivory`. Several of these are
  also Phase 6 colour-word behaviours.
- Archaic adverbs: `yore` +0.40, `henceforth` +0.30, `heretofore`, `behold`.

Reach scales fast, because the radius is `1.1 + 1.6 × mass` in a room 17.8 units
wide:

| striker mass | radius | can crush | share of curated set |
| --- | --- | --- | --- |
| +0.30 (`sienna`) | 1.58 | 46 words | 27% |
| +0.50 (`stone`) | 1.90 | 79 words | 46% |
| +0.90 (`boulder`) | 2.54 | 130 words | 75% |

A `boulder`'s crater spans 29% of the room's width. **`henceforth` flattening a
feather is the concrete oddity**, and whether that is charming or wrong is the
author's call — per the decision above, no constant was touched.

### `age` gets a visual consequence: old words are worn

Open since Phase 1a, and the only property the model predicts that nothing
consumed. An old word now renders very slightly eaten away and softer at the
boundary, as though it has been sitting in the paper longer.

It is free, which is the reason it is possible at all: the glyph is drawn from a
distance field, so eroding it is a shift in *where the field is thresholded*,
not a different outline. No re-bake, no second texture, no geometry — the same
argument as the commit spring, arriving at the opposite conclusion because this
one costs nothing.

It does not collide with Phase 6's ancient-words behaviour, which is a momentary
sepia flash at commit on ~30 curated words; this is a permanent material
property. Shadows are exempt: wear belongs to the ink on the paper, and a shadow
belongs to the light.

The model separates the cases cleanly — `whence` +0.79 and `granite` +0.68
against `startup` −0.88 and `laptop` −0.80 — and old words render a 26% wider
edge transition band. Note that proxy is confounded by stroke weight, since a
light word's thin strokes mimic a worn edge, so `whence` over `startup` measures
1.39× against 1.49× predicted.

### The mono face: IBM Plex Mono, 3.8 KB

A system stack was the placeholder and would have been defensible — free, never
blocks, no licence question. What decided against it is the **watermark**: an
exported still is drawn on the visitor's machine, so a system stack means every
image leaving the piece carries a different typeface, and the watermark is the
one part of the identity that travels.

Subset to the 75 characters the piece actually sets, assembled from the real
strings rather than a guessed range — a guessed range is how a subset quietly
stops being a subset — and the script fails above 8 KB for the same reason.

**Source fonts moved out of `public/`.** Vite copies that directory wholesale,
so `Archivo.ttf` was being *deployed*: 658 KB sitting at the edge that no
visitor ever requests, and invisible to `pnpm measure` because that follows
references from the entry rather than listing the bucket. Build inputs now live
in `fonts/`; only the subset lands in `public/`.

### Three bugs found by looking rather than by failing

None of these announced themselves.

**`hello123` became a body.** `normalizeWord` already implemented all three of
`DESIGN.md`'s refusals — a digit anywhere, nothing left after stripping trailing
punctuation, longer than 24 characters — but `commitWord` read a null
*prediction* as "the model is unavailable" and committed anyway with neutral
scores. The rule was computed and then discarded. Asking `normalizeWord`
directly separates "this is not a word" from "inference is not running", which
are opposite situations: the first must refuse, the second must still let the
room work.

**The glyph was losing its punctuation.** `DESIGN.md` says trailing punctuation
is preserved in the glyph and included in the body's shape, stripped only before
inference — but geometry was built from the model's stripped word, so `hello,`
committed as a body reading `hello`. The bake covers all printable ASCII; the
comma was always there and nothing was asking for it. `hello,` is now 33 hulls
at 2.504 em against `hello`'s 31 at 2.255.

**`pnpm measure` was under-reporting.** Its reference regex required a quote
before a path, which is true of every reference in HTML and JS — but Vite
minifies CSS to `url(/fonts/x.woff2)` with the quotes stripped, so the mono
subset was being downloaded and not counted. The failure mode is the dangerous
direction for a number the roadmap treats as a budget.

### Smaller things that were measured rather than assumed

**The caret was drawn underneath the words.** Parented into the ink layer it
drew *before* every word, because OGL keeps equal-depth transparent meshes in
traversal order and the caret is created once at startup while words are
appended as they commit. Measured: 200 accent pixels fell to 22 as soon as
anything was being typed. It has its own layer now.

**The aging fade's opacity is linear while its motion eases out.** Running
opacity through the same ease-out left the word 87.5% gone at the halfway point
— it stopped registering at all after about 1s of a 2s fade, so the back half of
the drift was animating something invisible.

**Spring rest detection is relative to travel.** An absolute epsilon larger than
the travel reports rest at the overshoot *peak*, where the spring is momentarily
at zero velocity and already inside epsilon. The commit spring retired at 308ms
— exactly its peak — freezing every word mid-bounce. Scaled by travel it retires
at 658ms.

**The soft cap had to become an invariant, not an event.** Enforced from a
commit callback it depended on every path that adds a word remembering to
announce itself; the dev console handle did not, and the room quietly reached
215 bodies. Checked from the room's step it settles at exactly 200.

**Waking a settled word does nothing.** The focus nudge originally only turned
frozen bodies back to dynamic, which is a no-op that looks like a feature: a
settled word is in equilibrium, so it simply re-freezes 1.5s later having not
moved. `stir` shoves as well as wakes.

### The blur/visibility split

`DESIGN.md` says window blur pauses physics and gives the reason as background
CPU burn. But `blur` also fires when the window is merely not frontmost, so
clicking a window on a second monitor would freeze a room the visitor is still
watching. The pause keys on `visibilitychange`, which is the case the stated
reason actually describes; blur pauses only the caret's pulse, which is the part
genuinely about holding the keyboard.

The resume nudge stirs the *surface* — words with nothing resting above them,
capped at 40 — rather than "all sleeping bodies". Waking a full pile costs a
second of full-room physics on every tab return and would visibly slump sediment
the visitor left settled. Measured on a 60-word pile with 59 frozen: hidden
stops the loop dead and zero bodies move; on resume 4 of the 12 surface words
shift measurably, every one on the surface, and all 47 buried words stay frozen.

### The grain

Two octaves, not one. `DESIGN.md` asks for "low frequency", which alone gives
mottle with no surface to it; the fine octave supplies tooth. Together they read
as stock, separately as either a gradient artefact or as video noise.

**No time uniform, deliberately.** Animated grain is the obvious reading and it
is wrong here: it would be the only continuously moving thing in an empty room,
in a piece whose argument is stillness, and it would make the still export a lie
by freezing one arbitrary frame of what the visitor saw as shimmer.

Measured: the midday mean lands on `#F4F0E8` to within 0.03 of a level, so the
grain is centred rather than darkening the paper; range ±3 levels; adjacent
pixels differ by 0.63 on average. Night reads 5 levels darker in red and 10 in
blue.

### Time of day

`#F4F0E8` is hue 40° in HSL — it sits in the oranges — so **warm is a negative
hue offset and cool is positive.** Getting that backwards would make golden hour
cool and evening warm, and at a 6° excursion nobody would notice for weeks.
Verified by measuring the output back: golden hour lands at 32° against a 40°
base, night at 42°.

The period table stores each period's *start* minute rather than its plateau,
which is what makes the night-to-morning wrap across midnight arithmetic instead
of a special case. Measured: max change 0.013 across 5-minute samples, midnight
wrap exactly 0, midday exactly `#F4F0E8`.

The tint is recomputed on a minute tick and the *same object* is handed back in
between, which is what lets the renderer decide by identity whether the room's
light has moved — so two hundred words are relit once a minute rather than every
frame.

### Phase 3 — the numbers, re-measured

Everything on the must-not-regress list, plus the two performance figures this
phase could plausibly have moved.

| | baseline | now |
| --- | --- | --- |
| Inference p50 / p95 | 0.10 / 0.80ms | under timer resolution, max 0.5ms |
| Feel test 1 — boulder to floor | ~900ms | **885ms** |
| Feel test 1 — feather to floor | ~2450ms | **2374ms** |
| Commit (inference + hulls + SDF bake), 40 distinct words | 4.7ms p50 | **3.9ms p50 / 5.3 p95 / 7.4 max** |
| Step, room filling, 132 bodies / 4906 colliders | 6.2ms p50 @199 awake | **1.7ms p50 / 2.0 p95** |
| Frame, step + springs + render, same room | 11.3ms p50 @166 words | **2.3ms p50 / 2.6 p95** |
| Cold desktop | 3174.1 KB | **3193.7 KB** |
| Cold mobile | 21.6 KB | **35.7 KB** |

Mobile grew for one reason and it is the grain: the fallback still is a capture
of the real room, and 2% procedural noise is close to incompressible. The old
20.6 KB image predates it. Lossless WebP came out at **399 KB**; the shipped
still is 880×660 at quality 85, which is 30.5 KB. The rest of the increase is
the mono subset at 3.7 KB. Desktop's figure now over-counts by both the fallback
image and the font — neither is requested on that route until the footer lands
in Phase 4/7.

**A measurement trap worth recording, because it produced a fake 7× regression.**
Committing 199 words in a tight loop reports a **44ms** step. Committing the same
199 words at a human pace reports **1.7ms**. The difference is not the room, it
is that every word spawns at the cursor's height and an instantaneous fill leaves
199 bodies interpenetrating at one point — a solver state no visitor can create.
The first reading looked exactly like a real finding. *Measure the room a person
would make.*

Related, and a real limit rather than an artefact: with light words the room
accumulates cleanly to about 130, and past that the pile reaches the spawn height
and new words start arriving inside it. That is what DESIGN.md's unimplemented
"safe zone around cursor" is for, and it is the practical ceiling on density
independently of the crush.

**Feel test #4.** Two minutes of mixed typing is 78 commits and settles to 27
bodies — the crush doing what the author decided it should. The still is
`docs/images/phase3-room.png`: sediment banked along the bottom of a mostly empty
page, tilts organic, semantic tint legible on inspection (`marble` and `crimson`
cooler, `amber` and `dusk` warmer) and invisible at a glance. Whether that is a
composition worth hanging is the author's call, and it is the one thing in this
phase that cannot be settled by measuring.

---

## Phase 3, second pass — legibility, and what counts as a word

Three changes after the author used the room. Two were "make it more obvious";
the third changes what the piece accepts, and contradicts two specification
documents on purpose.

### The tint was weak for a reason in the data, not the palette

`marble` and `cedar` were supposed to read cool and warm. They read the same.

The instinct is to reach for louder colours. The numbers say otherwise: the
palette's endpoints were reached at warmth ±1.0, and across the 10,750 labelled
words **58% score |warmth| < 0.3 and only 5% exceed 0.6**. Nearly every word
rendered within a hair of neutral `#1A1817`, and `#152838` / `#3A2418` were
decoration that nothing ever touched.

So the fix is a gain of 2 on the score, putting the endpoints at ±0.5 —
approximately the p10–p90 spread of the real distribution. **The declared
colours did not change.** `marble` now renders `#2d3d49` and `cedar` `#4e3a2e`,
which is legible at a glance without inventing anything.

Worth generalising: when a mapping looks too subtle, check the distribution of
what feeds it before touching the endpoints. A linear map across a range the
data never occupies is not a subtle effect, it is an unused one.

### `age` fades the ink as well as wearing the edge

Edge erosion alone did not read — it is a one-pixel boundary difference you have
to hunt for. Old writing fades, and fading changes a word's whole tone, so it
survives being glanced at. Both now apply: faded *and* slightly eaten is what old
ink on old paper looks like.

Two bugs caught by printing the values rather than by looking:

- Mapping age −1…+1 onto the fade meant a word of **neutral** age was already
  15% washed out, so `inkForWarmth(0)` returned `#3b3836` instead of `#1A1817`.
  That silently broke DESIGN.md's "a neutral word lands exactly on `INK`" and,
  because most words sit near the middle, it lightened the entire room rather
  than marking the old ones. Only positive age fades now.
- 30% was too much at the top: `whence` washed out to `#545453`. At 22% it is
  `#3f4040` — clearly older than its neighbours, still ink.

The ink mixes toward the paper rather than lowering alpha, so a worn word does
not go translucent over the words behind it.

### The room now decides what is a word

The largest change in the phase, and it overrides `DESIGN.md`'s "nonsense
strings ... this is a feature" and narrows `CLAUDE.md`'s OOV rule.

The author's argument: *a word that doesn't exist has no age, weight or
bounciness.* That is the piece's own premise turned back on it — mass comes from
meaning, so a string with no meaning has no business having mass. Phase 1c
already had the evidence and had filed it as a curiosity: `asdf` scores **warmth
+0.66 and neutral mass**, which is not DESIGN.md's promised "light, drifty,
unstable" but simply arbitrary. Nothing in those letters is readable, because a
word's physical feel is semantic rather than orthographic — the same finding that
killed the bidirectional GRU in Phase 1b.

**Two sources, intersected, and each covers the other's failure.**

A frequency list ranks `asdf`, `wasd` and `qwerty` *above* `gloaming`, because
keyboard mashing is common on the web. Growing it makes this worse rather than
better — measured, the top 250k admits `asdf` and `wasd` while still missing
`brume`. A lexicon alone is 370k entries and 867 KB compressed, overwhelmingly
obscure inflections.

Requiring both:

| | words | payload | evocative words | mashing admitted |
| --- | --- | --- | --- | --- |
| frequency top-60k | 57k | 110 KB | 12/20 | 1/14 |
| frequency top-250k | 99k | 469 KB | 19/20 | **3/14** |
| lexicon alone | 370k | **867 KB** | 19/20 | 0/14 |
| **lexicon ∩ top-150k** | **78k** | **157 KB** | **16/20** | **0/14** |

The model's vocabulary and `model/data/curated.txt` are unioned in
unconditionally — every word the model was trained on must be committable, and
the curated list carries the archaic words (`zounds`, `alack`) that Phase 6's
ancient-words behaviour is built on and that no frequency list contains.

**This does not retire the character branch, it scopes it.** The model knows
10,749 words; the lexicon allows 77,843. The branch still scores ~67,000 words
the model has never seen. It was doing two jobs and failing one; now it does one.

Cost is 157 KB brotli on the desktop route, and the *perceived* cost is zero:
typing was already gated on the 483 KB property model, and the lexicon loads
alongside it. A failed lexicon fetch degrades to accepting anything — a room that
refuses every word is broken in a way a briefly permissive one is not.

### Refusal keeps the word

The behaviour the author actually asked for, and the smallest change with the
largest effect on how it feels. The buffer used to be cleared *before* the commit
was attempted, so a refused word vanished and then the caret shook — which reads
as the piece eating your typing, and leaves you retyping something you can no
longer see. Now `onCommit` returns whether the room took the word, and the buffer
survives a no. You can turn `asdfgh` into `ash` by backspacing.

Letters are refused at the keystroke rather than at the commit, for the same
reason: there is nothing to be gained by letting a digit appear and then refusing
the whole word for containing it.

---

## Liveliness and touch — the room was dead, and the reason was a stale number

The author used the finished Phase 3 room and said it feels dead. The diagnosis
was right and it was structural rather than aesthetic: every settled word is a
Rapier `Fixed` body, nothing moves unless you type, and the pointer cannot touch
anything. Measured on a settled 150-word room, **150 of 150 frozen**.

The agreed direction is to make liveliness a *property, like mass*. The piece's
thesis is that meaning becomes physics, and today that only applies to falling.

### The measurement that unlocked everything, and why it had gone stale

Phase 2 converted settled words to static bodies because a 200-word awake room
cost **72ms** a step. That single number is the entire justification for the
mechanic, and every decision since has deferred to it.

It is stale, and the reason is that *the fixes it prompted invalidated it*. The
72ms reading is what led to sizing words down from `WORD_EM_UNITS` 0.9 to 0.4 —
a room that could not hold its own soft cap stays permanently pressurised — and
to narrowing the density range from 40:1 to 5:1. Both landed, and nobody went
back to re-take the measurement that asked for them.

Re-measured through the throttled Playwright driver, filling at a human pace:

| Room state | bodies | awake | colliders | step p50 | p95 | max |
| --- | --- | --- | --- | --- | --- | --- |
| Settled today, as it ships | 150 | **0** | 5,072 | 0.4ms | 0.5ms | 0.5ms |
| The same room, everything awake | 150 | 150 | 5,072 | 1.8ms | 2.1ms | 2.5ms |
| **At the 200 soft cap, everything awake** | **200** | **200** | 6,821 | **2.8ms** | **3.3ms** | **3.6ms** |

**Freezing is buying 2.4ms in a room with 13ms of headroom.** A permanently
awake room at the hard cap sits at 17% of budget, and a throttled reading under
budget is sufficient proof because throttling only ever inflates.

**Lesson for the writeup, and it is the sharpest one in the project so far:** a
measurement justifies a mechanic, the mechanic's own fixes change the thing
being measured, and the number is never re-taken. It then sits in a comment for
three phases being cited as a reason. The 72ms was true when it was written and
wrong within the same phase. *Re-measure the number a decision rests on when you
change what it was measuring.*

### Words land where the pointer is, in both axes

The cursor followed the mouse in x only and every word spawned at the room's
centre height. A room composed along a line is a shelf rather than a space.

Full height, no vertical clamp beyond the frame. Placing low is *setting a word
down* rather than dropping it, which is a gesture worth having, and feel test 1
survives because that test drops both words from the same height — which is what
anyone comparing two words does.

**This made DESIGN.md's unimplemented safe zone necessary rather than nice.**
Aiming into a pile puts a compound body inside other compound bodies and the
solver's only answer is to eject one at speed. It ships as a **lift, not a
circle**, and the asymmetry is the design: x is the axis the visitor chose and is
kept to the digit, y is the axis the pile occupies and is the only one corrected.
Extents come from each body's *rotated* bounding box, because a leaning word
sticks up by exactly the amount the safe zone exists to clear.

The part that makes it a design decision rather than a bug fix: **the draft
renders at the corrected height.** The caret visibly climbs the sediment as the
pointer sweeps across it, so the pile has presence before you commit anything to
it, and a word never silently teleports on commit. Measured: aiming 1.5 units
deep into an eight-word heap releases 0.06 above its surface; an empty column is
untouched exactly.

### Grab and throw, and the square root that nearly hid the whole point

Three decisions carry the feel.

**The pick is a projection with a radius, not a containment test.** A glyph is
mostly counters and gaps between letters, so clicking the middle of an `o` or
between `t` and `h` would miss — and a piece with no hover state gives the
visitor nothing to correct against. `projectPoint` turns "did I hit it" into
"how close was I", which is the answerable question.

**The spring pulls at the grip, stored in the body's own frame**, so a word held
by one corner hangs and swings from it instead of sliding rigidly under the
pointer. Damping is against the *grip's* velocity rather than the body's; damping
the body would leave a corner-held word free to spin, because the spin is
invisible at the centre of mass.

**The stiffness gap had to be far larger than it looked.** The impulse is scaled
by the body's mass, making it an acceleration drive, so the gain has to come from
the mass *score* or every word moves identically. The first values — 900 at the
light end, 260 at the heavy — are a 3.5:1 ratio and measured **1.8:1** of actual
lag, which read as nothing at all. The arithmetic says why: a damped spring
following the pointer at a steady speed settles at a lag of `2ζv/√k`, so felt
weight goes as the **square root** of the gap. 9:1 buys the ~3:1 that can be
felt.

**Release just stops the spring.** No captured pointer trail and no injected
throw velocity — a heavy word lagged behind your hand while it was held, so it
also leaves your hand slower. *The lag is the weight*, and replacing it with the
pointer's own speed would flatten the one distinction the piece exists to make.

Measured over an identical pointer path for every word:

| word | mass | lag behind pointer | flew after release |
| --- | --- | --- | --- |
| feather | −0.60 | 0.53 | 2.32 |
| paper | −0.50 | 0.54 | 3.06 |
| stone | +0.49 | 0.89 | 6.67 |
| boulder | +0.87 | **1.40** | **8.15** |

The 3.5:1 spread in throw distance is **emergent, not added**: it is the existing
damping model arresting a thrown feather in mid-air while a boulder keeps its
momentum. Nothing was written to produce it.

A held word does not freeze and cannot be crushed — the hand is the one place the
visitor is in charge — but it can still *crush*, and a swung `boulder` took 3 of
5 light words out of a bed. Grabbing wakes the sediment around it so the pile
falls into the space, reusing the crush's existing `wakeAround`.

**Two test bugs worth recording, because both looked like findings.** A swung
boulder first reported crushing 0 of 5 — the sweep ran at y = 1.5 while the light
words had settled at y = −4.8, so it passed through empty air. And a held word
reported as "gone" after release: correct behaviour, not a leak, because the
`mountain` parked on top of it while it was held flattened it the instant the
hand let go. *Measure the room a person would make* applies to the pointer as
much as to the keyboard.

### Liveliness replaces the freeze, and the deadness turns out to have two halves

`liveliness = (1 − mass)/2 + intensity × 0.25`, computed once at commit and
stored on the body as a first-class property beside `scores`. Above 0.5 a word
never freezes at all; below it the freeze delay scales from four seconds down to
four hundred milliseconds. Sediment still forms — it now forms at a rate that
means something, where Phase 2 turned a feather and a mountain to stone on the
same 1500ms schedule.

The breath is **one shared field phased by position**, so it crosses the room as
a slow broad wave rather than as two hundred oscillators that happen to share a
frequency. That is the difference between a room that has air and a room full of
independently restless objects, and it is also stable: a word's phase does not
jump when the room around it changes.

**It is primarily a torque, and that is physics rather than taste.** Sliding a
resting word means beating friction, which at `FRICTION` 0.85 needs an
acceleration of roughly `0.85 × 9.81` — comparable to gravity. That is a gale,
not a breath, and a sustained lateral force on a whole pile risks making it walk,
since friction resists but never restores. Rocking costs almost nothing and is
**bounded for free**: the righting torque's 8° deadband is exactly the band
inside which nothing restores, so a word breathes within it and is pushed back
the moment it leaves. The mechanism that keeps words readable is the same one
that keeps the breath from becoming a drift.

#### The finding: removing the freeze is not enough to keep a word alive

The first measurement came back with the freeze split landing perfectly on the
threshold — and **0.000 units of movement for every word**, including the ones
that now never freeze.

Rapier puts a settled *dynamic* body to sleep on its own, and **a sleeping body
silently discards an impulse applied with `wakeUp: false`.** Confirmed rather
than guessed: a `cloud` ten seconds after landing reported `frozen: false,
asleep: true`. The freeze mechanism was only the half of the deadness that was
documented; island sleeping was underneath it the whole time, ready to produce an
identically dead room by a different route. `wakeUp: true` is therefore not a
detail of the breath, it *is* the breath.

The `false` was copied from leaf drift, where it is correct — leaf drift only
ever acts on a *falling* word, and a falling word is never asleep. The flag was
right in its original context and silently wrong two hundred lines away.

#### A lone word on bare floor still cannot move, and that is correct

Worth recording because it looked like the fix had failed. A single word lying
flat on the flat floor measures zero motion, and the arithmetic says it should:
tipping it requires torque above `m·g·a` ≈ 0.54, where the breath peaks around
0.053 — a factor of ten. It is pinned by its own weight. Contact with neighbours
is what unlocks the rocking, which is why the single-word test was misleading and
the room test was not.

*Measure the room a person would make.* The lesson keeps arriving in new
costumes: first as an instantaneous 199-word fill, then as a boulder swung
through empty air, now as a word tested in the one configuration the piece almost
never produces.

#### Where it landed

On 40 light words placed across the floor at a human pace:

| | |
| --- | --- |
| frozen / asleep | **0 / 0** |
| visibly moving | **31 of 40** |
| top sway | 0.27 units, about ⅔ of a word's height |
| top rock | 31°, on a word stacked at an angle |
| **centroid drift over 10s** | **0.011 units** — it sways, it does not creep |

Stacked words move more than floor words (18 of 20 against 13 of 20), exactly as
the pinning argument predicts.

Nothing regressed. Feel test 1 measures **895ms / 2420ms** against a baseline of
885 / 2374. A heavy room still reaches 20/20 frozen. And the worst case the piece
can now produce — 200 never-freezing light words, all breathing, 6,992 colliders,
nothing frozen and nothing asleep — steps at **2.7ms p50 / 3.3ms max against
16.7ms**, through the throttled driver.

---

## Phase 5a — the free embedding does not exist, and knowing that cost an hour

Semantic gravity needs a notion of "these two words are related". The cheapest
possible answer would be that the property model already contains one: it has a
48-unit word embedding and a 128-unit penultimate layer, both of which ship
already, so semantic gravity would cost **zero extra bytes** against a model
that is already 483 KB.

`model/embedding_probe.py` runs offline against the existing checkpoint. It was
run *before* designing any of Phase 5a, because the answer changes what 5b has
to build.

**The prior was written down before the numbers were looked at**, so the result
could not be rationalised afterwards: every one of these representations is
supervised only through six physical scores, so by the data-processing
inequality none of them can carry more about a word than those six numbers do.
The prediction was that they would cluster words that *behave* alike rather than
words that *mean* alike.

| representation | related | opposed | random | sep | MRR | hit@10 |
| --- | --- | --- | --- | --- | --- | --- |
| word-embed (48) | 0.007 | 0.040 | −0.001 | 0.008 | 0.001 | **0%** |
| penultimate (128) | 0.383 | −0.075 | 0.044 | 0.339 | 0.059 | **10%** |
| scores (6) | 0.873 | −0.864 | 0.085 | **0.788** | 0.050 | **10%** |

### The aggregate numbers say yes and they are wrong

Look at `scores (6)`: related pairs at 0.873, antonyms at −0.864, a separation
of 0.788. On those three columns alone this is an *excellent* embedding, and a
less careful experiment would have stopped there and shipped it.

The nearest neighbours are unambiguous:

```
stone   ->  thousand, dr, gate, means, solid, bridge
ocean   ->  permanent, laws, mount, subject, court, scotland
iron    ->  scale, toronto, classes, guard, senate, streets
forest  ->  landscape, philosophy, long, settlement, lessons, grounds
```

**Why both things are true at once is the whole finding.** Related words really
do sit close together — `stone` and `rock` are both heavy, old and inert, so
their property vectors nearly coincide. But six numbers describe a very small
space, and several hundred unrelated words share any given profile. `stone` and
`thousand` are neighbours because both score mid-heavy, neutral and old-ish.
High similarity on curated pairs is not the same as *ranking*, and semantic
gravity picks neighbours by ranking. MRR 0.05 and hit@10 of 10% are the numbers
that matter, and they say the true partner is essentially never the nearest
thing.

The antonym column is the same illusion in reverse. −0.864 looks like the model
understands opposition; it is measuring that `hot` and `cold` sit at opposite
ends of the warmth axis *by construction*. Nothing semantic is happening.

**Lesson for the writeup:** pick the metric that matches how the artefact will
be *used* before running the experiment. Separation on a curated pair list is
the metric that flatters; rank against the full candidate pool is the metric the
mechanic actually consumes, and the two disagreed by enough to reverse the
decision.

### Two details worth keeping

**The 48-unit word embedding is pure noise** — MRR 0.001, hit@10 of 0%, and
neighbours with no discernible pattern. Nothing in training constrains it beyond
producing the right six outputs through a 256-unit MLP, so it is free to be
arbitrary and it is. Only what survives to the output means anything.

**There is exactly one genuine signal in the whole probe**, and it is worth
naming because it shows what the representation *does* encode: from the
penultimate layer, `silence` → `alone, quiet, dead, still, nothing, tired`. That
is a good list. It is also entirely the intensity and warmth axes doing the work
— quiet cold things — rather than anything semantic.

### What this changes

Phase 5a's baseline is "cosine similarity in embedding space", and there is now
no free embedding space to compute it in. So **5a cannot start with the physics;
it has to start with a payload decision**, which is the opposite of the order
the roadmap assumed. Real embeddings for the 10,749-word vocabulary are the
honest option and they are not cheap — a 50-dimensional int8 table is roughly
537 KB raw, against a 3.3 MB cold desktop budget that Phase 2.5 fought to hold.

That is a scope-and-payload question for the author, not an implementation
detail, so it goes back rather than being resolved here.

### The gravity probe: the drift is real, but not the drift the spec asks for

The embedding probe said real embeddings cost ~537 KB. Before buying them,
`src/ml/gravity.ts` answers the cheaper question with a hand-written similarity
over 38 words in five groups. Membership is all-or-nothing, which is
deliberately *more* confident than a real embedding would ever be: if the effect
is invisible at similarity 1.0, no embedding quality can rescue it.

Feel test 2 as `DESIGN.md` words it — type `stone`, wait three seconds, type
`rock`, and `rock` must visibly drift toward `stone` **after landing**:

| pull strength | gap on landing | gap 12s later | closed after settling | frozen |
| --- | --- | --- | --- | --- |
| 0 (off) | 3.00 | 3.00 | 0 | true/true |
| 11 | 2.62 | 2.39 | 0.23 | false/false |
| 30 | **1.09** | 1.09 | **0** | true/true |
| 60 | **1.00** | 1.00 | **0** | true/true |
| 120 | **0.67** | 0.67 | **0** | true/true |

**All of the motion happens during the fall. None happens after settling, at any
strength.** That is the friction wall the breath already hit, in a form drift
cannot dodge: sliding a resting word means beating `FRICTION` 0.85 against
gravity, roughly 8.3 units/s², and the field supplies 5.4 at its best useful
range. Cranking the strength does not produce post-landing creep — it just pulls
the words together harder *on the way down*, so they arrive already touching and
the force switches off at `ARRIVED_UNITS`.

The mechanism itself is correct, and the control proves it: dropped from the
same geometry, `rock` deflects 0.15 units toward `stone` at strength 11 while
`iron` — same weight class, no shared group — deflects **0.00**.

### What that means, and it is better than the spec

`DESIGN.md`'s "drift toward each other *after landing*" cannot be delivered. The
thing that can is arguably a stronger mechanic: **a word falls toward its
relatives.** At strength 30 a `rock` released three units from a settled `stone`
lands 1.09 away — a 1.9-unit deflection during flight, unmistakable.

It is better on four counts. It is *visible*, where post-landing creep is
0.01 units/second and imperceptible. It costs nothing to fight, because a
falling word has no static friction to overcome. It does not contradict Phase
3.5's rule that heavy words are still and stay still, because the word is not
settled yet. And it composes with placement — the visitor aims, and the room
pulls the word toward where it belongs, so the composition argues back.

**Recorded, not adopted.** Whether feel test 2 should be rewritten around a
falling word is the author's call, and it is a change to a document that says
its feel tests decide whether the piece ships.

### A trap that produced four identical rows

The first sweep exposed a `setPullAccel` setter and returned **byte-identical
results at 11, 25, 45 and 80**. Vite serves a dynamic `import()` as a *separate
module instance* from the one `physics.ts` imported statically, so the sweep was
setting a value on a second copy of the module and every run used the default.

Identical-to-two-decimals across an eight-fold range is what gave it away — a
real physical effect would have moved *something*. Strength is now a parameter
rather than module state, which removes the failure mode rather than documenting
it. Worth remembering for any future probe driven from a console: **module-level
mutable state is not shared with the running app under Vite dev.**

---

## Phase 4 — sound, synthesised rather than sampled

`CLAUDE.md` specifies a `Sampler` reading "small mp3s from `/public/audio/`".
There are no mp3s, and no way to make them, so the choice was between sourcing
foley and synthesising. Synthesis won on three arguments, only one of which is
about availability.

It costs **zero payload**, against a budget whose non-ML overhead is about
520 KB in total. `DESIGN.md` asks repeatedly for sound that varies
*parametrically* — "pitch varies with mass", "pitch varies with combined mass" —
which is synthesis's native mode; pitch-shifting one sample across the measured
5:1 mass range is chipmunky at one end and muddy at the other. And it keeps the
piece's premise intact: every other property of a word is computed from what it
means, so a fixed audio asset would be the one place a recording stood in for a
model output.

### The same six scores, heard

| axis | what it does |
| --- | --- |
| `mass` | pitch and length — 52 Hz and 240 ms at `mountain`, 300 Hz and 70 ms at `feather` |
| `intensity` | how much of the voice is the sharp contact transient rather than tone |
| `warmth` | lowpass cutoff: `cedar` woody at 900 Hz, `glacier` glassy at 5.2 kHz |
| `age` | damping — an old word lands dull, as if dropped on cloth |
| `restitution` | **how many times you hear it**, free, because every bounce is already a contact |

Every voice is the same two-part shape: a pitched body whose frequency falls as
it decays, plus a noise transient for the instant of contact. The falling pitch
is what separates a struck object from a note — a real impact's resonance drops
as the contact deforms and releases, so a fixed pitch reads as a synthesiser.

### The feared chatter does not happen, and the reason is worth knowing

The breath means lively words are in permanent gentle contact, so the obvious
worry was that a settled room would tick forever. Measured on 40 light words
with **none frozen**: exactly **one** contact in twelve seconds, at speed 0.074.
A settled heavy room produced none.

Rapier reports contact *starts*. The breath rocks words inside contacts that
already exist rather than making new ones, so it generates almost no events at
all. `AUDIBLE_IMPACT_SPEED` sits at 0.5, in the gap between the bedding-in tail
(0.07–0.13) and real landings and bounces (0.8 and up).

The landing speeds also turned out to do most of the work for free: a `mountain`
reaches the floor at **12.0 units/s** and a `feather` at **2.3**, so the physics
delivers a 5:1 dynamic range before mass is consulted at all. And `ball`
produced **18 contacts** on one drop — the bounces, audible without a line of
code written for them.

### The loudness ceiling, which was breached and is now a guarantee

`DESIGN.md` forbids anything above −20 dB peak. The first implementation was
badly over, and only measuring caught it:

| | first pass | shipped | ceiling |
| --- | --- | --- | --- |
| bed alone | −60 | −55.9 | ✓ |
| keypress | −30.3 | −27.5 | ✓ |
| commit | −21.1 | −24.2 | ✓ |
| `mountain` landing | **−10.2** | **−25.0** | ✓ |
| `boulder` | — | −25.4 | ✓ |
| `stone` | — | −28.6 | ✓ |
| `feather` | — | −39.4 | ✓ |
| `ball` bouncing | −18.0 | −32.5 | ✓ |
| twelve landing at once | **−7.7** | −22.3 | ✓ |
| forty landing at once | — | −21.0 | ✓ |

**The limiter was supposed to hold this and provably cannot.** A
`DynamicsCompressorNode` has a 2 ms attack, and a percussive transient is
largely through before its gain reduction engages — which is why a pile-up sat
8 dB over the ceiling *with the limiter in circuit*. A compressor can only
police the sum of sustained voices; it cannot police an impact.

Three changes fixed it, in increasing order of how principled they are. The
voice gains came down about 15 dB, so each voice clears the ceiling on its own.
Simultaneous voices duck by **1/√n**, which is not a fudge — voices landing
together are uncorrelated, so they sum in *power* rather than amplitude, and
1/√n is exactly what holds the total constant under that sum. And a **tanh
brickwall** now sits last in the chain: `y = C·tanh(x/C)` is transparent well
below C (a realistic 0.05 peak passes as 0.0499) and asymptotically cannot
exceed it however much is thrown at it. The ceiling is now true by construction
rather than by tuning, which matters because it is a safety property — a peak
overshoot is a real harm in headphones, not an aesthetic slip.

Worth recording that the pile-up figures move a decibel or two between runs:
twelve words committed in a tight loop do not all land in the same frame, so the
per-frame voice cap only sometimes binds. The number that is stable and that
matters is `mountain` dropped into a settled 24-word pile — crush, wake and
landing together, the busiest event the piece can actually produce — at
**−26.4 dB**.

The mass ordering is the point, and it survives: **−25.0 for `mountain` against
−39.4 for `feather`**, a 14 dB spread from one score.
