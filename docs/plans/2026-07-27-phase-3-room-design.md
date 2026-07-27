# Phase 3 — the room's design, implementation plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.
> The design decisions behind this plan are in
> `docs/specs/2026-07-27-phase-3-room-design.md`. Read that first. Do not
> re-open the four decisions it records.

**Goal:** Finish Phase 3 — give the functional room its visible design layer,
so that a still export taken after two minutes of use reads as a composed
image.

**Architecture:** Two new design modules (`motion.ts` for springs,
`room.ts` for density and focus policy) and one new engine module
(`background.ts` for the paper). Everything animated this phase is a *uniform*,
never a re-bake: the SDF is built once per word at its target axes and the
springs drive scale, blur, opacity and wear. Aging and clear reuse the exit path
the crush already established — physics drops the body, the renderer animates
the orphaned mesh.

**Tech Stack:** TypeScript strict, Vite, OGL (WebGL), Rapier2D, ONNX Runtime
Web (WASM). No new npm dependencies. `fonttools` via `uv run --with fonttools`
for the mono subset, at build time only.

## Global Constraints

- TypeScript strict. No `any` in checked-in code. TypeScript pinned to 6.x.
- No `console.log` — use the `debug(namespace, ...)` wrapper in `src/util/debug.ts`.
- Never use browser storage APIs. Never add analytics or telemetry.
- No new runtime npm dependencies without asking.
- Every constant with design meaning lives in `/src/design`. Physics constants
  group at the top of `src/engine/physics.ts`.
- Prettier defaults; `pnpm check` (typecheck, lint, format:check, build) must
  pass before any task is considered done.
- British spelling in prose and comments, matching the existing codebase.
- Do not change the crush constants (`CRUSH_*` in `physics.ts`).
- Do not re-bake the SDF or rebuild colliders inside any animation.

**Must not regress** (re-measure at Task 15):

- Payload: cold desktop 3174.1 KB, cold mobile 21.6 KB (`pnpm measure`). The
  mono subset is the only intended addition, ~4 KB, on both routes.
- Inference p50 0.10ms / p95 0.80ms, budget 5ms.
- Feel test 1: boulder to floor ~900ms, feather ~2450ms.
- Physics step 6.2ms p50 at 199 bodies awake, budget 16.7ms.
- SDF bake ~4.7ms p50; a 166-word room holds 11.3ms p50 frames.
- `/debug/properties` and `/debug/glyphs` both still work.

## Verification, and why there are no unit tests

This repo has no test runner and this plan does not add one. The deliverables
are a WebGL shader, a physics policy and a set of feel judgements; a unit test
harness would verify the arithmetic that is not where the risk lives, and
`CLAUDE.md` does not ask for one.

Three verification mechanisms are used instead, and every task names which:

1. **`pnpm check`** — typecheck, lint, format, build. Gates every commit.
2. **Browser-driven** — `pnpm dev`, then the Playwright MCP against
   `window.drift`, which in dev exposes `{ room, glyphs, properties, renderer,
   commit(word, spawnX) }`. To get an image out, `console.log` the canvas data
   URL in ~8000-char chunks and reassemble from `.playwright-mcp/console-*.log`.
3. **Scratch scripts** — `node scratch/<name>.ts` for anything numeric, since
   Node strips TypeScript types directly. Scratch files live in the session
   scratchpad, never in the repo.

Timing read through an automated browser is throttled. Throttling inflates and
never deflates, so a throttled reading **under** budget is sufficient proof, and
only a failing one needs foreground Chrome.

---

