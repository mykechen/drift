/**
 * The Rapier world: gravity, walls, and words as compound bodies.
 *
 * Every number a word's physics depends on comes from the property model. The
 * point of the piece is that `boulder` and `feather` behave differently because
 * of what they mean, and this file is where meaning becomes force.
 *
 * The world is measured in room units rather than pixels or metres: the room is
 * always `ROOM_HEIGHT_UNITS` tall and as wide as the aspect ratio makes it, so
 * physics is identical on every display and only the final draw scales.
 */

import RAPIER from "@dimforge/rapier2d";
import type { WordGeometry } from "./glyphs";
import type { PropertyScores } from "../ml/properties";
import { DEFAULT_PULL_ACCEL, semanticPulls } from "../ml/gravity";
import { debug } from "../util/debug";

// --- World ------------------------------------------------------------------

/**
 * Height of the room in world units. Sets the scale of everything else; a word
 * is a fraction of this and gravity is tuned against it.
 */
const ROOM_HEIGHT_UNITS = 10;

/**
 * Real gravity, which makes the room read at roughly human scale: a word
 * committed at the centre falls the five units to the floor in about a second.
 * That is slow enough to watch and fast enough not to feel like syrup.
 */
const GRAVITY_UNITS_PER_S2 = -9.81;

/** Walls are thick so nothing tunnels through them at speed. */
const WALL_THICKNESS_UNITS = 2;

// --- Word bodies ------------------------------------------------------------

/**
 * Em size of a committed word, in world units.
 *
 * Sized so the room can actually hold its own soft cap. DESIGN.md caps the room
 * at 200 words and says it "accumulates until it fills" — so 200 words have to
 * fit, loosely piled, in `ROOM_HEIGHT_UNITS` by however wide the aspect makes
 * it. At 16:9 that is about 134 square units. An average word is roughly 3.4 em
 * wide by 0.73 em tall, so at this scale it occupies about 0.4 square units of
 * bounding box and two hundred of them ask for ~80 — a room comfortably over
 * half full, with headroom for the pile to be untidy.
 *
 * The first value tried was 0.9, which asked for ~400 square units in a room
 * with 134. The symptom was not visual crowding but that *nothing ever slept*:
 * an overflowing pile stays permanently pressurised, every body jitters against
 * its neighbours forever, and the physics step never gets cheap.
 *
 * Exported because the renderer must scale its meshes by exactly the same
 * factor the colliders were built at, or the picture and the simulation drift
 * apart in a way that is very hard to see and very easy to misdiagnose.
 */
export const WORD_EM_UNITS = 0.4;

/**
 * Density range across the mass axis.
 *
 * Density rather than mass, so a longer word is heavier than a short one at the
 * same score — `boulder` outweighs `rock` partly because there is more of it,
 * which is both physically honest and reads correctly.
 */
const DENSITY_AT_LIGHTEST = 0.6;
const DENSITY_AT_HEAVIEST = 3;

/**
 * Linear damping range. This is what actually makes a feather fall differently
 * from a boulder.
 *
 * Gravity alone cannot do it — under gravity every body accelerates identically
 * regardless of mass, which is exactly the Galileo result. What separates them
 * in air is drag relative to weight, so that is what is modelled: resistance is
 * driven mostly by how light the word is, adjusted by the `drag` axis, which is
 * defined as a residual — how much faster or slower this word falls than its
 * weight alone predicts.
 *
 * The heavy end is already near free-fall (damping ≈ 0), so "heavier falls a lot
 * faster" cannot be bought by dropping boulders harder — they are already at the
 * floor of the range. The contrast is widened from the *light* end instead: a
 * bigger `MAX_LINEAR_DAMPING` makes a feather drift slower and longer, which
 * grows the ratio between the fastest and slowest word without breaking the
 * Galileo-honest model into a mass-scaled-gravity hack. Raised from 3.2 when the
 * boulder/feather gap read as real but not obvious.
 */
const MIN_LINEAR_DAMPING = 0;
const MAX_LINEAR_DAMPING = 5.4;

/** How much the drag residual can pull resistance away from what mass sets. */
const DRAG_RESIDUAL_INFLUENCE = 0.45;

/**
 * Leaf drift: very light words flutter sideways as they fall instead of dropping
 * straight, so `feather` and `mist` wander down like a leaf while `boulder` drops
 * like a stone. It is a horizontal sway force applied only while a light word is
 * *descending*; once it lands and slows, the sway stops so it can settle and
 * freeze. Strength scales with how far below `LEAF_MASS_MAX` the word's mass is.
 */
const LEAF_MASS_MAX = -0.15;
// Strong and slow: a light word is heavily damped (that is what makes it drift
// *down* slowly), and the same damping smothers a gentle sway — so the sideways
// push has to be large, and low-frequency so the word swings wide one way before
// reversing rather than buzzing in place.
const LEAF_FLUTTER_ACCEL = 19;
const LEAF_FLUTTER_HZ = 0.45;
const LEAF_MIN_FALL_SPEED = 0.2;

/** How leaf-like a word is, in [0, 1] — 0 for anything at or above LEAF_MASS_MAX. */
function leafFactor(scores: PropertyScores): number {
  return Math.max(0, Math.min(1, (LEAF_MASS_MAX - scores.mass) / 0.85));
}

/**
 * Rotation: words tumble freely, then right themselves as they settle.
 *
 * The first fix for the settling-flat problem locked rotation outright and
 * committed each word at a fixed tilt. It guaranteed readability but killed all
 * rotational life — a locked word never reacts to a shove, which read as rigid
 * and static and undercut "the word IS the body." This replaces the lock with a
 * lifecycle: a word rotates freely under real physics while it is moving (tumble
 * on impact), and once it slows a gentle restoring torque eases it upright.
 *
 * The torque is what the freeze section warned against — applied blindly every
 * step it keeps bodies awake and a full room never freezes. Two things keep it
 * safe. It only acts once a word has *slowed* (`ORIENT_ACTIVE_SPEED`), so a
 * word in flight still tumbles. And it has a deadband (`ORIENT_DEADBAND`): inside
 * it the torque is zero, so a righted word goes still and freezes normally. A
 * buried word that physically cannot rotate has its torque cancelled by contacts,
 * so its angular velocity stays near zero and it freezes at whatever angle it
 * wedged — which is fine, because buried words are not read anyway. Being a
 * torque rather than a hard `setAngvel`, it respects neighbours instead of
 * clipping through them.
 */
const ANGULAR_DAMPING = 3.2;

/** Below this linear speed a word is "settling" and the righting torque acts. */
const ORIENT_ACTIVE_SPEED = 1.6;

/** Within this angle of upright, no righting torque — the word is readable. */
const ORIENT_DEADBAND = (8 * Math.PI) / 180;

/**
 * Righting torque per radian of tilt, scaled by the body's mass so heavy and
 * light words right themselves in comparable time.
 *
 * It can be strong because freezing keys on *linear* stillness alone (see the
 * freeze condition): a stronger torque rights a word faster while it settles
 * without keeping it awake, where an earlier version that froze on angular
 * stillness too had to keep this gentle or the pile never went quiet.
 */
const ORIENT_TORQUE_GAIN = 0.11;

/**
 * Restitution: bounciness, and it is meant to be obvious.
 *
 * The property model already scores this well — `ball` +0.79, `rock` −0.25 — but
 * two things were flattening it. The floor had no restitution and Rapier averages
 * the two contacting surfaces, so a bouncy word hitting a dead floor lost half
 * its bounce; the word colliders now combine restitution by *max*, so the word's
 * own bounciness wins over the floor. And the mapping is now positives-only:
 * anything the model scores at or below zero (clay, stone, bone) maps to a dead
 * `0`, so `rock` truly hard-stops, while positive scores ramp up to
 * `MAX_RESTITUTION`. That is the crisp `ball`-bounces / `rock`-thuds split.
 *
 * `MAX_RESTITUTION` is high on purpose — the bounciest words should really leap,
 * not politely hop. It still stays below 1 so each bounce loses energy and the
 * word eventually comes to rest and freezes; a true 1.0 superball never settles
 * and a full room of them never goes quiet.
 */
