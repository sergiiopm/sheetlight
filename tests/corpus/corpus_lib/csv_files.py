"""Realistic Spanish CSV files (committed in tests/corpus/files/).

Each file is written as raw bytes so that encoding, BOM, delimiter, quoting and
line endings are exactly what we want to exercise. Expected JSON (see
xlsxbook.py for the shared schema) adds:

  "kind": "csv",
  "csv": {"delimiter": ";", "encoding": "utf-8", "decimal": ","},   # what detection must find
  "bom": true, "lineEnding": "crlf",
  "rows": 61, "cols": 6,            # logical records incl. header, max fields per record
  "cells": {"A2": {...}}             # no sheet prefix; may use "anyOf": [CellValue…] when Excel's
                                     # behavior is not what Sheetlight necessarily wants
"""
from __future__ import annotations

import datetime as dt
import os
import random

from . import esfmt as F
from .xlsxbook import cell_value


def _num_es(x: float, thousands: bool = False) -> str:
    s = f"{abs(x):,.2f}" if thousands else f"{abs(x):.2f}"
    s = s.replace(",", "_").replace(".", ",").replace("_", ".")
    return ("-" if x < 0 else "") + s


def _quote(field: str, delim: str) -> str:
    if any(ch in field for ch in (delim, '"', "\n", "\r")):
        return '"' + field.replace('"', '""') + '"'
    return field


def _write(path: str, records: list[list[str]], delim: str, encoding: str, bom: bool, eol: str,
           final_eol: bool = True) -> None:
    text = eol.join(delim.join(_quote(f, delim) for f in rec) for rec in records)
    if final_eol:
        text += eol
    data = text.encode(encoding)
    if bom:
        data = {"utf-8": b"\xef\xbb\xbf", "utf-16-le": b"\xff\xfe"}[encoding] + data
    with open(path, "wb") as fh:
        fh.write(data)


def _expected(name: str, description: str, delim: str, encoding: str, decimal: str, bom: bool, eol: str,
              records: list[list[str]], cells: dict) -> dict:
    return {
        "file": name, "kind": "csv", "description": description,
        "sheets": [os.path.splitext(name)[0]], "activeSheet": os.path.splitext(name)[0],
        "csv": {"delimiter": delim, "encoding": encoding, "decimal": decimal},
        "bom": bom, "lineEnding": "crlf" if eol == "\r\n" else "lf",
        "rows": len(records), "cols": max(len(r) for r in records),
        "cells": cells,
    }


def _cell(value, fmt: str | None = F.GENERAL, display: str | None = "auto") -> dict:
    e = {"value": cell_value(value)}
    if display == "auto":
        v = F.serial(value) if isinstance(value, (dt.date, dt.datetime)) else value
        display = F.display(v, fmt) if fmt is not None else None
    if display is not None:
        e["display"] = display
    return e


def _any(*values) -> dict:
    return {"anyOf": [cell_value(v) for v in values]}


# ---------------------------------------------------------------------------
def movimientos_banco_es(out_dir: str) -> dict:
    rnd = random.Random(101)
    name = "movimientos_banco_es.csv"
    rows = [["Fecha operación", "Fecha valor", "Concepto", "Importe", "Saldo", "Divisa"]]
    saldo = 3250.0
    d = dt.date(2025, 1, 2)
    conceptos = [("Nómina Talleres Martínez S.L.", 2450.0, 2450.0), ("Recibo Iberdrola Clientes, S.A.U.", -112, -48),
                 ("Compra tarjeta 4512, Mercadona", -150, -18), ("Transferencia de José Muñoz", 50, 900),
                 ("Bizum a Lucía", -60, -5), ("Cajero automático", -200, -20), ("Recibo comunidad", -65, -65),
                 ("Compra tarjeta 4512, El Corte Inglés", -320, -25)]
    cells: dict = {}
    for i in range(60):
        d += dt.timedelta(days=rnd.randrange(0, 6))
        valor = d + dt.timedelta(days=rnd.randrange(0, 2))
        concepto, lo, hi = rnd.choice(conceptos)
        imp = round(rnd.uniform(min(lo, hi), max(lo, hi)), 2)
        saldo = round(saldo + imp, 2)
        rows.append([d.strftime("%d/%m/%Y"), valor.strftime("%d/%m/%Y"), concepto, _num_es(imp), _num_es(saldo, True),
                     "EUR"])
        if i < 3 or i == 59:
            r = i + 2
            cells[f"A{r}"] = _cell(d, F.DATE)
            cells[f"B{r}"] = _cell(valor, F.DATE)
            cells[f"C{r}"] = _cell(concepto)
            cells[f"D{r}"] = _cell(imp)
            cells[f"E{r}"] = _cell(saldo)
            cells[f"F{r}"] = _cell("EUR")
    cells["A1"] = _cell("Fecha operación")
    _write(os.path.join(out_dir, name), rows, ";", "utf-8", True, "\r\n")
    return _expected(name, "Extracto bancario español: `;`, coma decimal, miles con punto en el saldo, UTF-8 con "
                           "BOM, CRLF, fechas dd/mm/aaaa, comas dentro de campos sin comillas.",
                     ";", "utf-8", ",", True, "\r\n", rows, cells)