## File structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/design/motion.ts` | create | Spring integrator; DESIGN.md's two spring configs; the shake envelope |
| `src/design/palette.ts` | modify | Time-of-day background and ink shift; grain constants |
| `src/engine/background.ts` | create | The paper: one full-screen quad, time-of-day colour and procedural grain |
| `src/engine/renderer.ts` | modify | Background integration, cursor, commit spring, age wear, fade-out |
| `src/world/room.ts` | create | Density cap and aging, clear, focus/defocus, surface-body detection |
| `src/engine/physics.ts` | modify | `remove(id)`, `surfaceBodies()`, `wake(id)` for the room's policy |
| `src/engine/input.ts` | modify | 24-character cap, rejection callbacks for the shake |
| `src/boot.ts` | modify | Wiring; stop committing input the model rejected |
| `src/style.css` | modify | The mono face |
| `scripts/build-mono-subset.ts` | create | `pnpm bake:mono` — fonttools subset of IBM Plex Mono |
| `docs/build-log.md` | modify | Phase 3 entry |
| `ROADMAP.md` | modify | Close Phase 3, resolve four standing debts |
| `model/axes.md` | modify | Record `age`'s visual consequence |

`renderer.ts` is 572 lines and this phase adds to it. The background is pulled
out to its own module because it is a genuinely separate concern — its own
shader, geometry and state, sharing nothing with the word pipeline. The cursor
stays in `renderer.ts` because it shares the projection uniforms.

---

## Task 1: The spring integrator

**Files:**
- Create: `src/design/motion.ts`

**Interfaces:**
- Produces:
  - `interface SpringConfig { readonly stiffness: number; readonly damping: number; readonly mass: number }`
  - `const DEFAULT_SPRING: SpringConfig` — 220 / 24 / 1, per DESIGN.md
  - `const COMMIT_SPRING: SpringConfig` — 180 / 18 / 1, per DESIGN.md
  - `interface Spring { value: number; velocity: number; readonly target: number }`
  - `function createSpring(config: SpringConfig, initial: number, target: number): Spring`
  - `function stepSpring(spring: Spring, fixedDeltaMs: number): void`
  - `function springAtRest(spring: Spring, epsilon?: number): boolean`
  - `function shakeOffset(elapsedMs: number): number` — damped sine, returns em

- [ ] **Step 1: Write the module**

Semi-implicit Euler, stepped at the fixed timestep so springs are frame-rate
independent like the physics:

```ts
export function stepSpring(spring: Spring, fixedDeltaMs: number): void {
  const dt = fixedDeltaMs / 1000;
  const force = -config.stiffness * (spring.value - spring.target)
              - config.damping * spring.velocity;
  spring.velocity += (force / config.mass) * dt;
  spring.value += spring.velocity * dt;
}
```

The shake is a damped sine, not a spring — it has no target to travel to, it
returns to where it started:

```ts
const SHAKE_DURATION_MS = 120;
const SHAKE_AMPLITUDE_EM = 0.08;
const SHAKE_CYCLES = 2.5;
```

- [ ] **Step 2: Verify the spring numerically**

Write a scratch script that steps `COMMIT_SPRING` from 0.92 to 1.0 at a 1/120s
timestep and prints peak value and settle time.

Run: `node <scratchpad>/spring-check.ts`
Expected: damping ratio ζ ≈ 0.67, first peak ≈ 1.03 at ≈ 316ms, settled
(within 0.5%) by ≈ 430ms. These are the numbers the spec predicts from
DESIGN.md's named constants; if they do not match, the integrator is wrong.

- [ ] **Step 3: `pnpm check`**

- [ ] **Step 4: Commit**

```bash
git add src/design/motion.ts && git commit -m "Add the spring integrator and DESIGN.md's two spring configs"
```

---

## Task 2: Time-of-day palette

**Files:**
- Modify: `src/design/palette.ts`

**Interfaces:**
- Produces:
  - `interface RoomTint { readonly background: [number, number, number]; readonly inkHueShift: number; readonly inkLightnessLift: number }`
  - `function roomTintAt(date: Date): RoomTint`
  - `function inkForWarmth(warmth: number, tint?: RoomTint): [number, number, number]` — existing signature gains an optional second parameter, so existing call sites keep working

- [ ] **Step 1: Add HSL conversion and the period table**

