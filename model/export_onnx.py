"""Export the trained property model to ONNX, quantize it, and prove it survived.

Three jobs in one script, because the middle one is only safe if the third runs:

1. Export `properties.pt` to ONNX. The graph is deliberately pure arithmetic —
   two integer tensors in, one float tensor out. Word-to-id lookup stays in
   JavaScript. A graph with no string ops is the one that quantizes cleanly and
   that every ONNX Runtime Web backend can execute.
2. Quantize the weights to int8. Roughly 90% of this model's bytes are the
   word-embedding table, which is also exactly where its accuracy lives — a
   boulder is heavy because that row of the table says so. So quantization
   lands hardest on the part of the model that matters most, and cannot be
   taken on faith.
3. Verify. Every candidate is scored against the PyTorch checkpoint over the
   whole dataset, and the smallest one that stays inside tolerance wins. The
   selection rule is printed, not assumed.

    uv run --with torch --with onnx --with onnxruntime python model/export_onnx.py
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

from data import AXES, MAX_WORD_LEN, Vocab, encode_chars, load_rows
from train import CHECKPOINT, PropertyModel

REPO_ROOT = Path(__file__).parent.parent
DATA_DIR = Path(__file__).parent / "data"
SHIP_DIR = REPO_ROOT / "src" / "ml" / "models"

# ONNX opset. 17 is comfortably below what onnxruntime-web 1.27 supports and
# above what this graph needs (Gather, MatMul, Add, Div, Tanh, Erf).
OPSET = 17

# A quantized model is accepted only if no single word on any axis moves more
# than this from the PyTorch prediction. 0.05 is a third of the 0.15 MAE target
# the axes were designed against — small enough that no visible property of any
# word changes, strict enough to catch a table that quantized badly.
MAX_DELTA_TOLERANCE = 0.05

# Sign flips are only counted where the reference score is meaningfully non-zero.
# About 1% of the dataset is function words labeled exactly 0.0 on every axis,
# where any float noise at all flips a sign without meaning anything.
SIGN_FLIP_FLOOR = 0.1

# The inspection list from ROADMAP 1b, plus the nonsense case. These are the
# words the piece is judged on, so they get printed in full for every candidate.
INSPECTION_WORDS = [
    "boulder",
    "feather",
    "stone",
    "silence",
    "ember",
    "whisper",
    "hush",
    "crimson",
    "ancient",
    "scream",
    "dust",
    "ocean",
    "glass",
    "asdf",
]

# Feel test 1 from ROADMAP: boulder and feather must stay far apart on mass.
# Training measured this gap at 1.46; quantization must not close it.
MIN_BOULDER_FEATHER_MASS_GAP = 1.0


def load_torch_model() -> tuple[PropertyModel, Vocab]:
    checkpoint = torch.load(CHECKPOINT, map_location="cpu", weights_only=True)
    vocab = Vocab.load()
    if vocab.size != checkpoint["vocab_size"]:
        raise SystemExit(
            f"vocab.json has {vocab.size} slots but the checkpoint was trained with "
            f"{checkpoint['vocab_size']}. Re-run train.py — the two are written together."
        )
    model = PropertyModel(checkpoint["vocab_size"])
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    return model, vocab


def export_fp32(model: PropertyModel, path: Path) -> None:
    """Trace the model to ONNX with int32 inputs and a dynamic batch axis.

    int32 rather than the int64 PyTorch trains with: ONNX Runtime Web maps
    int64 tensors onto `BigInt64Array`, so every keystroke would allocate 25
    BigInts and box each one. `nn.Embedding` accepts int32 indices and the
    vocabulary is five figures, nowhere near the 2^31 where the narrower type
    would matter. Plain `Int32Array` on the hot path is the whole reason.
    """
    example_chars = torch.zeros((1, MAX_WORD_LEN), dtype=torch.int32)
    example_word_id = torch.zeros((1,), dtype=torch.int32)

    torch.onnx.export(
        model,
        (example_chars, example_word_id),
        str(path),
        input_names=["chars", "word_id"],
        output_names=["scores"],
        # Batching matters: the debug page's latency benchmark and any future
        # multi-word commit both want more than one word per run() call.
        dynamic_axes={
            "chars": {0: "batch"},
            "word_id": {0: "batch"},
            "scores": {0: "batch"},
        },
        opset_version=OPSET,
        dynamo=False,
    )


def quantize(source: Path, target: Path, op_types: list[str]) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from onnxruntime.quantization.shape_inference import quant_pre_process

    prepared = source.with_suffix(".prepared.onnx")
    quant_pre_process(str(source), str(prepared), skip_symbolic_shape=True)
    quantize_dynamic(
        str(prepared),
        str(target),
        op_types_to_quantize=op_types,
        weight_type=QuantType.QInt8,
        per_channel=True,
    )
    prepared.unlink()


def predict_torch(model: PropertyModel, words: list[str], vocab: Vocab) -> np.ndarray:
    chars = torch.tensor([encode_chars(w) for w in words], dtype=torch.long)
    word_ids = torch.tensor([vocab.id_for(w) for w in words], dtype=torch.long)
    with torch.no_grad():
        return model(chars, word_ids).numpy()


def predict_onnx(path: Path, words: list[str], vocab: Vocab, batch: int = 2048) -> np.ndarray:
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    chunks = []
    for start in range(0, len(words), batch):
        window = words[start : start + batch]
        chunks.append(
            session.run(
                None,
                {
                    "chars": np.array([encode_chars(w) for w in window], dtype=np.int32),
                    "word_id": np.array([vocab.id_for(w) for w in window], dtype=np.int32),
                },
            )[0]
        )
    return np.concatenate(chunks)


def compare(reference: np.ndarray, candidate: np.ndarray) -> dict[str, float | list[float]]:
    delta = np.abs(candidate - reference)
    meaningful = np.abs(reference) > SIGN_FLIP_FLOOR
    flipped = meaningful & (np.sign(candidate) != np.sign(reference))
    return {
        "mean": float(delta.mean()),
        "max": float(delta.max()),
        "per_axis_max": [float(v) for v in delta.max(axis=0)],
        "sign_flips": int(flipped.sum()),
    }


def print_inspection(words: list[str], scores: dict[str, np.ndarray], vocab: Vocab) -> None:
    header = "word".ljust(10) + "  ".join(a[:4].rjust(6) for a in AXES) + "   source"
    print("\n" + header)
    print("-" * len(header))
    for index, word in enumerate(words):
        branch = "word" if vocab.id_for(word) != 0 else "char"
        for label, matrix in scores.items():
            row = "  ".join(f"{v:+.3f}" for v in matrix[index])
            print(f"{word.ljust(10)}{row}   {label} ({branch})")
        print()


def write_vocab_asset(vocab: Vocab, path: Path) -> None:
    """Write the lookup table as a newline-delimited word list, id = line + 1.

    `vocab.json` is 179KB of `{"word": id}` pairs, most of which is punctuation
    restating an index that is already implied by position. Ids are contiguous
    from 1, so the order alone reconstructs the mapping — half the bytes and a
    `split("\\n")` instead of a `JSON.parse` at load. The contiguity that makes
    this safe is asserted rather than assumed.
    """
    by_id = sorted(vocab.word_to_id.items(), key=lambda pair: pair[1])
    expected = list(range(1, len(by_id) + 1))
    if [word_id for _, word_id in by_id] != expected:
        raise SystemExit(
            "vocab ids are not contiguous from 1; the positional word list would "
            "silently mismap words. Ship vocab.json verbatim instead."
        )
    path.write_text("\n".join(word for word, _ in by_id), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--version", default="v1", help="version tag in the shipped filename")
    parser.add_argument(
        "--keep-fp32",
        action="store_true",
        help="also copy the unquantized model into the ship directory (for A/B in the browser)",
    )
    args = parser.parse_args()

    SHIP_DIR.mkdir(parents=True, exist_ok=True)
    model, vocab = load_torch_model()
    words = [word for word, _ in load_rows()]
    print(f"checkpoint {CHECKPOINT.name}  vocab {vocab.size}  dataset {len(words)} words")

    fp32_path = DATA_DIR / f"properties.{args.version}.fp32.onnx"
    export_fp32(model, fp32_path)
    print(f"exported fp32 -> {fp32_path.name}  ({fp32_path.stat().st_size / 1e6:.2f} MB)")

    reference = predict_torch(model, words, vocab)

    # Candidates, largest scope first. The embedding table is the whole size
    # story, so quantizing Gather is the one that matters; MatMul-only is the
    # fallback if the table cannot take it.
    candidates: list[tuple[str, Path, list[str]]] = [
        ("int8 (embedding + matmul)", DATA_DIR / f"properties.{args.version}.int8-all.onnx", ["Gather", "MatMul"]),
        ("int8 (matmul only)", DATA_DIR / f"properties.{args.version}.int8-matmul.onnx", ["MatMul"]),
    ]

    print("\ncandidate                    size     mean|d|   max|d|   flips   verdict")
    print("-" * 76)

    fp32_scores = predict_onnx(fp32_path, words, vocab)
    fp32_stats = compare(reference, fp32_scores)
    print(
        f"{'fp32 (export fidelity)'.ljust(28)}"
        f"{fp32_path.stat().st_size / 1e6:5.2f} MB  "
        f"{fp32_stats['mean']:8.5f}  {fp32_stats['max']:7.5f}  {fp32_stats['sign_flips']:5d}   reference"
    )

    chosen: tuple[str, Path, np.ndarray] | None = None
    all_scores: dict[str, np.ndarray] = {"torch": reference}

    for label, path, op_types in candidates:
        quantize(fp32_path, path, op_types)
        scores = predict_onnx(path, words, vocab)
        stats = compare(reference, scores)
        all_scores[label] = scores
        passes = stats["max"] <= MAX_DELTA_TOLERANCE and stats["sign_flips"] == 0
        if passes and chosen is None:
            chosen = (label, path, scores)
        print(
            f"{label.ljust(28)}"
            f"{path.stat().st_size / 1e6:5.2f} MB  "
            f"{stats['mean']:8.5f}  {stats['max']:7.5f}  {stats['sign_flips']:5d}   "
            f"{'PASS' if passes else 'FAIL'}{'  <- chosen' if chosen and chosen[1] == path else ''}"
        )

    print(
        f"\nselection rule: smallest candidate with max per-word delta <= {MAX_DELTA_TOLERANCE} "
        f"and zero sign flips where |score| > {SIGN_FLIP_FLOOR}"
    )

    if chosen is None:
        print("\nno quantized candidate passed. Shipping fp32.")
        chosen = ("fp32", fp32_path, fp32_scores)

    label, path, scores = chosen

    # Feel test 1, re-run on the model that actually ships rather than on the
    # checkpoint it came from.
    inspection = predict_onnx(path, INSPECTION_WORDS, vocab)
    mass = AXES.index("mass")
    gap = float(
        inspection[INSPECTION_WORDS.index("boulder")][mass]
        - inspection[INSPECTION_WORDS.index("feather")][mass]
    )
    if gap < MIN_BOULDER_FEATHER_MASS_GAP:
        raise SystemExit(
            f"feel test 1 failed on the shipping model: boulder-feather mass gap is {gap:.2f}, "
            f"below the {MIN_BOULDER_FEATHER_MASS_GAP} floor. Do not ship this export."
        )

    torch_inspection = predict_torch(model, INSPECTION_WORDS, vocab)
    print_inspection(INSPECTION_WORDS, {"torch": torch_inspection, label: inspection}, vocab)
    print(f"feel test 1: boulder - feather mass gap {gap:.2f} (floor {MIN_BOULDER_FEATHER_MASS_GAP})")

    ship_model = SHIP_DIR / f"properties.{args.version}.onnx"
    ship_vocab = SHIP_DIR / f"properties.{args.version}.vocab.txt"
    ship_model.write_bytes(path.read_bytes())
    write_vocab_asset(vocab, ship_vocab)

    if args.keep_fp32:
        (SHIP_DIR / f"properties.{args.version}.fp32.onnx").write_bytes(fp32_path.read_bytes())

    print(f"\nshipping {label}")
    print(f"  {ship_model.relative_to(REPO_ROOT)}  {ship_model.stat().st_size / 1e6:.2f} MB")
    print(f"  {ship_vocab.relative_to(REPO_ROOT)}  {ship_vocab.stat().st_size / 1e3:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