def clientes_win1252(out_dir: str) -> dict:
    name = "clientes_win1252.csv"
    rows = [["Código", "Nombre", "Población", "Observaciones", "Saldo"]]
    data = [
        ("C001", "Peña e Hijos, S.L.", "Logroño", "Cliente preferente", 1234.5),
        ("C002", 'Bar "El Rincón"', "A Coruña", "Paga en efectivo; avisar al encargado", -89.9),
        ("C003", "Ferretería Agüero", "Ávila", "Entregar por la mañana\r\nLlamar antes: 920 123 456", 0.0),
        ("C004", "Lavandería Ça Va", "Girona", "Factura con 2º apellido", 15.75),
        ("C005", "Óptica Núñez", "Cádiz", "¿Descuento? ¡Sí! 5 % — revisar «tarifa»", 2500.0),
        ("C006", "Mª José Ibáñez", "Córdoba", "Importe en €", 99.99),
        ("C007", "ÑAM Comidas", "Málaga", "", 10.0),
        ("C008", "Pérez & Asociados", "L'Hospitalet de Llobregat", "Dirección: C/ Mayor, 1; 2º B", -1500.25),
    ]
    rnd = random.Random(102)
    nombres = ["Panadería Gómez", "Clínica Dental Ruiz", "Transportes Gil", "Farmacia Domínguez",
               "Construcciones Vázquez", "Talleres Ramírez", "Distribuciones Molina"]
    pueblos = ["Jaén", "León", "Cáceres", "Almería", "Lleida", "Ourense", "Teruel", "Segovia"]
    for i in range(8, 25):
        data.append((f"C{i + 1:03d}", rnd.choice(nombres), rnd.choice(pueblos), "", round(rnd.uniform(-300, 3000), 2)))
    cells: dict = {"A1": _cell("Código"), "C1": _cell("Población")}
    for i, (code, nombre, pob, obs, saldo) in enumerate(data):
        rows.append([code, nombre, pob, obs, _num_es(saldo)])
        r = i + 2
        if i < 8:
            cells[f"A{r}"] = _cell(code)
            cells[f"B{r}"] = _cell(nombre)
            cells[f"C{r}"] = _cell(pob)
            cells[f"D{r}"] = _cell(obs if obs else None)
            cells[f"E{r}"] = _cell(saldo)
    # Embedded newlines inside quoted fields are part of the value (normalized to \n when read? keep exact):
    cells["D4"] = {"anyOf": [cell_value("Entregar por la mañana\r\nLlamar antes: 920 123 456"),
                             cell_value("Entregar por la mañana\nLlamar antes: 920 123 456")]}
    _write(os.path.join(out_dir, name), rows, ";", "cp1252", False, "\r\n")
    return _expected(name, "Clientes exportados desde un programa antiguo: Windows-1252 con acentos, ñ, ç, º, ª, €, "
                           "— y «»; `;`; comillas dobles escapadas, `;` y saltos de línea dentro de campos "
                           "entrecomillados; coma decimal.",
                     ";", "windows-1252", ",", False, "\r\n", rows, cells)