`#F4F0E8` is hue 40° in HSL, so **warm is a negative hue offset** and **cool is
positive**. Per DESIGN.md:

| Period | Hours | Background | Ink |
| --- | --- | --- | --- |
| Morning | 6–10 | hue +3°, L +1% | — |
| Midday | 10–16 | as declared | — |
| Golden hour | 16–19 | hue −6°, L −1% | hue −2° |
| Evening | 19–22 | hue +3°, L −2% | L +2% |
| Night | 22–6 | hue +4°, L −3% | L +3% |

The two ink lightness values are judgement filling in DESIGN.md's unquantified
"slightly lifted from full black". They are on the author's list at Task 15.

- [ ] **Step 2: Add 30-minute smoothstep transitions**

Each period boundary interpolates over the 30 minutes *centred* on it, so
09:45–10:15 crosses from morning to midday. Night wraps midnight — a period
table indexed by minutes-since-midnight with modular arithmetic, not a chain of
`if` statements.

- [ ] **Step 3: Verify the curve**

Scratch script printing `roomTintAt` every 15 minutes across 24 hours.

Run: `node <scratchpad>/tint-check.ts`
Expected: continuous — no step larger than the smoothstep's own increment
between adjacent samples, including across midnight; midday returns exactly
`#F4F0E8`; the total hue excursion across the day is 10° (−6 to +4).

- [ ] **Step 4: `pnpm check`**

- [ ] **Step 5: Commit**

---

## Task 3: The background pass

**Files:**
- Create: `src/engine/background.ts`
- Modify: `src/engine/renderer.ts` (replace `gl.clearColor` with the pass; pass the tint through `render`)

**Interfaces:**
- Consumes: `roomTintAt`, `GRAIN_OPACITY` from Task 2
- Produces:
  - `interface Background { readonly draw: (tint: RoomTint) => void; readonly resize: (width: number, height: number) => void }`
  - `function createBackground(gl: OGLRenderingContext): Background`

- [ ] **Step 1: Write the background quad and shader**

Two octaves totalling ±2% lightness — a fine hash for tooth and a
low-frequency smooth term for paper mottle. DESIGN.md says "low frequency",
which alone reads as mottle without tooth; the combination is what reads as
paper.

**Static, not animated.** Animated film grain would be motion in a room whose
whole argument is stillness. The noise is a function of `gl_FragCoord` only —
no time uniform exists in this shader.

```glsl
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
```

- [ ] **Step 2: Wire it into `render`**

The background draws first, before `shadowLayer`. Remove the `gl.clearColor`
background — the quad now owns the paper. Keep the clear itself.

`render()` gains a `tint: RoomTint` parameter. `boot.ts` passes it (Task 8
moves this to `room.ts`; until then compute in `boot.ts`).

- [ ] **Step 3: Verify in the browser**

`pnpm dev`, then via Playwright: capture the canvas data URL with an empty room,
reassemble, and inspect.

Expected: the paper reads as paper, not as flat fill. Sample the same pixel
across neighbouring coordinates — adjacent pixels must differ by a small
non-zero amount (the grain), and the mean must sit within 1% of the
time-adjusted background.

Then override the clock: call `roomTintAt` with a fixed 23:00 `Date` and confirm
the background is measurably cooler and darker than at 12:00.

- [ ] **Step 4: `pnpm check`**

- [ ] **Step 5: Commit**

---

## Task 4: Cursor render and pulse

**Files:**
- Modify: `src/engine/renderer.ts`

**Interfaces:**
- Consumes: `ACCENT_CURSOR` from `palette.ts`
- Produces: `render()` gains `draftWidth: number` so the caret can sit at the
  draft's right edge; `setPulsePaused(paused: boolean)` on `RoomRenderer` for
  Task 10

- [ ] **Step 1: Add a solid-colour program and the caret quad**

