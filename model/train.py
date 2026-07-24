"""Train the property model: word -> six semantic scores in [-1, 1].

Two branches per the ROADMAP design. A word-lookup embedding memorises words
seen in training; a character branch mean-pools letter embeddings so any string
— including nonsense — still produces plausible scores. The two representations
are concatenated and passed through a small MLP.

Overfitting is expected and fine: this is mostly a memorisation problem, and
genuinely unseen words fall through to the character branch at runtime anyway.

    uv run --with torch python model/train.py
    uv run --with torch python model/train.py --epochs 300 --predict boulder feather asdf
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import DataLoader

from data import (
    AXES,
    CHAR_VOCAB_SIZE,
    PAD_ID,
    Vocab,
    build_datasets,
    encode_chars,
)

CHECKPOINT = Path(__file__).parent / "data" / "properties.pt"


class PropertyModel(nn.Module):
    """Char branch + word-lookup branch -> MLP -> 6 scores in [-1, 1].

    The word-lookup branch memorises every word in the training set — this is
    where the accuracy lives, and it is the whole point of the piece: a boulder
    is heavy because the model was told so, not because it inferred it.

    The character branch mean-pools letter embeddings, giving any string a
    representation even when the word branch has never seen it. A stronger,
    order-aware char encoder (a GRU was tried) does not help and in fact hurts:
    a word's physical feel is semantic, not orthographic — nothing in the
    letters of "grief" says heavy — so extra capacity just overfits training
    spellings and generalises worse. The mean-pool's tendency to fall back
    toward neutral-light for unknown strings matches DESIGN.md's brief that
    nonsense should feel "light, drifty, unstable."
    """

    def __init__(
        self,
        vocab_size: int,
        char_dim: int = 32,
        word_dim: int = 48,
        hidden: tuple[int, int] = (256, 128),
    ):
        super().__init__()
        self.char_embed = nn.Embedding(CHAR_VOCAB_SIZE, char_dim, padding_idx=PAD_ID)
        self.word_embed = nn.Embedding(vocab_size, word_dim)

        h1, h2 = hidden
        self.mlp = nn.Sequential(
            nn.Linear(char_dim + word_dim, h1),
            nn.GELU(),
            nn.Linear(h1, h2),
            nn.GELU(),
            nn.Linear(h2, len(AXES)),
        )

    def forward(self, chars: torch.Tensor, word_id: torch.Tensor) -> torch.Tensor:
        # Mean-pool character embeddings, ignoring padding so short words are
        # not diluted toward zero by their pad slots.
        mask = (chars != PAD_ID).unsqueeze(-1).float()
        char_vectors = self.char_embed(chars) * mask
        char_repr = char_vectors.sum(dim=1) / mask.sum(dim=1).clamp(min=1.0)

        word_repr = self.word_embed(word_id)

        combined = torch.cat([char_repr, word_repr], dim=-1)
        # tanh gives the [-1, 1] range the axes are defined on directly.
        return torch.tanh(self.mlp(combined))


def evaluate(model: nn.Module, loader: DataLoader, device: torch.device) -> tuple[float, list[float]]:
    """Return overall MAE and per-axis MAE on a loader."""
    model.eval()
    abs_error = torch.zeros(len(AXES))
    count = 0
    with torch.no_grad():
        for batch in loader:
            pred = model(batch["chars"].to(device), batch["word_id"].to(device)).cpu()
            abs_error += (pred - batch["target"]).abs().sum(dim=0)
            count += pred.shape[0]
    per_axis = (abs_error / count).tolist()
    return sum(per_axis) / len(per_axis), per_axis


def predict(model: nn.Module, vocab: Vocab, words: list[str], device: torch.device) -> None:
    model.eval()
    chars = torch.tensor([encode_chars(w.lower()) for w in words], dtype=torch.long)
    word_ids = torch.tensor([vocab.id_for(w.lower()) for w in words], dtype=torch.long)
    with torch.no_grad():
        preds = model(chars.to(device), word_ids.to(device)).cpu()

    header = "word".ljust(14) + "  ".join(a[:4].rjust(5) for a in AXES) + "   branch"
    print("\n" + header)
    print("-" * len(header))
    for word, row in zip(words, preds):
        seen = "word" if vocab.id_for(word.lower()) != 0 else "char"
        scores = "  ".join(f"{v:+.2f}" for v in row.tolist())
        print(f"{word.lower().ljust(14)}{scores}   {seen}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--epochs", type=int, default=200)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--lr", type=float, default=2e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-5)
    parser.add_argument("--val-fraction", type=float, default=0.1)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--predict", nargs="*", default=["boulder", "feather", "stone", "silence", "ember", "asdf"])
    parser.add_argument(
        "--ship",
        action="store_true",
        help="train on every labeled word (no held-out split) for the deployed checkpoint; "
        "every dataset word is then memorised by the word branch, as it ships",
    )
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # In ship mode there is no holdout: the deployed model memorises every
    # labeled word. The held-out split exists only to measure how the character
    # branch generalises to words outside the dataset — a diagnostic, not the
    # shipping configuration.
    val_fraction = 0.0 if args.ship else args.val_fraction
    train_ds, val_ds, vocab = build_datasets(val_fraction)
    print(f"train {len(train_ds)}  val {len(val_ds)}  vocab {vocab.size}  device {device}")

    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=512)

    model = PropertyModel(vocab.size).to(device)
    params = sum(p.numel() for p in model.parameters())
    print(f"parameters: {params:,}")

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    loss_fn = nn.MSELoss()

    best_val = float("inf")
    for epoch in range(1, args.epochs + 1):
        model.train()
        for batch in train_loader:
            optimizer.zero_grad()
            pred = model(batch["chars"].to(device), batch["word_id"].to(device))
            loss = loss_fn(pred, batch["target"].to(device))
            loss.backward()
            optimizer.step()

        if epoch % 20 == 0 or epoch == args.epochs:
            train_mae, _ = evaluate(model, train_loader, device)
            if len(val_ds) > 0:
                val_mae, per_axis = evaluate(model, val_loader, device)
                best_val = min(best_val, val_mae)
                axes_str = " ".join(f"{a[:3]} {m:.2f}" for a, m in zip(AXES, per_axis))
                print(f"epoch {epoch:3d}  train MAE {train_mae:.3f}  val MAE {val_mae:.3f}  [{axes_str}]")
            else:
                print(f"epoch {epoch:3d}  train MAE {train_mae:.3f}  (ship mode, no holdout)")

    torch.save({"state_dict": model.state_dict(), "vocab_size": vocab.size}, CHECKPOINT)
    vocab.save()
    print(f"\nsaved checkpoint to {CHECKPOINT}")
    print(f"best val MAE {best_val:.3f}  (target < 0.15)")

    predict(model, vocab, args.predict, device)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