def inventario_tabuladores(out_dir: str) -> dict:
    rnd = random.Random(103)
    name = "inventario_tabuladores.csv"
    rows = [["SKU", "Descripción", "Cantidad", "Precio", "Almacén"]]
    descs = ["Tornillo M6, cabeza hexagonal; zincado", "Taladro percutor 750 W", "Cinta aislante 19 mm x 20 m",
             "Llave inglesa 10\"", "Pintura plástica blanca, 15 L", "Manguera 25 m; con racores"]
    cells: dict = {"B1": _cell("Descripción")}
    for i in range(40):
        desc = descs[i % len(descs)]
        qty = rnd.randrange(0, 500)
        price = round(rnd.uniform(0.1, 250), 2)
        rows.append([f"SKU-{20000 + i}", desc, str(qty), f"{price:.2f}", rnd.choice(["Getafe", "Martorell", "Paterna"])])
        if i < 6:
            r = i + 2
            cells[f"A{r}"] = _cell(f"SKU-{20000 + i}")
            cells[f"B{r}"] = _cell(desc)
            cells[f"C{r}"] = _cell(qty)
            cells[f"D{r}"] = _cell(price)
    _write(os.path.join(out_dir, name), rows, "\t", "utf-8", False, "\n")
    return _expected(name, "Inventario separado por tabuladores (UTF-8 sin BOM, LF, punto decimal) con comas, `;` y "
                           "comillas sueltas dentro de los campos para despistar la detección de separador.",
                     "\t", "utf-8", ".", False, "\n", rows, cells)


def unicode_utf16le(out_dir: str) -> dict:
    name = "unicode_utf16le.csv"
    rows = [["País", "Capital", "Moneda", "Habitantes"]]
    data = [("España", "Madrid", "€", 48_600_000), ("Ελλάδα", "Αθήνα", "€", 10_400_000),
            ("日本", "東京", "¥", 124_500_000), ("Paraguay", "Asunción", "₲", 6_900_000),
            ("Polska", "Warszawa", "zł", 36_700_000), ("Türkiye", "Ankara", "₺", 85_300_000),
            ("Россия", "Москва", "₽", 146_000_000), ("Ñandú Land 🐦", "Ñu", "₿", 1)]
    cells: dict = {"A1": _cell("País")}
    for i, (p, c, m, h) in enumerate(data):
        rows.append([p, c, m, str(h)])
        r = i + 2
        cells[f"A{r}"] = _cell(p)
        cells[f"B{r}"] = _cell(c)
        cells[f"C{r}"] = _cell(m)
        cells[f"D{r}"] = _cell(h)
    _write(os.path.join(out_dir, name), rows, "\t", "utf-16-le", True, "\r\n")
    return _expected(name, "Exportación «Texto Unicode» de Excel: UTF-16LE con BOM, tabuladores, CRLF; griego, "
                           "japonés, cirílico, símbolos de moneda y un emoji (par sustituto).",
                     "\t", "utf-16le", ".", True, "\r\n", rows, cells)


def sensores_iso(out_dir: str) -> dict:
    rnd = random.Random(104)
    name = "sensores_iso.csv"
    rows = [["fecha", "fecha_hora", "sensor", "temperatura", "humedad", "presion", "ratio"]]
    t0 = dt.datetime(2025, 2, 14, 8, 30, 0)
    cells: dict = {}
    for i in range(200):
        ts = t0 + dt.timedelta(minutes=15 * i)
        temp = round(rnd.uniform(-5, 18), 2)
        hum = round(rnd.uniform(30, 95), 1)
        pres = round(rnd.uniform(990, 1030), 1)
        ratio = rnd.choice(["1.5e-3", "2.25E-2", "0.5", "3"])
        rows.append([ts.date().isoformat(), ts.strftime("%Y-%m-%d %H:%M:%S"), f"S-{i % 4 + 1:02d}",
                     f"{temp}", f"{hum}", f"{pres}", ratio])
        if i < 3:
            r = i + 2
            cells[f"A{r}"] = _cell(ts.date(), F.DATE)
            cells[f"B{r}"] = _cell(ts, None)
            cells[f"C{r}"] = _cell(f"S-{i % 4 + 1:02d}")
            cells[f"D{r}"] = _cell(temp)
            cells[f"E{r}"] = _cell(hum)
            cells[f"G{r}"] = _cell(float(ratio), None)
    _write(os.path.join(out_dir, name), rows, ",", "utf-8", False, "\n")
    return _expected(name, "Datos de sensores con fechas ISO (aaaa-mm-dd), fecha-hora ISO con espacio, negativos, "
                           "notación científica; `,` y punto decimal, UTF-8 sin BOM, LF.",
                     ",", "utf-8", ".", False, "\n", rows, cells)


