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
