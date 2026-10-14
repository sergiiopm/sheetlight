"""Thin wrapper over xlsxwriter that records, while writing, what the file
contains: expected cell values/display strings and the structural features
(merges, frozen panes, autofilter, charts, images, comments…). `close()`
returns the `expected` dict that is stored next to the file as JSON.

Expected JSON schema (shared with the Rust harness and the Vitest corpus test):

{
  "file": "presupuesto_familiar.xlsx",
  "kind": "xlsx",
  "description": "...",
  "sheets": ["Presupuesto 2025", ...],          # in order
  "activeSheet": "Presupuesto 2025",
  "definedNames": {"Nombre": "Hoja!$A$1:$A$9"},
  "features": {                                  # per sheet
    "<sheet>": {"frozen": [rows, cols], "merges": ["A1:P1"], "autoFilter": "A3:F99",
                "filteredCols": [6], "hiddenRows": [40], "hiddenCols": [14],
                "colWidths": 12, "conditionalFormats": 2, "dataValidations": 1,
                "comments": 3, "hyperlinks": 1, "images": 1, "charts": 3}
  },
  "fidelity": {"charts": 3, "images": 1, ...},   # FidelityFeature -> count
  "cells": {
    "<sheet>!B5": {"value": {"type": "number", "value": 12.5},
                    "display": "12,50 €",        # optional (es-ES)
                    "input": "=SUM(B2:B4)"}      # optional (formulas, en-US)
  }
}
"""
from __future__ import annotations

import datetime as dt
import io
import json
import os
import struct
import zlib

import xlsxwriter
from xlsxwriter.utility import xl_cell_to_rowcol, xl_range_abs

from . import esfmt

FIXED_CREATED = dt.datetime(2025, 1, 1, 9, 0, 0)


def cell_value(v) -> dict:
    if v is None:
        return {"type": "empty"}
    if isinstance(v, bool):
        return {"type": "bool", "value": v}
    if isinstance(v, (int, float)):
        return {"type": "number", "value": float(v)}
    if isinstance(v, (dt.date, dt.datetime)):
        return {"type": "number", "value": esfmt.serial(v)}
    if isinstance(v, ErrorValue):
        return {"type": "error", "value": v.code}
    return {"type": "text", "value": str(v)}


class ErrorValue:
    def __init__(self, code: str):
        self.code = code


def png_bytes(w: int = 96, h: int = 48, seed: int = 0) -> bytes:
    """A small deterministic RGB PNG (gradient 'logo')."""
    raw = b"".join(
        b"\x00" + b"".join(bytes(((x * 3 + seed) % 256, (y * 5) % 256, 160)) for x in range(w))
        for y in range(h)
    )

    def chunk(t: bytes, d: bytes) -> bytes:
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


class Book:
    def __init__(self, out_dir: str, file_name: str, description: str):
        self.path = os.path.join(out_dir, file_name)
        self.wb = xlsxwriter.Workbook(self.path, {"use_future_functions": True})
        self.wb.set_properties({"title": file_name, "author": "Sheetlight corpus",
                                "created": FIXED_CREATED})
        self._formats: dict[tuple, object] = {}
        self._numfmt: dict[int, str] = {}
        self.sheets: list[Sheet] = []
        self.expected: dict = {
            "file": file_name, "kind": "xlsx", "description": description,
            "sheets": [], "activeSheet": None, "definedNames": {}, "features": {},
            "fidelity": {}, "cells": {},
        }

    # formats ---------------------------------------------------------------
    def fmt(self, num: str | None = None, **props):
        key = (num, tuple(sorted(props.items())))
        if key not in self._formats:
            p = dict(props)
            if num is not None and num != esfmt.GENERAL:
                p["num_format"] = num
            f = self.wb.add_format(p)
            self._formats[key] = f
            self._numfmt[id(f)] = num or esfmt.GENERAL
        return self._formats[key]

    def numfmt_of(self, f) -> str:
        return esfmt.GENERAL if f is None else self._numfmt.get(id(f), esfmt.GENERAL)

    # sheets ----------------------------------------------------------------
    def sheet(self, name: str) -> "Sheet":
        s = Sheet(self, self.wb.add_worksheet(name), name)
        self.sheets.append(s)
        self.expected["sheets"].append(name)
        return s

    def define_name(self, name: str, ref: str) -> None:
        self.wb.define_name(name, "=" + ref)
        self.expected["definedNames"][name] = ref

    def add_chart(self, options: dict):
        return self.wb.add_chart(options)

    def close(self) -> dict:
        active = next((s for s in self.sheets if s.active), self.sheets[0])
        self.expected["activeSheet"] = active.name
        fid: dict[str, int] = {}
        for s in self.sheets:
            feats = {k: v for k, v in s.features.items() if v not in (0, [], None)}
            self.expected["features"][s.name] = feats
            for key, feature in (("charts", "charts"), ("images", "images"), ("comments", "comments"),
                                 ("dataValidations", "dataValidation"),
                                 ("conditionalFormats", "conditionalFormatting")):
                if s.features.get(key):
                    fid[feature] = fid.get(feature, 0) + s.features[key]
            if s.features.get("autoFilter"):
                fid["autoFilter"] = fid.get("autoFilter", 0) + 1
        self.expected["fidelity"] = fid
        self.wb.close()
        return self.expected