A second, much simpler program than the SDF one — position and a flat colour,
no texture. ~0.72 em tall, ~0.055 em wide, in the same em units words scale by.

- [ ] **Step 2: Position it at the draft's right edge**

The draft is *centred* on `cursorX`, so a caret at `cursorX` would sit behind
the letters. It goes at `cursorX + draftWidth / 2`. With an empty buffer,
`draftWidth` is 0 and it lands on `cursorX`.

- [ ] **Step 3: Pulse**

2s cycle, sine, opacity 60% → 100%, never off. Driven by `performance.now()`,
not the physics clock — it is wall-clock polish and must keep running when the
simulation is paused mid-frame. `setPulsePaused` freezes it at its current
value rather than snapping to full.

- [ ] **Step 4: Verify in the browser**

Expected: caret visible in `#D94F1E` at room-centre height; it tracks the mouse
in x; typing `stone` moves it right as the word grows and it never overlaps a
letter; sampling its alpha over 2s shows a smooth 0.6→1.0→0.6 cycle.

- [ ] **Step 5: `pnpm check`**

- [ ] **Step 6: Commit**

---

## Task 5: The commit spring

**Files:**
- Modify: `src/engine/renderer.ts`
- Consumes: `COMMIT_SPRING`, `createSpring`, `stepSpring` from Task 1

**Interfaces:**
- Produces: `RoomRenderer.step(fixedDeltaMs: number)` — springs advance on the
  fixed timestep, called from the loop's `step`, not from `render`

- [ ] **Step 1: Give each attached word a commit spring**

One spring per word, created in `attach`, driving three uniforms:

| Channel | From | To |
| --- | --- | --- |
| `uScale` multiplier | 0.92 | 1.0 (overshooting ~1.03) |
| `uBlur` | 0 | the mass-derived value already computed in `buildWord` |
| shadow drop | 0 | the mass-derived value from `shadowDropFor` |

**Do not re-bake and do not rebuild colliders.** The geometry is already built
at the target axes; this drives uniforms only.

- [ ] **Step 2: Retire the spring when it settles**

Delete from the active map once `springAtRest` — a settled room must not be
stepping two hundred springs forever.

- [ ] **Step 3: Verify in the browser**

Expected: `window.drift.commit("boulder")` shows the word arriving with a
perceptible snap and its shadow blooming in rather than appearing at full
radius. Sample `uScale` across frames: it must exceed 1.0 at least once
(overshoot) and settle at exactly 1.0.

Then confirm the cost is nil: commit 30 words and check the SDF bake count is 30,
not 300. `window.drift.renderer` exposes the field cache; its size must grow by
one per committed word.

- [ ] **Step 4: `pnpm check`**

- [ ] **Step 5: Commit**

---

## Task 6: `age` → wear

**Files:**
- Modify: `src/engine/renderer.ts` (fragment shader, `buildWord`)
- Modify: `src/design/typography.ts` (the two constants — design meaning, so
  they live in `/src/design`)

**Interfaces:**
- Produces: `EDGE_EROSION_AT_OLDEST`, `EDGE_WEAR_AT_OLDEST` in `typography.ts`

- [ ] **Step 1: Add `uAge` and change the threshold**

```glsl
float erode = uAge * EROSION;
float soft  = uEdgeSoftness * (1.0 + uAge * WEAR);
float lower = 0.5 + erode - soft;
float upper = 0.5 + erode + soft;
```

`uAge` is the score mapped from [−1, 1] to [0, 1]. The shadow branch keeps its
own thresholds — a worn word does not cast a worn shadow.

- [ ] **Step 2: Start the constants small**

This must stay subtle enough that the room reads as one typeface. Begin at
`EDGE_EROSION_AT_OLDEST = 0.012` and `EDGE_WEAR_AT_OLDEST = 0.6`, then judge.

- [ ] **Step 3: Verify in the browser**

