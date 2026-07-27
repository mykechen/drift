# Liveliness and touch — making the room alive

Design specification for the work that follows Phase 3's second pass. Written
2026-07-27, after the author used the finished room and said it feels dead.

`DESIGN.md` remains authoritative on what the room looks like. This document
records what changes about how it *behaves*, and it is the first document in the
project that argues with `DESIGN.md`'s register rather than its details. That
argument is deliberately deferred to the end of this file — see "The document
decision" — because it should be made against a room you can actually touch,
not against a paragraph.

---

## The diagnosis

The room is dead, and the cause is structural rather than aesthetic. Three
things, in descending order of how much they matter:

1. **Words literally turn to stone.** After `FREEZE_AFTER_MS` (1500ms) of linear
   stillness every body is converted to a Rapier `Fixed` body — not asleep,
   static. Measured on a settled 150-word room: **150 of 150 frozen.** Nothing
   moves them but a direct heavy impact.
2. **Nothing moves unless you type.** There is no ambient motion anywhere. The
   grain shader is deliberately static and says so in its own comment.
3. **You cannot touch anything.** There is zero mouse interaction with bodies.
   The pointer aims where the next word lands and does nothing else.

The direction is to **make liveliness a property, like mass**. The piece's
thesis is that meaning becomes physics, and today that only applies to falling.
Extending it to aliveness — a light word never quite settles, a heavy one is
dead still and always will be — turns the freeze from a performance hack into a
semantic rule.

---

## The measurement that unlocks all of this

Phase 2 froze bodies because a 200-word awake room cost **72ms** a step. That
number is the entire justification for the mechanic, and it is stale. It was
measured when a word was more than twice its current size (`WORD_EM_UNITS` 0.9 →
0.4, which was itself the fix for that measurement) and before the density range
narrowed from 40:1 to 5:1.

Re-measured 2026-07-27 through the throttled Playwright driver, filling at a
human pace with a mixed light vocabulary:

| Room state | bodies | awake | colliders | step p50 | p95 | max |
| --- | --- | --- | --- | --- | --- | --- |
| Settled today, as it ships | 150 | **0** | 5,072 | 0.4ms | 0.5ms | 0.5ms |
| The same room, everything awake | 150 | 150 | 5,072 | 1.8ms | 2.1ms | 2.5ms |
| **At the 200 soft cap, everything awake** | **200** | **200** | 6,821 | **2.8ms** | **3.3ms** | **3.6ms** |

A permanently-awake room at the hard cap costs **17% of the 16.7ms budget**.
Freezing is buying 2.4ms in a room that has 13ms of headroom.

A throttled browser inflates wall-clock readings and never deflates them, so a
throttled reading under budget is sufficient proof — the real number can only be
better. This is the same argument that closed the step-cost debt in Phase 2.

**So this is not a question of how much motion the piece can afford. It is a
question of how much it wants.** Every decision below is a feel decision, and
none of them is being made to save a millisecond.

---

## Order of work

1. Place words at the cursor in 2D, with the safe zone.
2. Grab and throw.
3. Liveliness replaces the hard freeze.
4. Real colour from the model. *(Not designed here — see below.)*
5. Animated materials, as an experiment. *(Not designed here — see below.)*

1 and 2 come before 3 because they are the two changes that can be judged
without re-tuning anything, and because 3 is best judged in a room you can
already push around.

---

## 1. Place words at the cursor in 2D

Today the cursor follows the mouse in x only and sits at the room's centre
height. Every word spawns at `y = 0`. The author wants a word to form and drop
wherever the pointer actually is.

**`cursorY` joins `cursorX`**, read from the same `mousemove` handler, clamped
only by an edge margin so a word cannot form half-off the frame. The draft and
the caret render there. `PhysicsRoom.commit` takes a `spawnY` beside its
`spawnX`.

**Full height, no vertical clamp.** Placing low is a legitimate gesture — you are
setting a word down rather than dropping it — and it is the composition mechanic
Phase 2 established, now working in both axes. Feel test 1 is unaffected: that
test drops `boulder` and `feather` from the same height, which is what anyone
comparing two words does.

### The safe zone, built alongside it

`DESIGN.md` specifies "a small circular region around the text cursor where
physics bodies cannot settle. Prevents new words from spawning inside an
existing pile," and it has never been implemented. Placing in 2D makes it
necessary rather than nice: aiming into a pile spawns bodies inside each other,
and Phase 3 measured the consequence already — past roughly 130 light words the
pile reaches spawn height and new words are ejected.

**Scan the bodies overlapping the word's x-span and lift `spawnY` to clear the
highest of them**, plus a clearance. The correction is on **y only**: you aimed
at that column and the piece keeps it. x is the axis you chose; y is the axis
the pile occupies.

