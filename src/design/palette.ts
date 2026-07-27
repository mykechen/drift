/**
 * The palette. Values are final and come from DESIGN.md — do not adjust them
 * here without changing that document first. No hex literal belongs anywhere
 * else in the source.
 *
 * The warmth-driven ink interpolation and the time-of-day shift are applied on
 * top of these base values; both are in this file.
 */

/** Warm off-white. Paper. */
export const BACKGROUND = "#F4F0E8";

/** Near-black, warm. The default word. */
export const INK = "#1A1817";

/** Deep warm brown. Ink for words the model rates warmest (`warmth` = +1). */
export const INK_WARMEST = "#3A2418";

/** Deep cool blue-black. Ink for the coolest words (`warmth` = -1). */
export const INK_COOLEST = "#152838";

/** Deep coral-red. The text caret, and nothing else in the piece. */
export const ACCENT_CURSOR = "#D94F1E";

/** Cast beneath settled words. Blur radius scales with mass. */
export const SHADOW_COLOR = "#000000";
export const SHADOW_OPACITY = 0.08;

/**
 * Shadow blur and drop, in em, across the mass range.
 *
 * Both are bounded by the distance field's own reach: the shadow is read out of
 * the same texture as the ink, and that field only knows distances up to
 * `SPREAD_EM` beyond the glyph. The blur ramps from the letter's edge outward by
 * twice these values, so the heaviest must stay under half the spread or the
 * shadow would be sliced off square at the quad's edge.
 *
 * A heavy word casts a wider, further-dropped shadow — it reads as sitting
 * above the paper with weight behind it — where a light word's is tight and
 * close, barely detached. This is the same mass score driving `wght`, so the
 * shadow and the letterform thicken together.
 */
export const SHADOW_BLUR_EM_LIGHTEST = 0.022;
export const SHADOW_BLUR_EM_HEAVIEST = 0.065;
export const SHADOW_DROP_EM_LIGHTEST = 0.014;
export const SHADOW_DROP_EM_HEAVIEST = 0.055;

/** One channel of a `#RRGGBB` string, as 0–1. */
function channel(hex: string, index: number): number {
  return parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
}

/**
 * How hard to push warmth toward the palette's two ink extremes.
 *
 * The tint read as almost nothing for a reason that was in the *data*, not the
 * colours. `INK_COOLEST` and `INK_WARMEST` were only reached at warmth ±1.0,
 * and measured over the 10,750 labelled words, **58% score |warmth| < 0.3 and
 * only 5% exceed 0.6** — so nearly every word rendered within a hair of neutral
 * and the two declared colours were decoration nothing ever touched.
 *
 * A gain of 2 makes ±0.5 reach the endpoints, which is roughly the p10–p90
 * spread of the real distribution. The extremes stay exactly as DESIGN.md
 * declares them; what changes is that words actually arrive at them.
 */
const WARMTH_GAIN = 2;

/**
 * How much of its ink an old word gives up to the paper.
 *
 * `age` originally showed only as an eroded, softened edge, which was a
 * boundary difference you had to hunt for. Old writing fades, and fading is
 * legible at a glance because it changes the whole word's tone rather than one
 * pixel of its outline. The erosion stays — faded *and* slightly eaten is what
 * old ink on old paper looks like — but this is the half that reads.
 *
 * Mixing toward the background rather than lowering alpha, so a worn word does
 * not go translucent over the words behind it.
 *
 * Applied to **positive age only**. Mapping the full −1…+1 range onto the fade
 * meant a word of neutral age was already 15% washed out, which broke
 * DESIGN.md's promise that a neutral word lands exactly on `INK` — and since
 * most words sit near the middle, it lightened the whole room rather than
 * marking the old ones. Only what is actually old fades; everything else is ink.
 */
const AGE_FADE_TOWARD_PAPER = 0.22;

/**
 * Ink for a word, interpolated by its `warmth` score and shifted by the hour.
 *
 * Per DESIGN.md this runs `INK_COOLEST` → `INK` → `INK_WARMEST` across
 * warmth −1 → 0 → +1, and must stay subtle enough that the room reads as
 * monochrome at a glance. Two segments rather than one, so a neutral word lands
 * exactly on `INK` rather than somewhere between the extremes.
 *
 * `tint` is the time of day. Golden hour warms the ink and the two dark periods
 * lift it off full black; passing nothing leaves it as declared, which is what
 * the debug pages want.
 *
 * Returns linear 0–1 components, which is what the shader wants.
 */