Expected: commit `granite`, `ember`, `whence` beside `laptop`, `email`,
`startup`. The old words read softer at the edge on inspection; at a glance the
room still reads as one typeface. If the difference is invisible at a glance
*and* visible on inspection, the value is right.

- [ ] **Step 4: `pnpm check`**

- [ ] **Step 5: Commit**

---

## Task 7: The fade-out path

**Files:**
- Modify: `src/engine/renderer.ts` (add `fade`)
- Modify: `src/engine/physics.ts` (add `remove(id)`)

**Interfaces:**
- Produces:
  - `RoomRenderer.fade(id: number): void` — 2s ease-out: opacity to 0, upward
    drift 0.35 em, scale to 0.97
  - `PhysicsRoom.remove(id: number): boolean` — drops the body and all its
    bookkeeping; returns false if the id is unknown

- [ ] **Step 1: Add `remove(id)` to physics**

`removeWord` already exists as a private function for the crush. Expose it by
id. It already handles the frozen/static case, because removal does not care
about body type.

- [ ] **Step 2: Add `fade(id)` to the renderer**

Structurally identical to `crush`, which is the precedent: physics has already
dropped the body, the renderer owns the orphaned mesh and animates it out. A
separate map from `crushing`, because the animation differs — crush presses
flat and fast, fade drifts up and slow.

**Per the spec, no weight taper.** DESIGN.md asks for "weight tapering to 300",
which is the same per-frame axis change the commit spring decision rejected, for
the same reason.

- [ ] **Step 3: Verify in the browser**

Expected: `window.drift.room.remove(id)` followed by `renderer.fade(id)` shows
the word rising slightly and fading over 2s, then its mesh is gone from the
scene graph. `renderer.scene` child count must return to its previous value —
a fade that leaks meshes is the failure mode this checks for.

- [ ] **Step 4: `pnpm check`**

- [ ] **Step 5: Commit**

---

## Task 8: The room module, and word aging

**Files:**
- Create: `src/world/room.ts`
- Modify: `src/boot.ts` (delegate policy to it)

**Interfaces:**
- Consumes: `PhysicsRoom`, `RoomRenderer`, `roomTintAt`
- Produces:
  - `interface Room { readonly onCommitted: (id: number) => void; readonly clear: () => void; readonly canClear: () => boolean; readonly step: (fixedDeltaMs: number) => void; readonly tint: () => RoomTint; readonly onVisibilityChange: (hidden: boolean) => void; readonly onFocusChange: (focused: boolean) => void }`
  - `function createRoom(physics: PhysicsRoom, renderer: RoomRenderer, loop: FrameLoop): Room`
  - `const SOFT_CAP_BODIES = 200`

- [ ] **Step 1: Move the tint clock into the room**

Computed on a **minute tick**, not per frame. The whole cycle moves 10° over
twenty-four hours; per-frame sampling would be measuring floating-point noise.
This is what DESIGN.md's "compute at frame boundary; do not re-sample per
frame" asks for.

- [ ] **Step 2: Implement the soft cap**

On commit of body #201, the oldest begins its 2s fade: `physics.remove(id)`
then `renderer.fade(id)`. On #202, the next-oldest. Automatic, silent, no
announcement.

Bodies are already in commit order in `physics.bodies` — ids ascend and
`commit` pushes. Do not sort; take from the front, skipping any already fading.

- [ ] **Step 3: Verify in the browser**

Expected: commit 210 short light words via `window.drift.commit` (light, so the
crush does not interfere with the count). Body count peaks at 200 and holds. The
oldest words visibly fade rather than vanishing. `physics.bodies.length` never
exceeds 200.

- [ ] **Step 4: `pnpm check`**

- [ ] **Step 5: Commit**

---

## Task 9: Clear (Cmd/Ctrl+K)

**Files:**
- Modify: `src/world/room.ts`
- Modify: `src/boot.ts` (bind the key)

- [ ] **Step 1: Implement the staggered clear**