**The draft renders at the corrected position.** This is the part that makes it a
design decision rather than a bug fix. The caret visibly rides up and over a
pile as you sweep the pointer across it, so the word never silently teleports on
commit and the pile acquires presence — you can feel the room's contents through
the cursor before you commit anything to them.

---

## 2. Grab and throw

The missing verb, and the single biggest change to how alive the room feels.

- **`mousedown`** projects the pointer into the world and calls
  `world.projectPoint`, accepting a hit whose projected distance is inside a
  grab radius.

  Not `intersectionsWithPoint`. A strict containment test is the obvious choice
  and it is wrong here: a glyph is mostly counters and inter-letter gaps, so
  clicking the middle of an `o` or between two letters would miss. A projection
  with a radius is forgiving, which is what a piece with no UI and no hover
  state requires.

- **On grab:** unfreeze the body, and remember the grab point in the body's
  **local** frame.

- **Each step**, a critically-damped spring pulls that local point toward the
  pointer through `applyImpulseAtPoint`. Applying at the grab point rather than
  the centre of mass produces torque for free, so **a word swings from wherever
  you took hold of it** — held by a corner it hangs and turns, held in the middle
  it stays level. That is the difference between dragging a sprite and holding an
  object.

- **The spring's stiffness scales with mass, and this is the whole design.** A
  feather whips around the pointer; a boulder heaves and lags. The model is felt
  through the hand, which is the same move as "the word IS the body" applied to a
  new verb.

- **`mouseup` simply stops the spring.** The body keeps whatever velocity it
  earned. No injected throw velocity, no captured pointer trail — a heavy word
  that lagged behind your pointer also leaves your hand slower, because **the lag
  is the weight**. Anything else would flatten the one distinction the piece
  exists to make.

**While held**, a word gets no righting torque, does not accumulate freeze time,
and cannot be crushed. It can still *crush*: pick up a `boulder`, swing it
through the pile, and crater it. The pile already wakes on impact
(`WAKE_IMPACT_SPEED`, `wakeAround`), so a thrown word scatters what it hits with
no new code.

---

## 3. Liveliness replaces the hard freeze

### The score

```
liveliness = clamp01( (1 − mass) / 2  +  intensity × 0.25 )
```

Lightness is the spine, exactly as the author put it. Intensity is a signed
±0.25 modifier, so a loud word stays restless at middling weight and a quiet one
settles early even when it is light. Both axes already drive the glyph's shape;
this makes them drive its behaviour.

Measured against the real model:

| word | mass | intensity | liveliness | |
| --- | --- | --- | --- | --- |
| cloud | −0.74 | −0.40 | **0.77** | alive |
| alarm | −0.09 | +0.88 | **0.77** | restless despite mid-weight |
| scream | −0.05 | +0.94 | 0.76 | |
| mist | −0.83 | −0.72 | 0.73 | |
| feather | −0.60 | −0.57 | 0.66 | |
| whisper | −0.59 | −0.58 | 0.65 | |
| hush | −0.60 | −0.87 | 0.59 | light, but quieted by its own meaning |
| ember | −0.16 | −0.18 | 0.54 | |
| *— threshold 0.50 —* | | | | |
| rubber | 0.00 | −0.11 | 0.47 | settles |
| thunder | +0.65 | +0.89 | 0.40 | heavy, but never quite stone |
| silence | −0.24 | −0.93 | 0.39 | light, made still by what it means |
| stone | +0.49 | −0.03 | 0.25 | |
| ocean | +0.80 | +0.31 | 0.18 | |
| granite | +0.78 | −0.01 | 0.11 | |
| boulder | +0.87 | 0.00 | 0.07 | |
| glacier | +0.85 | −0.18 | 0.03 | |
| mountain | +0.94 | −0.20 | **0.00** | dead still, always |

`silence` at 0.39 and `thunder` at 0.40 are what earn the intensity term. A
light word that its own meaning holds still, and a heavy word that its own
meaning will not let rest, are both better than the room's mass axis alone could
produce.

### Three consequences

- **Above the threshold, a word never freezes.** It stays dynamic for the
  session. `cloud`, `mist`, `feather`, `whisper`, `hush`, `scream`, `alarm`,
  `ember` are permanent residents of the live world.
- **Below it, the freeze delay scales with liveliness.** `mountain` turns to
  stone in a few hundred milliseconds; `stone` takes a couple of seconds;
  `rubber` lingers. Sediment still forms — it now forms at a rate that means
  something.
