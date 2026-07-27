# DESIGN.md — Drift

This document is the design and interaction specification for Drift. Every decision here has been made deliberately. Do not deviate from a specification in this file without asking. Small refinements — a spring constant felt slightly off, a shadow blur value that reads better a pixel wider — are welcome and expected; category changes are not.

---

## The piece, in one paragraph

A single off-white canvas. A quiet cursor you move anywhere in the frame. You type a word — it appears, floating at the cursor. You press space — it commits, becomes physical, falls, settles where you aimed it. The word's mass, drag, and behavior are inferred from what the word means. You can reach in and pick a word up, and it will be as heavy in your hand as it means to be. Related words drift toward each other. Rare words trigger small unexpected responses in the room. There is no UI, no menu, no explanation. The room accumulates until it fills, then it forgets its oldest words the way people do. You can save a still image or a shareable replay URL. Then you close the tab.

**The room's stillness is not a style. It is a reading.** A room of mountains is silent sediment and always will be; a room of clouds never quite settles. What the room feels like is what you put in it.

> **Changed in Phase 3.5.** This paragraph, and several sections below, previously argued for stillness as the piece's defining quality — and one shader comment stated outright that "the whole argument of the piece is stillness." That was true when stillness was a property of the *room*. It is not any more: `liveliness` is now a property of a *word*, derived from its mass and intensity, and it decides whether that word ever comes to rest. The claim has not been abandoned so much as demoted from premise to consequence, which is the same move the piece already makes with weight. See `docs/specs/2026-07-27-liveliness-and-touch.md` for the decision and its reasoning.
>
> This is not a licence to make the piece loud. The room is still quiet, still warm, still off-white, and a visitor who types heavy words should still get a silent page. What changed is that quiet is now something the room can *say*, rather than something it always is.

---

## Palette

All values final. Use exactly these hex codes.

| Role                     | Value          | Notes                                                   |
| ------------------------ | -------------- | ------------------------------------------------------- |
| Background               | `#F4F0E8`      | Warm off-white. Paper.                                  |
| Background grain         | procedural     | SDF noise, ~2% opacity, low frequency                   |
| Ink (default word)       | `#1A1817`      | Near-black, warm                                        |
| Ink (warmest word)       | `#3A2418`      | Deep warm brown, for words the model rates warmest      |
| Ink (coolest word)       | `#152838`      | Deep cool blue-black, for words the model rates coolest |
| Shadow                   | `#000000` @ 8% | Blur radius scales with mass                            |
| Accent (cursor only)     | `#D94F1E`      | Deep coral-red                                          |
| Special: color-word tint | word-dependent | See "Special Behaviors" below                           |

**Semantic tint mapping:** each word's `warmth` score interpolates between `#152838` and `#3A2418` through `#1A1817` (score = 0).

> **Changed in Phase 3.** The endpoints were originally reached at score ±1.0, and the effect was invisible for a reason that was in the data rather than the colours: measured over the 10,750 labelled words, **58% score |warmth| < 0.3 and only 5% exceed 0.6**, so nearly every word rendered within a hair of neutral and the two declared colours were decoration nothing ever touched. The endpoints are now reached at **±0.5**, roughly the p10–p90 spread of the real distribution. The colours are unchanged; what changed is that words arrive at them. The room still reads as broadly monochromatic — most words sit near neutral — but `marble` against `cedar` is now legible rather than theoretical.

**Time-of-day shift:** the background hue is offset over a 24-hour cycle keyed to the user's local time.

| Time                | Background shift                   | Ink shift                       |
| ------------------- | ---------------------------------- | ------------------------------- |
| Morning (6–10)      | +3° hue toward cool, +1% lightness | none                            |
| Midday (10–16)      | neutral (as-declared)              | none                            |
| Golden hour (16–19) | +6° hue toward warm, -1% lightness | +2° toward warm                 |
| Evening (19–22)     | +3° toward cool, -2% lightness     | slightly lifted from full black |
| Night (22–6)        | +4° toward cool, -3% lightness     | slightly lifted from full black |

Transitions between periods are 30-minute smoothstep interpolations. Compute at frame boundary; do not re-sample per frame.

---

## Typography

**Display type (word bodies):** Archivo by Omnibus-Type. Variable, `wght` and `wdth` axes both required. SIL Open Font License; the variable file is a **build input** in `/fonts/` and is never downloaded by a visitor — outlines are baked at build time.