No-op below 10 bodies. Newest last. DESIGN.md gives both "staggered over 1.5s"
and "~30ms apart", which conflict above about fifty bodies. Clamp:

```ts
const CLEAR_TOTAL_MS = 1500;
const CLEAR_FADE_MS = 900;
const stagger = Math.min(30, (CLEAR_TOTAL_MS - CLEAR_FADE_MS) / Math.max(1, count - 1));
```

At fifty bodies this is exactly 30ms; at two hundred it is 3ms and the whole
gesture still completes in 1.5s.

- [ ] **Step 2: Bind the key**

`input.ts` already lets Cmd/Ctrl combinations through untouched, with a comment
saying they belong to later phases. Bind on `window` in `boot.ts` and
`preventDefault` so the browser does not steal it. No confirmation dialog.

- [ ] **Step 3: Verify in the browser**

Expected: with 9 bodies the keybind does nothing at all. With 30, all fade
newest-last and the room is empty within 1.5s. Then commit again — the room
must still accept words, so the clear left no stale state.

- [ ] **Step 4: `pnpm check`**

- [ ] **Step 5: Commit**

---

## Task 10: Focus and defocus

**Files:**
- Modify: `src/world/room.ts`
- Modify: `src/engine/physics.ts` (add `surfaceBodies`, `wake`)
- Modify: `src/boot.ts` (bind the events)

**Interfaces:**
- Produces:
  - `PhysicsRoom.surfaceBodies(limit: number): WordBody[]` — bodies with nothing resting above them
  - `PhysicsRoom.wake(id: number): void` — reuses the existing private `wakeBody`

- [ ] **Step 1: Split the pause by its stated reason**

Per the spec: pause the frame loop on `visibilitychange → hidden`, pause only
the cursor pulse on window `blur`. DESIGN.md says "window blur pauses physics"
and gives the reason as background CPU burn — but blur also fires when the
window is merely not frontmost, which would freeze a room the visitor is still
looking at.

- [ ] **Step 2: Implement surface detection and the resume nudge**

A body is *surface* if no other body's centre sits above it within 0.6 world
units in x. O(n²) over at most 200 bodies, run once per resume — trivial. Cap
at 40.

Frozen bodies are static, so the nudge must set them dynamic first; they
re-freeze through the normal path.

- [ ] **Step 3: Verify in the browser**

Expected: fill the room, let it freeze, then dispatch `visibilitychange` with
`document.hidden` stubbed true — `loop.isRunning` goes false. Restore it: the
loop resumes and at most 40 bodies leave the frozen state. Confirm buried
bodies stay frozen by recording frozen ids before and after; the difference must
be a subset of `surfaceBodies(40)`.

- [ ] **Step 4: `pnpm check`**

- [ ] **Step 5: Commit**

---

## Task 11: Input rules and the shake

**Files:**
- Modify: `src/boot.ts` (distinguish rejection from model-unavailable)
- Modify: `src/engine/input.ts` (24-character cap, rejection callback)
- Modify: `src/engine/renderer.ts` (apply the shake offset to draft and caret)

**Interfaces:**
- Consumes: `shakeOffset` from Task 1, `normalizeWord` from `src/ml/properties.ts`
- Produces: `WordInputCallbacks` gains `onRejected(): void`; `RoomRenderer.shake(): void`

- [ ] **Step 1: Fix the commit site**

This is the actual bug. `normalizeWord` **already implements all three
rejection rules correctly** — a digit anywhere, nothing left after stripping
trailing punctuation, longer than 24 characters. But `boot.ts:49-51` treats a
`null` prediction as "no model loaded" and commits anyway with neutral scores,
so `hello123` currently becomes a body. The rule is computed and then discarded.

Call `normalizeWord(raw)` directly at the commit site. `null` means rejected:
do not commit, shake. A `null` *prediction* with a non-null normalisation still
means the model is unavailable, and still commits with neutral scores.

- [ ] **Step 2: Cap the buffer at 24 in `input.ts`**

