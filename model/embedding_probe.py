"""Can the property model double as a semantic embedding for Phase 5a?

Semantic gravity needs a notion of "these two words are related". The cheapest
possible answer is that the property model already contains one — it has a
48-unit word embedding and a 128-unit penultimate layer, both of which ship
already. If either separates related words usefully, semantic gravity costs
**zero extra bytes** against a property model that is already 483 KB.

This runs offline against the existing checkpoint, before any of Phase 5a is
designed, because the answer changes what Phase 5b has to build.

**There is a strong prior that this will fail, and it is worth stating before
looking at the numbers so the result cannot be rationalised afterwards.** Every
one of these representations is supervised *only* through six physical scores.
By the data-processing inequality the penultimate layer can carry no more about
a word than those six numbers do, so it should cluster words that *behave*
alike rather than words that *mean* alike. The prediction is that `grief` and
`boulder` come out as neighbours — both heavy, both grave — while remaining
semantically unrelated.

The test that decides it is not average cosine similarity, which is easy to
pass. It is whether a related pair outranks the physical coincidences:

    uv run --with torch python model/embedding_probe.py
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch

from data import AXES, Vocab, encode_chars
from train import CHECKPOINT, PropertyModel

# Pairs a person would call related. Deliberately a mix of kinds: near-synonyms,
# same-category words, and one metaphorical pair.
RELATED: list[tuple[str, str]] = [
    ("stone", "rock"),          # feel test 2's own pair
    ("ocean", "sea"),
    ("fire", "flame"),
    ("grief", "sorrow"),
    ("cold", "ice"),
    ("quiet", "silence"),
    ("river", "stream"),
    ("forest", "tree"),
    ("bird", "wing"),
    ("night", "dark"),
    ("laugh", "joy"),
    ("storm", "thunder"),
    ("cloth", "linen"),
    ("metal", "iron"),
    ("dust", "ash"),
]

# Pairs a person would call opposites. Semantic gravity is supposed to push
# these apart, so a representation that scores them *close* is worse than
# useless — it would actively pull antonyms together.
OPPOSED: list[tuple[str, str]] = [
    ("heavy", "light"),
    ("hot", "cold"),
    ("loud", "quiet"),
    ("ancient", "modern"),
    ("joy", "grief"),
    ("giant", "tiny"),
]

# Words to inspect by nearest neighbour. This listing is the real diagnostic —
# the aggregate numbers can look fine while the neighbours are nonsense.
PROBES = ["stone", "ocean", "fire", "grief", "feather", "silence", "forest", "iron"]


def representations(
    model: PropertyModel, vocab: Vocab, words: list[str]
) -> dict[str, torch.Tensor]:
    """Every candidate embedding for a list of words, in one forward pass.

    Returns word-lookup (48), penultimate hidden (128) and output scores (6).
    The hidden layer is captured with a forward hook rather than by rebuilding
    the forward pass, so it cannot silently drift from what the model does.
    """
    chars = torch.tensor([encode_chars(w) for w in words], dtype=torch.long)
    word_ids = torch.tensor([vocab.id_for(w) for w in words], dtype=torch.long)

    captured: dict[str, torch.Tensor] = {}

    # mlp is Linear, GELU, Linear, GELU, Linear — index 3 is the second GELU,
    # whose output is the 128-unit penultimate representation.
    def grab(_module, _inputs, output):
        captured["penultimate"] = output.detach()

    handle = model.mlp[3].register_forward_hook(grab)
    model.eval()
    with torch.no_grad():
        scores = model(chars, word_ids)
        word_vectors = model.word_embed(word_ids)
    handle.remove()

    return {
        "word-embed (48)": word_vectors,
        "penultimate (128)": captured["penultimate"],
        "scores (6)": scores,
    }


def cosine(matrix: torch.Tensor) -> torch.Tensor:
    """Pairwise cosine similarity over rows."""
    normed = matrix / matrix.norm(dim=1, keepdim=True).clamp(min=1e-8)
    return normed @ normed.T


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--neighbours", type=int, default=6)
    parser.add_argument(
        "--pool",
        type=int,
        default=4000,
        help="How many of the most frequent vocabulary words to rank against.",
    )
    args = parser.parse_args()

    vocab = Vocab.load()
    # The checkpoint wraps its weights and carries the vocab size it was built
    # with; trust that over the vocab file, so a mismatch fails loudly here
    # rather than silently mapping words to the wrong embedding rows.
    saved = torch.load(CHECKPOINT, map_location="cpu")
    model = PropertyModel(vocab_size=saved["vocab_size"])
    model.load_state_dict(saved["state_dict"])
    assert saved["vocab_size"] == vocab.size, (
        f"checkpoint was trained with {saved['vocab_size']} words, "
        f"vocab.json has {vocab.size}"
    )

    # Ids are contiguous from 1 in frequency order, so sorting by id recovers
    # the original ranking. A prefix is then the words a visitor is most likely
    # to type — ranking against the long tail would flatter the result with
    # words nobody will ever see.
    ordered = [w for w, _ in sorted(vocab.word_to_id.items(), key=lambda kv: kv[1])]
    pool = ordered[: args.pool]
    index = {w: i for i, w in enumerate(pool)}

    def known(pair: tuple[str, str]) -> bool:
        return pair[0] in index and pair[1] in index

    related = [p for p in RELATED if known(p)]
    opposed = [p for p in OPPOSED if known(p)]
    missing = [p for p in RELATED + OPPOSED if not known(p)]
    if missing:
        print(f"note: {len(missing)} test pairs outside the pool: {missing}\n")

    reps = representations(model, vocab, pool)

    print(f"Ranking against the {len(pool)} most frequent vocabulary words.\n")
    header = f"{'representation':<20}{'related':>9}{'opposed':>9}{'random':>9}{'sep':>7}{'MRR':>7}{'hit@10':>8}"
    print(header)
    print("-" * len(header))

    generator = torch.Generator().manual_seed(0)
    left = torch.randint(0, len(pool), (4000,), generator=generator)
    right = torch.randint(0, len(pool), (4000,), generator=generator)

    results = {}
    for name, matrix in reps.items():
        sim = cosine(matrix)

        related_sim = torch.tensor([sim[index[a], index[b]] for a, b in related])
        opposed_sim = torch.tensor([sim[index[a], index[b]] for a, b in opposed])
        random_sim = sim[left, right]

        # Where does a word's true partner rank among all candidates? This is
        # the number that matters: semantic gravity picks neighbours by
        # proximity, so what counts is the ranking, not the raw similarity.
        reciprocal_ranks = []
        hits = 0
        for a, b in related:
            row = sim[index[a]].clone()
            row[index[a]] = -2.0  # never rank a word against itself
            order = row.argsort(descending=True)
            rank = (order == index[b]).nonzero()[0, 0].item() + 1
            reciprocal_ranks.append(1.0 / rank)
            hits += 1 if rank <= 10 else 0

        mrr = sum(reciprocal_ranks) / len(reciprocal_ranks)
        hit10 = hits / len(related)
        separation = related_sim.mean().item() - random_sim.mean().item()
        results[name] = (mrr, hit10)

        print(
            f"{name:<20}{related_sim.mean():>9.3f}{opposed_sim.mean():>9.3f}"
            f"{random_sim.mean():>9.3f}{separation:>7.3f}{mrr:>7.3f}{hit10:>8.0%}"
        )

    print(
        "\nrelated/opposed/random are mean cosine similarity. sep is related minus"
        "\nrandom. MRR and hit@10 ask where a word's true partner ranks among all"
        f"\n{len(pool)} candidates — that is what semantic gravity would actually use."
    )

    print("\n\nNearest neighbours — the diagnostic the aggregates can hide.\n")
    for name, matrix in reps.items():
        sim = cosine(matrix)
        print(f"  {name}")
        for word in PROBES:
            if word not in index:
                continue
            row = sim[index[word]].clone()
            row[index[word]] = -2.0
            top = row.argsort(descending=True)[: args.neighbours]
            neighbours = ", ".join(pool[i] for i in top.tolist())
            print(f"    {word:<10} {neighbours}")
        print()

    print("Per-axis spread of each probe word, for reading the neighbours above:\n")
    probe_reps = representations(model, vocab, PROBES)
    print("    " + "word".ljust(12) + "  ".join(a[:4].rjust(6) for a in AXES))
    for word, row in zip(PROBES, probe_reps["scores (6)"]):
        print("    " + word.ljust(12) + "  ".join(f"{v:+.2f}".rjust(6) for v in row.tolist()))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