- **The room breathes.** One shared low-frequency sine, phased per body from its
  id, applied as a horizontal acceleration. Amplitude scales with liveliness and
  **ramps from zero at the threshold upward**, so a word about to settle has no
  breath to fight and freezes cleanly, while `cloud` and `mist` never stop
  moving.

The threshold and the amplitude ramp are one mechanism, not two rules that could
disagree: the same number decides whether a word freezes and how much air it
feels, and both go to zero at the same point. There is no discontinuity to see.

### Why a shared field rather than per-word twitching

Considered and rejected: giving each lively word its own random walk. It reads
as a nest of small restless things. A single shared field reads as **the room
having air**, with mass deciding who notices it — which is the semantic claim
the piece is already making, extended one axis. It also reuses the leaf-drift
machinery that already exists for exactly this shape of force.

### What must be verified rather than assumed

- **The pile must sway, not creep.** A sine averages to zero over its period, so
  there should be no net drift. Measure the pile's centroid over 60s and confirm.
- **Freezing must still converge** for everything below the threshold. A room of
  heavy words must still reach near-total sediment.
- **The step budget** at 200 bodies with the breath running.
- **Feel test 1** — the fall is untouched by all of this and must measure as
  untouched.

---

## 4. Real colour from the model — *not designed here*

`warmth` and `intensity` should drive actual hue and saturation, so `ember` is
genuinely rust-orange and `ocean` genuinely blue rather than today's near-black
tints. Driven from scores, never a curated word list — there are 77,843
committable words and a lookup table would leave 99% of them grey while a
handful glow, which reads as "these words are special" rather than "words have
material".

**One finding recorded now, because it changes what this costs.** `ember` scores
warmth **+0.87** and `ocean` **−0.31**. Phase 3's `WARMTH_GAIN` of 2 already
pushes `ember` to the full declared endpoint `#3A2418` — which is a very dark
brown. So this is **not** a gain change. Reaching rust-orange means new palette
endpoints, which is an amendment to `DESIGN.md`'s palette table rather than a
tuning of the mapping onto it.

That amendment goes to the author with real stills to look at, not as a
paragraph. Deferred deliberately.

## 5. Animated materials — *not designed here*

An experiment, not a feature. Fire flicker, water ripple, built for exactly two
words (`ember`, `ocean`), looked at, and thrown away if it reads cheap. Each word
is already an SDF quad, so a fragment shader can animate its fill for the cost of
a uniform. The price is that the room stops being still, which is what the still
export depends on. **Judge it; do not assume it.**

---

## The document decision

This direction changes the piece's register, and it should not be allowed to
erode commit by commit.

`DESIGN.md` currently points at Muji copy, museum wall text and stillness. The
grain shader's own comment justifies itself with "a piece whose whole argument is
stillness". A playground is a different argument. Feel test #4 — a quiet still
export you would hang on a wall — and the OG image both get harder when the room
is breathing and the visitor is throwing words around in it.

**Once items 1–3 are working, the rewrite of `DESIGN.md`'s intent section goes to
the author explicitly**, as a decision rather than a drift. The author's own
framing for the piece is "an artistic playground for words to have feeling and
motion", and if that is the piece, the document should say so in its first
paragraph rather than being contradicted by its fourth.

---

## Decisions already made — not to be re-opened

- **The crush is not retuned.** 31% of curated words clear the striker gate and a
  mixed vocabulary settles at ~60 bodies. That is intended. No `CRUSH_*` constant
  is touched.
- **The commit spring drives uniforms only.** Never re-bake the SDF or rebuild
  colliders inside an animation.
- **Input is letters-only, refused at the keystroke**, against
  `src/ml/lexicon.v1.txt`. A refused commit keeps the buffer and shakes.
- **ONNX Runtime Web, WASM backend only.** The entry/binary pairing does not
  change.
- **`@dimforge/rapier2d` (ESM), not `-compat`**, and it stays in
  `optimizeDeps.exclude`.
- **fontkit is a devDependency** and never re-enters the runtime.
- No browser storage. No analytics. Ever.

---

## Must not regress

- Payload: cold desktop 3364.8 KB, cold mobile 35.7 KB (`pnpm measure`). Nothing
  here adds an asset.
- Inference p50 under 0.5ms, against a 5ms budget.
- Feel test 1: `boulder` reaches the floor in ~885ms, `feather` in ~2374ms.
- Commit (inference + hulls + SDF bake): 3.9ms p50 over 40 distinct words.
- Step: under the 16.7ms budget at the 200-body soft cap, with the breath
  running and nothing frozen.
- `/debug/properties` and `/debug/glyphs` both still work.
- `pnpm check` passes: typecheck, lint, format, build. No `any`, no
  `console.log`.