Keystrokes past 24 are ignored and shake, rather than being accepted and
rejected at commit. Backspace on an empty buffer shakes.

- [ ] **Step 3: Apply the shake**

A damped horizontal jitter on the draft word and caret, ~120ms, ~0.08 em.
Wall-clock, like the pulse.

Punctuation behaviour is already correct and must stay so: the glyph keeps its
punctuation and the body includes it, while the model is asked about the
stripped word.

- [ ] **Step 4: Verify in the browser**

Expected, each producing a shake and no body: `hello123`, `...`, a 25-character
word, backspace on empty. And each producing a body: `hello,` (comma in the
glyph, `hello` scored), `asdf`, a 24-character word. Check
`physics.bodies.length` after each.

- [ ] **Step 5: `pnpm check`**

- [ ] **Step 6: Commit**

---

## Task 12: The mono face

**Files:**
- Create: `scripts/build-mono-subset.ts`
- Create: `public/fonts/IBMPlexMono-Regular.ttf` (source, build input) and `OFL-IBMPlexMono.txt`
- Create: `public/fonts/plex-mono-subset.woff2` (the shipped artefact)
- Modify: `src/style.css`, `package.json` (`bake:mono` script)

- [ ] **Step 1: Fetch IBM Plex Mono and its licence**

SIL OFL. If the download is not reachable, stop and report rather than
substituting a different face — the choice was the author's.

- [ ] **Step 2: Write the subset script**

`uv run --with fonttools` per `CLAUDE.md`. Subset to exactly the glyphs the
piece uses: the mobile caption, `drift`, the author's name, `GitHub`, the
watermark domain, and digits for the export timestamp. Emit woff2.

Assert the output is under 8 KB and fail loudly if not — a subset that silently
stops being a subset is the failure mode worth guarding.

- [ ] **Step 3: Wire it into the CSS**

`@font-face` with `font-display: swap` and the existing system stack as the
fallback, so nothing blocks first paint. `public/fonts/` is already covered by
`vercel.json`'s immutable cache rule.

Replace the placeholder in `src/style.css:79` and delete the "still undecided"
comment above it.

- [ ] **Step 4: Verify**

Run: `pnpm build && pnpm measure`
Expected: the subset appears in the cold set on both routes; mobile rises from
21.6 KB by roughly the subset's size and no more. Then check the mobile route
in the browser — the caption renders in Plex Mono, not the fallback.

- [ ] **Step 5: `pnpm check`**

- [ ] **Step 6: Commit**

---

## Task 13: Measure which words actually crush

**Files:** none — this is a measurement, and its output is a note in the build log.

Not a change. The build log records 358 commits to 198 bodies *"even with
heavyweights excluded"*, which suggests crush may be firing for words DESIGN.md
would not call heavyweights. `CRUSH_MIN_STRIKER_MASS` is 0.25.

- [ ] **Step 1: Enumerate**

Score the ~200-word curated demo set through `window.drift.properties` and list
every word with `mass > 0.25` — the set that can crush at all.

- [ ] **Step 2: Judge and report**

If the list is genuinely heavy words, the code matches its documented intent and
nothing changes. If it includes words no one would call heavy, that is a
mismatch between the code and DESIGN.md's "only genuine heavyweights crush" —
**report it to the author and do not fix it unilaterally.** Decision 2 in the
spec forbids changing crush constants.

- [ ] **Step 3: Record the finding in the build log** (folded into Task 14)

---

## Task 14: Documentation

**Files:**
- Modify: `docs/build-log.md` (Phase 3 entry)
- Modify: `ROADMAP.md` (Phase 3 checkboxes; standing debts)
- Modify: `model/axes.md` (`age`)

- [ ] **Step 1: Write the build-log entry**