def columnas_mixtas(out_dir: str) -> dict:
    name = "columnas_mixtas.csv"
    rows = [
        ["id", "codigo", "valor", "activo", "porcentaje", "cuenta", "notas"],
        ["1", "00123", "42", "TRUE", "12%", "ES7621000418401234567891", "  espacios al inicio y al final  "],
        ["2", "A-17", "texto", "FALSE", "7.5%", "12345678901234567890", "=SUM(A1:A2)"],
        ["3", "4500", "", "VERDADERO", "0%", "0012345678", 'línea con "comillas"'],
        ["4", "0", "N/A", "sí", "100%", "1234567890123456", "+34 600 123 456"],
        ["5", "-12", "#N/A", "0", "-5%", "1e5", "multi\r\nlínea"],
        ["6", "(123)", "1.234", "1", "", "3.14", "✓ ok"],
        ["7", "2025-02-14", "14/02/2025", "", "", "", "-"],
        ["8", "X"],
        ["9", "Y", "1", "TRUE", "1%", "x", "notas", "EXTRA"],
        ["10", "", "", "", "", "", "@usuario"],
    ]
    cells = {
        "A2": _cell(1),
        "B2": _any("00123", 123),
        "C2": _cell(42),
        "D2": _any(True, "TRUE"),
        "E2": _any(0.12, "12%"),
        "F2": _cell("ES7621000418401234567891"),
        "G2": _cell("  espacios al inicio y al final  "),
        "B3": _cell("A-17"),
        "C3": _cell("texto"),
        "D3": _any(False, "FALSE"),
        "F3": _any("12345678901234567890", 12345678901234567890.0),
        # CSV injection: a CSV value that looks like a formula must stay text (never evaluated).
        "G3": _cell("=SUM(A1:A2)"),
        "C4": _cell(None),
        "D4": _any(True, "VERDADERO"),
        "F4": _any("0012345678", 12345678),
        "G4": _cell('línea con "comillas"'),
        "C5": _cell("N/A"),
        "D5": _cell("sí"),
        "G5": _any("+34 600 123 456", 34600123456),
        "C6": {"anyOf": [cell_value("#N/A"), {"type": "error", "value": "#N/A"}]},
        "F6": _any(100000, "1e5"),
        "G6": _any("multi\r\nlínea", "multi\nlínea"),
        "B7": _any(-123, "(123)"),
        "C7": _cell(1.234),
        "G7": _cell("✓ ok"),
        "B8": _any(F.serial(dt.date(2025, 2, 14)), "2025-02-14"),
        "C8": _any("14/02/2025", F.serial(dt.date(2025, 2, 14))),
        "B9": _cell("X"),
        "C9": _cell(None),
        "H10": _cell("EXTRA"),
        "G11": _cell("@usuario"),
    }
    _write(os.path.join(out_dir, name), rows, ",", "utf-8", False, "\r\n", final_eol=False)
    return _expected(name, "Columnas con tipos mezclados: ceros a la izquierda, IBAN, números de 20 dígitos, "
                           "porcentajes, booleanos en/es, #N/A, negativos entre paréntesis, celdas vacías, filas "
                           "con menos y más campos, texto que parece fórmula (inyección CSV), salto de línea dentro "
                           "de comillas, última línea sin salto final.",
                     ",", "utf-8", ".", False, "\r\n", rows, cells)


ALL = [movimientos_banco_es, clientes_win1252, inventario_tabuladores, unicode_utf16le, sensores_iso,
       columnas_mixtas]
