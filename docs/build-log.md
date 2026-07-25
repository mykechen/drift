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
