# SKILLS.md — Claude Code skills for Drift

Claude Code supports "skills" — small folders of best practices Claude reads when the task matches. For Drift, you don't need many. This is a focused single-page project, not an enterprise codebase.

Below: what to install, what to write yourself, and what to skip.

---

## Skills to install (public / existing)

Anthropic maintains public skills at `/mnt/skills/public/`. Not all of them are relevant to Drift. Install these:

### 1. `frontend-design`

**What it is:** guidance for distinctive, intentional visual design when building new UI. Covers aesthetic direction, typography, and making choices that don't read as templated defaults.

**Why for Drift:** the piece lives or dies on visual craft. This skill will nudge Claude Code toward considered decisions instead of Tailwind defaults.

**Note:** the skill has design tokens and rules for standard web UIs. Drift is not a standard web UI. Load the skill, but let it inform *taste* rather than dictate structure — the piece is a canvas, not a component tree.

### 2. `product-self-knowledge`

**What it is:** guidance for accurate details about Anthropic products (Claude API, Claude Code, etc.).

**Why for Drift:** not directly used, but if you end up embedding any Anthropic API references in your case study later, this prevents Claude Code from hallucinating pricing/model details.

**Optional.** Skip if you never plan to touch API integration in Drift.

---

## Skills to write yourself (custom, project-specific)

The high-leverage move for Drift. These skills are *project-specific* — they encode decisions from `DESIGN.md` and `ROADMAP.md` into small, focused instructions that Claude Code reads when the task matches.

Put them under `.claude/skills/` in the repo (Claude Code will pick them up).

### 1. `drift-motion` — how motion is done in this project

A skill that says, in effect: "when writing or modifying animation code in this project, use springs from these configs, never linear tweens, never CSS transitions on user-facing elements, always animate variable font axes with the commit spring."

Structure:

```
.claude/skills/drift-motion/
  SKILL.md
  spring-configs.ts   (reference implementation)
```

**When it triggers:** any task involving animation, transition, movement, springs, motion.

### 2. `drift-glyphs` — how glyphs become physics bodies

Encodes the glyph rendering + convex decomposition pipeline (fontkit for outlines, decomp.js for hulls, SDF for rendering). Prevents Claude Code from suggesting "just use a rectangle with text on it" the third time you refactor.

Structure:

```
.claude/skills/drift-glyphs/
  SKILL.md
  reference/
    outline-extraction.ts
    convex-decomposition-example.ts
```

**When it triggers:** any task involving glyph rendering, physics body creation, font loading, text-as-shape.

### 3. `drift-ml` — how ML is done in this project

Encodes the property model + force field contract. Prevents Claude Code from suggesting runtime embedding API calls when the whole point is client-side inference.

Structure:

```
.claude/skills/drift-ml/
  SKILL.md
  reference/
    model-loading.ts
    property-inference.ts
```

**When it triggers:** any task involving ML, embeddings, models, inference, ONNX, PyTorch, semantic properties.

### 4. `drift-copy` — how words appear on the page (they mostly don't)

Encodes the brand voice from `brand-guidelines.md`. Prevents Claude Code from adding tooltips, help text, error toasts, or any of the standard-web-app copy that would ruin the piece.

Structure:

```
.claude/skills/drift-copy/
  SKILL.md
```

**When it triggers:** any task involving user-facing text, copy, messages, tooltips, error states.

---

## How to write a project skill (quick reference)

Each `SKILL.md` follows this shape:

```markdown
---
name: drift-motion
description: How motion is done in Drift. Use whenever animating, transitioning, or moving anything on-screen. Prevents linear tweens and enforces the spring configurations from DESIGN.md.
---

# drift-motion

## When to use this skill

Any task that involves animation, transition, spring, tween, motion, movement, or timing of visual state changes.

## Rules

1. Never use CSS transitions on user-facing elements. Use springs.
2. Never use linear easing.
3. The two allowed spring configs are:
   - default: stiffness 220, damping 24, mass 1
   - commit: stiffness 180, damping 18, mass 1
4. Variable font axes are always animated with `commit` spring.
5. Physics-driven bodies use Rapier's own step — do NOT spring them.

## Reference

See `reference/spring-configs.ts` for the canonical implementation.
```

Keep them short. A good project skill is ~30 lines of markdown and one small reference file. If your skill is long, it's really a `DESIGN.md` section pretending to be a skill.

---

## Skills NOT to use

Skip these — they don't fit Drift:

- **`docx`, `pdf`, `pptx`, `xlsx`** — Drift produces no documents.
- **`skill-creator`** — useful once, to help write the four custom skills above. Then unnecessary.
- Generic frontend framework skills (React, Next.js) — Drift is vanilla TS + Vite.
- SEO / accessibility auditor skills — Lighthouse in the browser is enough. The site is a single canvas; there is little for a skill to check.

---

## Setup order

1. Initialize the repo with the four .md files (`CLAUDE.md`, `DESIGN.md`, `brand-guidelines.md`, `ROADMAP.md`).
2. Confirm Claude Code reads them at the start of every session.
3. Once the repo has some code (post Phase 0), write the four custom skills.
4. Point Claude Code at the public `frontend-design` skill for taste-level guidance.
5. Optionally install `product-self-knowledge` if you'll touch API topics.

You'll be over-tooled if you install anything else. Restraint applies here as much as anywhere else in the project.

---

## Credit

Skill list by [YOUR NAME] and Claude.
