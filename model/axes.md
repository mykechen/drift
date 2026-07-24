# axes.md — the six property axes

The property model maps a word to six scores, each in `[-1, 1]`. This document
is the canonical definition of what those scores mean. The labeling prompt is
derived from it, so a change here invalidates the dataset.

Status: **v1, validated across three pilot runs (48 words).** No pair of axes
correlates above |r| = 0.59. Getting there required rewriting `drag` as a
residual and restricting `intensity` to acoustic energy — both changes are
documented in their sections below.

---

## Scoring principles

These apply to every axis and are repeated in the labeling prompt.

**Score the felt quality, not the literal fact.** Abstract words have no
physical mass, but they have an imagined one. `grief` is heavy. `whim` is light.
A word that denotes nothing physical still gets six numbers.

**Use the whole range.** A rubric where everything lands between −0.2 and +0.2
is useless — the physics would be identical for every word and the piece dies.
Most words should sit somewhere in the middle, but the tails must be populated.

**The axes are independent — and this is the failure mode.** A word can be light
*and* aerodynamic: `arrow` is low mass and low drag; `balloon` is low mass and
high drag. Before finalizing a word, check whether you have simply copied `mass`
into the other axes with the sign flipped. If heavy words are always slow, loud,
and old, then five of the six axes are doing no work and the model has one
dimension instead of six.

Pilot run 1 measured `mass` × `drag` at r = −0.90 and `mass` × `intensity` at
r = +0.74. Those two correlations are what the clarifications below exist to
break.

**Never refuse.** Every string gets six numbers. Uncertainty is expressed by
scoring near 0, not by declining.

---

## mass — how heavy it feels

`-1` feather · `+1` boulder

Drives body density in the physics simulation, the font's weight axis
(300 → 800), shadow blur radius, and the pitch of the landing sound.

| Score | Anchor |
| ----- | -------- |
| +1.0  | boulder |
| +0.8  | anvil |
| +0.5  | stone |
| +0.2  | book |
| 0.0   | apple |
| −0.3  | leaf |
| −0.6  | feather |
| −0.9  | mist |
| −1.0  | breath |

## drag — faster or slower than its weight suggests

`-1` falls far faster than expected · `0` exactly as expected · `+1` far slower

**This axis is a residual, not an absolute.** It scores only the part of a
word's descent that its `mass` does not already explain. `mass` sets the
baseline fall; `drag` modulates it.

Absolute drag was tried first and failed: it correlated with `mass` at r = −0.86
across 48 pilot words, because in English almost everything that feels light
also feels floaty. Rewriting the axis as a deviation forces orthogonality by
construction rather than by asking for it. The residual definition measured
r = −0.59 on the same words, with every heavy word scoring exactly 0.0.

| Score | Anchor |
| ----- | -------- |
| +1.0  | parachute |
| +0.8  | balloon |
| +0.5  | feather |
| +0.2  | paper |
| 0.0   | stone |
| 0.0   | apple |
| −0.4  | arrow |
| −0.7  | needle |
| −1.0  | bullet |

**`stone` is the pivot.** Under the old absolute scale it was −0.6. Here it is
0.0: a stone drops fast, but that is precisely what its weight predicts, so
there is no surprise and nothing to score. `arrow` is the opposite case — barely
heavier than a stick, yet it drops like something far heavier, and the weight
does not explain the gap.

**Most words belong near 0.0.** This axis inverts the "use the whole range"
principle: ordinary words fall about as their weight implies, and the tails are
reserved for genuine outliers. A uniformly distributed residual would mean the
axis is measuring something other than surprise.

## restitution — how much it bounces

`-1` clay · `+1` rubber

Drives collision restitution. Clay lands dead and stays; rubber hops before
settling.

| Score | Anchor |
| ----- | -------- |
| +1.0  | rubber |
| +0.8  | ball |
| +0.5  | spring |
| +0.2  | wood |
| 0.0   | bone |
| −0.3  | sand |
| −0.6  | clay |
| −0.9  | mud |
| −1.0  | ash |

## warmth — thermal and tonal temperature

`-1` ice · `+1` ember

Drives ink color: interpolates `#152838` (cool blue-black) through `#1A1817`
(neutral) to `#3A2418` (warm brown).

**This is temperature, not pleasantness.** `fever` is warm and unpleasant.
`silver` is cool and desirable. Do not score how nice the word is.

| Score | Anchor |
| ----- | -------- |
| +1.0  | ember |
| +0.8  | hearth |
| +0.5  | amber |
| +0.2  | bread |
| 0.0   | stone |
| −0.3  | silver |
| −0.6  | frost |
| −0.9  | ice |
| −1.0  | glacier |

## age — how old the thing feels

`-1` fresh · `+1` ancient

**Currently has no direct visual consequence** — see the open question below.
It feeds the semantic gravity model in Phase 5.

This scores the age of the **thing the word denotes**, not whether the word
itself is archaic. `ruin` is ancient even though the word is ordinary. The
alternative reading — "is this an archaic word like `zounds`" — was rejected
because it is nearly binary: ~99% of a 25k corpus would score 0, leaving the
axis without a usable distribution.

| Score | Anchor |
| ----- | -------- |
| +1.0  | primordial |
| +0.8  | ruin |
| +0.5  | parchment |
| +0.2  | oak |
| 0.0   | house |
| −0.3  | plastic |
| −0.6  | neon |
| −0.9  | pixel |
| −1.0  | debut |

## intensity — how loud and forceful it feels

`-1` quiet · `+1` scream

Drives the font's optical size axis. Higher intensity yields tighter
proportional metrics and more visually assertive letterforms.

**This is acoustic energy, not importance.** A `boulder` is enormous and
completely silent — it belongs near 0. A `cathedral` is imposing and is the
quietest building most people ever enter. An `alarm` weighs nothing and is
deafening. Grandeur, significance, and scale are not intensity; only how much
noise and energy the thing puts into the air.

Pilot run 1 scored `boulder` at +0.3 and `cathedral` at +0.5, which is this
mistake.

| Score | Anchor |
| ----- | -------- |
| +1.0  | scream |
| +0.8  | blast |
| +0.5  | shout |
| +0.2  | speak |
| 0.0   | walk |
| −0.3  | murmur |
| −0.6  | whisper |
| −0.9  | hush |
| −1.0  | silence |

---

## Open question: does `age` earn its place?

Five of the six axes have a visible consequence the moment a word lands. `age`
does not. Three options, to be settled after the pilot:

1. **Wire it to the glyph tint.** DESIGN.md's "ancient words" special behavior
   applies a sepia tint off a hand-curated list of ~30 words. Driving that
   continuously from the `age` score instead would give the axis a visible
   consequence and fold a hardcoded list into the model.
2. **Leave it latent.** Accept that it only shapes semantic gravity.
3. **Replace it** with a different quality, before anything is labeled.

Changing this after the dataset is frozen means relabeling, so it should be
resolved during Phase 1a.
