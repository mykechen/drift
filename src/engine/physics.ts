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

import RAPIER from "@dimforge/rapier2d-compat";
import type { WordGeometry } from "./glyphs";
import type { PropertyScores } from "../ml/properties";
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
const FREEZE_LINEAR_SPEED = 0.08;
const FREEZE_AFTER_MS = 1500;

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
   * Drop a word into the room, centred horizontally on `spawnX` (world units,
   * where the cursor is). Returns null if the word has no geometry.
   */
  commit(
    word: string,
    geometry: WordGeometry,
    scores: PropertyScores,
    spawnX: number,
  ): WordBody | null;
  /** Advance by one fixed step. */
  step(fixedDeltaMs: number): void;
  /**
   * Ids of words crushed since the last call. The caller owns their exit
   * animation — physics has already removed the bodies. Drains the queue.
   */
  drainCrushed(): number[];
  /** Remove every body. */
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
 * Build the world. Rapier's WebAssembly must be initialised first, which is why
 * this is async and why `RAPIER.init()` lives here rather than at module scope.
 */
export async function createPhysicsRoom(aspect: number): Promise<PhysicsRoom> {
  await RAPIER.init();

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
  /** Ids of words crushed this step, handed to the renderer to animate out. */
  let crushedIds: number[] = [];

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
      if (striker.scores.mass - target.scores.mass <= CRUSH_MASS_GAP) continue;
      if (Math.hypot(target.x - striker.x, target.y - striker.y) <= radius)
        toCrush.add(target);
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

    commit(
      word: string,
      geometry: WordGeometry,
      scores: PropertyScores,
      spawnX: number,
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

      // Released at the cursor's x (DESIGN.md: words land where the cursor is),
      // then nudged downward rather than dropped from rest. Free to rotate under
      // real physics; the righting torque in `step` settles it upright.
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(spawnX, 0)
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

      world.step(eventQueue);

      // Crush is decided from collision events — any contact, since a heavy word
      // landing on a light one barely generates force — and wake from the
      // force-gated events so settling jitter never wakes the pile. Either
      // collider may be the striker, so both orderings are tried. Crushed words
      // are collected and removed after draining, since removing a body
      // mid-iteration is unsafe.
      const toCrush = new Set<WordBody>();
      eventQueue.drainCollisionEvents((handle1, handle2, started) => {
        if (!started) return;
        considerAreaCrush(bodyByCollider.get(handle1), toCrush);
        considerAreaCrush(bodyByCollider.get(handle2), toCrush);
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

        if (elapsed >= FREEZE_AFTER_MS) {
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

    drainCrushed(): number[] {
      if (crushedIds.length === 0) return [];
      const drained = crushedIds;
      crushedIds = [];
      return drained;
    },

    clear(): void {
      for (const body of handles.values()) world.removeRigidBody(body);
      handles.clear();
      bodyByCollider.clear();
      stillForMs.clear();
      bodies.length = 0;
      crushedIds = [];
    },
  };
}
