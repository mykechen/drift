# Pilot run — notes and acceptance checklist

The prompt itself lives in `pilot-prompt.txt`, which is the paste-ready copy.
It is derived from `axes.md` — if the anchors change there, regenerate it.

```sh
pbcopy < model/pilot-prompt.txt   # macOS: straight to clipboard
```

Paste into Google AI Studio (aistudio.google.com) as a single message.

---

## Why these 24 words

Thirteen are the inspection list ROADMAP requires at the end of Phase 1b:
`boulder, feather, stone, silence, ember, whisper, hush, crimson, ancient,
scream, dust, ocean, glass`.

The other eleven are stress cases:

| Word | Tests |
| ---- | ------ |
| `memory`, `grief`, `verse`, `hollow` | Do abstract nouns get committed scores, or does everything hedge to 0.0? |
| `the` | A function word with no referent. Stands in for ~200 like it in the corpus. |
| `iron`, `velvet`, `salt`, `thread`, `mist`, `cathedral` | Concrete but not anchors — checks the ladder interpolates rather than pattern-matching. |

## Acceptance checklist

- **The boulder/feather gap.** These must be far apart on `mass` and `drag`. If
  they land within ~0.5 of each other, DESIGN.md feel test #1 fails before a
  line of physics exists, and the ladder needs sharpening. This one is
  disqualifying on its own.
- **`silence` and `hush` on intensity.** Both are ladder anchors and should come
  back near -1.0 and -0.9. If they do not, the ladder was not followed at all
  and nothing else in the run means anything.
- **Abstract words.** Did `memory`, `grief`, `verse`, `hollow` get real scores,
  or did they hedge to 0.0? Hedging means rule 1 is not landing and needs
  sharper wording.
- **`the`.** Whatever comes back is what every function word in the corpus will
  get. If it is nonsense, function words need explicit handling.
- **Spread.** Across 24 words × 6 axes, are the tails populated or is everything
  bunched near the middle? A rubric that only produces mid-range scores produces
  a room where every word falls identically.
- **`age`.** Real distribution, or mostly 0.0 outside the obvious cases? This is
  the evidence for the open question at the bottom of `axes.md`.
- **Axis independence.** Is `drag` just a copy of `mass` with the sign flipped?
  If the two correlate almost perfectly, the `arrow` anchor is not doing its job.