class Sheet:
    def __init__(self, book: Book, ws, name: str):
        self.book, self.ws, self.name = book, ws, name
        self.active = False
        self.features: dict = {
            "frozen": None, "merges": [], "autoFilter": None, "filteredCols": [],
            "hiddenRows": [], "hiddenCols": [], "colWidths": 0, "conditionalFormats": 0,
            "dataValidations": 0, "comments": 0, "hyperlinks": 0, "images": 0, "charts": 0,
        }

    # expectations ------------------------------------------------------------
    def expect(self, ref: str, value, f=None, formula: str | None = None, display: str | None = "auto"):
        entry: dict = {"value": cell_value(value)}
        if display == "auto":
            v = esfmt.serial(value) if isinstance(value, (dt.date, dt.datetime)) else value
            if isinstance(value, ErrorValue):
                display = None
            else:
                display = esfmt.display(v, self.book.numfmt_of(f))
        if display is not None:
            entry["display"] = display
        if formula is not None:
            entry["input"] = formula
        self.book.expected["cells"][f"{self.name}!{ref}"] = entry

    # cells -------------------------------------------------------------------
    def put(self, ref: str, value, f=None, expect: bool = False):
        r, c = xl_cell_to_rowcol(ref)
        if isinstance(value, bool):
            self.ws.write_boolean(r, c, value, f)
        elif isinstance(value, (dt.date, dt.datetime)):
            v = value if isinstance(value, dt.datetime) else dt.datetime.combine(value, dt.time())
            self.ws.write_datetime(r, c, v, f)
        elif isinstance(value, (int, float)):
            self.ws.write_number(r, c, value, f)
        elif value is None:
            self.ws.write_blank(r, c, None, f)
        else:
            self.ws.write_string(r, c, value, f)
        if expect:
            self.expect(ref, value, f)

    def row(self, ref: str, values, f=None, expect: bool = False):
        r, c = xl_cell_to_rowcol(ref)
        for i, v in enumerate(values):
            self.put(xlsxwriter.utility.xl_rowcol_to_cell(r, c + i), v, f, expect)

    def formula(self, ref: str, formula: str, value, f=None, expect: bool = True, display="auto"):
        """Writes `formula` (en-US, leading `=`) with `value` as cached result."""
        r, c = xl_cell_to_rowcol(ref)
        cached = value
        if isinstance(value, (dt.date, dt.datetime)):
            cached = esfmt.serial(value)
        elif isinstance(value, ErrorValue):
            cached = value.code
        self.ws.write_formula(r, c, formula, f, cached)
        if expect:
            self.expect(ref, value, f, formula=formula, display=display)

    # structure -------------------------------------------------------------
    def merge(self, rng: str, value, f=None):
        self.ws.merge_range(rng, value, f)
        self.features["merges"].append(rng)

    def freeze(self, rows: int, cols: int):
        self.ws.freeze_panes(rows, cols)
        self.features["frozen"] = [rows, cols]

    def widths(self, spec: dict[str, float]):
        """{"A": 24, "B:M": 11} in Excel character units."""
        for cols, w in spec.items():
            rng = cols if ":" in cols else f"{cols}:{cols}"
            self.ws.set_column(rng, w)
            a, b = rng.split(":")
            n = xl_cell_to_rowcol(b + "1")[1] - xl_cell_to_rowcol(a + "1")[1] + 1
            self.features["colWidths"] += n

    def hide_rows(self, rows: list[int]):
        """0-based row indices."""
        for r in rows:
            self.ws.set_row(r, None, None, {"hidden": True})
        self.features["hiddenRows"].extend(rows)

    def hide_col(self, col_letter: str, width: float = 12):
        self.ws.set_column(f"{col_letter}:{col_letter}", width, None, {"hidden": True})
        self.features["hiddenCols"].append(xl_cell_to_rowcol(col_letter + "1")[1])

    def autofilter(self, rng: str):
        self.ws.autofilter(rng)
        self.features["autoFilter"] = rng

    def filter_list(self, col_letter: str, values: list[str]):
        self.ws.filter_column_list(col_letter, values)
        self.features["filteredCols"].append(xl_cell_to_rowcol(col_letter + "1")[1])

    def cond(self, rng: str, options: dict):
        self.ws.conditional_format(rng, options)
        self.features["conditionalFormats"] += 1

    def validation(self, rng: str, options: dict):
        self.ws.data_validation(rng, options)
        self.features["dataValidations"] += 1

    def comment(self, ref: str, text: str):
        self.ws.write_comment(ref, text, {"author": "Sheetlight"})
        self.features["comments"] += 1

    def link(self, ref: str, url: str, text: str, f=None):
        self.ws.write_url(ref, url, f, string=text)
        self.features["hyperlinks"] += 1

    def image(self, ref: str, data: bytes, name: str, options: dict | None = None):
        opts = {"image_data": io.BytesIO(data)}
        opts.update(options or {})
        self.ws.insert_image(ref, name, opts)
        self.features["images"] += 1

    def chart(self, ref: str, chart, options: dict | None = None):
        self.ws.insert_chart(ref, chart, options or {})
        self.features["charts"] += 1

    def activate(self):
        self.ws.activate()
        self.active = True


def abs_range(r0: int, c0: int, r1: int, c1: int) -> str:
    return xl_range_abs(r0, c0, r1, c1)


def write_expected(out_dir: str, expected: dict) -> str:
    path = os.path.join(out_dir, expected["file"] + ".expected.json")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(expected, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    return path