It is source material for a case study, so record *why*, and record what was
measured — including approaches that failed. Cover: the four decisions and the
reasoning that produced them; the two departures from DESIGN.md; the two places
DESIGN.md conflicts with itself (the spring's duration versus its constants, the
clear's stagger versus its total); the `boot.ts` rejection bug; the Task 13
finding; and every number measured this phase.

- [ ] **Step 2: Update ROADMAP**

Tick Phase 3's items. Close four standing debts: mono face, `age` axis, crush
versus the density cap (as a finding, not a fix), and character branch (judged —
see Task 15). Move the state-of-play table on.

- [ ] **Step 3: Record `age` in `model/axes.md`**

It now has a visual consequence — edge wear — as well as being a force-field
input. Note that this closes the question open since Phase 1a.

- [ ] **Step 4: Commit and push**

---

## Task 15: The judgement pass

**Files:**
- Modify: `public/mobile-fallback.webp` (regenerate)

This task is where the phase's exit criterion is actually tested, and most of it
is not implementable — it is a set of judgements that belong to the author.

- [ ] **Step 1: Re-measure everything on the must-not-regress list**

`pnpm measure`, the inference spot-check (`boulder` heavy, `feather` light,
`ball` bouncy), the physics step at ~199 awake bodies, the SDF bake p50, frame
p50 in a filled room, and both debug routes.

Report the numbers against their baselines. Timing read through the automated
driver is throttled — a reading under budget is sufficient proof; only a failing
one needs foreground Chrome.

- [ ] **Step 2: Record a 30-second capture and watch it cold**

DESIGN.md calls this the highest-leverage QA practice on the project, and Phase
3 is the phase it exists for.

- [ ] **Step 3: Fill the room for two minutes and take a still**

This is feel test #4. Not 200 words — a real two minutes of typing, which is
60–100 commits. Hold the still overnight and look at it cold.

- [ ] **Step 4: Regenerate the mobile fallback**

`public/mobile-fallback.webp` was captured from the functional-and-ugly build.
Recapture from the finished room, lossless WebP. Confirm the mobile payload
after.

- [ ] **Step 5: Put the five judgement items to the author**

With stills, not descriptions:

1. Shadow blur and drop — DESIGN.md fixes only colour and opacity. The current
   values were chosen to be *visible* after a first pass was not; whether they
   are now too loud is a feel question. Note that a word on the floor casts no
   visible shadow, because the floor is the frame's bottom edge.
2. The character branch — `asdf` reads mildly warm (+0.66) and neutral-mass
   rather than DESIGN.md's "light, drifty, unstable". Judging it is the
   deliverable; retraining is not in this phase.
3. The commit spring's duration — DESIGN.md's "~180ms" and its named constants
   describe different springs.
4. The two ink lightness values filling in "slightly lifted from full black".
5. `EDGE_EROSION_AT_OLDEST` and `EDGE_WEAR_AT_OLDEST`.

- [ ] **Step 6: Commit and push**

---

## Self-review

**Spec coverage.** Every section of the spec maps to a task: decision 1 → Task
5; decision 2 → Task 13; decision 3 → Task 6; decision 4 → Task 12; the fade's
dropped weight taper → Task 7; the blur/visibility split → Task 10; module
structure → Tasks 1, 3, 8; background → Tasks 2, 3; cursor → Task 4; aging and
clear → Tasks 8, 9; input rules → Task 11; judgement items → Task 15; docs →
Task 14.

**Ordering.** Grain and time of day come first because everything else is judged
against the room they produce. `motion.ts` precedes them because Tasks 4, 5 and
11 all consume it.

**Known interface ripples.** `render()` gains two parameters (`tint` in Task 3,
`draftWidth` in Task 4) and `RoomRenderer` gains four methods (`step`, `fade`,
`shake`, `setPulsePaused`) across Tasks 5, 7, 11 and 4. `PhysicsRoom` gains
three (`remove`, `surfaceBodies`, `wake`) across Tasks 7 and 10. Both are
touched by several tasks in sequence, so each task must re-read the current
signature rather than trusting this plan's snapshot of it.
