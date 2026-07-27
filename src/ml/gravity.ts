/**
 * Semantic gravity — **a hard-coded stand-in, built to answer one question.**
 *
 * `ROADMAP.md` plans this as cosine similarity over a real embedding space
 * (Phase 5a), then a learned force field (Phase 5b). Both need embeddings, and
 * `model/embedding_probe.py` established that the property model cannot supply
 * them: its representations cluster words that *behave* alike, not words that
 * *mean* alike, so `stone`'s nearest neighbours come out as `thousand, dr,
 * gate`. Real embeddings for the vocabulary cost roughly 537 KB against a
 * desktop budget whose non-ML overhead is about 520 KB in total.
 *
 * Before spending that, this answers the cheaper question: **is the drift
 * visible at all?** A hand-written similarity over thirty words costs nothing
 * and produces exactly the same forces a perfect embedding would produce for
 * those words. If `rock` does not visibly move toward `stone` here, no
 * embedding quality fixes it, and the payload buys nothing.
 *
 * The table is deliberately tiny and deliberately not exported for general use.
 * It is a measuring instrument, not a feature — if this survives, every word of
 * it is replaced by the real thing.
 */

/**
 * Words that a perfect embedding would place together. One group per row;
 * membership is all-or-nothing, which overstates a real embedding's confidence
 * and is the right bias for a probe — if the effect is invisible at similarity
 * 1.0, it is invisible.
 */
const GROUPS: readonly (readonly string[])[] = [
  ["stone", "rock", "granite", "slate", "pebble", "boulder", "gravel", "flint"],
  ["ocean", "sea", "river", "water", "wave", "tide", "stream", "lake"],
  ["fire", "flame", "ember", "ash", "smoke", "coal", "spark", "cinder"],
  ["cloud", "mist", "fog", "haze", "vapor", "steam", "rain"],
  ["tree", "forest", "leaf", "branch", "root", "wood", "moss"],
];

const GROUP_OF = new Map<string, number>();
for (const [index, group] of GROUPS.entries()) {
  for (const word of group) GROUP_OF.set(word, index);
}

/** Whether this word participates at all. Most do not — the table is 38 words. */
export function hasSemanticGroup(word: string): boolean {
  return GROUP_OF.has(word);
}

/**
 * Similarity in [0, 1]. 1 for words in the same group, 0 otherwise.
 *
 * A real embedding would return a graded value and would sometimes be wrong.
 * This returns the answer a *perfect* embedding would give, which is what makes
 * a negative result here conclusive.
 */
export function similarity(a: string, b: string): number {
  const groupA = GROUP_OF.get(a);
  if (groupA === undefined) return 0;
  return groupA === GROUP_OF.get(b) ? 1 : 0;
}

/**
 * How hard related words pull, in units per second squared.
 *
 * **It has to beat friction to do anything at all**, and that sets the floor
 * rather than taste: sliding a resting word means overcoming `FRICTION` 0.85
 * against gravity, so roughly 8.3 units/s². This is the same wall the room's
 * breath hit, and it is why the breath became a torque instead. Drift has no
 * such escape — semantic gravity that only rocks words in place is not drift.
 *
 * That is itself part of what the probe is measuring: whether a force large
 * enough to move a settled word can possibly read as a gentle drift rather
 * than as words sliding around on their own.
 *
 * **Passed as a parameter rather than held as module state**, and that is not
 * fastidiousness. The first version of this probe exposed a `setPullAccel`
 * setter, and sweeping it from the console changed nothing at all: Vite serves
 * a dynamic `import()` as a *separate module instance* from the one `physics.ts`
 * imported, so the sweep was setting a value on a second copy. Four strengths
 * eight-fold apart returned byte-identical results, which is what gave it away.
 */
export const DEFAULT_PULL_ACCEL = 11;

/** Beyond this, related words do not feel each other. */
const RADIUS_UNITS = 4.5;

/**
 * Inside this, the pull stops — they have arrived. Without it a pair grinds
 * into each other permanently and neither can ever settle.
 */
const ARRIVED_UNITS = 1.1;

export interface GravityBody {
  readonly word: string;
  readonly x: number;
  readonly y: number;
}

export interface GravityPull {
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

/**
 * The acceleration each body feels from the others, in world units per second
 * squared. Only bodies in the table are considered, so this is O(k²) over the
 * handful of participating words rather than O(n²) over the room.
 *
 * Returned rather than applied, so the caller owns waking and impulse scaling
 * and this stays a pure function that can be reasoned about on its own.
 */
export function semanticPulls(
  bodies: readonly GravityBody[],
  pullAccel: number = DEFAULT_PULL_ACCEL,
): GravityPull[] {
  const active: number[] = [];
  for (const [index, body] of bodies.entries())
    if (hasSemanticGroup(body.word)) active.push(index);

  const pulls: GravityPull[] = [];
  for (const i of active) {
    let accelX = 0;
    let accelY = 0;
    const self = bodies[i]!;
    for (const j of active) {
      if (i === j) continue;
      const other = bodies[j]!;
      const weight = similarity(self.word, other.word);
      if (weight === 0) continue;

      const dx = other.x - self.x;
      const dy = other.y - self.y;
      const distance = Math.hypot(dx, dy);
      if (distance > RADIUS_UNITS || distance < ARRIVED_UNITS) continue;

      // Linear falloff to zero at the radius. Not inverse-square: the real
      // thing is a force *field* over a composition, not a gravitational
      // simulation, and inverse-square makes near pairs violent while doing
      // nothing at the distances that matter here.
      const falloff =
        (distance - ARRIVED_UNITS) / (RADIUS_UNITS - ARRIVED_UNITS);
      const magnitude = weight * pullAccel * (1 - falloff);
      accelX += (dx / distance) * magnitude;
      accelY += (dy / distance) * magnitude;
    }
    if (accelX !== 0 || accelY !== 0)
      pulls.push({ index: i, x: accelX, y: accelY });
  }
  return pulls;
}