> **Changed in Phase 2.** This originally specified Söhne Breit by Klim Type Foundry with variable weight and optical size. Klim ships Söhne — including Söhne Breit — as **static fonts only**: eight weights in roman and italic, no `wght` axis and no `opsz` axis. The variable-axis wiring below is load-bearing (`CLAUDE.md` calls it "the word IS the body" and says do not skip it), and a commit spring animating across eight discrete masters would pop rather than spring. Archivo is a grotesque in the same Akzidenz lineage with genuine designed masters across `wght 100–900` and `wdth 62–125`, and it is free, which removed the licensing question at the same time.

**UI / meta type (footer, credit line, watermark):** **IBM Plex Mono**, SIL OFL, subset to the ~75 characters the piece actually sets (3.8 KB woff2, `/public/fonts/`). Chosen in Phase 3. A system mono stack was the alternative and is free, but an exported still's watermark is drawn on the visitor's machine — a system stack would put a different typeface on every image that leaves the piece, and the watermark is the one part of the identity that travels.

**Fallback stack:** `ui-sans-serif, -apple-system, "SF Pro", "Inter", sans-serif` during font load. The first-load screen is intentionally still and quiet — the font swap should be imperceptible because there's nothing to compare against yet.

**Variable axis wiring:**

- `wght` (weight): mapped from `mass` property score. Range 300 → 800 across the mass range.
- `wdth` (width): mapped from `intensity` property score. Range 85 → 125. Higher intensity = wider = more visually assertive glyph shapes.
  - This replaces the original `opsz` mapping, whose stated intent was "tighter proportional metrics = more visually assertive glyph shapes" — which describes a width behaviour more than an optical-size one. Width also does more work here than optical size would: it changes the glyph silhouette substantially (`o` measures 306 units wide at `wdth 62` against 696 at `wdth 125`, at fixed height), so an intense word is a physically wider body, not just a differently-drawn one.
- Both axes animate on commit — the in-progress word renders at neutral values (`wght 500, wdth 100`), then springs to the model-predicted values in ~180ms with an overshoot spring.
- Outlines across axis values are point-compatible, so a word's collision geometry can be interpolated rather than re-decomposed every frame of that spring.

**No serifs anywhere.** No system fallback to a serif.

---

## Motion

Everything is a spring. Nothing is linear. Nothing is instant.

- **Default spring:** stiffness 220, damping 24, mass 1. Springy but settles.
- **Commit spring (word properties finalizing):** stiffness 180, damping 18, mass 1. More overshoot; makes commit feel decisive.
- **Physics-body movement:** Rapier handles this. No spring; it's real physics. But _rendering_ the physics state uses a 1-frame smoothing filter to hide sub-frame jitter.
- **Cursor pulse:** 2s cycle, sine wave, opacity 60% → 100%. Never off.
- **Word fade (aging out when room is full):** 2s ease-out, opacity + slight upward drift + weight tapering to 300 as it goes. Read: the word is being forgotten, not deleted.
- **Whole-scene fade (clear command):** 1.5s, all bodies fade in staggered ~30ms apart so the last words to fade are the newest — visual echo of the accumulation order in reverse.

- **The room's air (added Phase 3.5):** one shared, very-low-frequency field that crosses the room as a slow wave, phased by position rather than per word. How much of it a word feels is its `liveliness`; a word below the threshold feels none at all. It is applied mostly as a *torque*, so lively words rock gently in place rather than sliding — sliding a resting word means beating friction at roughly the strength of gravity, which is a gale rather than a breath, and a sustained lateral force on a pile makes it walk. The rocking is bounded by the righting torque's deadband, so a breathing word never becomes an unreadable one.
  - **This must stay at the edge of perception.** If you can see the motion *as motion* rather than as the room being inhabited, it is too strong. Feel test #6 exists to catch exactly that.

No parallax. No scroll-triggered anything.

> **Changed in Phase 2.** This section originally read "Nothing follows the mouse cursor (there is no mouse cursor to follow; the only cursor is the text caret)." The text caret now follows the mouse horizontally — see Camera and framing. The point it protected still holds: nothing in the *scene* parallaxes or drifts with the pointer, and there is no hover state. The mouse only aims where the next word lands.
>
> **Amended again in Phase 3.5.** The mouse now also *takes hold of* words — see "Touch" in the interaction spec. There is still no hover state and still no parallax; the scene does not respond to the pointer passing over it, only to the pointer closing on it.

