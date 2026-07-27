# Phase 3 — the room's design

Design specification for the remaining Phase 3 items. Written 2026-07-27, after
shadows and semantic tint shipped and before anything else in the phase was
built.

`DESIGN.md` remains authoritative on what the room should look like. This
document records the decisions Phase 3 had to make that `DESIGN.md` does not
settle, and the two places where it is deliberately not followed to the letter.

**Exit criterion:** feel test #4 — use the piece for two minutes, take a still,
look at it cold the next morning. Is it a composition you would hang on a wall?

---

## Decisions taken before building

Four questions went to the author. All four are settled and are not to be
re-opened during implementation.

### 1. The commit spring does not re-bake the field

`DESIGN.md` springs `wght` and `wdth` from neutral (500/100) to the model's
values over ~180ms. Geometry is cached at a 5-unit axis quantum, so that spring
passes through roughly eleven distinct axis pairs, each needing its own SDF bake
and its own texture.

The cost is worse than eleven bakes. `fields` in `renderer.ts` is a
`Map<WordPath, …>` with no eviction, and the geometry and outline caches are
unbounded too. A word's field is roughly 230×65 texels, about 15 KB, so eleven
intermediates across two hundred words is ~33 MB of textures that are never read
again. On top of that, ~4.7ms of bake landing inside an 11.3ms p50 frame is a
dropped frame in a busy room, repeatedly, across the 180ms a commit is supposed
to feel best.

**Decision: build geometry and colliders once at the target axes, and spring
only uniforms.** `ROADMAP.md` already forbids rebuilding colliders during the
spring; this extends the same reasoning to the distance field, which is the same
kind of cost for the same reason.

What is important to keep straight: the axis **mapping** is the load-bearing
move, not the axis **animation**. `CLAUDE.md`'s "the word IS the body — do not
skip it" is about a heavy word rendering heavy, and that already ships. The
spring is motion polish layered on top of it.

Two alternatives were considered and rejected. Blending the neutral field into
the target field in the shader costs no extra bakes — the neutral field is
already cached, because it is the draft word that was just being typed — but
`wdth` moves letters by far more than the field's 0.14 em spread, so the blend
would crossfade letters between two positions rather than slide them. Accepting
the churn with an LRU over the caches is truest to the specification and was
judged not worth a dropped frame per commit.

### 2. The crush is not retuned

A mixed-vocabulary fill settles at about 60 bodies, and it took 358 commits to
reach 198. `DESIGN.md`'s soft cap of 200 therefore rarely fires.

**Decision: change nothing.** The goal of the piece is that words have
discoverable physical attributes, and a word being able to crush other words is
that premise paying off. It is not to fill the screen. A 60-word room with a
crater where a heavy word landed is a better composition than a 200-word
undifferentiated pile, so this serves feel test #4 rather than threatening it.

The 200-body cap is therefore reclassified from a mechanic to a long-session
safety valve, and the standing debt in `ROADMAP.md` is closed as a finding
rather than a fix.

One factual check remains, and it is a check rather than a change: the build log
records 358 commits to 198 bodies *"even with heavyweights excluded."* If crush
is firing for words `DESIGN.md` would not call heavyweights, that is a mismatch
between the code and its own documented intent. Measure which words actually
crush and record the list. If it matches the spec, nothing changes.

### 3. `age` gets a visual consequence: old words are worn

`age` has been an unused model output since Phase 1a.

**Decision: age erodes and softens the glyph's edge.** An old word renders
very slightly eaten away and softer at the boundary, as though it has been
sitting in the paper longer. This costs nothing — `uEdgeSoftness` is already a
uniform and the threshold is one line in the fragment shader.

It does not collide with Phase 6's ancient-words behaviour. That is a momentary
sepia flash at commit on roughly thirty curated words; this is a permanent
material property of every word.

### 4. The mono face is IBM Plex Mono, subset

Undecided since the typeface change. Used at 10–12pt for the footer, credit
line, mobile caption and the export and OG watermarks.

**Decision: IBM Plex Mono (SIL OFL), subset to the glyphs actually used,
shipped as woff2 from `/public/fonts/`.** Roughly 4 KB, which is 0.13% of the
payload.

The deciding argument is the export watermark: it is drawn on the visitor's
machine, so a system mono stack means every still that leaves the site carries a
different typeface. `brand-guidelines.md` also treats "the mono face" as an
identity element, which wants a name rather than a stack.

---

## Two deliberate departures from DESIGN.md

Both are recorded here rather than buried in code comments.

### The aging fade does not taper weight

`DESIGN.md`'s word fade is "2s ease-out, opacity + slight upward drift + weight
tapering to 300 as it goes." The weight taper is the same per-frame axis change
as the commit spring and carries the same cost, so decision 1 applies to it
identically. **The fade is opacity, upward drift, and a slight scale-down. No
axis taper.**

### Blur and visibility are split

`DESIGN.md` says window blur pauses physics, and gives the reason as background
CPU burn. But `blur` also fires when the window is merely not frontmost —
clicking a window on a second monitor would freeze a room the visitor is still
looking at.

