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
const DENSITY_AT_LIGHTEST = 0.15;
const DENSITY_AT_HEAVIEST = 6;

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
 */
const MIN_LINEAR_DAMPING = 0;
const MAX_LINEAR_DAMPING = 3.2;

/** How much the drag residual can pull resistance away from what mass sets. */
const DRAG_RESIDUAL_INFLUENCE = 0.45;

/**
 * Angular damping, fixed and high. Per CLAUDE.md words should tumble slightly
 * and settle flat, never spin like propellers.
 */
const ANGULAR_DAMPING = 4.5;

/** Restitution range. Nothing in the room is a superball. */
const MAX_RESTITUTION = 0.55;

/** High enough that words stack and hold rather than sliding into a flat layer. */
const FRICTION = 0.85;

/**
 * The downward nudge on commit, per DESIGN.md — releasing from rest and letting
 * gravity take over reads as indecisive.
 */
const COMMIT_IMPULSE_UNITS_PER_S = -1.2;

// --- Settling ---------------------------------------------------------------

/**
 * Rapier's JavaScript bindings do not expose its sleep thresholds, so settling
 * is implemented here instead: a body slower than these limits for
 * `SETTLE_AFTER_MS` is put to sleep by hand. CLAUDE.md asks for a settled word
 * to stop simulating within about half a second of coming to rest.
 */
const SETTLE_LINEAR_SPEED = 0.06;
const SETTLE_ANGULAR_SPEED = 0.15;
const SETTLE_AFTER_MS = 500;

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
  asleep: boolean;
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
  /** Drop a word into the room at the cursor. Returns null if it has no geometry. */
  commit(
    word: string,
    geometry: WordGeometry,
    scores: PropertyScores,
  ): WordBody | null;
  /** Advance by one fixed step. */
  step(fixedDeltaMs: number): void;
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
  const stillForMs = new Map<number, number>();

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
    ): WordBody | null {
      if (geometry.hulls.length === 0) return null;

      const density = lerp(
        scores.mass,
        DENSITY_AT_LIGHTEST,
        DENSITY_AT_HEAVIEST,
      );
      const damping =
        MIN_LINEAR_DAMPING +
        fallResistance(scores) * (MAX_LINEAR_DAMPING - MIN_LINEAR_DAMPING);
      const restitution = lerp(scores.restitution, 0, MAX_RESTITUTION);

      // Committed at the cursor, which DESIGN.md fixes at the centre of the
      // room, then given a nudge downward rather than released from rest.
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(0, 0)
          .setLinearDamping(damping)
          .setAngularDamping(ANGULAR_DAMPING)
          .setLinvel(0, COMMIT_IMPULSE_UNITS_PER_S),
      );

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
        collider.setFriction(FRICTION);
        try {
          world.createCollider(collider, body);
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
        id: nextId,
        word,
        geometry,
        scores,
        x: 0,
        y: 0,
        rotation: 0,
        asleep: false,
      };
      nextId += 1;

      handles.set(wordBody.id, body);
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
      world.step();

      for (const wordBody of bodies) {
        const body = handles.get(wordBody.id);
        if (!body) continue;

        const translation = body.translation();
        wordBody.x = translation.x;
        wordBody.y = translation.y;
        wordBody.rotation = body.rotation();
        wordBody.asleep = body.isSleeping();

        if (wordBody.asleep) continue;

        // Hand-rolled settling, since the bindings do not expose Rapier's own
        // thresholds. A body slow enough for long enough is put to sleep.
        const velocity = body.linvel();
        const still =
          Math.hypot(velocity.x, velocity.y) < SETTLE_LINEAR_SPEED &&
          Math.abs(body.angvel()) < SETTLE_ANGULAR_SPEED;
        const elapsed = still
          ? (stillForMs.get(wordBody.id) ?? 0) + fixedDeltaMs
          : 0;
        stillForMs.set(wordBody.id, elapsed);
        if (elapsed >= SETTLE_AFTER_MS) body.sleep();
      }
    },

    clear(): void {
      for (const body of handles.values()) world.removeRigidBody(body);
      handles.clear();
      stillForMs.clear();
      bodies.length = 0;
    },
  };
}