---

## Camera and framing

- **2D side view.** Gravity is down. Down is down.
- **Fixed camera.** No pan, no zoom, no shake, no anything.
- **Frame IS the room.** No drawn floor, no drawn walls. Words settle against the bottom edge of the canvas. The frame boundaries are the physics boundaries. Left and right walls are the canvas edges. Top has no wall — new words spawn just above the top edge and fall in.
- **Aspect ratio:** viewport, but with a minimum 4:3 and maximum 16:9. Enforce via CSS on the canvas element.
- **Text cursor position: it follows the mouse in both axes.** The word being typed forms at the cursor, and on commit it is released from there and falls — so a word lands where you aimed it. This is how the room is composed: you place words by moving the cursor between them.
  - > **Changed in Phase 2.** Originally the cursor was "horizontally centered. Fixed." That made every word spawn at x=0 and stack in a single column. Harmless while rotation was locked (rigid words balance in a tower), but once words rotate freely a 1-D tower is unstable and never settles. A movable cursor gives the pile the horizontal spread it needs *and* turns placement into the composition mechanic. Cursor x is clamped so a word cannot spawn half-off the frame.
  - > **Changed again in Phase 3.5: the cursor moves vertically too.** A room composed along a line is a shelf rather than a space. There is **no vertical clamp beyond the frame margin** — placing low is *setting a word down* rather than dropping it, and that gesture is worth having. Feel test #1 is unaffected, because it drops both words from the same height, which is what anyone comparing two words does.
- **Safe zone around cursor: implemented in Phase 3.5, as a lift rather than a circle.** Before a word is released, the room finds the top of whatever already occupies that column and raises the release point clear of it.
  - **The asymmetry is the design.** `x` is the axis the visitor chose and is kept exactly; `y` is the axis the pile occupies and is the only one corrected. A circular exclusion would push the word sideways out of the column it was aimed at.
  - **The draft renders at the corrected height**, so the caret visibly climbs the sediment as the pointer sweeps across it. The visitor is shown where the word will land before committing it; a correction applied silently at commit would read as the word teleporting.
  - Necessary rather than optional once the cursor moves in y: aiming into a pile puts a compound body inside other compound bodies, and the solver's only answer is to eject one of them at speed.

---

## Sound

Subtle. Present. Never loud. Mutable via a small toggle in the footer (icon only, no text label needed). Sound is ON by default.

**Sound events:**

| Event                  | Sound                                                             | Design intent                                    |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| Keypress (letter)      | soft tick, ~1kHz, 15ms, -30dB                                     | Feels like a well-machined keyboard              |
| Backspace              | slightly duller tick, -32dB                                       | Distinct from letter                             |
| Commit (space/enter)   | small woody thud, 200Hz filter, 60ms decay                        | Marks the transition to physical                 |
| Body-to-body collision | short percussive tick, pitch varies with combined mass            | Rare — only above a collision velocity threshold |
| Body-to-floor landing  | soft thump, pitch varies with mass, subtle attack                 | The signature sound of the piece                 |
| Fade-out (word aging)  | gentle 500ms whisper of pink noise, -40dB                         | Barely audible                                   |
| Ambient bed            | very quiet room tone, ~-45dB, slight modulation with word density | Present but easy to miss                         |

The ambient bed is the piece's atmosphere. Get it right. Reference: the ambient bed under scenes in `Andor` when characters are just thinking.

**Never:**

- Musical tones. No arpeggios, no chords, no key-of-C-major fills.
- Voice, whispers, or samples of people.
- Any sound louder than -20dB peak.

---

## The interaction spec, exhaustively

### Typing state — no committed word yet

- Letters appear at the cursor position as you type. Rendered in Archivo at neutral variable-axis values (`wght: 500, wdth: 100`).
- Letters are NOT physics bodies yet. They are ordinary rendered text bound to the cursor.
- No shadow beneath in-progress letters.
- Backspace erases the last letter. If the word is empty, backspace is a no-op (small subtle shake to indicate).
- Only letters may be typed. Any other printable key shakes and is discarded.

### Commit (space or enter)