**The pause is keyed on `visibilitychange → hidden`, which is the case the
stated reason describes. Window blur pauses only the cursor pulse**, which is
the focus affordance and is correct to stop when the piece does not have the
keyboard.

---

## Module structure

Two modules `CLAUDE.md` already declares and that do not exist yet.

**`src/design/motion.ts`** — a semi-implicit Euler spring integrator and
`DESIGN.md`'s two configurations: default (stiffness 220, damping 24, mass 1)
and commit (180, 18, 1). Stepped at the fixed timestep so springs are
frame-rate independent, like the physics.

> Note a discrepancy to settle during the final tuning pass, not now.
> `DESIGN.md` asks for both "~180ms" and "stiffness 180, damping 18", and those
> are not the same spring: at ζ = 0.67 the first overshoot peak lands at ~316ms
> and it settles at ~430ms. Implement the **named constants**, which are
> explicit, and judge the duration by eye at the end.

**`src/world/room.ts`** — density management, clear, and focus/defocus policy.
`boot.ts` is 188 lines of wiring and this phase would otherwise double it with
policy that does not belong there.

---

## Background pass — time of day and grain

Both land in one full-screen quad drawn before the words, replacing the
`gl.clearColor` the room uses today.

**Time of day.** A hue and lightness offset on `#F4F0E8` across `DESIGN.md`'s
five periods, with 30-minute smoothstep transitions between them. The background
is hue 40° in HSL, so *warm* is a negative hue offset (toward orange) and *cool*
is positive (toward green-blue).

| Period | Background | Ink |
| --- | --- | --- |
| Morning 6–10 | hue +3°, L +1% | none |
| Midday 10–16 | as declared | none |
| Golden hour 16–19 | hue −6°, L −1% | hue −2° |
| Evening 19–22 | hue +3°, L −2% | L +2% |
| Night 22–6 | hue +4°, L −3% | L +3% |

The two ink lightness values fill in `DESIGN.md`'s "slightly lifted from full
black", which it does not quantify. They are judgement and are on the list for
the author's eye at the end.

Computed on a **minute tick**, not per frame — the full cycle moves 6° over
twenty-four hours, so per-frame sampling would be measuring floating-point
noise. This is what `DESIGN.md`'s "compute at frame boundary; do not re-sample
per frame" is asking for.

**Grain.** Two octaves in the same shader, totalling ±2% of background
lightness: a fine hash for tooth and a low-frequency smooth term for paper
mottle. `DESIGN.md` says "low frequency", which on its own reads as mottle
without tooth; the combination is what reads as paper. **Static, not animated** —
animated film grain would be motion in a room whose whole argument is stillness.

---

## Commit motion

Geometry and colliders build once at the target axes, exactly as they do today.
The commit spring drives uniforms only.

| Channel | From | To |
| --- | --- | --- |
| `uScale` | 0.92 | 1.0 (overshooting to ~1.03) |
| `uBlur` | 0 | the mass-derived value |
| shadow drop | 0 | the mass-derived value |

The shadow channels are not an invention: `DESIGN.md`'s commit sequence already
says "shadow appears and blurs to its target radius."

**A known cost.** The draft renders at neutral axes and the body appears at
target axes, so there is a weight and width pop at the moment of commit that the
scale spring only partly masks. This is inherent to not re-baking and is
accepted.

---

## Cursor

A thin bar in `#D94F1E` at the room's centre height, riding the mouse in x,
pulsing 60% → 100% opacity on a 2s sine. Never off, per `DESIGN.md`.

It sits at the **right edge of the draft word**, not at `cursorX`. The draft is
centred on the cursor, so a caret at the cursor itself would sit behind the
letters. With an empty buffer it is at `cursorX`. `DESIGN.md` does not specify
this; it is the reading that behaves like a caret.

Approximate dimensions: 0.72 em tall, 0.055 em wide, in the same em units the
words are scaled by.

---

## Aging and clear share one path

The crush already established the pattern: physics drops the body, and the
renderer animates the orphaned mesh out. Aging and clear reuse it exactly —
`renderer.fade(id)` beside the existing `renderer.crush(id)`.

This dissolves `ROADMAP.md`'s warning that "any upward drift during fade-out
needs them unfrozen first." Once physics has released the body, nothing is
frozen and nothing needs waking.

**Aging.** Soft cap 200. On commit of body #201 the oldest begins a 2s ease-out
fade — opacity to 0, upward drift of ~0.35 em, scale to 0.97. Automatic, silent,
no announcement.

**Clear.** `Cmd/Ctrl+K`, and a no-op below 10 bodies. The same fade, staggered
newest-last, with the whole gesture completing in 1.5s.

`DESIGN.md` gives both "staggered over 1.5s" and "~30ms apart", which conflict
above about fifty bodies. Resolve by clamping: `stagger = min(30ms, 600ms /
(count − 1))` against a 900ms per-body fade, so the total is 1.5s at any count
and the stagger is exactly 30ms at fifty bodies.