export function inkForWarmth(
  warmth: number,
  tint?: RoomTint,
  age = 0,
): [number, number, number] {
  const clamped = Math.max(-1, Math.min(1, warmth * WARMTH_GAIN));
  const from = clamped < 0 ? INK_COOLEST : INK;
  const to = clamped < 0 ? INK : INK_WARMEST;
  const t = clamped < 0 ? clamped + 1 : clamped;

  const rgb: [number, number, number] = [
    channel(from, 0) + (channel(to, 0) - channel(from, 0)) * t,
    channel(from, 1) + (channel(to, 1) - channel(from, 1)) * t,
    channel(from, 2) + (channel(to, 2) - channel(from, 2)) * t,
  ];

  const shifted: [number, number, number] = tint
    ? toRgb(
        toHsl(rgb)[0] + tint.inkHueShift,
        toHsl(rgb)[1],
        toHsl(rgb)[2] + tint.inkLightnessLift,
      )
    : rgb;

  // Age fades the word toward the paper it sits on — a no-op on everything the
  // model rates neutral or modern, which is most of the room.
  const fade = Math.max(0, Math.min(1, age)) * AGE_FADE_TOWARD_PAPER;
  if (fade === 0) return shifted;

  const paper = tint
    ? tint.background
    : ([
        channel(BACKGROUND, 0),
        channel(BACKGROUND, 1),
        channel(BACKGROUND, 2),
      ] as [number, number, number]);

  return [
    shifted[0] + (paper[0] - shifted[0]) * fade,
    shifted[1] + (paper[1] - shifted[1]) * fade,
    shifted[2] + (paper[2] - shifted[2]) * fade,
  ];
}

/** Procedural background grain, per DESIGN.md. */
export const GRAIN_OPACITY = 0.02;

// --- Time of day ------------------------------------------------------------

/**
 * The room has weather, and this is it.
 *
 * DESIGN.md: "so subtle that 90% of visitors never consciously notice it, but a
 * returning visitor will feel that the room is different without being able to
 * say why. Do not compensate for its subtlety by making it louder."
 *
 * `#F4F0E8` is hue 40° in HSL, which sits in the oranges — so **warm is a
 * negative hue offset** (toward red) and **cool is positive** (toward green and
 * blue). Getting this backwards would make golden hour cool and evening warm,
 * and at a 6° excursion nobody would notice for weeks.
 */
export interface RoomTint {
  /** Background colour, linear 0–1 components, ready for the shader. */
  readonly background: [number, number, number];
  /** Degrees to rotate ink hue. Negative is warmer. */
  readonly inkHueShift: number;
  /** Added to ink lightness, 0–1. Lifts the dark periods off full black. */
  readonly inkLightnessLift: number;
}

/**
 * DESIGN.md's five periods, as offsets from the declared palette.
 *
 * Each entry stores the minute its period *begins*. Transitions run for
 * `TRANSITION_MINUTES` centred on that boundary — so 09:45 to 10:15 crosses
 * morning into midday — which means the table is interpolated by boundary
 * rather than by plateau. Storing boundaries is what lets the night → morning
 * wrap across midnight be arithmetic rather than a special case.
 */
interface Period {
  /** Minutes since midnight at which this period begins. */
  readonly startMinute: number;
  readonly backgroundHueShift: number;
  readonly backgroundLightnessShift: number;
  readonly inkHueShift: number;
  readonly inkLightnessLift: number;
}

const PERIODS: readonly Period[] = [
  // Night 22–6. Listed first because the table is indexed from midnight and
  // night is what midnight is inside of.
  {
    startMinute: 22 * 60,
    backgroundHueShift: 4,
    backgroundLightnessShift: -0.03,
    inkHueShift: 0,
    inkLightnessLift: 0.03,
  },
  {
    startMinute: 6 * 60,
    backgroundHueShift: 3,
    backgroundLightnessShift: 0.01,
    inkHueShift: 0,
    inkLightnessLift: 0,
  },
  {
    startMinute: 10 * 60,
    backgroundHueShift: 0,
    backgroundLightnessShift: 0,
    inkHueShift: 0,
    inkLightnessLift: 0,
  },
  {
    startMinute: 16 * 60,
    backgroundHueShift: -6,
    backgroundLightnessShift: -0.01,
    inkHueShift: -2,
    inkLightnessLift: 0,
  },
  {
    startMinute: 19 * 60,
    backgroundHueShift: 3,
    backgroundLightnessShift: -0.02,
    inkHueShift: 0,
    inkLightnessLift: 0.02,
  },
];