- The complete word becomes a single compound physics body.
- ML inference runs synchronously (must complete under 5ms) to get the 6 property scores.
- Variable axes animate to their target values with the commit spring.
- Shadow appears and blurs to its target radius.
- A tiny downward impulse is applied (do not rely on pure gravity from rest — feels indecisive).
- The commit sound plays.
- Input buffer clears; cursor is ready for the next word.

### Touch — grab and throw (added Phase 3.5)

The room was previously untouchable: the pointer aimed where the next word would land and could do nothing to the words already there. It can now pick them up.

- **Press** takes hold of the word under the pointer. The pick is forgiving — the nearest point on the nearest word, accepted within a small radius — because a glyph is mostly counters and gaps between letters, and a strict hit test would miss the middle of an `o`. There is no hover state and no cursor change to advertise this; discovery is the point, as it is with the special behaviors.
- **Drag** pulls the word by *the point you took hold of*, so a word held near one end hangs and swings from it rather than sliding rigidly under the pointer.
- **A word is as heavy in your hand as it means to be.** The pull is weaker for heavier words, so a feather whips around the pointer and a boulder heaves and lags well behind it. This is "the word IS the body" applied to the hand, and it is the most direct experience of the model the piece offers — the visitor feels the prediction rather than inferring it from a fall.
- **Release** simply lets go. The word keeps whatever speed it had gathered — nothing is added. A heavy word lagged behind your hand while you held it, so it also leaves your hand slower. **The lag is the weight.** Do not "improve" this by throwing at the pointer's own velocity; that flattens the one distinction the piece exists to make.
- A held word does not settle and cannot be crushed — the hand is the one place the visitor is in charge. It can still *crush*: a heavy word swung through a bed of light ones flattens them.
- Taking a word out of a pile wakes the sediment around it, so the pile falls into the space it leaves.

### Punctuation

**Changed in Phase 3: there is no punctuation.** Non-letter keys are refused at the *keystroke* — they never enter the buffer, and the caret shakes. You cannot type `hello,` at all.

The original rule preserved trailing punctuation in the glyph while stripping it before inference. It was coherent, but it sat oddly beside the word check below: if the room only accepts real words, admitting `hello,` as a word-plus-ornament is a second, softer standard. One rule — letters only — is easier to feel and needs no explanation.

### Numbers

- Digits are refused at the keystroke, like all non-letters. They never enter the buffer; the caret shakes.
- Rationale: this is a piece about language.

### Empty commits

- Space with an empty buffer: no-op. No sound. No visual feedback. Silence.

### Multi-space

- Multiple consecutive spaces after committing a word are absorbed silently.

### Word length limits

- Maximum 24 characters. Additional keystrokes past 24 are ignored with a subtle shake.

### Paste (Cmd/Ctrl+V)

- Disabled. `preventDefault` on paste events into the input.
- Rationale: this piece is about the pace of typing, not dumping text.

### Out-of-vocabulary words

- The character-level branch of the property model handles any word the model has not seen. **Never refuse a commit because the *model* hasn't seen the word** — that is what the branch is for, and it scores roughly 67,000 words outside the model's 10,749-word vocabulary.
- **Changed in Phase 3: a string that is not a word is refused.** The room checks a shipped lexicon (~78,000 words) before committing.

> The original rule made nonsense "a feature": `asdf` and `qwerty` were to get plausible-feeling properties, "usually light, drifty, unstable". Two things killed it. Measured in Phase 1c, `asdf` came out **warmth +0.66 and neutral mass** — not light and drifty, just arbitrary, because a word's physical feel is semantic rather than orthographic and there is nothing in those letters to read. And the piece's whole argument is that mass comes from meaning; a room where `asdfgh` lands with a weight contradicts its own premise.
>
> The refusal is a *shake with the word intact*, not a deletion — you can fix `asdfgh` into `ash` without retyping.

### Repeat words

- Allowed. Typing "stone stone stone" produces three stones with identical properties. They physically differ in position and history but are semantically identical bodies.

### Density management

- Soft cap: 200 active bodies.
- On commit of body #201, the oldest body begins its 2s fade-out.
- On body #202, the next-oldest starts fading, and so on.
- Automatic. Silent. No announcement to the user.

### Density-aware physics quality

- <100 bodies: 120Hz physics, all bodies awake by default until they sleep on their own.
- 100–200 bodies: 60Hz physics, more aggressive sleep thresholds.
- User should not perceive the switch.

