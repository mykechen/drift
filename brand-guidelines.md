# brand-guidelines.md — Drift

The identity for **Drift**. This document covers how the piece names itself, presents itself, gets shared, and speaks in the very small number of places it uses words.

---

## Name

**Drift.**

- Always lowercase in body text and in the piece itself: `drift`.
- Capitalized only at the start of a sentence, or in title-case contexts (URLs, filenames, OS window titles): `Drift`.
- Never stylized: no all-caps, no periods, no unusual spacing, no diacritics.
- No tagline. If you have to write a subtitle, the correct subtitle is nothing.
- If a subtitle is unavoidable in a technical context (a meta description, an OG image caption), use exactly: _a room of language._
- Never abbreviate. Never call it "the app" or "the site" in copy.

---

## What Drift is

A piece where typed words become physical objects, given weight and behavior by what they mean.

That sentence is the canonical description. Use it verbatim in any place that needs a one-liner.

## What Drift is not

- A tool. Do not describe features. Do not use the word "feature."
- A game. Do not describe goals, levels, wins.
- A demo. Do not describe technology in user-facing copy.
- A studio, brand, or product line. Drift is one piece. Not the start of a series in its own copy.

If a piece of copy makes Drift sound like any of these, it is wrong.

---

## Voice

Where copy exists (there is almost none), it is quiet, plainspoken, and short.

**Do:**

- Use short sentences.
- Use concrete words.
- Trust the reader.
- Under-explain.

**Don't:**

- Marketing verbs: _unleash_, _reimagine_, _reinvent_, _transform_, _empower_.
- Adjectives that are compliments to the piece: _beautiful_, _stunning_, _innovative_, _cutting-edge_.
- Emoji.
- Exclamation points.
- Em-dashes at the start of sentences.
- The words _experience_, _journey_, _playground_, _canvas_, _space_.
- Any language that hedges: _sort of_, _kind of_, _a bit of a_.

**Reference:** Muji's product copy. Klim's font specimen books. The wall text at a well-curated museum.

---

## Places copy appears

In descending order of visibility. Every string that exists on this site should be listed here.

### 1. The `<title>` tag

`Drift`

That's it. No dash, no separator, no "— a room of language."

### 2. The meta description

`A piece where typed words become physical objects, given weight and behavior by what they mean. By [YOUR NAME].`

### 3. The OG image caption

`drift`

Set in Söhne Breit at a large size, off-white background, near-black ink. Nothing else on the OG image except a small watermark and one hero composition. See "OG image" below.

### 4. The footer of the piece

Three items, evenly spaced, in Söhne Mono at 11pt, `#1A1817` at 60% opacity:

- `drift`
- Icons (from left): sound toggle, save image, copy replay URL
- `[YOUR NAME] · GitHub`

The right-hand item's `GitHub` is a link. The name is not a link. If you want it linked, decide later.

### 5. Mobile fallback

`Drift is made for a keyboard. Come back on a desktop.`

Söhne Mono, centered under a static composition image.

### 6. The 404 page

A minimal 404 with the same background and typography. Text:

`This page does not exist. Try drift.[domain].`

### 7. README.md (public GitHub)

One paragraph. See `README.md` template.

**Every other string on the site is a violation.** No tooltips, no help text, no about page, no error messages surfaced to the user, no cookie banner (there are no cookies), no "made with love" line, no year.

---

## OG image

The single most important marketing surface. This is what appears when the link is shared anywhere.

- **Dimensions:** 1200 × 630 px
- **Background:** `#F4F0E8` with the standard procedural grain
- **Composition:** a hand-designed still of an ideal Drift room — approximately 25–40 words settled naturally, chosen for beauty. The word `drift` itself set larger than the others, near the visual center of the composition but not exactly centered. Suggested corpus for the OG image: _stone, feather, weather, silence, ember, cloud, salt, memory, hush, crimson, verse, echo, moss, thread, tide, quiet, ash, hollow, glass, morning, whisper, cinder, hollow, grain, drift_.
- **Watermark:** bottom-right, `drift.[domain]` in Söhne Mono 12pt, `#1A1817` at 40% opacity, 24px margin from both edges.
- **No other text.** No "portfolio piece," no "by [YOUR NAME]," no tagline.
- **File:** `/public/og.png`. Static. Regenerated when the visual design of the piece is updated.

Twitter card uses the same image with `summary_large_image` card type.

---

## Favicon

- SVG. A single filled circle of ink (`#1A1817`) at 60% of the SVG's bounding box, on a transparent background. Nothing else.
- Fallback ICO at 32×32 for older browsers, same content.

Not a "D." Not a Söhne Breit letterform. Just the circle. The circle reads as a body, a full stop, a period, a sediment particle — many things. Ambiguity is the design.

---

## Domain

To be chosen. Preferred candidates in order:

1. `drift.computer`
2. `drift.works`
3. `drift.lol`
4. `[yourdomain]/drift` if you already have a personal domain and want to house it under there
5. A short new `.com` only if the first three are all unavailable and you have $50 to spend on a domain

Do not pay for premium `.com` variants. The audience will find it either way.

---

## When people share the piece

If someone posts about Drift and asks how to describe it, the canonical text is:

_A piece where typed words become physical objects, given weight and behavior by what they mean. Type a word and it falls in. Related words drift toward each other. Rare words do rare things._

That's three sentences, ~35 words. Reuse this if you post about the piece yourself. If you shorten it, shorten it to the first sentence alone.

Do not describe the ML. Do not describe the tech stack. Do not describe how long it took. Let people discover the depth themselves.

---

## What the piece is trying to do

Not for public copy. For internal alignment.

Drift makes an argument that meaning has weight. It uses interaction, physics, typography, and a small trained model to make that argument in a way you can feel in ten seconds and think about for ten minutes. It is not a product. It is a small piece of work made carefully by one person, and its job is to reward attention.

If a decision — copy, design, engineering, launch — moves the piece away from that, the decision is wrong.

---

## Credit

Drift is by [YOUR NAME]. Identity guidelines maintained by [YOUR NAME].