const MAX_RESTITUTION = 0.92;

/**
 * Bouncy words shed less of their fall damping, so a high rebound is not eaten by
 * the same drag that makes light words drift. At full bounciness a word keeps
 * this fraction of the damping its mass/drag imply; at zero bounciness, all of
 * it. Without this a light, bouncy word (`ball`) barely leaves the floor because
 * its lightness makes it draggy — the very thing that should let it soar.
 */
const BOUNCY_DAMPING_FLOOR = 0.35;

/**
 * Wake-on-impact: a frozen word is knocked back to dynamic only when struck by
 * another word *moving* faster than `WAKE_IMPACT_SPEED`, not merely leaned on.
 *
 * The gate is velocity, not contact force, and the distinction is load-bearing.
 * A force threshold cannot tell "just landed hard" from "sitting there heavily":
 * a heavy word's resting weight on the word beneath it exceeds any force worth
 * waking on, so it would re-wake its neighbour every single step and the pile
 * would never go quiet. A striker's *speed* separates them cleanly — a falling
 * word arrives fast, a resting one is below the freeze threshold — and it also
 * damps the cascade, since a knocked word re-settles slowly and so does not
 * re-trigger its own neighbours.
 *
 * `WAKE_IMPACT_FORCE` stays as the colliders' contact-force *event* threshold:
 * it only decides which contacts are worth examining at all (a frozen pile
 * generates ~0 internal force, a light landing ~17, a heavy one ~640), keeping
 * event traffic cheap. The wake decision itself is the speed test below.
 */
const WAKE_IMPACT_FORCE = 80;
const WAKE_IMPACT_SPEED = 2;

/**
 * When an impact wakes a frozen word, frozen words within this radius of it wake
 * too, so a heavy landing produces a visible local *give* — the pile settles a
 * little where it was hit — rather than one pinned word twitching. Bounded and
 * one-shot: the woken cluster re-settles slowly (below `WAKE_IMPACT_SPEED`) so it
 * does not re-trigger its own neighbours, and it re-freezes within the usual
 * delay.
 */
const WAKE_RADIUS = 1.3;

/**
 * Crush: a heavy word landing flattens the much lighter words *around* where it
 * lands — meaning with weight obliterating meaning without. The premise of the
 * piece paying off, and a way to clear the board by dropping something heavy.
 *
 * It is an *area* smash, not a direct hit, and that is deliberate: the lightest
 * words leaf-drift as they fall, so they are never sitting in a tidy column
 * under the cursor. A radius lets a dropped `mountain` flatten the feathers
 * scattered near it, which is what "flatten everything out" means and what a
 * punch-straight-down crush conspicuously failed to do.
 *
 * A word smashes only when it is genuinely heavy (`CRUSH_MIN_STRIKER_MASS`) and
 * moving (the same velocity gate as waking, so a *resting* heavy word crushes
 * nothing), and it only takes words lighter than it by a wide margin
 * (`CRUSH_MASS_GAP`) — `mountain` buries `feather`, `stone` merely nudges
 * `pebble`. The radius grows with the striker's weight. Crushed words also wake
 * the frozen neighbourhood, so the pile collapses into the cleared space rather
 * than leaving sediment floating over a hole. Measured on the mass axis
 * (semantic weight), because the mechanic is about what words *mean*.
 */
const CRUSH_MIN_STRIKER_MASS = 0.25;
const CRUSH_MASS_GAP = 0.5;
const CRUSH_RADIUS_BASE = 1.1;
const CRUSH_RADIUS_PER_MASS = 1.6;

/**
 * How far apart in x two words can be and still count as stacked, for the
 * purpose of deciding which words are on the surface of the pile. Roughly an
 * average word's half-width — wider and everything at floor level reads as
 * buried, narrower and words sitting under a long neighbour read as exposed.
 */
const SURFACE_SPAN_UNITS = 0.7;

// --- Grab and throw ---------------------------------------------------------

/**
 * How far from a word the pointer may be and still take hold of it, in world
 * units.
 *
 * A radius, because a *containment* test is the obvious choice and it is wrong
 * here. A glyph is mostly counters and gaps between letters, so clicking the
 * middle of an `o`, or the space between `t` and `h`, would miss — and a piece
 * with no UI and no hover state gives the visitor nothing to correct against.
 * Rapier's `projectPoint` returns the nearest point on the nearest shape, which
 * turns "did I hit it" into "how close was I", and that is the question worth
 * asking.
 */
const GRAB_RADIUS_UNITS = 0.35;

/**
 * The spring pulling a held word toward the pointer, across the mass range.
 *
 * **This gap is the whole design of the gesture.** The impulse is scaled by the
 * body's mass, which makes it an *acceleration* drive — so a uniform gain would
 * move every word identically and throw away the one property the piece exists
 * to express. Driving the gain from the mass *score* instead means a feather
 * whips around the pointer and a boulder heaves and lags behind it. The model is
 * felt through the hand.
 *
 * **The ratio has to be large, and the reason is arithmetic.** A damped spring
 * following the pointer at a steady speed settles at a lag of `2ζv/√k`, so felt
 * weight goes as the *square root* of this gap, not the gap itself. The first
 * values tried were 900 and 260 — a 3.5:1 ratio, which measured 1.8:1 of actual
 * lag and read as almost nothing. 9:1 here buys the ~3:1 that can be felt.
 *
 * The heavy end still lifts easily: holding against gravity at `k = 130` needs
 * the spring stretched 0.07 units, which is a tenth of a word's height.
 */
const GRAB_STIFFNESS_AT_LIGHTEST = 1200;
const GRAB_STIFFNESS_AT_HEAVIEST = 130;

/**
 * Slightly under critical damping, so a held word has a little life in the hand
 * rather than tracking the pointer like a rigid cursor.
 */
const GRAB_DAMPING_RATIO = 0.85;

/**
 * How far the spring may be stretched before the pull stops growing, in world
 * units.
 *
 * A flick of the pointer can move it most of the room's width between two
 * steps. Without a cap that is an unbounded force, and the word leaves at a
 * speed that tunnels through a wall rather than being thrown at it.
 */
const GRAB_MAX_PULL_UNITS = 1.5;

/**
 * The safe zone: how much air a spawning word is given above whatever it is
 * being set down on.
 *
 * DESIGN.md asks for "a small circular region around the text cursor where
 * physics bodies cannot settle. Prevents new words from spawning inside an
 * existing pile," and it went unimplemented while the cursor could only move in
 * x — a visitor could always aim at empty floor. Placing in 2D removes that
 * escape: aiming into a pile puts a compound body inside other compound bodies,
 * and the solver's only answer is to eject one of them at speed.
 *
 * It is a *lift*, not a circle, and the difference is the design: x is the axis
 * the visitor chose and it is kept exactly, while y is the axis the pile
 * occupies and is the only one corrected.
 */
const SPAWN_CLEARANCE_UNITS = 0.12;

/**
 * How far below the ceiling the safe zone may lift a word.
 *
 * Above this the lift gives up and the word spawns into the pile anyway. That
 * is the honest failure: it is the density ceiling Phase 3 already measured —
 * past roughly 130 light words the pile reaches spawn height — and pushing a
 * word out through the open top to avoid it would trade a visible problem for
 * an invisible one.
 */