---

## Focus and defocus

Pause the frame loop on `visibilitychange → hidden`; resume on visible. Pause
the cursor pulse on window `blur`; resume on `focus`. See the departure noted
above.

**The resume nudge goes to surface bodies only** — a body with nothing resting
above it — capped at 40. Waking all two hundred costs a second of full-room
physics on every tab return and would visibly slump sediment that has no
business moving. Surface detection is O(n²) over at most 200 bodies, run once
per resume, which is trivial.

Frozen bodies are static, so a nudge requires setting them dynamic first. They
re-freeze through the normal path.

---

## `age` → wear

One uniform and one line of shader.

```
erode = uAge * EROSION
soft  = uEdgeSoftness * (1.0 + uAge * WEAR)
lower = 0.5 + erode - soft
upper = 0.5 + erode + soft
```

`granite`, `ember` and `whence` get a soft, slightly eaten edge; `laptop` and
`email` stay crisp. `EROSION` and `WEAR` are design constants and live in
`src/design/`. Start small — this must stay subtle enough that the room reads as
one typeface.

---

## Input rules and the shake

A gap found while specifying this phase, belonging to no phase. `input.ts`'s
header comment says the commit rules "land in Phase 2 alongside the shake that
communicates them." They did not, and no later phase claims them. The shake is a
motion item, so Phase 3 is where they fit.

`normalizeWord` in `src/ml/properties.ts` **already implements all three
rejection rules correctly** — a digit anywhere, nothing left after stripping
trailing punctuation, or longer than 24 characters. The bug is at the commit
site: `boot.ts` treats a `null` prediction as "no model loaded" and commits
anyway with neutral scores, so `hello123` currently becomes a body. The rule is
computed and then discarded.

To implement:

- Distinguish *rejected input* from *model unavailable* at the commit site.
  Rejected input does not commit and shakes.
- Cap the buffer at 24 characters — keystrokes past it are ignored and shake,
  rather than being accepted and rejected later.
- Backspace on an empty buffer shakes.
- The shake is a damped horizontal jitter on the draft and cursor, roughly 120ms
  and 0.08 em, driven by the same spring module.

Punctuation behaviour is already correct and must stay so: the glyph keeps its
punctuation and the body includes it, while the model is asked about the
stripped word.

---

## Order of work

Grain and time of day first, because everything else is judged against the room
they produce. Then the cursor, then the commit spring, then the fade path
(aging and clear share it), then focus/defocus, then the input rules, then
`age` → wear. The mono subset is independent and can land at any point.

---

## What the author judges at the end, against real stills

Not implementable decisions. These need eyes on the finished room.

1. **Shadow blur and drop.** `DESIGN.md` fixes the colour and opacity (`#000000`
   at 8%) but not these. The current values were chosen to be visible after a
   first pass was not. Whether they are now too loud for a piece this quiet is a
   feel question. Note that a word resting on the floor casts no visible shadow,
   because the floor is the bottom edge of the frame — shadows appear on the
   pile, so the effect is invisible in a near-empty room.
2. **The character branch.** Nonsense reads mildly warm (`asdf` warmth +0.66)
   and neutral-mass rather than light, which is not `DESIGN.md`'s "light,
   drifty, unstable." Deferred from Phase 1c specifically so it could be judged
   as colour and motion rather than as numbers. Judging it is the deliverable;
   retraining is not in this phase.
3. **The mobile fallback still.** `public/mobile-fallback.webp` was captured
   from the functional-and-ugly build and must be regenerated once the room has
   grain, the time-of-day shift and the final palette. Its caption picks up the
   mono face.
4. **The commit spring's duration**, per the `DESIGN.md` discrepancy noted
   above.
5. **The two ink lightness values** filling in "slightly lifted from full
   black."

---

## Out of scope

The footer and its icons (Phases 4 and 7, and the piece's answer to the
Lighthouse `NO_FCP` finding), all sound, semantic gravity, the six special
behaviours, still-image export, and replay URLs. Crush constants, per decision
2. No browser storage and no telemetry, ever.

---

## Must not regress

- Payload: cold desktop 3174.1 KB, cold mobile 21.6 KB (`pnpm measure`). The
  mono subset is the only intended addition, at roughly 4 KB, and mobile already
  loads a mono caption so it lands on both routes.
- Inference p50 0.10ms / p95 0.80ms, under a 5ms budget.
- Feel test 1: boulder reaches the floor in ~900ms, feather in ~2450ms.
- Physics step 6.2ms p50 with 199 bodies awake, against 16.7ms at 60Hz.
- SDF bake ~4.7ms p50 a word; a 166-word room holds 11.3ms p50 frames.
- Lighthouse on the mobile route: 100 / 100 / 96 / 100. The 96 is the missing
  favicon, a Phase 8 item.
- `/debug/properties` and `/debug/glyphs` both still work.
- `pnpm check` passes: typecheck, lint, format, build. No `any`, no
  `console.log`.
