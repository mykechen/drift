"""Dataset loading, tokenization, and the train/val split for the property model.

The model has two input branches, mirroring the ROADMAP design:

- a word-lookup branch that memorises words seen during training, and
- a character branch that generalises to anything else, so nonsense strings
  still produce plausible properties instead of a refusal.

Vocabulary and the split are derived deterministically from dataset.csv, so a
checkpoint's inputs can always be reconstructed.
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from pathlib import Path

import torch
from torch.utils.data import Dataset

DATA_DIR = Path(__file__).parent / "data"
DATASET_CSV = DATA_DIR / "dataset.csv"
VOCAB_JSON = DATA_DIR / "vocab.json"

AXES = ["mass", "drag", "restitution", "warmth", "age", "intensity"]

# DESIGN.md caps a committed word at 24 characters, so the character branch
# never needs to encode more than that.
MAX_WORD_LEN = 24

# Character token ids. 0 is reserved for padding so it can be masked in the
# mean-pool; 1 for any character outside a-z (the corpus is a-z only, but a
# runtime OOV string may not be).
PAD_ID = 0
OOV_CHAR_ID = 1
FIRST_LETTER_ID = 2  # 'a'
CHAR_VOCAB_SIZE = FIRST_LETTER_ID + 26

# Word-lookup id 0 is the out-of-vocabulary slot: every word absent from the
# training set maps here, which is also what any runtime word hits.
WORD_UNK_ID = 0


def encode_chars(word: str) -> list[int]:
    """Map a word to a fixed-length list of character token ids, right-padded."""
    ids = []
    for char in word[:MAX_WORD_LEN]:
        offset = ord(char) - ord("a")
        ids.append(FIRST_LETTER_ID + offset if 0 <= offset < 26 else OOV_CHAR_ID)
    ids += [PAD_ID] * (MAX_WORD_LEN - len(ids))
    return ids


@dataclass
class Vocab:
    """Maps words to lookup-branch ids. Persisted so inference matches training."""

    word_to_id: dict[str, int]

    @property
    def size(self) -> int:
        # +1 because id 0 is the shared unknown slot, not in word_to_id.
        return len(self.word_to_id) + 1

    def id_for(self, word: str) -> int:
        return self.word_to_id.get(word, WORD_UNK_ID)

    def save(self, path: Path = VOCAB_JSON) -> None:
        path.write_text(json.dumps({"word_to_id": self.word_to_id}), encoding="utf-8")

    @classmethod
    def load(cls, path: Path = VOCAB_JSON) -> "Vocab":
        return cls(**json.loads(path.read_text(encoding="utf-8")))


def load_rows(path: Path = DATASET_CSV) -> list[tuple[str, list[float]]]:
    with path.open(encoding="utf-8") as handle:
        return [
            (row["word"], [float(row[axis]) for axis in AXES])
            for row in csv.DictReader(handle)
        ]


def _split_index(word: str, val_fraction: float) -> bool:
    """Deterministic held-out membership, stable across runs and machines.

    Hashing the word rather than shuffling means the same word is always in the
    same split regardless of row order or a random seed, so eval numbers are
    comparable between training runs.
    """
    bucket = (hash(word) & 0xFFFFFFFF) / 0xFFFFFFFF
    return bucket < val_fraction


class WordPropertyDataset(Dataset):
    """Char ids, a word-lookup id, and the six target scores per word."""

    def __init__(self, rows: list[tuple[str, list[float]]], vocab: Vocab):
        self.rows = rows
        self.vocab = vocab

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> dict[str, torch.Tensor]:
        word, scores = self.rows[index]
        return {
            "chars": torch.tensor(encode_chars(word), dtype=torch.long),
            "word_id": torch.tensor(self.vocab.id_for(word), dtype=torch.long),
            "target": torch.tensor(scores, dtype=torch.float32),
        }


def build_datasets(
    val_fraction: float = 0.1,
    path: Path = DATASET_CSV,
) -> tuple[WordPropertyDataset, WordPropertyDataset, Vocab]:
    """Load the CSV, split it, and build the vocab from the training words only.

    The vocab is built from training words only so a validation word is a
    genuine word-branch miss — it exercises the character branch at eval time,
    which is the behaviour that matters for runtime OOV words.
    """
    rows = load_rows(path)
    train_rows = [r for r in rows if not _split_index(r[0], val_fraction)]
    val_rows = [r for r in rows if _split_index(r[0], val_fraction)]

    word_to_id = {word: i + 1 for i, (word, _) in enumerate(train_rows)}
    vocab = Vocab(word_to_id)

    return (
        WordPropertyDataset(train_rows, vocab),
        WordPropertyDataset(val_rows, vocab),
        vocab,
    )