const SPAWN_CEILING_MARGIN_UNITS = 0.6;

/**
 * How hard the focus nudge shoves a surface word, in units per second.
 *
 * Small enough that the pile gives rather than jumps — DESIGN.md says "a small
 * impulse ... so they don't look frozen", and a room that visibly rearranges
 * itself every time a tab regains focus would be worse than one that sits
 * still.
 */
const STIR_IMPULSE_UNITS_PER_S = 0.35;

/** Shortest signed angle from `angle` to upright (0), in (−π, π]. */
function wrapToPi(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** High enough that words stack and hold rather than sliding into a flat layer. */
const FRICTION = 0.85;

/**
 * The downward nudge on commit, per DESIGN.md — releasing from rest and letting
 * gravity take over reads as indecisive.
 */
const COMMIT_IMPULSE_UNITS_PER_S = -1.2;

// --- Settling ---------------------------------------------------------------

/**
 * A word slower than these limits for `FREEZE_AFTER_MS` becomes a *static* body.
 *
 * Sleeping alone cannot carry a full room, and the reason is structural. Rapier
 * sleeps by **island**: every body in a connected set of contacts sleeps
 * together or not at all, so in a two-hundred-word pile — which is one island —
 * a single jittering body resets the timer for all of it. Measured, a settled
 * pile has 194 of 200 bodies below the sleep threshold and sleeps none of them;
 * the count flickers to 1 or 2 and falls back to 0 as micro-collapses ripple
 * through. That is combinatorial, not a threshold that can be tuned.
 *
 * Three other levers were measured and rejected first. Forcing individual
 * bodies to `sleep()` made it *worse*, because it resets the activation timer
 * Rapier's own island logic depends on. Doubling solver iterations to 8 slept
 * nothing and cost 41.6ms a step against 23ms. Halving the collider count via a
 * coarser flattening tolerance changed the step cost by nothing at all, which is
 * what established that the cost is solver work over awake bodies rather than
 * collider count.
 *
 * Freezing sidesteps islands entirely: a fixed body is not in one. It also
 * matches what the piece already claims to be — a room that accumulates
 * sediment. A frozen word holds absolutely still, which made the settled pile
 * feel dead: dropping a heavy word onto it moved nothing. Wake-on-impact
 * restores that reaction — a hard enough contact (`WAKE_IMPACT_FORCE`) turns a
 * struck frozen word back to dynamic so it shifts and then re-settles. The
 * generous delay still keeps the buried mass sediment; only what is hit hard, or
 * still on the live surface, moves.
 */
/**
 * The floor below which a contact is not even reported to the sound layer.
 *
 * Deliberately far below anything that should be audible — this exists to keep
 * the queue from filling with numerical noise, not to make the taste decision.
 * The audible threshold is chosen separately, from the distribution this
 * produces in a room that is breathing.
 */
const IMPACT_REPORT_SPEED = 0.05;

const FREEZE_LINEAR_SPEED = 0.08;

/**
 * How restless a word is, in [0, 1]. **A property of the word, like its mass.**
 *
 * The piece's thesis is that meaning becomes physics, and until now that only
 * applied to falling — every word, having landed, turned to stone at the same
 * rate. Extending it to aliveness is what turns the freeze from a performance
 * hack into a semantic rule: a light word never quite settles, a heavy one is
 * dead still and always will be.
 *
 * Lightness is the spine. Intensity is a signed modifier of a quarter, so a
 * loud word stays restless at middling weight and a quiet one settles early
 * even when it is light. Both axes already drive the glyph's shape; this makes
 * them drive its behaviour. Measured, the two words that earn the intensity
 * term are `silence` at 0.39 — light, but held still by what it means — and
 * `thunder` at 0.40, heavy but never quite stone.
 *
 *     cloud 0.77   alarm 0.77   mist 0.73   feather 0.66   hush 0.59
 *     — threshold —
 *     rubber 0.47   stone 0.25   boulder 0.07   mountain 0.00
 */
function liveliness(scores: PropertyScores): number {
  return Math.max(
    0,
    Math.min(
      1,
      (1 - scores.mass) / 2 + scores.intensity * LIVELINESS_FROM_INTENSITY,
    ),
  );
}

const LIVELINESS_FROM_INTENSITY = 0.25;

/**
 * Above this, a word never freezes at all — it stays dynamic for the whole
 * session and keeps answering to the room's air.
 */
const LIVELINESS_NEVER_FREEZES = 0.5;

/**
 * How long a word must hold still before it turns to stone, across the range
 * that still turns to stone at all.
 *
 * Phase 2 used a flat 1500ms for everything, and the flatness is what made the
 * room read as sediment rather than as a place: a feather and a mountain went
 * rigid on the same schedule. Sediment still forms — it now forms at a rate
 * that means something.
 */
const FREEZE_AFTER_MS_AT_DEADEST = 400;
const FREEZE_AFTER_MS_AT_THRESHOLD = 4000;

/**
 * Milliseconds of stillness before this word freezes, or **null if it never
 * does**.
 */
function freezeDelayFor(alive: number): number | null {
  if (alive >= LIVELINESS_NEVER_FREEZES) return null;
  const t = alive / LIVELINESS_NEVER_FREEZES;
  return (
    FREEZE_AFTER_MS_AT_DEADEST +
    t * (FREEZE_AFTER_MS_AT_THRESHOLD - FREEZE_AFTER_MS_AT_DEADEST)
  );
}

// --- The room's air ---------------------------------------------------------

/**
 * The room breathes, and mass decides who notices.
 *
 * A word that merely stops freezing does not move: the build log already
 * established that waking a settled body is a no-op, because a settled body is
 * in equilibrium. So liveliness needs something to move *against*, and this is
 * it — one shared low-frequency field rather than per-word twitching, because
 * the claim being made is that the room has air, not that each word is
 * independently restless.
 *
 * **Phase comes from position, not from id.** A word's place in the cycle
 * depends on where it is standing, so the breath crosses the room as a slow
 * broad wave — one field that things are *in*, rather than two hundred
 * oscillators that happen to share a frequency. It is also stable: a word's
 * phase does not jump when the room around it changes.
 */
const BREATH_HZ = 0.11;
const BREATH_WAVE_PER_UNIT = 0.35;

/**
 * The breath is primarily a **torque**, and that is a physical necessity rather
 * than a taste.
 *
 * Sliding a resting word means overcoming friction, which at `FRICTION` 0.85
 * needs an acceleration of roughly `0.85 × 9.81` — comparable to gravity. A
 * force that large is a gale, not a breath, and a sustained lateral force on a
 * whole pile risks making it walk, since friction resists but never restores.
 *
 * Rocking costs almost nothing by comparison, and it is *bounded for free*: the
 * righting torque's deadband (`ORIENT_DEADBAND`, 8°) is exactly the band inside
 * which no restoring torque acts, so a word breathes within it and is pushed
 * back the moment it leaves. The mechanism that keeps words readable is the
 * same one that keeps the breath from becoming a drift.
 */
const BREATH_TORQUE = 0.9;

/** A little lateral push as well — enough to stir what is loose, not to shove. */
const BREATH_SWAY_ACCEL = 1.4;

/**
 * How much air a word feels, in [0, 1].
 *
 * **Ramped from zero at the freeze threshold**, so the two halves of liveliness
 * cannot disagree: a word on the edge of settling has no breath to fight and
 * freezes cleanly, and there is no discontinuity to see at the boundary where
 * one behaviour becomes the other.
 */
function breathFactor(alive: number): number {
  if (alive <= LIVELINESS_NEVER_FREEZES) return 0;
  return (alive - LIVELINESS_NEVER_FREEZES) / (1 - LIVELINESS_NEVER_FREEZES);
}

// --- Density-aware rate -----------------------------------------------------

/** Per DESIGN.md: 120Hz below this many bodies, 60Hz above it. */
const DENSE_BODY_COUNT = 100;
const PHYSICS_HZ_SPARSE = 120;
const PHYSICS_HZ_DENSE = 60;

export interface WordBody {
  readonly id: number;
  readonly word: string;
  readonly geometry: WordGeometry;
  readonly scores: PropertyScores;
  /**
   * How restless this word is, in [0, 1] — see `liveliness`. Decides whether it
   * ever turns to stone, how fast it does if it does, and how much of the
   * room's air it feels.
   */
  readonly liveliness: number;
  /** World-unit position of the body's centre, refreshed each step. */
  x: number;
  y: number;
  /** Radians. */
  rotation: number;
  /** Not simulating: either Rapier put it to sleep or it has been frozen. */
  asleep: boolean;
  /**
   * Turned static after settling. A frozen word holds its position absolutely
   * until something *hard* lands on it, at which point it wakes back to dynamic
   * — see `WAKE_IMPACT_FORCE` and the freeze constants.
   */
  frozen: boolean;
}

/**
 * A contact worth hearing: what struck, how hard, and against what.
 *
 * Emitted for *every* contact above a low floor rather than only the ones the
 * room decides to sound. Where the audible threshold sits is a question about
 * the room's breath — a settled lively word is in permanent gentle contact —
 * and that has to be measured against a real distribution rather than guessed.
 */
export interface Impact {
  readonly id: number;
  readonly word: string;
  readonly scores: PropertyScores;
  /** Speed at the instant of contact, units/s — read from before the step. */
  readonly speed: number;
  /** Struck the room itself (floor or wall) rather than another word. */
  readonly againstRoom: boolean;
}

export interface PhysicsRoom {
  readonly bodies: readonly WordBody[];
  /** Room extent in world units, for the renderer's projection. */
  readonly roomWidth: number;
  readonly roomHeight: number;
  /** Colliders currently in the world. Diagnostic. */
  readonly colliderCount: number;
  /** Physics rate the current body count calls for. */
  physicsHz(): number;
  /** Rebuild the walls for a new aspect ratio. */
  setAspect(aspect: number): void;
  /**
   * Drop a word into the room, centred on `spawnX`/`spawnY` (world units, where
   * the cursor is). Returns null if the word has no geometry.
   */
  commit(
    word: string,
    geometry: WordGeometry,
    scores: PropertyScores,
    spawnX: number,
    spawnY: number,
  ): WordBody | null;
  /**
   * A spawn height at `x` that does not put a word of this size inside the
   * pile — the safe zone. Returns `preferredY` when the column is clear.
   *
   * Extents are in em, the units geometry is measured in; the room converts.
   * Called once a frame with the draft's own size, so the caret rides up over
   * the sediment as the pointer sweeps across it and the visitor sees where the
   * word will actually land *before* committing it. A silent correction applied
   * only at commit would read as the word teleporting.
   */
  safeSpawnY(
    x: number,
    halfWidthEm: number,
    halfHeightEm: number,
    preferredY: number,
  ): number;
  /** Advance by one fixed step. */
  step(fixedDeltaMs: number): void;
  /**
   * Contacts since the last call, for the sound layer. Drains the queue.
   *
   * Reported rather than sounded: physics knows what hit what and how fast,
   * and has no opinion about whether it should be audible.
   */
  drainImpacts(): Impact[];
  /**
   * Ids of words crushed since the last call. The caller owns their exit
   * animation — physics has already removed the bodies. Drains the queue.
   */
  drainCrushed(): number[];
  /**
   * Drop one word from the world by id. Returns false if the id is unknown.
   *
   * The caller owns whatever the word does on its way out — this only ends its
   * participation in the simulation. Body type does not matter: a frozen word
   * is removed exactly like a falling one, which is what lets the aging fade
   * drift a settled word upward without having to unfreeze it first.
   */
  remove(id: number): boolean;
  /**
   * Words with nothing resting on top of them, newest first, up to `limit`.
   *
   * This is the surface of the pile. The focus nudge uses it so that returning
   * to the tab stirs what is visible rather than waking two hundred bodies and
   * slumping sediment that has no business moving.
   */
  surfaceBodies(limit: number): WordBody[];
  /**
   * Take hold of whatever word is under a world point, within reach. Returns
   * the word taken, or null if the pointer was over bare paper.
   *
   * A frozen word is woken, and so is the sediment around it — pulling a word
   * out of a pile should let the pile collapse into the space, the same way the
   * crush already does.
   */
  grab(x: number, y: number): WordBody | null;
  /** Where the held word is being pulled to. A no-op if nothing is held. */
  dragTo(x: number, y: number): void;
  /**
   * Let go.
   *
   * The body simply keeps whatever velocity it earned under the spring. There
   * is deliberately no captured pointer trail and no injected throw velocity: a
   * heavy word lagged behind the pointer while it was held, so it also leaves
   * the hand slower. **The lag is the weight**, and replacing it with the
   * pointer's own speed would flatten the one distinction the piece is about.
   */
  release(): void;
  /** The word currently held, if any. */
  readonly held: WordBody | null;
  /**
   * Wake one word and give it a small shove, so the pile visibly gives.
   *
   * Waking alone is not enough and that is worth stating: a settled word is in
   * equilibrium, so turning it back to dynamic produces no motion at all — it
   * simply re-freezes a second and a half later having done nothing. The
   * impulse is what makes the gesture observable, which is the entire point of
   * DESIGN.md asking for one.
   */
  stir(id: number): void;
  /**
   * Turn the semantic-gravity probe on or off. Off by default.
   *
   * A **probe**, not a feature — `src/ml/gravity.ts` explains why it is
   * hard-coded. It exists so the drift can be looked at before roughly 537 KB
   * of real embeddings is bought to produce it.
   */
  setSemanticGravity(enabled: boolean, pullAccel?: number): void;
  /**
   * Remove every body from the simulation.
   *
   * **Not a room-level clear, and not what `Cmd/Ctrl+K` calls.** This drops the
   * bodies and nothing else, so the renderer is left holding meshes for words
   * that no longer exist — and because those meshes are still parented into the
   * scene, they keep drawing at whatever transform they last had. The room's
   * `clear()` in `world/room.ts` is the one to use: it retires each word through
   * `remove` + `renderer.fade`, which is also what makes the gesture visible.
   *
   * Kept public for the dev console and for teardown. Pair it with
   * `renderer.detachAll()` if you call it directly.
   */
  clear(): void;
}

function lerp(t: number, from: number, to: number): number {
  return from + ((Math.max(-1, Math.min(1, t)) + 1) / 2) * (to - from);
}

/** Unsigned area of a flat `[x, y, …]` polygon. Diagnostic, for rejected hulls. */
function polygonArea(points: Float32Array): number {
  let total = 0;
  const count = points.length / 2;
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count;
    total +=
      points[i * 2]! * points[j * 2 + 1]! - points[j * 2]! * points[i * 2 + 1]!;
  }
  return Math.abs(total) / 2;
}