### Clear (Cmd/Ctrl+K)

- Available only when there are 10 or more bodies in the room. Below that, keybind is a no-op.
- All bodies fade out staggered over 1.5s (newest last).
- No confirmation dialog.

### Focus / defocus

- Window blur pauses physics (no CPU burn in background).
- Window focus resumes with a small impulse applied to all sleeping bodies so they don't look frozen.
- Cursor pulse pauses on blur, resumes on focus.

### Save still image

- Trigger: keyboard shortcut Cmd/Ctrl+S, or a small icon in the footer.
- Renders the current canvas at 2× resolution to a PNG.
- Downloads immediately as `drift-YYYYMMDD-HHMMSS.png`.
- No modal. No settings. No confirmation.
- The exported PNG includes a small watermark in the bottom-right: `drift.[domain]` in the mono face at 10pt, 40% opacity.

### Session replay URL

- Trigger: keyboard shortcut Cmd/Ctrl+L, or a small icon in the footer next to the save-image icon.
- Encodes the sequence of committed words plus their commit timestamps into a URL fragment (`#`, not a query string — never send this data to a server).
- Encoding: base64url of a compact binary format (varint timestamps in ms, length-prefixed word strings). Fragment length limit ~2000 chars — beyond that, refuse and show a subtle inline message.
- Copies URL to clipboard, shows a small "copied" indicator that fades in 2s.
- On load, if a fragment is present, the room replays the word sequence with the original timings. During replay, input is disabled. When replay ends, input is re-enabled — the visitor can continue from that state.

### Mobile fallback

- Detect via viewport width < 768px OR touch-only.
- Show a full-viewport static image of an example composition, generated at build time.
- Below it, a single line in the mono face: `Drift is made for a keyboard. Come back on a desktop.`
- No back button. No dismiss. The mobile page IS the piece for that visitor.

---

## Special behaviors

The room reacts to a small number of specific word categories. These are NOT advertised anywhere. Discovery is the point. Cap at 6. More than that, the piece becomes a bag of tricks.

Ship exactly these six:

1. **Color words** (`crimson`, `azure`, `emerald`, `saffron`, etc. — curated list of ~40 in `/src/world/behaviors.ts`)
   - On commit, briefly tint the background toward the named color (~4% saturation for ~800ms, then fade back).
   - The tint should be _sensed_, not seen. If you can point at it in a screenshot, it's too strong.

2. **Onomatopoeia** (`hush`, `boom`, `whisper`, `crash`, `hum`, `crackle`, curated list)
   - `hush`, `whisper`, `mute`: everything within a radius slows to 20% velocity for 1.5s.
   - `boom`, `crash`, `bang`: radial impulse from the word's position.
   - `hum`, `drone`: ambient bed volume rises briefly.
   - `crackle`, `pop`: brief flurry of collision-tick sounds even without actual collisions.

3. **Weight words** (`heavy`, `light`, `feather`, `boulder`, `anchor`, `stone`)
   - The property model already handles their mass. The special behavior is an exaggerated commit shake — a heavier micro-thud on landing, felt but not obvious.

4. **Silence** (the word "silence" specifically)
   - Ambient bed drops to zero for 3 seconds. Only the physics thumps remain audible. Fades back in.
   - The most heavy-handed special behavior. Reserve it for this one word.

5. **Ancient / archaic words** (a curated list of ~30: `whence`, `hither`, `alack`, `zounds`, etc.)
   - Commit with a slightly slower spring and a subtle sepia tint on the glyph itself for 2s before settling to the normal palette.
   - "This word is old" made physical.

6. **Words with holes as glyphs** (containing `o`, `p`, `d`, `g`, `q`, `e`, `a`, `b`)
   - Not really a "special behavior" — but ensure the convex decomposition is correct for these glyphs. They will misbehave without it.
   - Include this as a category so it's tested explicitly.

Do not add a seventh. If a great one occurs to you, replace one of these — do not extend.

### Physics expression (added Phase 2)

These are **not** special behaviors — there is no per-word script and no curated
list. They are emergent consequences of the mass/restitution model, so they do
not count against the cap of six above. Documented here because they materially
change how the room behaves.

