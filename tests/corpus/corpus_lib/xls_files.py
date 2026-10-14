"""Legacy Excel 97-2003 (.xls, BIFF8) files (committed in tests/corpus/files/).

Sheetlight opens .xls read-only through calamine (`xlsx_package::import_xls`)
and saves it as .xlsx. The importer keeps values, formulas, date formats and
merges; styles, widths and frozen panes are not read, so the expectations only
pin what the importer promises (see the module docs of `xls.rs`).

xlwt writes formulas without a cached result: every expected value here is
only reachable if the engine recalculates the imported formulas.
"""
from __future__ import annotations

import datetime as dt
import os
import random

import xlwt

from . import esfmt as F
from .xlsxbook import cell_value

FIRST = ["Lucía", "José", "Begoña", "Íñigo", "María Ángeles", "Raúl", "Nuria", "Óscar", "Ainhoa", "Jesús",
         "Pilar", "Ramón", "Inés", "Tomás", "Elena"]
LAST = ["Muñoz", "García", "Peña", "Ibáñez", "Fernández", "López", "Martín", "Sáez", "Gómez", "Núñez"]
DEPTS = ["Administración", "Almacén", "Ventas", "Taller"]
SS_RATE = 0.0635


def _cell(value, fmt: str | None = F.GENERAL, input_: str | None = None) -> dict:
    e: dict = {"value": cell_value(value)}
    if fmt is not None:
        v = F.serial(value) if isinstance(value, (dt.date, dt.datetime)) else value
        shown = F.display(v, fmt)
        if shown is not None:
            e["display"] = shown
    if input_ is not None:
        e["input"] = input_
    return e


