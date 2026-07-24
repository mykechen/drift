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
