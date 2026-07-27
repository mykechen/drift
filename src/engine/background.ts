/**
 * The paper.
 *
 * Until Phase 3 the background was `gl.clearColor` and nothing else — a flat
 * fill, which is the one thing paper is not. This is a single full-screen quad
 * carrying the time-of-day colour and the procedural grain, drawn before
 * anything else in the scene.
 *
 * It is its own module rather than more of `renderer.ts` because it shares
 * nothing with the word pipeline: its own shader, its own geometry, no SDF, no
 * transforms, no per-body state. `renderer.ts` owns words; this owns the room
 * they sit in.
 */

import {
  Geometry,
  Mesh,
  Program,
  type OGLRenderingContext,
  type Transform,
} from "ogl";
import { GRAIN_OPACITY, type RoomTint } from "../design/palette";

/**
 * Grain frequencies, in device pixels per cycle.
 *
 * Two octaves, because one does not read as paper. DESIGN.md asks for "low
 * frequency", which on its own gives mottle — broad patches of slightly
 * uneven tone, like held-up-to-the-light paper — with no surface to it. The
 * fine octave supplies tooth. Together they read as stock; separately they read
 * as either a gradient artefact or as video noise.
 */
const GRAIN_TOOTH_PIXELS = 1.7;
const GRAIN_MOTTLE_PIXELS = 90;

/** How the ±2% budget is split between the two octaves. */
const GRAIN_TOOTH_SHARE = 0.62;

const VERTEX_SHADER = /* glsl */ `
  attribute vec2 position;

  void main() {
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

/**
 * Grain is a function of `gl_FragCoord` alone. There is deliberately no time
 * uniform in this shader.
 *
 * Animated film grain is the obvious reading of "grain" and it is wrong here.
 * It would be the only continuously moving thing in an empty room, in a piece
 * whose whole argument is stillness — and it would make the still export a lie,
 * since the exported PNG freezes one arbitrary frame of something the visitor
 * saw as shimmer.
 */
const FRAGMENT_SHADER = /* glsl */ `
  precision mediump float;

  uniform vec3 uBackground;
  uniform float uToothScale;
  uniform float uMottleScale;
  uniform float uToothAmount;
  uniform float uMottleAmount;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  // Value noise: hash the four lattice corners and interpolate with a
  // smoothstep, which is what separates mottle from static.
  float valueNoise(vec2 p) {
    vec2 cell = floor(p);
    vec2 offset = fract(p);
    vec2 weight = offset * offset * (3.0 - 2.0 * offset);
    float a = hash(cell);
    float b = hash(cell + vec2(1.0, 0.0));
    float c = hash(cell + vec2(0.0, 1.0));
    float d = hash(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, weight.x), mix(c, d, weight.x), weight.y);
  }

  void main() {
    // Centred on zero so grain darkens and lightens the paper equally rather
    // than only darkening it, which would shift the whole background off the
    // declared value.
    float tooth = hash(floor(gl_FragCoord.xy / uToothScale)) - 0.5;
    float mottle = valueNoise(gl_FragCoord.xy / uMottleScale) - 0.5;

    float grain = tooth * uToothAmount + mottle * uMottleAmount;
    gl_FragColor = vec4(uBackground + grain, 1.0);
  }
`;

export interface Background {
  /** Draw the paper. Call before anything else in the frame. */
  readonly draw: (tint: RoomTint) => void;
  /** Drop the mesh from the scene graph. */
  readonly detach: () => void;
}

/**
 * Build the background pass.
 *
 * The quad is given in clip space directly and never transformed, so it needs
 * no projection uniform and does not care about the room's aspect ratio or the
 * drawing buffer's size. The grain is sized in *device pixels* via
 * `gl_FragCoord`, which is what keeps its texture the same physical size on a
 * retina display as on a 1× one — scaling it with the room would make the paper
 * coarser on big monitors.
 */
export function createBackground(
  gl: OGLRenderingContext,
  scene: Transform,
): Background {
  const mesh = new Mesh(gl, {
    geometry: new Geometry(gl, {
      position: {
        size: 2,
        data: new Float32Array([-1, -1, 3, -1, -1, 3]),
      },
    }),
    program: new Program(gl, {
      vertex: VERTEX_SHADER,
      fragment: FRAGMENT_SHADER,
      // The paper is opaque and is the first thing drawn; blending it would
      // composite it against whatever the clear left behind.
      transparent: false,
      cullFace: false,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uBackground: { value: [1, 1, 1] },
        uToothScale: { value: GRAIN_TOOTH_PIXELS },
        uMottleScale: { value: GRAIN_MOTTLE_PIXELS },
        uToothAmount: { value: GRAIN_OPACITY * GRAIN_TOOTH_SHARE },
        uMottleAmount: { value: GRAIN_OPACITY * (1 - GRAIN_TOOTH_SHARE) },
      },
    }),
  });

  // One triangle rather than two, large enough to cover the clip cube. It costs
  // one fewer vertex and, more usefully, has no diagonal seam across the middle
  // of the paper where two triangles would meet.
  mesh.setParent(scene);

  return {
    draw(tint: RoomTint): void {
      (mesh.program.uniforms["uBackground"] as { value: number[] }).value = [
        tint.background[0],
        tint.background[1],
        tint.background[2],
      ];
    },
    detach(): void {
      mesh.setParent(null);
    },
  };
}
