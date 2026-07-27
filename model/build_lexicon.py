"""Build the lexicon: the set of strings Drift will accept as words.

Run with `pnpm bake:lexicon`. Not to be confused with `build_wordlist.py`, which
picks *candidates for labeling*; this decides what a visitor is allowed to type.

Why this exists
---------------
Until Phase 3 the piece committed any string at all, on the principle that the
property model's character branch produces plausible values for anything. That
principle turned out to be half right. The branch is good at *real words the
model has not seen* — `gloaming`, `spindrift`, `tarn` — and bad at strings with
no meaning to read, because a word's physical feel is semantic rather than
orthographic. Measured, `asdf` came out at warmth +0.66, which is the model
inventing a feeling for a string that has none.

So the two jobs are split. This list answers "is this a word?"; the character
branch answers "what does it feel like?". The model knows 10,749 words and this
list allows ~78,000, so the branch still scores roughly 67,000 words the model
has never seen — the split gives it a clearer job rather than removing it.

Why two sources, intersected
----------------------------
Neither alone works, and each fails in the opposite direction.

A **frequency list** ranks `asdf`, `wasd` and `qwerty` above `gloaming`, because
keyboard mashing is common on the web. Growing it to catch rare real words lets
in *more* mashing, not less — measured, the top 250k admits `asdf` and `wasd`
while still missing `brume`.

A **lexicon** alone has the opposite problem: 370k entries, 867 KB compressed,
overwhelmingly obscure inflections nobody will ever type.

Requiring both — a real dictionary word that is also not vanishingly rare — cuts
to ~78k words and ~157 KB, admits **zero** of fourteen mashing probes, and still
accepts `gloaming`, `tarn`, `scree`, `lichen` and `estuary`.

The model's own vocabulary and the curated demo list are unioned in
unconditionally. Every word the model was trained on must be committable by
definition, and `model/data/curated.txt` carries the archaic words (`zounds`,
`alack`) that DESIGN.md's ancient-words behaviour is built on — a frequency list
will never contain those.
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

from wordfreq import top_n_list

ROOT = Path(__file__).resolve().parent.parent
LEXICON_CACHE = ROOT / "model" / "data" / "words_alpha.txt"
LEXICON_URL = (
    "https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt"
)
VOCAB = ROOT / "src" / "ml" / "models" / "properties.v1.vocab.txt"
CURATED = ROOT / "model" / "data" / "curated.txt"
OUTPUT = ROOT / "src" / "ml" / "lexicon.v1.txt"

# Where the sweet spot landed. Below this, `gloaming`, `spindrift` and `ossuary`
# start dropping out; above it the only additions are words like `quern` and
# `brume` that nobody types, at roughly 50 KB apiece.
FREQUENCY_RANK = 150_000

# DESIGN.md's cap. Anything longer cannot be committed anyway, so shipping it
# would be paying for rows that can never match.
MAX_WORD_LENGTH = 24


def load_lines(path: Path) -> set[str]:
    return {
        line.strip().lower() for line in path.read_text().splitlines() if line.strip()
    }


def main() -> None:
    if not LEXICON_CACHE.exists():
        print(f"fetching lexicon -> {LEXICON_CACHE.relative_to(ROOT)}")
        LEXICON_CACHE.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(LEXICON_URL, LEXICON_CACHE)

    lexicon = load_lines(LEXICON_CACHE)
    frequent = {w for w in top_n_list("en", FREQUENCY_RANK) if w.isalpha()}
    vocab = load_lines(VOCAB)
    curated = load_lines(CURATED)

    accepted = (lexicon & frequent) | vocab | curated
    accepted = {w for w in accepted if w.isalpha() and 1 <= len(w) <= MAX_WORD_LENGTH}

    # A guard, not a report. Both directions are failures: far fewer words means
    # a source failed to load and the piece would start refusing ordinary
    # language; far more means the intersection silently stopped intersecting
    # and the mashing filter is gone.
    if not 60_000 <= len(accepted) <= 95_000:
        sys.exit(
            f"refusing to write: {len(accepted)} words is outside the expected "
            f"60k-95k band. Check that both sources loaded."
        )

    # Sorted so the file is stable across runs and compresses well — brotli does
    # far better on sorted text, where neighbouring lines share prefixes.
    body = "\n".join(sorted(accepted)) + "\n"
    OUTPUT.write_text(body)

    print(
        f"lexicon {len(lexicon)} ∩ top-{FREQUENCY_RANK} ({len(frequent)}) "
        f"∪ vocab {len(vocab)} ∪ curated {len(curated)}"
    )
    print(
        f"wrote {OUTPUT.relative_to(ROOT)} — {len(accepted)} words, "
        f"{len(body) / 1024:.1f} KB raw"
    )


if __name__ == "__main__":
    main()