/** Per DESIGN.md: "Transitions between periods are 30-minute smoothstep interpolations." */
const TRANSITION_MINUTES = 30;

const MINUTES_PER_DAY = 24 * 60;

function smoothstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/** RGB 0–1 to HSL, hue in degrees. */
function toHsl(
  rgb: readonly [number, number, number],
): [number, number, number] {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return [0, 0, lightness];

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);

  return [(hue + 360) % 360, saturation, lightness];
}

/** HSL back to RGB 0–1. Hue wraps; saturation and lightness clamp. */
function toRgb(
  hue: number,
  saturation: number,
  lightness: number,
): [number, number, number] {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.max(0, Math.min(1, saturation));
  const l = Math.max(0, Math.min(1, lightness));

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

/** Shortest signed distance from `from` to `to` around a 24-hour clock, in minutes. */
function minutesBetween(from: number, to: number): number {
  return (((to - from) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * Which period a minute falls in, and how far it has crossed into the next.
 *
 * The blend runs over the 30 minutes *centred* on a boundary — so 09:45 to
 * 10:15 crosses morning into midday — which is why the fraction can be
 * negative-going at the start of a period as well as positive-going at its end.
 */
function blendAt(minute: number): {
  from: Period;
  to: Period;
  fraction: number;
} {
  let current = PERIODS[0]!;
  let next = PERIODS[0]!;
  let bestElapsed = Number.POSITIVE_INFINITY;

  for (const [index, period] of PERIODS.entries()) {
    const elapsed = minutesBetween(period.startMinute, minute);
    if (elapsed < bestElapsed) {
      bestElapsed = elapsed;
      current = period;
      next = PERIODS[(index + 1) % PERIODS.length]!;
    }
  }

  const half = TRANSITION_MINUTES / 2;
  const untilNext = minutesBetween(minute, next.startMinute);

  // Inside the second half of a boundary crossing: `current` has already
  // started, so blend forward from the period before it.
  if (bestElapsed < half) {
    const previous =
      PERIODS[
        (PERIODS.indexOf(current) - 1 + PERIODS.length) % PERIODS.length
      ]!;
    return {
      from: previous,
      to: current,
      fraction: smoothstep((bestElapsed + half) / TRANSITION_MINUTES),
    };
  }

  // Inside the first half of the next boundary crossing.
  if (untilNext < half) {
    return {
      from: current,
      to: next,
      fraction: smoothstep((half - untilNext) / TRANSITION_MINUTES),
    };
  }

  return { from: current, to: current, fraction: 0 };
}

function mix(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * The room's tint for a moment in local time.
 *
 * Call this on a **minute tick**, not per frame. The whole cycle moves 10° of
 * hue over twenty-four hours, so sampling per frame would be measuring
 * floating-point noise — which is what DESIGN.md means by "compute at frame
 * boundary; do not re-sample per frame."
 */
export function roomTintAt(date: Date): RoomTint {
  const minute = date.getHours() * 60 + date.getMinutes();
  const { from, to, fraction } = blendAt(minute);

  const base = toHsl([
    channel(BACKGROUND, 0),
    channel(BACKGROUND, 1),
    channel(BACKGROUND, 2),
  ]);

  const hueShift = mix(
    from.backgroundHueShift,
    to.backgroundHueShift,
    fraction,
  );
  const lightnessShift = mix(
    from.backgroundLightnessShift,
    to.backgroundLightnessShift,
    fraction,
  );

  return {
    background: toRgb(base[0] + hueShift, base[1], base[2] + lightnessShift),
    inkHueShift: mix(from.inkHueShift, to.inkHueShift, fraction),
    inkLightnessLift: mix(from.inkLightnessLift, to.inkLightnessLift, fraction),
  };
}
