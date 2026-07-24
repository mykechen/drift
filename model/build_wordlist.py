"""Build the candidate word list for labeling.

Source is `wordfreq`, which ranks English words by frequency aggregated across
books, subtitles, news, and Wikipedia. Frequency order matters: the property
model memorises the top ~20k words in its lookup table and everything else
falls through to the character branch, so the list must be ordered by how
likely a visitor is to actually type the word.

Usage:
    uv run --with wordfreq python model/build_wordlist.py --target 25000
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

from wordfreq import top_n_list, zipf_frequency

DATA_DIR = Path(__file__).parent / "data"
BLOCKLIST_PATH = DATA_DIR / "blocklist.txt"
CURATED_PATH = DATA_DIR / "curated.txt"

# DESIGN.md rejects any word containing a digit and caps commits at 24
# characters, so labeling those would be wasted spend.
MAX_LENGTH = 24
ALPHABETIC = re.compile(r"^[a-z]+$")

# The only single letters that are words. Every other one-character entry in a
# frequency list is corpus noise.
SINGLE_LETTER_WORDS = {"a", "i"}

# Frequency-list residue: markup, protocol fragments, and roman numerals that
# survive tokenisation but are not words anyone types at a piece like this.
JUNK = {"www", "http", "https", "com", "org", "net", "html", "px", "amp"}
ROMAN_NUMERAL = re.compile(r"^(?=[ivxlcdm]+$)m*(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$")


def load_blocklist() -> set[str]:
    """Words to exclude by hand. Absent by default; one word per line.

    Worth populating before the bulk run: this repo is public, and a committed
    dataset scoring slurs on `warmth` is not something to discover later. The
    piece still accepts any typed string at runtime via the character branch —
    this only controls what gets labeled and checked in.
    """
    if not BLOCKLIST_PATH.exists():
        return set()
    lines = BLOCKLIST_PATH.read_text(encoding="utf-8").splitlines()
    return {w.strip().lower() for w in lines if w.strip() and not w.startswith("#")}


def is_usable(word: str, blocklist: set[str]) -> bool:
    if not ALPHABETIC.match(word):
        return False
    if len(word) > MAX_LENGTH:
        return False
    if len(word) == 1 and word not in SINGLE_LETTER_WORDS:
        return False
    if word in JUNK or word in blocklist:
        return False
    # `i`, `mix`, and `did` are real words that happen to be valid numerals;
    # only reject numerals that are not also ordinary vocabulary.
    if len(word) > 1 and ROMAN_NUMERAL.match(word) and word not in {"mix", "did", "dim", "mild"}:
        return False
    return True


def load_curated() -> list[str]:
    """Vocabulary that is labeled regardless of how rare it is.

    Frequency ranking drops words the piece is built around — `ember` is rank
    30,019 and sits in the OG image, and DESIGN.md's archaic behavior needs
    words like `zounds` at rank 151,613. For those, rarity is the point.
    """
    if not CURATED_PATH.exists():
        return []
    lines = CURATED_PATH.read_text(encoding="utf-8").splitlines()
    return [w.strip().lower() for w in lines if w.strip() and not w.startswith("#")]


def build(target: int, pool_multiplier: int = 3) -> list[tuple[str, float, str]]:
    """Return the labeling corpus: top-`target` by frequency, plus curated.

    Rows are `(word, zipf, source)` ordered by descending frequency. Curated
    words that already appear in the frequency head are marked `both`, so the
    output shows how much the curated list actually rescued.
    """
    blocklist = load_blocklist()
    curated = [w for w in load_curated() if is_usable(w, blocklist)]
    curated_set = set(curated)

    kept: list[str] = []
    for word in top_n_list("en", target * pool_multiplier):
        if is_usable(word, blocklist):
            kept.append(word)
        if len(kept) == target:
            break

    if len(kept) < target:
        print(
            f"warning: only {len(kept)} usable words from the frequency pool; "
            f"raise --pool-multiplier",
            file=sys.stderr,
        )

    frequency_set = set(kept)
    rescued = [w for w in curated if w not in frequency_set]

    rows = [
        (w, round(zipf_frequency(w, "en"), 3), "both" if w in curated_set else "frequency")
        for w in kept
    ] + [(w, round(zipf_frequency(w, "en"), 3), "curated") for w in rescued]

    rows.sort(key=lambda row: -row[1])
    print(f"  frequency head: {len(kept)}   curated rescued: {len(rescued)}")
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", type=int, default=25_000, help="how many words to keep")
    parser.add_argument("--pool-multiplier", type=int, default=3, help="oversample factor before filtering")
    parser.add_argument("--out", type=Path, default=DATA_DIR / "wordlist.csv")
    args = parser.parse_args()

    words = build(args.target, args.pool_multiplier)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["rank", "word", "zipf", "source"])
        for rank, (word, zipf, source) in enumerate(words, start=1):
            writer.writerow([rank, word, zipf, source])

    print(f"wrote {len(words)} words to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
