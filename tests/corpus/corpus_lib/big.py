"""Large benchmark files (git-ignored, written to tests/corpus/generated/).

Same content and seeds as the Phase 0 IronCalc spike
(`sheetlight-spikes/ironcalc/gen_corpus.py`), so numbers are comparable with
docs/spikes/ironcalc-engine.md:

- big_100k.xlsx   100k rows x 20 cols + a formula column (2.0M cells, 100k formulas, ~15 MB)
- chain_100k.xlsx A1=1, A2=A1+1, ... A100000 (recalc benchmark)
- big_1M.csv      1M rows x 10 cols, UTF-8, `,` (~79 MB)
- big_1M_es.csv   same rows as big_1M.csv but `;` + decimal comma + dd/mm/yyyy (Spanish export)
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import os
import random

import xlsxwriter

from .xlsxbook import FIXED_CREATED

CATS = ["Alquiler", "Nominas", "Suministros", "Marketing", "Software", "Viajes", "Material", "Impuestos"]
CITIES = ["Madrid", "Barcelona", "Valencia", "Sevilla", "Bilbao", "Zaragoza", "Malaga", "Murcia"]
WORDS = ("lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor "
         "incididunt ut labore et dolore magna aliqua enim ad minim veniam quis").split()


def big_100k(out_dir: str, rows: int = 100_000) -> dict:
    rnd = random.Random(1)
    name = "big_100k.xlsx"
    wb = xlsxwriter.Workbook(os.path.join(out_dir, name), {"constant_memory": False})
    wb.set_properties({"created": FIXED_CREATED})
    ws = wb.add_worksheet("Data")
    datef = wb.add_format({"num_format": "dd/mm/yyyy"})
    money = wb.add_format({"num_format": "#,##0.00"})
    hdr = ["Id", "Fecha", "Categoria", "Ciudad", "Cliente", "Descripcion", "Cantidad", "Precio",
           "Descuento", "Coste", "Unidades", "Peso", "Ratio", "Codigo", "Activo", "Score",
           "Lat", "Lon", "Nota", "Total"]
    for c, h in enumerate(hdr):
        ws.write_string(0, c, h)
    base = dt.date(2020, 1, 1)
    totals = {}
    for r in range(1, rows + 1):
        ws.write_number(r, 0, r)
        ws.write_datetime(r, 1, dt.datetime.combine(base + dt.timedelta(days=rnd.randrange(2000)), dt.time()), datef)
        ws.write_string(r, 2, rnd.choice(CATS))
        ws.write_string(r, 3, rnd.choice(CITIES))
        ws.write_string(r, 4, f"Cliente {rnd.randrange(5000):04d}")
        ws.write_string(r, 5, " ".join(rnd.choice(WORDS) for _ in range(4)))
        qty = rnd.randrange(1, 500)
        price = round(rnd.uniform(1, 999), 2)
        disc = round(rnd.random() * 0.3, 3)
        ws.write_number(r, 6, qty)
        ws.write_number(r, 7, price, money)
        ws.write_number(r, 8, disc)
        ws.write_number(r, 9, round(rnd.uniform(1, 5000), 2), money)
        ws.write_number(r, 10, rnd.randrange(1000))
        ws.write_number(r, 11, round(rnd.uniform(0, 100), 3))
        ws.write_number(r, 12, rnd.random())
        ws.write_string(r, 13, f"SKU-{rnd.randrange(10**6):06d}")
        ws.write_boolean(r, 14, rnd.random() > 0.5)
        ws.write_number(r, 15, rnd.randrange(100))
        ws.write_number(r, 16, round(rnd.uniform(36, 43), 5))
        ws.write_number(r, 17, round(rnd.uniform(-9, 3), 5))
        ws.write_string(r, 18, rnd.choice(WORDS))
        x = r + 1
        ws.write_formula(r, 19, f"=ROUND(G{x}*H{x}*(1-I{x}),2)")
        if r in (1, 2, rows):
            totals[f"Data!T{x}"] = {"value": {"type": "number", "value": round(qty * price * (1 - disc), 2)}}
    wb.close()
    return {"file": name, "kind": "xlsx", "sheets": ["Data"], "rows": rows + 1, "cols": 20, "cells": totals}


def chain_100k(out_dir: str, rows: int = 100_000) -> dict:
    name = "chain_100k.xlsx"
    wb = xlsxwriter.Workbook(os.path.join(out_dir, name), {"constant_memory": True})
    wb.set_properties({"created": FIXED_CREATED})
    ws = wb.add_worksheet("Chain")
    ws.write_number(0, 0, 1)
    for r in range(1, rows):
        ws.write_formula(r, 0, f"=A{r}+1", None, r + 1)
    wb.close()
    return {"file": name, "kind": "xlsx", "sheets": ["Chain"], "rows": rows, "cols": 1,
            "cells": {f"Chain!A{rows}": {"value": {"type": "number", "value": float(rows)}}},
            "bench": {"edit": "Chain!A1", "newValue": 2, "expect": {f"Chain!A{rows}": float(rows + 1)}}}


def big_1m_csv(out_dir: str, rows: int = 1_000_000) -> list[dict]:
    rnd = random.Random(2)
    base = dt.date(2015, 1, 1)
    p_en = os.path.join(out_dir, "big_1M.csv")
    p_es = os.path.join(out_dir, "big_1M_es.csv")
    header = ["id", "fecha", "categoria", "ciudad", "cliente", "cantidad", "precio", "coste", "ratio", "nota"]
    with open(p_en, "w", newline="", encoding="utf-8") as fen, open(p_es, "w", newline="", encoding="utf-8-sig") as fes:
        wen = csv.writer(fen)
        wes = csv.writer(fes, delimiter=";", lineterminator="\r\n")
        wen.writerow(header)
        wes.writerow(header)
        for r in range(1, rows + 1):
            d = base + dt.timedelta(days=rnd.randrange(3000))
            row = [r, d.isoformat(), rnd.choice(CATS), rnd.choice(CITIES), f"Cliente {rnd.randrange(5000):04d}",
                   rnd.randrange(1, 500), f"{rnd.uniform(1, 999):.2f}", f"{rnd.uniform(1, 5000):.2f}",
                   f"{rnd.random():.6f}", rnd.choice(WORDS)]
            wen.writerow(row)
            es = list(row)
            es[1] = d.strftime("%d/%m/%Y")
            for k in (6, 7, 8):
                es[k] = es[k].replace(".", ",")
            wes.writerow(es)
    common = {"kind": "csv", "rows": rows + 1, "cols": 10}
    return [
        dict(common, file="big_1M.csv", csv={"delimiter": ",", "encoding": "utf-8", "decimal": "."}, bom=False),
        dict(common, file="big_1M_es.csv", csv={"delimiter": ";", "encoding": "utf-8", "decimal": ","}, bom=True),
    ]


def generate(out_dir: str, which: list[str] | None = None) -> None:
    os.makedirs(out_dir, exist_ok=True)
    jobs = {"big_100k": big_100k, "chain_100k": chain_100k, "big_1m_csv": big_1m_csv}
    for key in which or list(jobs):
        t = dt.datetime.now()
        result = jobs[key](out_dir)
        for exp in result if isinstance(result, list) else [result]:
            with open(os.path.join(out_dir, exp["file"] + ".expected.json"), "w", encoding="utf-8") as fh:
                json.dump(exp, fh, ensure_ascii=False, indent=1)
        print(f"  {key}: {(dt.datetime.now() - t).total_seconds():.1f} s")
