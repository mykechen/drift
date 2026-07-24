"""Label the word corpus with the six property scores defined in axes.md.

Two passes, because `drag` is a residual: it scores how much a word's descent
deviates from what its `mass` already implies, so mass has to exist first.

    pass 1  mass, restitution, warmth, age, intensity
    pass 2  drag, given each word's pass-1 mass

Both passes append to JSONL as they go and skip words already present on
restart, so an interrupted run costs nothing to resume.

Usage:
    # See the exact prompt and a cost estimate without spending anything
    python model/generate_dataset.py --pass 1 --dry-run

    # Real run
    export DRIFT_LABEL_MODEL=<model id from your provider's console>
    export GEMINI_API_KEY=...          # or ANTHROPIC_API_KEY
    python model/generate_dataset.py --pass 1 --provider gemini
    python model/generate_dataset.py --pass 2 --provider gemini

    # Merge both passes into the final dataset
    python model/generate_dataset.py --merge
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable, Iterator

MODEL_DIR = Path(__file__).parent
DATA_DIR = MODEL_DIR / "data"
PROMPT_DIR = MODEL_DIR / "prompts"

WORDLIST = DATA_DIR / "wordlist.csv"
PASS1_OUT = DATA_DIR / "labels-pass1.jsonl"
PASS2_OUT = DATA_DIR / "labels-pass2.jsonl"
DATASET_OUT = DATA_DIR / "dataset.csv"

PASS1_AXES = ["mass", "restitution", "warmth", "age", "intensity"]
ALL_AXES = ["mass", "drag", "restitution", "warmth", "age", "intensity"]

# Batch size is a tradeoff: larger batches amortise the ~900-token rubric across
# more words, but a single malformed response costs the whole batch. 50 keeps
# pass-1 output near 3k tokens, well inside any provider's per-response ceiling.
DEFAULT_BATCH_SIZE = 50

# Rough token accounting for the dry-run estimate only. Real usage is reported
# by the provider; these are for deciding whether to press go.
RUBRIC_TOKENS = 900
TOKENS_PER_WORD_IN = 3
PASS1_TOKENS_PER_WORD_OUT = 60
PASS2_TOKENS_PER_WORD_OUT = 15


# --------------------------------------------------------------------------
# Corpus and resume state
# --------------------------------------------------------------------------


def read_wordlist() -> list[str]:
    if not WORDLIST.exists():
        sys.exit(f"{WORDLIST} not found. Run model/build_wordlist.py first.")
    with WORDLIST.open(encoding="utf-8") as handle:
        return [row["word"] for row in csv.DictReader(handle)]


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def append_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")


def batched(items: list[Any], size: int) -> Iterator[list[Any]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


# --------------------------------------------------------------------------
# Prompts
# --------------------------------------------------------------------------


def build_prompt(pass_number: int, batch: list[Any]) -> str:
    """Render a pass's prompt template with this batch's words substituted."""
    template = (PROMPT_DIR / f"pass{pass_number}.txt").read_text(encoding="utf-8")
    if pass_number == 1:
        words = ", ".join(batch)
    else:
        words = ", ".join(f"{word} (mass {mass:+.1f})" for word, mass in batch)
    return template.replace("{WORDS}", words)


def response_schema(pass_number: int) -> dict[str, Any]:
    """JSON Schema constraining the response, so malformed output is impossible."""
    axes = PASS1_AXES if pass_number == 1 else ["drag"]
    properties: dict[str, Any] = {"word": {"type": "string"}}
    for axis in axes:
        properties[axis] = {"type": "number", "minimum": -1.0, "maximum": 1.0}
    return {
        "type": "array",
        "items": {
            "type": "object",
            "properties": properties,
            "required": ["word"] + axes,
        },
    }


# --------------------------------------------------------------------------
# Providers
# --------------------------------------------------------------------------

Labeler = Callable[[str, dict[str, Any]], str]


def gemini_labeler(model: str) -> Labeler:
    from google import genai  # imported lazily so --dry-run needs no SDK

    client = genai.Client(api_key=require_env("GEMINI_API_KEY"))

    def call(prompt: str, schema: dict[str, Any]) -> str:
        response = client.models.generate_content(
            model=model,
            contents=prompt,
            config={"response_mime_type": "application/json", "response_schema": schema},
        )
        return response.text

    return call


def anthropic_labeler(model: str) -> Labeler:
    import anthropic  # imported lazily so --dry-run needs no SDK

    client = anthropic.Anthropic(api_key=require_env("ANTHROPIC_API_KEY"))

    def call(prompt: str, schema: dict[str, Any]) -> str:
        response = client.messages.create(
            model=model,
            max_tokens=8000,
            output_config={"format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(block.text for block in response.content if block.type == "text")

    return call


PROVIDERS: dict[str, Callable[[str], Labeler]] = {
    "gemini": gemini_labeler,
    "anthropic": anthropic_labeler,
}


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"{name} is not set.")
    return value


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------


def validate_batch(raw: str, expected: list[str], pass_number: int) -> list[dict[str, Any]]:
    """Parse a response and keep only rows that are well-formed and in-range.

    A schema-constrained provider should make most of this unreachable, but a
    silently dropped word would leave a hole in the dataset that only surfaces
    during training. Cheaper to catch it here.
    """
    axes = PASS1_AXES if pass_number == 1 else ["drag"]
    try:
        rows = json.loads(raw)
    except json.JSONDecodeError as error:
        print(f"    unparseable response: {error}", file=sys.stderr)
        return []

    wanted = set(expected)
    seen: set[str] = set()
    good: list[dict[str, Any]] = []

    for row in rows:
        word = row.get("word")
        if word not in wanted or word in seen:
            continue
        scores = {}
        for axis in axes:
            value = row.get(axis)
            if not isinstance(value, (int, float)):
                break
            scores[axis] = max(-1.0, min(1.0, round(float(value), 2)))
        else:
            seen.add(word)
            good.append({"word": word, **scores})

    if missing := wanted - seen:
        print(f"    {len(missing)} words missing from response, will retry next run", file=sys.stderr)
    return good


# --------------------------------------------------------------------------
# Cost estimate
# --------------------------------------------------------------------------


def estimate(pass_number: int, word_count: int, batch_size: int) -> None:
    batches = -(-word_count // batch_size)
    out_per_word = PASS1_TOKENS_PER_WORD_OUT if pass_number == 1 else PASS2_TOKENS_PER_WORD_OUT
    tokens_in = batches * RUBRIC_TOKENS + word_count * TOKENS_PER_WORD_IN
    tokens_out = word_count * out_per_word

    print(f"  {word_count} words in {batches} requests")
    print(f"  ~{tokens_in/1000:.0f}k input tokens, ~{tokens_out/1000:.0f}k output tokens")
    print("  cost at some example rates (check your provider's current pricing):")
    for label, rate_in, rate_out in [
        ("$1 / $5 per Mtok", 1.0, 5.0),
        ("$5 / $25 per Mtok", 5.0, 25.0),
    ]:
        total = tokens_in / 1e6 * rate_in + tokens_out / 1e6 * rate_out
        print(f"    {label:22} ~${total:.2f}")
    print("  free tier: $0.00")


# --------------------------------------------------------------------------
# Passes
# --------------------------------------------------------------------------


def run_pass(pass_number: int, args: argparse.Namespace) -> int:
    out_path = PASS1_OUT if pass_number == 1 else PASS2_OUT
    done = {row["word"] for row in read_jsonl(out_path)}

    if pass_number == 1:
        pending: list[Any] = [w for w in read_wordlist() if w not in done]
    else:
        mass_by_word = {row["word"]: row["mass"] for row in read_jsonl(PASS1_OUT)}
        if not mass_by_word:
            sys.exit("pass 2 needs pass 1 output; run --pass 1 first.")
        pending = [(w, m) for w, m in mass_by_word.items() if w not in done]

    if args.limit:
        pending = pending[: args.limit]

    print(f"pass {pass_number}: {len(done)} already labeled, {len(pending)} pending")
    if not pending:
        return 0

    if args.dry_run:
        estimate(pass_number, len(pending), args.batch_size)
        sample = build_prompt(pass_number, pending[: args.batch_size])
        print("\n--- first request, verbatim ---\n")
        print(sample if args.full_prompt else sample[:1500] + "\n[...truncated, --full-prompt for all]")
        return 0

    if not args.model:
        sys.exit("--model, or DRIFT_LABEL_MODEL, is required. Copy the exact id from your provider's console.")
    label = PROVIDERS[args.provider](args.model)

    written = 0
    for index, batch in enumerate(batched(pending, args.batch_size), start=1):
        words = [b if pass_number == 1 else b[0] for b in batch]
        try:
            raw = label(build_prompt(pass_number, batch), response_schema(pass_number))
        except Exception as error:  # provider SDKs raise their own hierarchies
            print(f"  batch {index}: {type(error).__name__}: {error}", file=sys.stderr)
            time.sleep(args.retry_delay)
            continue

        rows = validate_batch(raw, words, pass_number)
        append_jsonl(out_path, rows)
        written += len(rows)
        print(f"  batch {index}: +{len(rows)} ({written} this run)")

    print(f"pass {pass_number} wrote {written} rows to {out_path}")
    return 0


def merge() -> int:
    """Join both passes into the final six-column dataset."""
    pass1 = {row["word"]: row for row in read_jsonl(PASS1_OUT)}
    pass2 = {row["word"]: row["drag"] for row in read_jsonl(PASS2_OUT)}

    complete = [w for w in pass1 if w in pass2]
    if missing := len(pass1) - len(complete):
        print(f"warning: {missing} words have pass-1 but no pass-2 scores", file=sys.stderr)

    with DATASET_OUT.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["word"] + ALL_AXES)
        for word in complete:
            row = pass1[word]
            writer.writerow([word] + [row["mass"], pass2[word]] + [row[a] for a in PASS1_AXES[1:]])

    print(f"wrote {len(complete)} labeled words to {DATASET_OUT}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pass", dest="pass_number", type=int, choices=[1, 2])
    parser.add_argument("--merge", action="store_true", help="join both passes into dataset.csv")
    parser.add_argument("--provider", choices=sorted(PROVIDERS), default="gemini")
    parser.add_argument("--model", default=os.environ.get("DRIFT_LABEL_MODEL"))
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--limit", type=int, help="only process this many pending words")
    parser.add_argument("--dry-run", action="store_true", help="print prompt and cost, call nothing")
    parser.add_argument("--full-prompt", action="store_true", help="with --dry-run, print the whole prompt")
    parser.add_argument("--retry-delay", type=float, default=5.0)
    args = parser.parse_args()

    if args.merge:
        return merge()
    if not args.pass_number:
        parser.error("one of --pass or --merge is required")
    return run_pass(args.pass_number, args)


if __name__ == "__main__":
    raise SystemExit(main())