def nominas_legacy(out_dir: str) -> dict:
    rnd = random.Random(501)
    name = "nominas_legacy.xls"
    wb = xlwt.Workbook(encoding="utf-8")
    emp = wb.add_sheet("Empleados")
    res = wb.add_sheet("Resumen")
    bold = xlwt.easyxf("font: bold on")
    datef = xlwt.easyxf(num_format_str="dd/mm/yyyy")
    eur = xlwt.easyxf(num_format_str='#,##0.00 "€"')
    pct = xlwt.easyxf(num_format_str="0.0%")
    emp.set_panes_frozen(True)
    emp.set_horz_split_pos(1)

    header = ["Empleado", "DNI", "Departamento", "Fecha alta", "Salario base", "Complemento", "Bruto",
              "Seg. Social", "IRPF %", "Neto"]
    for c, h in enumerate(header):
        emp.write(0, c, h, bold)

    cells: dict = {}
    by_dept: dict[str, list[float]] = {d: [] for d in DEPTS}
    netos: list[float] = []
    n = 24
    for i in range(n):
        r = i + 1
        x = r + 1
        nombre = f"{rnd.choice(FIRST)} {rnd.choice(LAST)} {rnd.choice(LAST)}"
        dni = f"{rnd.randrange(10**7, 10**8):08d}{'TRWAGMYFPDXBNJZSQVHLCKE'[rnd.randrange(23)]}"
        dept = DEPTS[i % len(DEPTS)]
        alta = dt.date(1995, 1, 1) + dt.timedelta(days=rnd.randrange(0, 365 * 12))
        base = round(rnd.uniform(1050, 2900), 2)
        comp = float(rnd.choice([0, 0, 75, 120, 210.5]))
        irpf = rnd.choice([0.08, 0.12, 0.15, 0.19])
        bruto = round(base + comp, 2)
        ss = F.excel_round(bruto * SS_RATE, 2)
        neto = F.excel_round(bruto - ss - bruto * irpf, 2)
        emp.write(r, 0, nombre)
        emp.write(r, 1, dni)
        emp.write(r, 2, dept)
        emp.write(r, 3, alta, datef)
        emp.write(r, 4, base, eur)
        emp.write(r, 5, comp, eur)
        emp.write(r, 6, xlwt.Formula(f"E{x}+F{x}"), eur)
        emp.write(r, 7, xlwt.Formula(f"ROUND(G{x}*{SS_RATE},2)"), eur)
        emp.write(r, 8, irpf, pct)
        emp.write(r, 9, xlwt.Formula(f"ROUND(G{x}-H{x}-G{x}*I{x},2)"), eur)
        by_dept[dept].append(neto)
        netos.append(neto)
        if i in (0, 1, n - 1):
            cells[f"Empleados!A{x}"] = _cell(nombre)
            cells[f"Empleados!B{x}"] = _cell(dni)
            cells[f"Empleados!D{x}"] = _cell(alta, F.DATE)
            cells[f"Empleados!E{x}"] = _cell(base, F.EUR)
            cells[f"Empleados!G{x}"] = _cell(bruto, F.EUR, f"=E{x}+F{x}")
            cells[f"Empleados!H{x}"] = _cell(ss, F.EUR, f"=ROUND(G{x}*{SS_RATE},2)")
            cells[f"Empleados!I{x}"] = _cell(irpf, F.PCT1)
            cells[f"Empleados!J{x}"] = _cell(neto, F.EUR, f"=ROUND(G{x}-H{x}-G{x}*I{x},2)")
    last = n + 1
    cells["Empleados!A1"] = _cell("Empleado")

    # Resumen: merged title, per-department SUMIF/COUNTIF/AVERAGEIF, cross-sheet refs.
    res.write_merge(0, 0, 0, 3, "Resumen de nóminas", bold)
    for c, h in enumerate(["Departamento", "Empleados", "Neto total", "Neto medio"]):
        res.write(2, c, h, bold)
    rng_dept = f"Empleados!$C$2:$C${last}"
    rng_neto = f"Empleados!$J$2:$J${last}"
    for k, dept in enumerate(DEPTS):
        r = 3 + k
        x = r + 1
        res.write(r, 0, dept)
        res.write(r, 1, xlwt.Formula(f'COUNTIF({rng_dept},A{x})'))
        res.write(r, 2, xlwt.Formula(f'SUMIF({rng_dept},A{x},{rng_neto})'), eur)
        res.write(r, 3, xlwt.Formula(f'ROUND(C{x}/B{x},2)'), eur)
        total = round(sum(by_dept[dept]), 2)
        cells[f"Resumen!A{x}"] = _cell(dept)
        cells[f"Resumen!B{x}"] = _cell(len(by_dept[dept]))
        cells[f"Resumen!C{x}"] = _cell(total, F.EUR)
        cells[f"Resumen!D{x}"] = _cell(F.excel_round(total / len(by_dept[dept]), 2), F.EUR)
    tr = 3 + len(DEPTS)
    tx = tr + 1
    res.write(tr, 0, "Total", bold)
    res.write(tr, 1, xlwt.Formula(f"SUM(B4:B{tr})"))
    res.write(tr, 2, xlwt.Formula(f"SUM(C4:C{tr})"), eur)
    res.write(tr + 1, 0, "Neto máximo")
    res.write(tr + 1, 2, xlwt.Formula(f"MAX({rng_neto})"), eur)
    res.write(tr + 2, 0, "Primer empleado")
    res.write(tr + 2, 2, xlwt.Formula("Empleados!A2"))
    cells[f"Resumen!B{tx}"] = _cell(n)
    cells[f"Resumen!C{tx}"] = _cell(round(sum(netos), 2), F.EUR)
    cells[f"Resumen!C{tx + 1}"] = _cell(max(netos), F.EUR)
    cells[f"Resumen!C{tx + 2}"] = cells["Empleados!A2"] | {}
    cells["Resumen!A1"] = _cell("Resumen de nóminas")

    path = os.path.join(out_dir, name)
    wb.save(path)
    return {
        "file": name, "kind": "xls",
        "description": "Nóminas en formato Excel 97-2003 (.xls, BIFF8): acentos y ñ, DNI como texto, fechas "
                       "dd/mm/aaaa, fórmulas ROUND/SUMIF/COUNTIF/MAX entre hojas sin valores en caché, título "
                       "combinado. Solo lectura: se guarda como .xlsx.",
        "sheets": ["Empleados", "Resumen"], "activeSheet": "Empleados",
        "features": {"Resumen": {"merges": ["A1:D1"]}},
        "cells": cells,
    }


ALL = [nominas_legacy]
