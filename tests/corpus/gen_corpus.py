"""Sheetlight test corpus generator.

Usage (from the repo root; Python 3.11+, deps pinned in tests/corpus/requirements.txt):

    python tests/corpus/gen_corpus.py files   # realistic Spanish files -> tests/corpus/files/ (committed)
    python tests/corpus/gen_corpus.py big     # benchmark files -> tests/corpus/generated/ (git-ignored, ~200 MB)
    python tests/corpus/gen_corpus.py all
    python tests/corpus/gen_corpus.py check   # regenerate files/ in a temp dir and compare (CI)

Every generator is deterministic (fixed seeds, fixed document timestamps), so
`files` reproduces the committed bytes exactly and `check` fails when someone
edits a generator without regenerating, or edits a committed file by hand.
"""
from __future__ import annotations

import filecmp
import os
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from corpus_lib import big, csv_files, esfmt, xls_files, xlsx_files  # noqa: E402
from corpus_lib.xlsxbook import write_expected  # noqa: E402

FILES_DIR = os.path.join(HERE, "files")
GENERATED_DIR = os.path.join(HERE, "generated")
MAX_COMMITTED_BYTES = 1_000_000


def gen_files(out_dir: str) -> list[str]:
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for gen in xlsx_files.ALL + xls_files.ALL + csv_files.ALL:
        expected = gen(out_dir)
        written.append(expected["file"])
        written.append(os.path.basename(write_expected(out_dir, expected)))
        size = os.path.getsize(os.path.join(out_dir, expected["file"]))
        if size > MAX_COMMITTED_BYTES:
            raise SystemExit(f"{expected['file']} is {size} bytes (> {MAX_COMMITTED_BYTES})")
        print(f"  {expected['file']:<32} {size / 1024:7.1f} KB  {len(expected['cells']):4d} expected cells")
    return written


def same_content(a: str, b: str) -> bool:
    """Byte equality, except .xlsx packages compare their uncompressed parts
    (deflate output may differ between zlib builds on CI and locally) with
    CRLF folded to LF (XlsxWriter writes XML through text-mode files, so parts
    generated on Windows carry CRLF and parts generated on Linux carry LF)."""
    if a.endswith(".xlsx"):
        def part(z: zipfile.ZipFile, n: str) -> bytes:
            data = z.read(n)
            return data.replace(b"\r\n", b"\n") if n.endswith((".xml", ".rels")) else data

        with zipfile.ZipFile(a) as za, zipfile.ZipFile(b) as zb:
            names = za.namelist()
            return names == zb.namelist() and all(part(za, n) == part(zb, n) for n in names)
    return filecmp.cmp(a, b, shallow=False)


def check() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        names = gen_files(tmp)
        committed = sorted(n for n in os.listdir(FILES_DIR) if not n.startswith("."))
        problems = []
        for n in names:
            if not os.path.exists(os.path.join(FILES_DIR, n)):
                problems.append(f"missing in tests/corpus/files: {n}")
            elif not same_content(os.path.join(tmp, n), os.path.join(FILES_DIR, n)):
                problems.append(f"differs from generator output: {n}")
        for n in committed:
            if n not in names:
                problems.append(f"not produced by the generator: {n}")
    for p in problems:
        print("ERROR:", p)
    print("corpus check:", "OK" if not problems else f"{len(problems)} problem(s)")
    return 1 if problems else 0


def main(argv: list[str]) -> int:
    esfmt._selftest()
    cmd = argv[0] if argv else "files"
    if cmd == "check":
        return check()
    if cmd in ("files", "all"):
        print(f"files -> {FILES_DIR}")
        gen_files(FILES_DIR)
    if cmd in ("big", "all"):
        print(f"big -> {GENERATED_DIR}")
        big.generate(GENERATED_DIR, argv[1:] or None)
    if cmd not in ("files", "big", "all"):
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