/**
 * Half-extents of a settled word's bounding box *after* its rotation, in world
 * units.
 *
 * A word leans as it settles, and a leaning word is both taller and wider than
 * the box its glyphs were measured in. Reading the unrotated extents would
 * under-report the top of the pile by exactly the amount a tilted word sticks
 * up, which is the amount the safe zone exists to clear.
 */
function rotatedHalfExtents(wordBody: WordBody): { x: number; y: number } {
  const halfWidth = (wordBody.geometry.width / 2) * WORD_EM_UNITS;
  const halfHeight = (wordBody.geometry.height / 2) * WORD_EM_UNITS;
  const cos = Math.abs(Math.cos(wordBody.rotation));
  const sin = Math.abs(Math.sin(wordBody.rotation));
  return {
    x: halfWidth * cos + halfHeight * sin,
    y: halfWidth * sin + halfHeight * cos,
  };
}

/**
 * How strongly a word resists falling, in [0, 1].
 *
 * Mass sets the baseline — a light word drifts — and the drag residual adjusts
 * it, since `drag` is defined relative to what the word's weight already
 * implies rather than in absolute terms.
 */
function fallResistance(scores: PropertyScores): number {
  const fromMass = (1 - scores.mass) / 2;
  const resistance = fromMass + scores.drag * DRAG_RESIDUAL_INFLUENCE;
  return Math.max(0, Math.min(1, resistance));
}