- **Bounce is loud.** A word's `restitution` really launches it — `ball` and
  `rubber` leap and hop several times; `rock` and `boulder` thud dead. Bouncy
  words also shed most of their fall-damping so a light bouncy word can actually
  soar instead of being smothered by its own drift-drag.
- **Leaf drift.** Very light words (`feather`, `mist`, `cloud`) flutter sideways
  as they fall, wandering down like a leaf, then settle. Heavy words drop
  straight. Because light words no longer stack in tidy columns, this also shapes
  where they come to rest.
- **Liveliness (added Phase 3.5).** *How restless a word is* is a property like
  its mass, derived from lightness with intensity as a signed modifier:
  `(1 − mass)/2 + intensity × 0.25`. Above a threshold a word **never comes to
  rest at all** and keeps answering to the room's air for the whole session;
  below it, a word settles and turns to sediment, and the heavier it is the
  faster it does so — `mountain` in a few hundred milliseconds, `stone` in a
  couple of seconds.
  - The intensity term is what makes this more than a restatement of mass, and
    two words earn it: `silence`, light but held still by what it means, and
    `thunder`, heavy but never quite stone.
  - This replaces a flat rule that turned every word to stone on the same
    schedule. That rule existed for a performance reason which measurement
    later retired — see `docs/build-log.md` — and a mechanic that survives its
    own justification should become a semantic rule or be deleted, not kept out
    of habit.

- **Crush.** A heavy word landing flattens the much-lighter words *within a
  radius* of where it lands — meaning with weight obliterating meaning without —
  and they squash thin and fade (~0.3s). The radius grows with the striker's
  weight (`mountain` clears a wide crater, `stone` only its neighbours). Only
  genuine heavyweights crush, only words lighter by a wide margin are crushed
  (`boulder` never crushes `rock`), and only a *landing* word crushes — a resting
  one does not. This is a second clearing path alongside the density fade: the
  fade forgets the *oldest*, the crush clears *where you aim weight*. It is
  deletion rather than forgetting, deliberately — the one violent gesture in a
  quiet room, earned because it is the mass premise made physical.

---

## Feel targets

These are the tests the piece must pass. If any of them fail, the piece is not shipped, regardless of how polished the code is.

1. **The boulder-feather test.** Type `boulder`. Type `feather`. The boulder must be visibly, undeniably heavier — in fall speed, in landing behavior, in shadow, in rendered weight. A first-time viewer must feel this within 5 seconds without being told.

2. **The stone-rock test.** Type `stone`. Wait 3 seconds. Type `rock`. `rock` must visibly drift toward `stone` after landing. Semantic gravity is real.

3. **The 90-second test.** Sit down and use the piece for 90 seconds. Do you want to keep going at 90? If the answer is "not really," something is wrong. This test catches the failure mode where the piece is beautiful for 30s and boring by 60s.

4. **The screenshot test.** Fill the room over 2 minutes. Take a still export. Look at it the next morning cold. Is it a composition you'd hang on a wall? If not, something is wrong with the palette, the typography, or the density mechanics.

5. **The no-instructions test.** Give the URL to someone who has not used the piece and say nothing. Watch them. Do they figure out that typing works? Do they figure out that space commits? If not, the empty canvas needs a slightly stronger initial affordance — but only slightly. Do not add tutorial text.

6. **The breathing test.** *(Added Phase 3.5.)* Record 30 seconds of a room that has already settled. Watch it cold. Does it read as **breathing, or as jitter**? If you notice the motion *as motion* — if your eye is caught by a word twitching rather than by the room being inhabited — it is too strong.
   - This is feel test #4's sibling and it exists because #4 no longer covers what the piece does. A still cannot fail a room for moving badly, and a moving room cannot be judged by a frame. The piece must survive **both**: a composition worth keeping, *and* motion you do not consciously see.
   - The two tests pull in opposite directions on purpose. That tension is the register the piece is aiming at, and anything that passes one by failing the other is not finished.

Record 30-second screen captures during development. Watch them cold. This is the highest-leverage QA practice on this project.

---

## The room has weather

The time-of-day shift IS the weather. It should be so subtle that 90% of visitors never consciously notice it, but a returning visitor will feel that the room is different without being able to say why. This is a deliberate design choice. Do not compensate for its subtlety by making it louder.

---

## Credit

Piece by [YOUR NAME]. Design specification maintained by [YOUR NAME] and Claude.