/**
 * Build the world.
 *
 * There is no `RAPIER.init()` call any more. Phase 2.5 moved off the `-compat`
 * build, which carried its WebAssembly base64-inlined in the JavaScript and had
 * to be handed to an explicit async initialiser; the ESM build imports the
 * `.wasm` as a module and the loader instantiates it before this module's body
 * ever runs. That is worth 121 KB brotli — base64 inside JS compresses far
 * worse than the binary does — and it lets the browser cache the engine as its
 * own file.
 *
 * It is therefore *synchronous*. It was `async` only ever to hold that
 * initialiser, and keeping the promise for symmetry's sake would mean an async
 * function with nothing to await — which the lint rejects, correctly, since it
 * would advertise a wait that cannot happen.
 */
export function createPhysicsRoom(aspect: number): PhysicsRoom {
  const world = new RAPIER.World({ x: 0, y: GRAVITY_UNITS_PER_S2 });
  const bodies: WordBody[] = [];
  const handles = new Map<number, RAPIER.RigidBody>();
  /** Milliseconds each still-dynamic body has spent below the freeze thresholds. */
  const stillForMs = new Map<number, number>();
  /** Collider handle → the word it belongs to, for resolving impact events. */
  const bodyByCollider = new Map<number, WordBody>();
  /**
   * Each body's speed at the *start* of the current step, keyed by id. Impact
   * resolution must judge how fast a striker was travelling when it hit, not
   * after — the same step that fires the contact event is the one the solver
   * stops the striker in, so its post-step speed is already near zero.
   */
  const speedBeforeStep = new Map<number, number>();
  /**
   * Drained after every step to find hard contacts. Autodrain is off; contacts
   * are read explicitly in `step`. Only colliders whose contact-force threshold
   * is exceeded generate events, so this stays cheap in a settled room.
   */
  const eventQueue = new RAPIER.EventQueue(false);
  /** Accumulated sim time, for the leaf-drift sway phase. */
  let elapsedMs = 0;
  /** Whether the semantic-gravity probe is running. Off unless asked. */
  let semanticGravityOn = false;
  let semanticPullAccel = DEFAULT_PULL_ACCEL;
  /** Ids of words crushed this step, handed to the renderer to animate out. */
  let crushedIds: number[] = [];
  /** Contacts this step, handed to the sound layer. */
  let impacts: Impact[] = [];
  /**
   * The word in the visitor's hand.
   *
   * `localPoint` is where they took hold of it, in the body's *own* frame, so
   * the grip stays put on the letterform as the word turns. That is what lets a
   * word held by one corner hang and swing from it rather than sliding rigidly
   * under the pointer.
   */
  let grabbed: {
    readonly body: WordBody;
    readonly localX: number;
    readonly localY: number;
    readonly stiffness: number;
    readonly damping: number;
    targetX: number;
    targetY: number;
  } | null = null;

  let roomWidth = ROOM_HEIGHT_UNITS * aspect;
  let walls: RAPIER.RigidBody | null = null;
  let nextId = 1;

  /**
   * Floor and side walls as one fixed body. The top is deliberately open — per
   * DESIGN.md the frame is the room, and a word thrown hard enough to leave
   * through the ceiling is allowed to.
   */
  function buildWalls(): void {
    if (walls) world.removeRigidBody(walls);
    walls = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    const halfWidth = roomWidth / 2;
    const halfHeight = ROOM_HEIGHT_UNITS / 2;
    const half = WALL_THICKNESS_UNITS / 2;

    const floor = RAPIER.ColliderDesc.cuboid(
      halfWidth + WALL_THICKNESS_UNITS,
      half,
    );
    floor.setTranslation(0, -halfHeight - half);
    floor.setFriction(FRICTION);
    world.createCollider(floor, walls);

    for (const side of [-1, 1]) {
      const wall = RAPIER.ColliderDesc.cuboid(
        half,
        halfHeight + WALL_THICKNESS_UNITS,
      );
      wall.setTranslation(side * (halfWidth + half), 0);
      wall.setFriction(FRICTION);
      world.createCollider(wall, walls);
    }
  }

  buildWalls();

  function physicsHz(): number {
    return bodies.length < DENSE_BODY_COUNT
      ? PHYSICS_HZ_SPARSE
      : PHYSICS_HZ_DENSE;
  }

  /** How fast a word was travelling at the start of this step — its impact speed. */
  function impactSpeed(wordBody: WordBody): number {
    return speedBeforeStep.get(wordBody.id) ?? 0;
  }

  /** Turn one frozen word back to dynamic and restart its settle timer. */
  function wakeBody(wordBody: WordBody): void {
    const body = handles.get(wordBody.id);
    if (!body) return;
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    wordBody.frozen = false;
    wordBody.asleep = false;
    stillForMs.set(wordBody.id, 0);
  }

  /** Wake every frozen word within `WAKE_RADIUS` of a point. */
  function wakeAround(cx: number, cy: number): void {
    for (const wordBody of bodies) {
      if (!wordBody.frozen) continue;
      if (Math.hypot(wordBody.x - cx, wordBody.y - cy) <= WAKE_RADIUS)
        wakeBody(wordBody);
    }
  }

  /** Drop a word from the world entirely — its body, colliders, and bookkeeping. */
  function removeWord(wordBody: WordBody): void {
    // The hand can outlive the word: a held word may still age out under the
    // soft cap. Leaving the grab pointed at a removed body would drive impulses
    // into a handle that no longer resolves, every step, until the mouse is
    // released.
    if (grabbed?.body === wordBody) grabbed = null;
    const body = handles.get(wordBody.id);
    if (body) world.removeRigidBody(body);
    handles.delete(wordBody.id);
    stillForMs.delete(wordBody.id);
    for (const [handle, owner] of bodyByCollider)
      if (owner === wordBody) bodyByCollider.delete(handle);
    const index = bodies.indexOf(wordBody);
    if (index >= 0) bodies.splice(index, 1);
  }

  /**
   * If `striker` is a heavy word moving fast enough to smash, mark every much
   * lighter word within its (mass-scaled) crush radius for destruction. Called
   * per collision so a heavy word smashes wherever it first lands and again as it
   * sinks. A no-op for walls, light words, and resting words.
   */
  function considerAreaCrush(
    striker: WordBody | undefined,
    toCrush: Set<WordBody>,
  ): void {
    if (!striker || striker.scores.mass <= CRUSH_MIN_STRIKER_MASS) return;
    if (impactSpeed(striker) <= WAKE_IMPACT_SPEED) return;
    const radius =
      CRUSH_RADIUS_BASE + striker.scores.mass * CRUSH_RADIUS_PER_MASS;
    for (const target of bodies) {
      if (target === striker || toCrush.has(target)) continue;
      // A word in the visitor's hand is not crushed. Having something
      // destroyed while you are holding it reads as the piece taking it away
      // from you, and the hand is the one place the visitor is in charge.
      if (isHeld(target)) continue;
      if (striker.scores.mass - target.scores.mass <= CRUSH_MASS_GAP) continue;
      if (Math.hypot(target.x - striker.x, target.y - striker.y) <= radius)
        toCrush.add(target);
    }
  }

  /**
   * Note a contact for the sound layer, once per word per step.
   *
   * The floor is `IMPACT_REPORT_SPEED` rather than the audible threshold: this
   * is the raw material the audible threshold is chosen *from*, and filtering
   * it here would hide the distribution that decision needs.
   */
  function recordImpact(
    wordBody: WordBody | undefined,
    againstRoom: boolean,
    heardThisStep: Set<number>,
  ): void {
    if (!wordBody || heardThisStep.has(wordBody.id)) return;
    const speed = impactSpeed(wordBody);
    if (speed < IMPACT_REPORT_SPEED) return;
    heardThisStep.add(wordBody.id);
    impacts.push({
      id: wordBody.id,
      word: wordBody.word,
      scores: wordBody.scores,
      speed,
      againstRoom,
    });
  }

  /** Whether a word is currently in the visitor's hand. */
  function isHeld(wordBody: WordBody): boolean {
    return grabbed?.body === wordBody;
  }

  /**
   * Pull the held word's grip toward the pointer, applying the force *at the
   * grip* so the word swings from it.
   *
   * Run before `world.step` rather than after, so the impulse is resolved by the
   * same step that sees it — a force applied after the solver has run is a force
   * the visitor feels one frame late.
   */
  function driveGrab(fixedDeltaMs: number): void {
    if (!grabbed) return;
    const body = handles.get(grabbed.body.id);
    if (!body) return;

    // Where the grip has ended up in the world, given how the word has turned
    // since it was taken hold of.
    const translation = body.translation();
    const angle = body.rotation();
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const gripX = translation.x + grabbed.localX * cos - grabbed.localY * sin;
    const gripY = translation.y + grabbed.localX * sin + grabbed.localY * cos;

    let pullX = grabbed.targetX - gripX;
    let pullY = grabbed.targetY - gripY;
    const reach = Math.hypot(pullX, pullY);
    if (reach > GRAB_MAX_PULL_UNITS) {
      pullX = (pullX / reach) * GRAB_MAX_PULL_UNITS;
      pullY = (pullY / reach) * GRAB_MAX_PULL_UNITS;
    }

    // The grip's own velocity, which is the body's plus whatever the rotation
    // contributes at that distance from the centre of mass. Damping against the
    // *body's* velocity instead would leave a word held by a corner free to
    // spin, because the spin is invisible at the centre.
    const centre = body.worldCom();
    const armX = gripX - centre.x;
    const armY = gripY - centre.y;
    const linear = body.linvel();
    const spin = body.angvel();
    const gripVelX = linear.x - spin * armY;
    const gripVelY = linear.y + spin * armX;

    const accelX = grabbed.stiffness * pullX - grabbed.damping * gripVelX;
    const accelY = grabbed.stiffness * pullY - grabbed.damping * gripVelY;
    const scale = body.mass() * (fixedDeltaMs / 1000);
    body.applyImpulseAtPoint(
      { x: accelX * scale, y: accelY * scale },
      { x: gripX, y: gripY },
      true,
    );
  }

  /**
   * Pull related words toward each other — the semantic-gravity probe.
   *
   * **It has to unfreeze what it wants to move, and that is the collision this
   * exists to expose.** Phase 3.5 made stillness a semantic claim: a heavy word
   * is dead still and always will be. Feel test 2's own pair, `stone` and
   * `rock`, are liveliness 0.25 and 0.22 — both well below the threshold, so
   * both are sediment within about two seconds of landing. Semantic gravity
   * therefore cannot demonstrate itself on the words it is specified against
   * without contradicting the rule the room just adopted.
   *
   * Unfreezing here is the permissive choice, taken so the drift can be *seen*
   * and judged. It is not a decision that it should ship this way.
   */
  function driveSemanticGravity(fixedDeltaMs: number): void {
    if (!semanticGravityOn) return;
    const pulls = semanticPulls(bodies, semanticPullAccel);
    const seconds = fixedDeltaMs / 1000;
    for (const pull of pulls) {
      const wordBody = bodies[pull.index];
      if (!wordBody || isHeld(wordBody)) continue;
      if (wordBody.frozen) wakeBody(wordBody);
      const body = handles.get(wordBody.id);
      if (!body) continue;
      const scale = body.mass() * seconds;
      body.applyImpulse({ x: pull.x * scale, y: pull.y * scale }, true);
      // A word being pulled has not settled, whatever its speed says.
      stillForMs.set(wordBody.id, 0);
    }
  }

  /**
   * From a forceful contact, wake a frozen `target` and its cluster if the
   * striker is moving — the pile gives where it is hit. A no-op on an unfrozen
   * target or a slow/resting striker, which is what keeps dead weight from
   * perpetually re-waking the word beneath it.
   */
  function resolveWake(
    target: WordBody | undefined,
    striker: WordBody | undefined,
  ): void {
    if (!target || !target.frozen || !striker) return;
    if (impactSpeed(striker) <= WAKE_IMPACT_SPEED) return;
    wakeAround(target.x, target.y);
  }

  return {
    bodies,
    get roomWidth(): number {
      return roomWidth;
    },
    roomHeight: ROOM_HEIGHT_UNITS,
    get colliderCount(): number {
      return world.colliders.len();
    },
    physicsHz,

    setAspect(nextAspect: number): void {
      roomWidth = ROOM_HEIGHT_UNITS * nextAspect;
      buildWalls();
    },

    safeSpawnY(
      x: number,
      halfWidthEm: number,
      halfHeightEm: number,
      preferredY: number,
    ): number {
      const halfWidth = halfWidthEm * WORD_EM_UNITS;
      const halfHeight = halfHeightEm * WORD_EM_UNITS;

      // The top of whatever occupies this column. O(n) over at most 200 bodies,
      // once a frame — the same order as the surface scan and just as cheap.
      let pileTop = Number.NEGATIVE_INFINITY;
      for (const other of bodies) {
        const extent = rotatedHalfExtents(other);
        if (Math.abs(other.x - x) > extent.x + halfWidth) continue;
        pileTop = Math.max(pileTop, other.y + extent.y);
      }
      if (pileTop === Number.NEGATIVE_INFINITY) return preferredY;

      const ceiling =
        ROOM_HEIGHT_UNITS / 2 - halfHeight - SPAWN_CEILING_MARGIN_UNITS;
      const lifted = pileTop + halfHeight + SPAWN_CLEARANCE_UNITS;
      // Never *lower* than where the visitor aimed — the safe zone lifts a word
      // out of the pile, it does not drag one down into it.
      return Math.min(
        Math.max(preferredY, lifted),
        Math.max(preferredY, ceiling),
      );
    },

    commit(
      word: string,
      geometry: WordGeometry,
      scores: PropertyScores,
      spawnX: number,
      spawnY: number,
    ): WordBody | null {
      if (geometry.hulls.length === 0) return null;

      const density = lerp(
        scores.mass,
        DENSITY_AT_LIGHTEST,
        DENSITY_AT_HEAVIEST,
      );
      // Positives-only: anything the model rates clay-to-neutral (≤ 0) hard-stops
      // at 0; only genuinely bouncy words rebound. See MAX_RESTITUTION.
      const bounciness = Math.max(0, Math.min(1, scores.restitution));
      const restitution = MAX_RESTITUTION * bounciness;
      // Bouncy words keep less of their fall damping so the rebound can actually
      // soar — see BOUNCY_DAMPING_FLOOR.
      const damping =
        (MIN_LINEAR_DAMPING +
          fallResistance(scores) * (MAX_LINEAR_DAMPING - MIN_LINEAR_DAMPING)) *
        (1 - bounciness * (1 - BOUNCY_DAMPING_FLOOR));

      const id = nextId;
      nextId += 1;

      // Released at the cursor (DESIGN.md: words land where the cursor is),
      // then nudged downward rather than dropped from rest. Free to rotate under
      // real physics; the righting torque in `step` settles it upright.
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(spawnX, spawnY)
          .setLinearDamping(damping)
          .setAngularDamping(ANGULAR_DAMPING)
          .setLinvel(0, COMMIT_IMPULSE_UNITS_PER_S),
      );

      const colliderHandles: number[] = [];
      let attached = 0;
      let rejected = 0;
      for (const [index, hull] of geometry.hulls.entries()) {
        const scaled = new Float32Array(hull.length);
        for (let i = 0; i < hull.length; i += 1)
          scaled[i] = hull[i]! * WORD_EM_UNITS;

        const collider = RAPIER.ColliderDesc.convexHull(scaled);
        // Typed `ColliderDesc | null`, which implies this is where a bad hull
        // is caught. It is not. `convexHull` only stores the vertices; the hull
        // is actually computed inside `createCollider`, and a degenerate point
        // set makes *that* throw out of wasm-bindgen with "expected instance of
        // lA" — a message naming nothing involved. So the guard has to be here,
        // and it has to be a try/catch rather than a null check.
        if (!collider) continue;
        collider.setDensity(density);
        collider.setRestitution(restitution);
        // Max, not the default average, so a bouncy word keeps its bounce
        // against the dead floor instead of losing half of it.
        collider.setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max);
        collider.setFriction(FRICTION);
        // Collision events (any contact, regardless of force) drive crush, since
        // a heavy word landing on a light one barely generates force. Contact-
        // force events, gated high, drive wake so settling jitter is ignored.
        collider.setActiveEvents(
          RAPIER.ActiveEvents.COLLISION_EVENTS |
            RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS,
        );
        collider.setContactForceEventThreshold(WAKE_IMPACT_FORCE);
        try {
          colliderHandles.push(world.createCollider(collider, body).handle);
          attached += 1;
        } catch {
          // One unusable sliver costs a sliver of silhouette. Letting it
          // propagate would cost the whole word.
          rejected += 1;
          debug(
            "physics",
            `"${word}" hull ${String(index)} rejected: ` +
              `${String(hull.length / 2)} points, area ${polygonArea(hull).toExponential(2)} em²`,
          );
        }
      }

      if (attached === 0) {
        world.removeRigidBody(body);
        debug("physics", `"${word}" produced no usable colliders`);
        return null;
      }

      const wordBody: WordBody = {
        id,
        word,
        geometry,
        scores,
        liveliness: liveliness(scores),
        x: 0,
        y: 0,
        rotation: 0,
        asleep: false,
        frozen: false,
      };

      handles.set(wordBody.id, body);
      for (const handle of colliderHandles)
        bodyByCollider.set(handle, wordBody);
      bodies.push(wordBody);
      debug(
        "physics",
        `"${word}" density ${density.toFixed(2)} damping ${damping.toFixed(2)} ` +
          `restitution ${restitution.toFixed(2)} colliders ${String(attached)}` +
          (rejected > 0 ? ` (${String(rejected)} rejected)` : ""),
      );
      return wordBody;
    },

    step(fixedDeltaMs: number): void {
      world.timestep = fixedDeltaMs / 1000;
      elapsedMs += fixedDeltaMs;

      // Snapshot how fast each word is moving *before* the step resolves — the
      // contact that fires an impact event is the same one that stops the
      // striker, so its post-step speed no longer reflects the blow.
      speedBeforeStep.clear();
      for (const wordBody of bodies) {
        const body = handles.get(wordBody.id);
        if (body) {
          const v = body.linvel();
          speedBeforeStep.set(wordBody.id, Math.hypot(v.x, v.y));
        }
      }

      // Before the solver runs, so the pull is resolved by the same step that
      // sees it rather than landing a frame late in the visitor's hand.
      driveGrab(fixedDeltaMs);
      driveSemanticGravity(fixedDeltaMs);

      world.step(eventQueue);

      // Crush is decided from collision events — any contact, since a heavy word
      // landing on a light one barely generates force — and wake from the
      // force-gated events so settling jitter never wakes the pile. Either
      // collider may be the striker, so both orderings are tried. Crushed words
      // are collected and removed after draining, since removing a body
      // mid-iteration is unsafe.
      const toCrush = new Set<WordBody>();
      // One report per word per step: a compound body has dozens of colliders
      // and a single landing fires a contact for every one of them that
      // touches, so without this a word would be heard tens of times at once.
      const heardThisStep = new Set<number>();
      eventQueue.drainCollisionEvents((handle1, handle2, started) => {
        if (!started) return;
        const a = bodyByCollider.get(handle1);
        const b = bodyByCollider.get(handle2);
        considerAreaCrush(a, toCrush);
        considerAreaCrush(b, toCrush);
        // A collider absent from the map belongs to the walls, which is what
        // distinguishes landing on the floor from landing on another word.
        recordImpact(a, b === undefined, heardThisStep);
        recordImpact(b, a === undefined, heardThisStep);
      });
      eventQueue.drainContactForceEvents((event) => {
        const a = bodyByCollider.get(event.collider1());
        const b = bodyByCollider.get(event.collider2());
        resolveWake(a, b);
        resolveWake(b, a);
      });
      for (const wordBody of toCrush) {
        wakeAround(wordBody.x, wordBody.y);
        removeWord(wordBody);
        crushedIds.push(wordBody.id);
      }

      for (const wordBody of bodies) {
        const body = handles.get(wordBody.id);
        if (!body) continue;

        const translation = body.translation();
        wordBody.x = translation.x;
        wordBody.y = translation.y;
        wordBody.rotation = body.rotation();
        wordBody.asleep = body.isSleeping() || wordBody.frozen;

        if (wordBody.frozen) continue;

        // A held word answers to the hand and to nothing else. The righting
        // torque would fight the visitor for control of its angle, and the
        // freeze timer would turn it to stone while they were still holding it
        // steady.
        if (isHeld(wordBody)) {
          stillForMs.set(wordBody.id, 0);
          continue;
        }

        const velocity = body.linvel();
        const linSpeed = Math.hypot(velocity.x, velocity.y);

        // Leaf drift: a light word descending gets a sideways sway so it wanders
        // down instead of dropping straight. Gated on falling, so it stops once
        // the word lands and can then settle and freeze. Phased by id so no two
        // leaves sway in unison.
        const leaf = leafFactor(wordBody.scores);
        if (leaf > 0 && velocity.y < -LEAF_MIN_FALL_SPEED) {
          const sway =
            Math.sin(
              (elapsedMs / 1000) * LEAF_FLUTTER_HZ * 2 * Math.PI + wordBody.id,
            ) *
            leaf *
            LEAF_FLUTTER_ACCEL;
          body.applyImpulse(
            { x: sway * body.mass() * (fixedDeltaMs / 1000), y: 0 },
            false,
          );
        }

        // The room's air. Phased by position, so it crosses the room as one
        // slow wave rather than as two hundred separate oscillators, and mostly
        // a torque — see BREATH_TORQUE for why sliding a resting word is not
        // affordable and rocking one is.
        const breath = breathFactor(wordBody.liveliness);
        if (breath > 0) {
          const wave = Math.sin(
            (elapsedMs / 1000) * BREATH_HZ * 2 * Math.PI +
              wordBody.x * BREATH_WAVE_PER_UNIT,
          );
          const seconds = fixedDeltaMs / 1000;
          // `wakeUp: true`, and it is the whole mechanism rather than a detail.
          // Not freezing a word is *not enough to keep it alive*: Rapier puts a
          // settled dynamic body to sleep on its own, and a sleeping body
          // silently discards an impulse applied with `wakeUp: false`. Measured
          // — a `cloud` ten seconds after landing came back `frozen: false,
          // asleep: true` and had moved 0.000 units in twelve seconds of
          // breathing. The freeze was never the only thing making the room
          // dead; it was only the half that was documented.
          body.applyImpulse(
            {
              x: wave * breath * BREATH_SWAY_ACCEL * body.mass() * seconds,
              y: 0,
            },
            true,
          );
          body.applyTorqueImpulse(
            wave * breath * BREATH_TORQUE * body.mass() * seconds,
            true,
          );
        }

        // Right the word once it has slowed — a word still in flight keeps
        // tumbling. Inside the deadband the torque is zero, so a settled word
        // can go still and freeze. wakeUp=false so righting never wakes a
        // sleeping neighbour; a buried word's torque is cancelled by contacts.
        if (linSpeed < ORIENT_ACTIVE_SPEED) {
          const tilt = wrapToPi(wordBody.rotation);
          if (Math.abs(tilt) > ORIENT_DEADBAND) {
            body.applyTorqueImpulse(
              -ORIENT_TORQUE_GAIN * tilt * body.mass(),
              false,
            );
          }
        }

        // Linear stillness alone: a word that has stopped *moving* is settled,
        // even if the righting torque is still easing it upright. Requiring
        // angular stillness too would strand any word torqued toward upright
        // from outside the deadband — it would never freeze and the room would
        // never go quiet. Angular damping and the deadband keep the frozen angle
        // readable; see ORIENT_DEADBAND.
        const still = linSpeed < FREEZE_LINEAR_SPEED;
        const elapsed = still
          ? (stillForMs.get(wordBody.id) ?? 0) + fixedDeltaMs
          : 0;
        stillForMs.set(wordBody.id, elapsed);

        // Null for a word too alive to ever settle: it stays dynamic for the
        // whole session, which is the point.
        const freezeAfterMs = freezeDelayFor(wordBody.liveliness);
        if (freezeAfterMs !== null && elapsed >= freezeAfterMs) {
          // Not `sleep()` — see the note on the freeze constants. Fixed bodies
          // are outside the island graph, so this cannot be undone by a
          // neighbour waking up. Only a hard impact reverts it, via wakeFrozen.
          body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
          wordBody.frozen = true;
          wordBody.asleep = true;
          stillForMs.delete(wordBody.id);
        }
      }
    },

    remove(id: number): boolean {
      const wordBody = bodies.find((candidate) => candidate.id === id);
      if (!wordBody) return false;
      removeWord(wordBody);
      return true;
    },

    surfaceBodies(limit: number): WordBody[] {
      // A word is buried if any other word's centre sits above it and close
      // enough in x to be resting on it. O(n²) over at most 200 bodies, run
      // once per resume — about 40,000 comparisons, which is nothing for
      // something that happens when a tab regains focus.
      const surface: WordBody[] = [];
      for (const candidate of bodies) {
        let buried = false;
        for (const other of bodies) {
          if (other === candidate) continue;
          if (
            other.y > candidate.y &&
            Math.abs(other.x - candidate.x) < SURFACE_SPAN_UNITS
          ) {
            buried = true;
            break;
          }
        }
        if (!buried) surface.push(candidate);
      }
      // Newest first, so a cap takes the most recently placed words — the ones
      // a visitor is most likely to still be looking at.
      surface.sort((a, b) => b.id - a.id);
      return surface.slice(0, limit);
    },

    get held(): WordBody | null {
      return grabbed?.body ?? null;
    },

    grab(x: number, y: number): WordBody | null {
      // The walls are excluded rather than filtered afterwards: `projectPoint`
      // returns only the *nearest* collider, so a visitor reaching for a word
      // sitting against the floor would otherwise be handed the floor.
      const projection = world.projectPoint(
        { x, y },
        true,
        undefined,
        undefined,
        undefined,
        walls ?? undefined,
      );
      if (!projection) return null;

      const wordBody = bodyByCollider.get(projection.collider.handle);
      if (!wordBody) return null;
      const reach = Math.hypot(projection.point.x - x, projection.point.y - y);
      if (!projection.isInside && reach > GRAB_RADIUS_UNITS) return null;

      if (wordBody.frozen) wakeBody(wordBody);
      // Taking a word out of sediment should let the sediment fall into the
      // space it leaves, exactly as the crush does.
      wakeAround(wordBody.x, wordBody.y);

      const body = handles.get(wordBody.id);
      if (!body) return null;

      // The grip is the nearest point *on* the word, not the pointer itself. A
      // forgiving radius means the pointer is often outside the shape, and
      // hanging the word off a point in mid-air beside it gives the grab a long
      // lever arm and a wild swing.
      const translation = body.translation();
      const angle = body.rotation();
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const offsetX = projection.point.x - translation.x;
      const offsetY = projection.point.y - translation.y;

      const stiffness = lerp(
        wordBody.scores.mass,
        GRAB_STIFFNESS_AT_LIGHTEST,
        GRAB_STIFFNESS_AT_HEAVIEST,
      );

      grabbed = {
        body: wordBody,
        // Inverse rotation, so the grip is stored in the word's own frame and
        // travels with the letterform as it turns.
        localX: offsetX * cos + offsetY * sin,
        localY: -offsetX * sin + offsetY * cos,
        stiffness,
        damping: 2 * GRAB_DAMPING_RATIO * Math.sqrt(stiffness),
        targetX: x,
        targetY: y,
      };
      debug(
        "physics",
        `grabbed "${wordBody.word}" mass ${wordBody.scores.mass.toFixed(2)} ` +
          `stiffness ${stiffness.toFixed(0)}`,
      );
      return wordBody;
    },

    dragTo(x: number, y: number): void {
      if (!grabbed) return;
      grabbed.targetX = x;
      grabbed.targetY = y;
    },

    release(): void {
      grabbed = null;
    },

    stir(id: number): void {
      const wordBody = bodies.find((candidate) => candidate.id === id);
      if (!wordBody) return;
      if (wordBody.frozen) wakeBody(wordBody);
      const body = handles.get(id);
      if (!body) return;
      // Upward and slightly sideways, phased by id so a whole surface does not
      // twitch in unison. Scaled by mass so heavy and light words move by
      // comparable amounts rather than the feathers flying off.
      const sway = Math.sin(id * 2.399) * STIR_IMPULSE_UNITS_PER_S;
      body.applyImpulse(
        {
          x: sway * body.mass(),
          y: STIR_IMPULSE_UNITS_PER_S * body.mass(),
        },
        true,
      );
    },

    drainImpacts(): Impact[] {
      if (impacts.length === 0) return [];
      const drained = impacts;
      impacts = [];
      return drained;
    },

    drainCrushed(): number[] {
      if (crushedIds.length === 0) return [];
      const drained = crushedIds;
      crushedIds = [];
      return drained;
    },

    setSemanticGravity(enabled: boolean, pullAccel = DEFAULT_PULL_ACCEL): void {
      semanticGravityOn = enabled;
      semanticPullAccel = pullAccel;
      debug(
        "physics",
        `semantic gravity ${enabled ? "on" : "off"} at ${pullAccel.toFixed(0)}`,
      );
    },

    clear(): void {
      grabbed = null;
      for (const body of handles.values()) world.removeRigidBody(body);
      handles.clear();
      bodyByCollider.clear();
      stillForMs.clear();
      bodies.length = 0;
      crushedIds = [];
      impacts = [];
    },
  };
}
