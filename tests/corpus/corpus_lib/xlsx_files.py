"""Realistic Spanish .xlsx files (committed in tests/corpus/files/).

Every generator writes the file through `xlsxbook.Book`, which records the
expected values (computed here in Python, independently of any engine) and the
structural features, and returns the expected dict.
"""
from __future__ import annotations

import datetime as dt
import random

from xlsxwriter.utility import xl_col_to_name

from . import esfmt as F
from .xlsxbook import Book, ErrorValue, png_bytes

MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
MESES_LARGOS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto",
                "Septiembre", "Octubre", "Noviembre", "Diciembre"]


def _styles(b: Book) -> dict:
    return {
        "title": b.fmt(bold=True, font_size=16, align="center", valign="vcenter",
                       bg_color="#DDEBF7", font_color="#1F4E78"),
        "hdr": b.fmt(bold=True, bg_color="#1F4E78", font_color="#FFFFFF", border=1,
                     align="center", valign="vcenter", text_wrap=True),
        "section": b.fmt(bold=True, bg_color="#F2F2F2"),
        "italic": b.fmt(italic=True, font_color="#595959"),
        "bold": b.fmt(bold=True),
        "eur": b.fmt(F.EUR),
        "eur_b": b.fmt(F.EUR, bold=True, top=1, bg_color="#F2F2F2"),
        "eur_red": b.fmt(F.EUR_RED),
        "eur_red_b": b.fmt(F.EUR_RED, bold=True, top=1, bg_color="#F2F2F2"),
        "eur_loc": b.fmt(F.EUR_LOCALE),
        "eur_loc_b": b.fmt(F.EUR_LOCALE, bold=True, top=1, bg_color="#F2F2F2"),
        "eur0": b.fmt(F.EUR0),
        "pct0": b.fmt(F.PCT0),
        "pct1": b.fmt(F.PCT1),
        "pct1_b": b.fmt(F.PCT1, bold=True, top=1, bg_color="#F2F2F2"),
        "pct2": b.fmt(F.PCT2),
        "date": b.fmt(F.DATE),
        "date_long": b.fmt(F.DATE_LONG),
        "num0": b.fmt(F.NUM0),
        "num2": b.fmt(F.NUM2),
        "plain2": b.fmt(F.PLAIN2),
        "text": b.fmt(F.TEXT),
    }


# ---------------------------------------------------------------------------
# 1. Presupuesto familiar
# ---------------------------------------------------------------------------
INGRESOS = [("Nómina", 2450.0), ("Nómina pareja", 1980.0), ("Extras", 150.0)]
GASTOS = [("Hipoteca", 780.0), ("Comunidad", 65.0), ("Luz", 72.0), ("Agua", 28.0), ("Gas", 45.0),
          ("Internet y móvil", 59.9), ("Supermercado", 520.0), ("Transporte", 140.0),
          ("Seguros", 85.0), ("Ocio", 180.0), ("Restaurantes", 120.0), ("Ropa", 90.0),
          ("Salud", 60.0), ("Educación", 110.0), ("Regalos", 40.0)]


def _movimientos(rnd: random.Random) -> list[tuple[dt.date, str, str, str, float]]:
    rows = []

    def add(m, d, concepto, cat, tipo, imp):
        rows.append((dt.date(2025, m, d), concepto, cat, tipo, round(imp, 2)))

    for m in range(1, 13):
        add(m, 28, "Nómina Talleres Martínez", "Nómina", "Ingreso", 2450 * (2 if m in (6, 12) else 1))
        add(m, 27, "Nómina Hospital La Paz", "Nómina pareja", "Ingreso", 1980 * (2 if m in (7, 12) else 1))
        for _ in range(rnd.randrange(0, 3)):
            add(m, rnd.randrange(1, 28), rnd.choice(["Venta Wallapop", "Clases particulares", "Devolución Hacienda"]),
                "Extras", "Ingreso", rnd.uniform(40, 380))
        add(m, 1, "Recibo hipoteca BBVA", "Hipoteca", "Gasto", 780)
        add(m, 5, "Cuota comunidad propietarios", "Comunidad", "Gasto", 65)
        add(m, rnd.randrange(8, 14), "Iberdrola Clientes S.A.U.", "Luz", "Gasto", rnd.uniform(48, 112))
        if m % 2 == 1:
            add(m, 20, "Canal de Isabel II", "Agua", "Gasto", rnd.uniform(38, 66))
        add(m, 15, "Naturgy gas", "Gas", "Gasto", rnd.uniform(70, 120) if m in (1, 2, 3, 11, 12) else rnd.uniform(18, 35))
        add(m, 3, "Movistar fibra + móvil", "Internet y móvil", "Gasto", 59.9)
        for _ in range(rnd.randrange(4, 7)):
            add(m, rnd.randrange(1, 29), rnd.choice(["Mercadona", "Carrefour", "Lidl", "Alcampo", "Frutería Paco"]),
                "Supermercado", "Gasto", rnd.uniform(25, 150))
        for _ in range(rnd.randrange(2, 5)):
            add(m, rnd.randrange(1, 29), rnd.choice(["Abono transporte", "Gasolina Repsol", "Cabify", "Parking"]),
                "Transporte", "Gasto", rnd.uniform(12, 64))
        add(m, 10, "Seguro de vida", "Seguros", "Gasto", 35)
        if m == 3:
            add(m, 18, "Seguro hogar Mapfre (anual)", "Seguros", "Gasto", 420)
        for _ in range(rnd.randrange(1, 5)):
            add(m, rnd.randrange(1, 29), rnd.choice(["Cine Yelmo", "Concierto", "Netflix", "Escapada fin de semana"]),
                "Ocio", "Gasto", rnd.uniform(12, 95))
        for _ in range(rnd.randrange(1, 5)):
            add(m, rnd.randrange(1, 29), rnd.choice(["Restaurante El Puerto", "Telepizza", "Bar Manolo", "Sushi Kō"]),
                "Restaurantes", "Gasto", rnd.uniform(18, 78))
        for _ in range(rnd.randrange(0, 3)):
            add(m, rnd.randrange(1, 29), rnd.choice(["Zara", "Decathlon", "El Corte Inglés"]), "Ropa", "Gasto",
                rnd.uniform(20, 140))
        for _ in range(rnd.randrange(0, 3)):
            add(m, rnd.randrange(1, 29), rnd.choice(["Farmacia", "Dentista", "Óptica"]), "Salud", "Gasto",
                rnd.uniform(9, 95))
        if m not in (7, 8):
            add(m, 2, "Academia de inglés", "Educación", "Gasto", 60)
        if m == 9:
            add(m, 6, "Libros de texto curso 25/26", "Educación", "Gasto", 348.75)
        if m == 12:
            for _ in range(3):
                add(m, rnd.randrange(10, 24), "Regalos de Navidad", "Regalos", "Gasto", rnd.uniform(25, 120))
        elif rnd.random() < 0.3:
            add(m, rnd.randrange(1, 29), "Regalo cumpleaños", "Regalos", "Gasto", rnd.uniform(15, 60))
    rows.sort(key=lambda r: (r[0], r[2], r[1]))
    return rows


def presupuesto_familiar(out_dir: str) -> dict:
    rnd = random.Random(11)
    b = Book(out_dir, "presupuesto_familiar.xlsx",
             "Presupuesto familiar anual: meses x categorías con SUMIFS/SUMIF/VLOOKUP sobre una hoja de "
             "movimientos, %, formatos €, formato condicional, paneles inmovilizados, autofiltro.")
    s = _styles(b)
    pres = b.sheet("Presupuesto 2025")
    movs = b.sheet("Movimientos")
    cats = b.sheet("Categorías")
    pres.activate()

    # Categorías
    cats.row("A1", ["Categoría", "Tipo", "Presupuesto mensual"], s["hdr"])
    all_cats = [(n, "Ingreso", v) for n, v in INGRESOS] + [(n, "Gasto", v) for n, v in GASTOS]
    for i, (n, t, v) in enumerate(all_cats):
        cats.put(f"A{i + 2}", n)
        cats.put(f"B{i + 2}", t)
        cats.put(f"C{i + 2}", v, s["eur"])
    cats.widths({"A": 20, "B": 10, "C": 20})
    last_cat = len(all_cats) + 1

    # Movimientos
    rows = _movimientos(rnd)
    n = len(rows) + 1
    movs.row("A1", ["Fecha", "Concepto", "Categoría", "Tipo", "Importe", "Mes"], s["hdr"])
    for i, (d, concepto, cat, tipo, imp) in enumerate(rows):
        r = i + 2
        movs.put(f"A{r}", d, s["date"], expect=i < 3)
        movs.put(f"B{r}", concepto)
        movs.put(f"C{r}", cat)
        movs.put(f"D{r}", tipo)
        movs.put(f"E{r}", imp, s["eur"], expect=i < 3)
        movs.formula(f"F{r}", f"=MONTH(A{r})", d.month, expect=i < 3)
    movs.freeze(1, 0)
    movs.autofilter(f"A1:F{n}")
    movs.widths({"A": 12, "B": 32, "C": 18, "D": 9, "E": 13, "F": 6})

    def real(cat: str, month: int | None = None) -> float:
        return round(sum(r[4] for r in rows if r[2] == cat and (month is None or r[0].month == month)), 2)

    # Presupuesto 2025
    pres.merge("A1:T1", "Presupuesto familiar 2025", s["title"])
    pres.ws.set_row(0, 28)
    pres.put("A2", "Importes en euros. Real según la hoja Movimientos.", s["italic"])
    pres.row("A3", ["Categoría"] + MESES + ["Total", "Media", "% s/ total", "Total (SUMIF)",
                                           "Presupuesto", "Desviación", "% ejecutado"], s["hdr"])
    rng = lambda col: f"Movimientos!${col}$2:${col}${n}"  # noqa: E731

    def category_row(x: int, name: str, total_row: int, total_value: float):
        pres.put(f"A{x}", name)
        month_vals = []
        for m in range(1, 13):
            col = xl_col_to_name(m)
            v = real(name, m)
            month_vals.append(v)
            pres.formula(f"{col}{x}", f"=SUMIFS({rng('E')},{rng('C')},$A{x},{rng('F')},{m})", v, s["eur"])
        tot = round(sum(month_vals), 2)
        pres.formula(f"N{x}", f"=SUM(B{x}:M{x})", tot, s["eur_loc"])
        pres.formula(f"O{x}", f"=AVERAGE(B{x}:M{x})", tot / 12, s["eur"])
        pres.formula(f"P{x}", f"=N{x}/N${total_row}", tot / total_value, s["pct1"])
        pres.formula(f"Q{x}", f"=SUMIF({rng('C')},$A{x},{rng('E')})", real(name), s["eur"])
        budget = dict((c[0], c[2]) for c in all_cats)[name] * 12
        pres.formula(f"R{x}", f"=VLOOKUP($A{x},Categorías!$A$2:$C${last_cat},3,FALSE)*12", budget, s["eur"])
        pres.formula(f"S{x}", f"=N{x}-R{x}", tot - budget, s["eur_red"])
        pres.formula(f"T{x}", f"=IF(R{x}=0,0,N{x}/R{x})", tot / budget if budget else 0, s["pct1"])
        return month_vals, tot, budget

    def total_row(x: int, label: str, first: int, last: int, sums: list[list[float]], budgets: list[float]):
        pres.put(f"A{x}", label, s["section"])
        months = [round(sum(v[m] for v in sums), 2) for m in range(12)]
        for m in range(12):
            col = xl_col_to_name(m + 1)
            pres.formula(f"{col}{x}", f"=SUM({col}{first}:{col}{last})", months[m], s["eur_b"])
        tot = round(sum(months), 2)
        pres.formula(f"N{x}", f"=SUM(N{first}:N{last})", tot, s["eur_loc_b"])
        pres.formula(f"O{x}", f"=AVERAGE(B{x}:M{x})", tot / 12, s["eur_b"])
        pres.formula(f"P{x}", f"=SUM(P{first}:P{last})", 1.0, s["pct1_b"])
        pres.formula(f"Q{x}", f"=SUM(Q{first}:Q{last})", tot, s["eur_b"])
        bud = sum(budgets)
        pres.formula(f"R{x}", f"=SUM(R{first}:R{last})", bud, s["eur_b"])
        pres.formula(f"S{x}", f"=N{x}-R{x}", tot - bud, s["eur_red_b"])
        pres.formula(f"T{x}", f"=IF(R{x}=0,0,N{x}/R{x})", tot / bud, s["pct1_b"])
        return months, tot

    # Section totals must be known before the category rows (for column P).
    ing_tot = round(sum(real(c) for c, _ in INGRESOS), 2)
    gas_tot = round(sum(real(c) for c, _ in GASTOS), 2)

    pres.put("A4", "INGRESOS", s["section"])
    ing_first = 5
    ing = [category_row(ing_first + i, c, ing_first + len(INGRESOS), ing_tot) for i, (c, _) in enumerate(INGRESOS)]
    ing_total_row = ing_first + len(INGRESOS)
    ing_months, _ = total_row(ing_total_row, "Total ingresos", ing_first, ing_total_row - 1,
                              [v[0] for v in ing], [v[2] for v in ing])

    gas_header = ing_total_row + 2
    pres.put(f"A{gas_header}", "GASTOS", s["section"])
    gas_first = gas_header + 1
    gas_total_row = gas_first + len(GASTOS)
    gas = [category_row(gas_first + i, c, gas_total_row, gas_tot) for i, (c, _) in enumerate(GASTOS)]
    gas_months, _ = total_row(gas_total_row, "Total gastos", gas_first, gas_total_row - 1,
                              [v[0] for v in gas], [v[2] for v in gas])

    ah = gas_total_row + 2
    tasa = ah + 1
    pres.put(f"A{ah}", "Ahorro neto", s["section"])
    pres.put(f"A{tasa}", "Tasa de ahorro", s["section"])
    for m in range(12):
        col = xl_col_to_name(m + 1)
        a = ing_months[m] - gas_months[m]
        pres.formula(f"{col}{ah}", f"={col}{ing_total_row}-{col}{gas_total_row}", a, s["eur_red_b"])
        pres.formula(f"{col}{tasa}", f"=IF({col}{ing_total_row}=0,0,{col}{ah}/{col}{ing_total_row})",
                     a / ing_months[m] if ing_months[m] else 0, s["pct1_b"])
    pres.formula(f"N{ah}", f"=N{ing_total_row}-N{gas_total_row}", ing_tot - gas_tot, s["eur_red_b"])
    pres.formula(f"N{tasa}", f"=IF(N{ing_total_row}=0,0,N{ah}/N{ing_total_row})",
                 (ing_tot - gas_tot) / ing_tot, s["pct1_b"])

    pres.freeze(3, 1)
    pres.widths({"A": 22, "B:M": 10.5, "N:T": 13})
    pres.cond(f"T{gas_first}:T{gas_total_row - 1}",
              {"type": "cell", "criteria": ">", "value": 1,
               "format": b.wb.add_format({"bg_color": "#FFC7CE", "font_color": "#9C0006"})})
    pres.cond(f"B{gas_first}:M{gas_total_row - 1}", {"type": "3_color_scale", "min_color": "#63BE7B",
                                                      "mid_color": "#FFEB84", "max_color": "#F8696B"})
    pres.cond(f"P{gas_first}:P{gas_total_row - 1}", {"type": "data_bar", "bar_color": "#5B9BD5"})
    return b.close()


# ---------------------------------------------------------------------------
# 2. Cuenta de resultados
# ---------------------------------------------------------------------------
GRUPOS = ["Importe neto de la cifra de negocios", "Aprovisionamientos", "Gastos de personal",
          "Otros gastos de explotación", "Amortización del inmovilizado", "Gastos financieros"]
CUENTAS = [
    (700, "Ventas de mercaderías", 0, (9000, 26000), 6),
    (705, "Prestaciones de servicios", 0, (2500, 9000), 5),
    (600, "Compras de mercaderías", 1, (3000, 11000), 5),
    (607, "Trabajos realizados por otras empresas", 1, (400, 2500), 2),
    (640, "Sueldos y salarios", 2, (14500, 14500), 1),
    (642, "Seguridad Social a cargo de la empresa", 2, (4650, 4650), 1),
    (621, "Arrendamientos y cánones", 3, (1800, 1800), 1),
    (622, "Reparaciones y conservación", 3, (90, 900), 1),
    (623, "Servicios de profesionales independientes", 3, (250, 600), 1),
    (625, "Primas de seguros", 3, (180, 180), 1),
    (627, "Publicidad, propaganda y relaciones públicas", 3, (100, 1200), 1),
    (628, "Suministros", 3, (320, 780), 2),
    (629, "Otros servicios", 3, (40, 400), 2),
    (681, "Amortización del inmovilizado material", 4, (1250, 1250), 1),
    (662, "Intereses de deudas", 5, (310, 560), 1),
]


def cuenta_resultados(out_dir: str) -> dict:
    rnd = random.Random(22)
    b = Book(out_dir, "cuenta_resultados.xlsx",
             "Cuenta de pérdidas y ganancias de una pyme: diario contable, SUMIFS por trimestre, VLOOKUP, "
             "XLOOKUP, INDEX/MATCH, MAXIFS, AVERAGEIF, errores #N/A y #DIV/0!, préstamo con PMT y EOMONTH, "
             "VAN/TIR, fechas dd/mm/aaaa, nombres de hoja con acentos y espacios.")
    s = _styles(b)
    pyg = b.sheet("PyG")
    diario = b.sheet("Diario")
    plan = b.sheet("Plan contable")
    prest = b.sheet("Préstamo")
    inv = b.sheet("Inversión")
    pyg.activate()

    # Plan contable
    plan.row("A1", ["Código", "Cuenta", "Grupo"], s["hdr"])
    for i, (code, name, g, _, _) in enumerate(CUENTAS):
        plan.put(f"A{i + 2}", code)
        plan.put(f"B{i + 2}", name)
        plan.put(f"C{i + 2}", GRUPOS[g])
    plan.widths({"A": 8, "B": 44, "C": 38})
    last_plan = len(CUENTAS) + 1
    plan_rng = lambda col: f"'Plan contable'!${col}$2:${col}${last_plan}"  # noqa: E731

    # Diario
    entries = []
    asiento = 0
    for m in range(1, 13):
        for code, name, g, (lo, hi), per_month in CUENTAS:
            for _ in range(per_month):
                asiento += 1
                day = rnd.randrange(1, 29)
                amount = round(rnd.uniform(lo, hi) / (per_month if lo != hi else 1), 2)
                concepto = f"{name} {MESES_LARGOS[m - 1].lower()}"
                entries.append((dt.date(2025, m, day), code, concepto, amount, g))
    entries.sort(key=lambda e: (e[0], e[1]))
    diario.row("A1", ["Fecha", "Asiento", "Cuenta", "Concepto", "Importe", "Grupo", "Mes", "Trimestre"], s["hdr"])
    for i, (d, code, concepto, amount, g) in enumerate(entries):
        r = i + 2
        exp = i < 3
        diario.put(f"A{r}", d, s["date"], expect=exp)
        diario.put(f"B{r}", i + 1)
        diario.put(f"C{r}", code)
        diario.put(f"D{r}", concepto)
        diario.put(f"E{r}", amount, s["eur"], expect=exp)
        diario.formula(f"F{r}", f"=VLOOKUP(C{r},'Plan contable'!$A$2:$C${last_plan},3,FALSE)",
                       GRUPOS[g], expect=exp)
        diario.formula(f"G{r}", f"=MONTH(A{r})", d.month, expect=exp)
        diario.formula(f"H{r}", f'="T"&ROUNDUP(G{r}/3,0)', f"T{(d.month - 1) // 3 + 1}", expect=exp)
    n = len(entries) + 1
    diario.freeze(1, 0)
    diario.autofilter(f"A1:H{n}")
    diario.widths({"A": 12, "B": 8, "C": 8, "D": 46, "E": 13, "F": 34, "G": 6, "H": 9})
    drng = lambda col: f"Diario!${col}$2:${col}${n}"  # noqa: E731

    def total(g: int, q: int | None = None) -> float:
        return round(sum(e[3] for e in entries if e[4] == g and (q is None or (e[0].month - 1) // 3 + 1 == q)), 2)

    # PyG
    pyg.merge("A1:G1", "Cuenta de pérdidas y ganancias 2025", s["title"])
    pyg.ws.set_row(0, 28)
    pyg.put("A2", "Talleres Martínez S.L. · Importes en euros", s["italic"])
    pyg.row("A4", ["Concepto", "T1", "T2", "T3", "T4", "Total 2025", "% s/ ventas"], s["hdr"])
    quarters = ["T1", "T2", "T3", "T4"]
    vals: dict[str, list[float]] = {}

    def group_line(x: int, g: int, sign: int):
        pyg.put(f"A{x}", GRUPOS[g])
        qv = []
        for qi, q in enumerate(quarters):
            col = "BCDE"[qi]
            v = sign * total(g, qi + 1)
            qv.append(v)
            minus = "-" if sign < 0 else ""
            pyg.formula(f"{col}{x}", f"={minus}SUMIFS({drng('E')},{drng('F')},$A{x},{drng('H')},{col}$4)", v,
                        s["eur_red"])
        vals[str(x)] = qv

    def sum_line(x: int, label: str, terms: list[int]):
        pyg.put(f"A{x}", label, s["section"])
        qv = [sum(vals[str(t)][qi] for t in terms) for qi in range(4)]
        for qi in range(4):
            col = "BCDE"[qi]
            if len(terms) == 2:
                f = f"={col}{terms[0]}+{col}{terms[1]}"
            else:
                f = f"=SUM({col}{terms[0]}:{col}{terms[-1]})"
            pyg.formula(f"{col}{x}", f, qv[qi], s["eur_red_b"])
        vals[str(x)] = qv

    group_line(5, 0, 1)
    group_line(6, 1, -1)
    group_line(7, 2, -1)
    group_line(8, 3, -1)
    sum_line(9, "EBITDA", [5, 6, 7, 8])
    group_line(10, 4, -1)
    sum_line(11, "Resultado de explotación", [9, 10])
    group_line(12, 5, -1)
    sum_line(13, "Resultado antes de impuestos", [11, 12])
    pyg.put("A14", "Impuesto sobre beneficios (25 %)")
    tax = []
    for qi in range(4):
        col = "BCDE"[qi]
        t = -F.excel_round(max(0.0, vals["13"][qi]) * 0.25, 2)
        tax.append(t)
        pyg.formula(f"{col}14", f"=-ROUND(MAX(0,{col}13)*25%,2)", t, s["eur_red"])
    vals["14"] = tax
    sum_line(15, "Resultado del ejercicio", [13, 14])
    ventas_total = sum(vals["5"])
    for x in range(5, 16):
        tot = sum(vals[str(x)])
        fmt = s["eur_red_b"] if x in (9, 11, 13, 15) else s["eur_red"]
        pyg.formula(f"F{x}", f"=SUM(B{x}:E{x})", tot, fmt)
        pyg.formula(f"G{x}", f"=IF($F$5=0,0,F{x}/$F$5)", tot / ventas_total, s["pct1"])

    pyg.put("A17", "Detalle por cuenta", s["bold"])
    pyg.row("A18", ["Código", "Cuenta", "Grupo", "Total", "Nº apuntes", "Media", "Máximo"], s["hdr"])
    for i, (code, name, g, _, _) in enumerate(CUENTAS):
        x = 19 + i
        amounts = [e[3] for e in entries if e[1] == code]
        pyg.put(f"A{x}", code)
        pyg.formula(f"B{x}", f"=INDEX({plan_rng('B')},MATCH(A{x},{plan_rng('A')},0))", name)
        pyg.formula(f"C{x}", f'=XLOOKUP(A{x},{plan_rng("A")},{plan_rng("C")},"Sin grupo")', GRUPOS[g])
        pyg.formula(f"D{x}", f"=SUMIF({drng('C')},A{x},{drng('E')})", round(sum(amounts), 2), s["eur"])
        pyg.formula(f"E{x}", f"=COUNTIF({drng('C')},A{x})", len(amounts))
        pyg.formula(f"F{x}", f"=IFERROR(AVERAGEIF({drng('C')},A{x},{drng('E')}),0)",
                    sum(amounts) / len(amounts), s["eur"])
        pyg.formula(f"G{x}", f"=MAXIFS({drng('E')},{drng('C')},A{x})", max(amounts), s["eur"])
    x = 19 + len(CUENTAS)
    pyg.put(f"A{x}", 999)
    pyg.formula(f"B{x}", f'=IFERROR(INDEX({plan_rng("B")},MATCH(A{x},{plan_rng("A")},0)),"No existe")', "No existe")
    pyg.formula(f"C{x}", f'=XLOOKUP(A{x},{plan_rng("A")},{plan_rng("C")},"Sin grupo")', "Sin grupo")
    pyg.formula(f"D{x}", f"=SUMIF({drng('C')},A{x},{drng('E')})", 0.0, s["eur"])
    pyg.formula(f"E{x}", f"=COUNTIF({drng('C')},A{x})", 0)
    pyg.formula(f"F{x}", f"=VLOOKUP(A{x},'Plan contable'!$A$2:$C${last_plan},2,FALSE)", ErrorValue("#N/A"))
    pyg.formula(f"G{x}", f"=D{x}/E{x}", ErrorValue("#DIV/0!"))
    pyg.freeze(4, 1)
    pyg.widths({"A": 40, "B:E": 14, "F": 15, "G": 12})

    # Préstamo
    capital, rate, years, start = 150000.0, 0.045, 10, dt.date(2025, 1, 15)
    cuota = F.pmt(rate / 12, years * 12, -capital)
    prest.merge("A1:F1", "Préstamo hipotecario", s["title"])
    prest.put("A3", "Capital")
    prest.put("B3", capital, s["eur"], expect=True)
    prest.put("A4", "Interés anual")
    prest.put("B4", rate, s["pct2"], expect=True)
    prest.put("A5", "Años")
    prest.put("B5", years)
    prest.put("A6", "Fecha de inicio")
    prest.put("B6", start, s["date"], expect=True)
    prest.put("A7", "Cuota mensual")
    prest.formula("B7", "=PMT(B4/12,B5*12,-B3)", cuota, s["eur"])
    prest.put("A8", "Total intereses")
    prest.formula("B8", "=B7*B5*12-B3", cuota * years * 12 - capital, s["eur"])
    prest.put("A9", "Fecha fin")
    fin = F.eomonth(start, years * 12 - 1)
    prest.formula("B9", "=EOMONTH(B6,B5*12-1)", fin, s["date"])
    prest.formula("C9", "=B9", fin, s["date_long"])
    prest.row("A11", ["Nº", "Fecha", "Cuota", "Intereses", "Amortización", "Capital pendiente"], s["hdr"])
    saldo = capital
    sums = [0.0, 0.0, 0.0]
    for k in range(1, 25):
        x = 11 + k
        interes = saldo * rate / 12
        amort = cuota - interes
        nuevo = saldo - amort
        prest.put(f"A{x}", k)
        prest.formula(f"B{x}", f"=EOMONTH($B$6,A{x}-1)", F.eomonth(start, k - 1), s["date"])
        prest.formula(f"C{x}", "=$B$7", cuota, s["eur"])
        prev = "$B$3" if k == 1 else f"F{x - 1}"
        prest.formula(f"D{x}", f"={prev}*$B$4/12", interes, s["eur"])
        prest.formula(f"E{x}", f"=C{x}-D{x}", amort, s["eur"])
        prest.formula(f"F{x}", f"={prev}-E{x}", nuevo, s["eur"])
        sums[0] += cuota
        sums[1] += interes
        sums[2] += amort
        saldo = nuevo
    prest.put("A36", "Totales 24 meses", s["section"])
    for i, col in enumerate("CDE"):
        prest.formula(f"{col}36", f"=SUM({col}12:{col}35)", sums[i], s["eur_b"])
    prest.freeze(11, 0)
    prest.widths({"A": 16, "B": 14, "C:F": 16})

    # Inversión
    flows = [-50000.0, 12000.0, 15000.0, 18000.0, 20000.0, 22000.0]
    inv.merge("A1:C1", "Análisis de inversión", s["title"])
    inv.put("A3", "Tasa de descuento")
    inv.put("B3", 0.08, s["pct1"], expect=True)
    inv.row("A5", ["Año", "Flujo de caja"], s["hdr"])
    for i, v in enumerate(flows):
        inv.put(f"A{6 + i}", i)
        inv.put(f"B{6 + i}", v, s["eur_red"])
    inv.put("A13", "VAN")
    inv.formula("B13", "=NPV(B3,B7:B11)+B6", F.npv(0.08, flows[1:]) + flows[0], s["eur_red"])
    inv.put("A14", "TIR")
    inv.formula("B14", "=IRR(B6:B11)", F.irr(flows), s["pct2"])
    inv.put("A15", "Ahorro a 5 años (300 €/mes al 3 %)")
    inv.formula("B15", "=FV(0.03/12,60,-300,0,0)", F.fv(0.03 / 12, 60, -300), s["eur"])
    inv.put("A16", "Plazo de recuperación (años)")
    acc, payback = flows[0], None
    for i, v in enumerate(flows[1:], start=1):
        if acc < 0 <= acc + v:
            payback = i - 1 + (-acc / v)
        acc += v
    inv.formula("B16", "=ROUND(3+(-(B6+B7+B8+B9))/B10,2)", F.excel_round(payback, 2), s["plain2"])
    inv.widths({"A": 34, "B": 16})
    return b.close()


# ---------------------------------------------------------------------------
# 3. Clientes e inventario
# ---------------------------------------------------------------------------
POBLACIONES = [("Madrid", "Madrid", "28"), ("Alcalá de Henares", "Madrid", "28"), ("Barcelona", "Barcelona", "08"),
               ("L'Hospitalet de Llobregat", "Barcelona", "08"), ("Valencia", "Valencia", "46"),
               ("Sevilla", "Sevilla", "41"), ("Zaragoza", "Zaragoza", "50"), ("Málaga", "Málaga", "29"),
               ("Bilbao", "Bizkaia", "48"), ("A Coruña", "A Coruña", "15"), ("Ávila", "Ávila", "05"),
               ("Cádiz", "Cádiz", "11"), ("Córdoba", "Córdoba", "14"), ("Logroño", "La Rioja", "26"),
               ("Gijón", "Asturias", "33"), ("Castelló de la Plana", "Castellón", "12")]
APELLIDOS = ["García", "Martínez", "López", "Sánchez", "Pérez", "Gómez", "Martín", "Jiménez", "Ruiz",
             "Hernández", "Díaz", "Moreno", "Muñoz", "Álvarez", "Romero", "Alonso", "Gutiérrez", "Navarro",
             "Torres", "Domínguez", "Vázquez", "Ramos", "Gil", "Ramírez", "Serrano", "Blanco", "Molina",
             "Ibáñez", "Núñez", "Agüero", "Peña", "Castaño"]
TIPOS_EMPRESA = ["Ferretería {a} S.L.", "Distribuciones {a} S.A.", "{a} e Hijos S.L.", "Talleres {a}",
                 "{a} & Asociados", "Construcciones {a} S.L.U.", "Farmacia {a}", "Panadería {a}",
                 "Clínica Dental {a}", "Transportes {a} S.L."]
CALLES = ["C/ Mayor", "Avda. de la Constitución", "C/ Real", "Plaza de España", "C/ del Sol",
          "Paseo de la Castellana", "C/ San Juan", "Rambla de Catalunya", "C/ Doctor Fleming"]


def _ascii(s: str) -> str:
    table = str.maketrans("áéíóúüñÁÉÍÓÚÜÑ' &", "aeiouunAEIOUUN---")
    return s.translate(table).lower().replace(".", "").replace("--", "-")


def clientes_inventario(out_dir: str) -> dict:
    rnd = random.Random(33)
    b = Book(out_dir, "clientes_inventario.xlsx",
             "Listado de clientes con autofiltro activo (filas ocultas por el filtro), columna oculta, CP y "
             "teléfonos como texto, booleanos; inventario con encabezados combinados, filas ocultas, "
             "SUBTOTAL 9/109, paneles inmovilizados y anchos de columna; resumen con COUNTIF/COUNTIFS/"
             "SUMIF/AVERAGEIF/LARGE/MEDIAN.")
    s = _styles(b)
    cli = b.sheet("Clientes")
    inv = b.sheet("Inventario")
    res = b.sheet("Resumen")
    cli.activate()

    # Clientes
    hdr = ["Código", "Nombre", "NIF", "Dirección", "CP", "Ciudad", "Provincia", "Teléfono", "Email",
           "Fecha alta", "Activo", "Límite crédito", "Saldo pendiente", "Riesgo", "Notas internas"]
    cli.row("A1", hdr, s["hdr"])
    clients = []
    for i in range(250):
        r = i + 2
        ap = rnd.choice(APELLIDOS)
        name = rnd.choice(TIPOS_EMPRESA).format(a=ap)
        city, prov, cp2 = rnd.choice(POBLACIONES)
        cp = f"{cp2}{rnd.randrange(0, 1000):03d}"
        nif = f"{rnd.choice('ABJ')}{rnd.randrange(10**7, 10**8):08d}"
        tel = f"9{rnd.randrange(10, 99)} {rnd.randrange(100, 999)} {rnd.randrange(100, 999)}"
        email = f"{_ascii(ap)}{i + 1}@{_ascii(name.split()[0])}.es"
        alta = dt.date(2015, 1, 1) + dt.timedelta(days=rnd.randrange(0, 3900))
        activo = rnd.random() > 0.2
        limite = float(rnd.choice([3000, 5000, 10000, 20000]))
        saldo = round(rnd.uniform(0, limite * 1.2), 2)
        riesgo = "Alto" if saldo > limite else ("Medio" if saldo > limite * 0.8 else "Bajo")
        clients.append((city, prov, activo, limite, saldo, riesgo))
        exp = i < 5
        cli.put(f"A{r}", f"C{i + 1:04d}", expect=exp)
        cli.put(f"B{r}", name, expect=exp)
        cli.put(f"C{r}", nif)
        cli.put(f"D{r}", f"{rnd.choice(CALLES)}, {rnd.randrange(1, 140)}")
        cli.put(f"E{r}", cp, s["text"], expect=exp)
        cli.put(f"F{r}", city, expect=exp)
        cli.put(f"G{r}", prov, expect=exp)
        cli.put(f"H{r}", tel, s["text"], expect=exp)
        cli.put(f"I{r}", email)
        cli.put(f"J{r}", alta, s["date"], expect=exp)
        cli.put(f"K{r}", activo, expect=exp)
        cli.put(f"L{r}", limite, s["eur0"], expect=exp)
        cli.put(f"M{r}", saldo, s["eur"], expect=exp)
        cli.formula(f"N{r}", f'=IF(M{r}>L{r},"Alto",IF(M{r}>L{r}*0.8,"Medio","Bajo"))', riesgo, expect=i < 20)
        cli.put(f"O{r}", "Revisar condiciones de pago" if saldo > limite else "")
    cli.autofilter("A1:O251")
    keep = ["Madrid", "Barcelona"]
    cli.filter_list("G", keep)
    hidden = [i + 1 for i, c in enumerate(clients) if c[1] not in keep]
    for r in hidden:
        cli.ws.set_row(r, None, None, {"hidden": True})
    cli.features["hiddenRows"] = hidden
    cli.freeze(1, 2)
    cli.widths({"A": 8, "B": 34, "C": 11, "D": 30, "E": 7, "F": 24, "G": 12, "H": 13, "I": 30,
                "J": 11, "K": 8, "L": 13, "M": 15, "N": 8})
    cli.hide_col("O", 30)

    # Inventario
    inv.merge("A1:C1", "Producto", s["hdr"])
    inv.merge("D1:F1", "Existencias", s["hdr"])
    inv.merge("G1:I1", "Valoración", s["hdr"])
    inv.merge("J1:K1", "Análisis", s["hdr"])
    inv.row("A2", ["SKU", "Descripción", "Categoría", "Stock", "Mínimo", "Ubicación", "Coste unitario", "PVP",
                   "Valor stock", "Reponer", "Margen"], s["hdr"])
    cats = ["Tornillería", "Herramientas", "Electricidad", "Fontanería", "Pintura", "Jardín"]
    items = []
    for i in range(120):
        r = i + 3
        cat = rnd.choice(cats)
        stock = rnd.randrange(0, 400)
        minimo = rnd.choice([10, 20, 25, 50])
        coste = round(rnd.uniform(0.15, 85), 2)
        pvp = round(coste * rnd.uniform(1.25, 2.1), 2)
        items.append((stock, minimo, coste, pvp, r - 1))
        exp = i < 5
        inv.put(f"A{r}", f"SKU-{10000 + i * 7}", expect=exp)
        inv.put(f"B{r}", f"{cat[:-1] if cat.endswith('s') else cat} ref. {rnd.randrange(100, 999)}")
        inv.put(f"C{r}", cat)
        inv.put(f"D{r}", stock, s["num0"], expect=exp)
        inv.put(f"E{r}", minimo)
        inv.put(f"F{r}", f"Pasillo {rnd.randrange(1, 9)} - {rnd.choice('ABCD')}{rnd.randrange(1, 6)}")
        inv.put(f"G{r}", coste, s["eur"])
        inv.put(f"H{r}", pvp, s["eur"])
        inv.formula(f"I{r}", f"=D{r}*G{r}", stock * coste, s["eur"], expect=exp)
        inv.formula(f"J{r}", f'=IF(D{r}<E{r},"Sí","No")', "Sí" if stock < minimo else "No", expect=exp)
        inv.formula(f"K{r}", f"=IF(H{r}=0,0,(H{r}-G{r})/H{r})", (pvp - coste) / pvp, s["pct1"], expect=exp)
    hidden_inv = [40, 41, 42]  # 0-based: Excel rows 41-43 ("descatalogados")
    inv.hide_rows(hidden_inv)
    vis = [it for it in items if it[4] not in hidden_inv]
    inv.put("A124", "Total", s["section"])
    inv.formula("D124", "=SUBTOTAL(9,D3:D122)", sum(it[0] for it in items), s["num0"])
    inv.formula("I124", "=SUBTOTAL(9,I3:I122)", sum(it[0] * it[2] for it in items), s["eur_b"])
    inv.put("A125", "Total (SUM)")
    inv.formula("D125", "=SUM(D3:D122)", sum(it[0] for it in items), s["num0"])
    inv.put("A126", "Total visibles (SUBTOTAL 109)")
    inv.formula("D126", "=SUBTOTAL(109,D3:D122)", sum(it[0] for it in vis), s["num0"])
    inv.formula("I126", "=SUBTOTAL(109,I3:I122)", sum(it[0] * it[2] for it in vis), s["eur"])
    inv.put("A127", "Productos a reponer")
    inv.formula("D127", '=COUNTIF(J3:J122,"Sí")', sum(1 for it in items if it[0] < it[1]))
    inv.freeze(2, 1)
    inv.autofilter("A2:K122")
    inv.widths({"A": 12, "B": 28, "C": 14, "D:E": 8, "F": 16, "G:I": 14, "J": 9, "K": 9})

    # Resumen
    res.row("A1", ["Provincia", "Clientes", "Activos", "Saldo pendiente", "Límite medio"], s["hdr"])
    provs = sorted({p[1] for p in POBLACIONES})
    for i, prov in enumerate(provs):
        r = i + 2
        sel = [c for c in clients if c[1] == prov]
        res.put(f"A{r}", prov)
        res.formula(f"B{r}", f"=COUNTIF(Clientes!$G$2:$G$251,A{r})", len(sel))
        res.formula(f"C{r}", f"=COUNTIFS(Clientes!$G$2:$G$251,A{r},Clientes!$K$2:$K$251,TRUE)",
                    sum(1 for c in sel if c[2]))
        res.formula(f"D{r}", f"=SUMIF(Clientes!$G$2:$G$251,A{r},Clientes!$M$2:$M$251)",
                    round(sum(c[4] for c in sel), 2), s["eur"])
        avg = sum(c[3] for c in sel) / len(sel) if sel else ErrorValue("#DIV/0!")
        res.formula(f"E{r}", f"=AVERAGEIF(Clientes!$G$2:$G$251,A{r},Clientes!$L$2:$L$251)", avg, s["eur"])
    r = len(provs) + 3
    saldos = sorted(c[4] for c in clients)
    res.put(f"A{r}", "Total clientes")
    res.formula(f"B{r}", "=COUNTA(Clientes!A2:A251)", 250)
    res.put(f"A{r + 1}", "Saldo máximo")
    res.formula(f"B{r + 1}", "=MAX(Clientes!M2:M251)", saldos[-1], s["eur"])
    res.put(f"A{r + 2}", "Tercer mayor saldo")
    res.formula(f"B{r + 2}", "=LARGE(Clientes!M2:M251,3)", saldos[-3], s["eur"])
    res.put(f"A{r + 3}", "Mediana saldo")
    res.formula(f"B{r + 3}", "=MEDIAN(Clientes!M2:M251)", (saldos[124] + saldos[125]) / 2, s["eur"])
    res.put(f"A{r + 4}", "Clientes riesgo alto")
    res.formula(f"B{r + 4}", '=COUNTIF(Clientes!N2:N251,"Alto")', sum(1 for c in clients if c[5] == "Alto"))
    res.widths({"A": 22, "B:C": 10, "D:E": 16})
    return b.close()


# ---------------------------------------------------------------------------
# 4. Informe de ventas con gráficos
# ---------------------------------------------------------------------------
def informe_ventas(out_dir: str) -> dict:
    rnd = random.Random(44)
    b = Book(out_dir, "informe_ventas.xlsx",
             "Informe con 3 gráficos (columnas agrupadas, líneas, circular), una imagen, 3 comentarios, "
             "3 validaciones de datos (lista, número entero, fecha), hipervínculos interno y externo, "
             "nombres definidos, conjunto de iconos, INDEX/MATCH/MAX.")
    s = _styles(b)
    inf = b.sheet("Informe")
    dat = b.sheet("Datos")
    inf.activate()

    regiones = ["Norte", "Sur", "Este", "Oeste"]
    dat.row("A1", ["Mes"] + regiones + ["Total", "Objetivo", "% objetivo"], s["hdr"])
    season = [0.8, 0.85, 0.95, 1.0, 1.05, 1.15, 1.25, 1.1, 0.95, 1.0, 1.1, 1.4]
    table = []
    for m in range(12):
        r = m + 2
        vals = [round(rnd.uniform(8000, 20000) * season[m]) for _ in regiones]
        obj = 60000.0
        tot = float(sum(vals))
        table.append((vals, tot, obj))
        dat.put(f"A{r}", MESES_LARGOS[m])
        for j, v in enumerate(vals):
            dat.put(f"{'BCDE'[j]}{r}", v, s["eur0"])
        dat.formula(f"F{r}", f"=SUM(B{r}:E{r})", tot, s["eur0"])
        dat.put(f"G{r}", obj, s["eur0"])
        dat.formula(f"H{r}", f"=F{r}/G{r}", tot / obj, s["pct1"])
    dat.put("A14", "Total", s["section"])
    col_tot = [float(sum(t[0][j] for t in table)) for j in range(4)]
    for j, col in enumerate("BCDE"):
        dat.formula(f"{col}14", f"=SUM({col}2:{col}13)", col_tot[j], s["eur0"])
    grand = sum(col_tot)
    dat.formula("F14", "=SUM(F2:F13)", grand, s["eur0"])
    dat.formula("G14", "=SUM(G2:G13)", 720000.0, s["eur0"])
    dat.formula("H14", "=F14/G14", grand / 720000.0, s["pct1"])
    dat.cond("H2:H13", {"type": "icon_set", "icon_style": "3_arrows"})
    dat.freeze(1, 1)
    dat.widths({"A": 12, "B:G": 12, "H": 11})
    b.define_name("Ventas", "Datos!$F$2:$F$13")
    b.define_name("Regiones", "Datos!$B$1:$E$1")

    inf.image("A1", png_bytes(96, 48, 7), "logo.png", {"x_scale": 1.0, "y_scale": 1.0})
    inf.merge("C2:H2", "Informe de ventas 2025", s["title"])
    inf.ws.set_row(1, 30)
    best = max(range(12), key=lambda m: table[m][1])
    kpis = [
        ("A5", "Ventas totales", "B5", "=Datos!F14", grand, s["eur0"]),
        ("A6", "Mejor mes", "B6", "=INDEX(Datos!A2:A13,MATCH(MAX(Datos!F2:F13),Datos!F2:F13,0))",
         MESES_LARGOS[best], None),
        ("A7", "Crecimiento dic. / ene.", "B7", "=Datos!F13/Datos!F2-1", table[11][1] / table[0][1] - 1, s["pct1"]),
    ]
    for la, label, ref, f, v, fm in kpis:
        inf.put(la, label, s["bold"])
        inf.formula(ref, f, v, fm)
    inf.put("A8", "Región seleccionada", s["bold"])
    inf.put("B8", "Sur", expect=True)
    inf.validation("B8", {"validate": "list", "source": "=Regiones", "input_title": "Región",
                          "input_message": "Elija una región"})
    inf.put("A9", "Ventas de la región", s["bold"])
    inf.formula("B9", "=INDEX(Datos!B14:E14,MATCH(B8,Regiones,0))", col_tot[1], s["eur0"])
    inf.put("A10", "Mes (1-12)", s["bold"])
    inf.put("B10", 6, expect=True)
    inf.validation("B10", {"validate": "integer", "criteria": "between", "minimum": 1, "maximum": 12,
                           "error_title": "Mes no válido", "error_message": "Introduzca un número de 1 a 12"})
    inf.put("A11", "Ventas del mes", s["bold"])
    inf.formula("B11", "=INDEX(Ventas,B10)", table[5][1], s["eur0"])
    inf.put("A12", "Fecha de corte", s["bold"])
    inf.put("B12", dt.date(2025, 12, 31), s["date"], expect=True)
    inf.validation("B12", {"validate": "date", "criteria": "between",
                           "minimum": dt.date(2025, 1, 1), "maximum": dt.date(2025, 12, 31)})
    inf.put("A13", "Media mensual", s["bold"])
    inf.formula("B13", "=AVERAGE(Ventas)", grand / 12, s["eur0"])
    inf.comment("B5", "Incluye las cuatro regiones. Fuente: ERP.")
    inf.comment("B6", "Mes con mayor facturación total.")
    inf.comment("B9", "Cambie la región en B8 (lista desplegable).")
    inf.link("A15", "internal:Datos!A1", "Ver datos")
    inf.link("A16", "https://www.ine.es/", "Fuente: INE")
    inf.widths({"A": 24, "B": 14})

    col = b.add_chart({"type": "column"})
    for j, reg in enumerate(regiones):
        c = "BCDE"[j]
        col.add_series({"name": f"=Datos!${c}$1", "categories": "=Datos!$A$2:$A$13",
                        "values": f"=Datos!${c}$2:${c}$13"})
    col.set_title({"name": "Ventas por región"})
    col.set_y_axis({"name": "Euros", "num_format": "#,##0"})
    col.set_legend({"position": "bottom"})
    inf.chart("D5", col, {"x_scale": 1.3, "y_scale": 1.1})

    line = b.add_chart({"type": "line"})
    line.add_series({"name": "=Datos!$F$1", "categories": "=Datos!$A$2:$A$13", "values": "=Datos!$F$2:$F$13",
                     "marker": {"type": "circle"}})
    line.add_series({"name": "=Datos!$G$1", "categories": "=Datos!$A$2:$A$13", "values": "=Datos!$G$2:$G$13",
                     "line": {"dash_type": "dash"}})
    line.set_title({"name": "Total vs objetivo"})
    line.set_legend({"position": "bottom"})
    inf.chart("D22", line, {"x_scale": 1.3, "y_scale": 1.0})

    pie = b.add_chart({"type": "pie"})
    pie.add_series({"name": "Reparto anual", "categories": "=Datos!$B$1:$E$1", "values": "=Datos!$B$14:$E$14",
                    "data_labels": {"percentage": True}})
    pie.set_title({"name": "Reparto por región"})
    inf.chart("M5", pie)
    return b.close()


# ---------------------------------------------------------------------------
# 5. Facturas
# ---------------------------------------------------------------------------
def facturas(out_dir: str) -> dict:
    rnd = random.Random(55)
    b = Book(out_dir, "facturas.xlsx",
             "Factura con bloque de emisor combinado y ajustado, líneas con descuento, bases e IVA por tipo "
             "(21/10/4 %) con SUMIF, retención IRPF con literal 15% en la fórmula, cuadre; registro de "
             "facturas con referencias entre hojas, SUMIFS con criterios de fecha concatenados, booleanos.")
    s = _styles(b)
    fac = b.sheet("Factura")
    reg = b.sheet("Registro")
    fac.activate()
    wrap = b.fmt(text_wrap=True, valign="top", border=1)
    big = b.fmt(bold=True, font_size=20, font_color="#1F4E78")

    fac.merge("A1:D4", "Talleres Martínez S.L.\nCIF B12345678\nC/ Mayor, 15 - 28013 Madrid\nTel. 912 345 678",
              wrap)
    fac.put("F1", "FACTURA", big)
    fac.put("F2", "Nº")
    fac.put("G2", "2025-0042", expect=True)
    fac.put("F3", "Fecha")
    fecha = dt.date(2025, 2, 14)
    fac.put("G3", fecha, s["date"], expect=True)
    fac.put("F4", "Vencimiento")
    fac.formula("G4", "=G3+30", fecha + dt.timedelta(days=30), s["date"])
    fac.put("A6", "Cliente:", s["bold"])
    fac.put("B6", "Distribuciones Núñez S.A.")
    fac.put("B7", "NIF A87654321")
    fac.put("B8", "Avda. de la Constitución, 3 - 41001 Sevilla")
    fac.row("A10", ["Concepto", "Cantidad", "Precio unitario", "Dto.", "IVA", "Base imponible", "Cuota IVA",
                    "Total"], s["hdr"])
    lines = [("Revisión general vehículo", 1, 180.00, 0.0, 0.21),
             ("Aceite sintético 5W30 (litros)", 5, 12.40, 0.10, 0.21),
             ("Filtro de aceite", 1, 14.95, 0.0, 0.21),
             ("Pastillas de freno delanteras", 2, 38.50, 0.05, 0.21),
             ("Mano de obra (horas)", 3.5, 42.00, 0.0, 0.21),
             ("Libro de mantenimiento", 1, 9.90, 0.0, 0.04),
             ("Servicio de recogida a domicilio", 1, 25.00, 0.0, 0.10),
             ("Lavado interior", 1, 18.00, 0.15, 0.21)]
    bases, cuotas = [], []
    for i, (concepto, qty, price, dto, iva) in enumerate(lines):
        r = 11 + i
        base = F.excel_round(qty * price * (1 - dto), 2)
        cuota = F.excel_round(base * iva, 2)
        bases.append((base, iva))
        cuotas.append(cuota)
        fac.put(f"A{r}", concepto)
        fac.put(f"B{r}", qty)
        fac.put(f"C{r}", price, s["eur"])
        fac.put(f"D{r}", dto, s["pct0"])
        fac.put(f"E{r}", iva, s["pct0"])
        fac.formula(f"F{r}", f"=ROUND(B{r}*C{r}*(1-D{r}),2)", base, s["eur"])
        fac.formula(f"G{r}", f"=ROUND(F{r}*E{r},2)", cuota, s["eur"])
        fac.formula(f"H{r}", f"=F{r}+G{r}", base + cuota, s["eur"])
    iva_total = 0.0
    for k, rate in enumerate([0.21, 0.10, 0.04]):
        r = 20 + k
        bsum = round(sum(bb for bb, ii in bases if ii == rate), 2)
        q = F.excel_round(bsum * rate, 2)
        iva_total += q
        fac.put(f"E{r}", f"Base {int(rate * 100)} %")
        fac.put(f"D{r}", rate, s["pct0"])
        fac.formula(f"F{r}", f"=SUMIF($E$11:$E$18,D{r},$F$11:$F$18)", bsum, s["eur"])
        fac.formula(f"G{r}", f"=ROUND(F{r}*D{r},2)", q, s["eur"])
    base_total = round(sum(bb for bb, _ in bases), 2)
    irpf = -F.excel_round(bases[4][0] * 0.15, 2)
    fac.put("E24", "Base imponible", s["bold"])
    fac.formula("F24", "=SUM(F11:F18)", base_total, s["eur"])
    fac.put("E25", "Total IVA", s["bold"])
    fac.formula("F25", "=SUM(G20:G22)", round(iva_total, 2), s["eur"])
    fac.put("E26", "Retención IRPF mano de obra")
    fac.formula("F26", "=-ROUND(F15*15%,2)", irpf, s["eur_red"])
    total = round(base_total + iva_total + irpf, 2)
    fac.put("E27", "TOTAL FACTURA", s["bold"])
    fac.formula("F27", "=F24+F25+F26", total, b.fmt(F.EUR, bold=True, bottom=6, font_size=12))
    lines_total = round(sum(bb for bb, _ in bases) + sum(cuotas), 2)
    ok = "OK" if abs(lines_total - (base_total + round(iva_total, 2))) < 0.05 else "Revisar"
    fac.put("E28", "Cuadre")
    fac.formula("F28", '=IF(ABS(SUM(H11:H18)-(F24+F25))<0.05,"OK","Revisar")', ok)
    fac.put("A30", "Forma de pago: transferencia bancaria a 30 días")
    fac.put("A31", "IBAN: ES91 2100 0418 4502 0005 1332", expect=True)
    fac.widths({"A": 34, "B": 9, "C": 14, "D": 7, "E": 18, "F": 15, "G": 12, "H": 12})
    for r in range(0, 4):
        fac.ws.set_row(r, 18)

    # Registro
    ref = dt.date(2025, 6, 30)
    reg.put("J1", "Fecha de referencia", s["bold"])
    reg.put("K1", ref, s["date"])
    reg.row("A1", ["Nº", "Fecha", "Cliente", "Base", "IVA", "Cuota IVA", "Total", "Cobrada", "Días de retraso"],
            s["hdr"])
    clientes = ["Distribuciones Núñez S.A.", "Panadería Peña", "Clínica Dental Ibáñez", "Transportes Gil S.L.",
                "Agüero & Asociados"]
    regs = []
    for i in range(20):
        r = i + 2
        if i == 6:
            num, d, cliente, base, iva = "2025-0042", fecha, clientes[0], base_total, 0.21
            reg.put(f"A{r}", num)
            reg.formula(f"B{r}", "=Factura!G3", d, s["date"])
            reg.put(f"C{r}", cliente)
            reg.formula(f"D{r}", "=Factura!F24", base, s["eur"])
        else:
            num = f"2025-{36 + i:04d}"
            d = dt.date(2025, 1, 8) + dt.timedelta(days=i * 17 + rnd.randrange(0, 6))
            cliente = rnd.choice(clientes)
            base = round(rnd.uniform(120, 4800), 2)
            iva = rnd.choice([0.21, 0.21, 0.10])
            reg.put(f"A{r}", num)
            reg.put(f"B{r}", d, s["date"])
            reg.put(f"C{r}", cliente)
            reg.put(f"D{r}", base, s["eur"])
        cobrada = d < dt.date(2025, 5, 1) and rnd.random() > 0.25
        cuota = F.excel_round(base * iva, 2)
        tot = round(base + cuota, 2)
        retraso = 0 if cobrada else max(0, (ref - d).days - 30)
        regs.append((d, tot, cobrada))
        reg.put(f"E{r}", iva, s["pct0"])
        reg.formula(f"F{r}", f"=ROUND(D{r}*E{r},2)", cuota, s["eur"], expect=i in (0, 6))
        reg.formula(f"G{r}", f"=D{r}+F{r}", tot, s["eur"], expect=i in (0, 6))
        reg.put(f"H{r}", cobrada)
        reg.formula(f"I{r}", f"=IF(H{r},0,MAX(0,$K$1-B{r}-30))", retraso, expect=True)
    reg.row("A24", ["Trimestre", "Facturado"], s["hdr"])
    for q in range(4):
        r = 25 + q
        y0, y1 = dt.date(2025, 3 * q + 1, 1), (dt.date(2025, 3 * q + 4, 1) if q < 3 else dt.date(2026, 1, 1))
        v = round(sum(t for d, t, _ in regs if y0 <= d < y1), 2)
        reg.put(f"A{r}", f"T{q + 1}")
        end = f"DATE(2025,{3 * q + 4},1)" if q < 3 else "DATE(2026,1,1)"
        reg.formula(f"B{r}", f'=SUMIFS($G$2:$G$21,$B$2:$B$21,">="&DATE(2025,{3 * q + 1},1),$B$2:$B$21,"<"&{end})',
                    v, s["eur"])
    reg.put("A30", "Pendiente de cobro", s["bold"])
    reg.formula("B30", "=SUMIF(H2:H21,FALSE,G2:G21)", round(sum(t for _, t, c in regs if not c), 2), s["eur"])
    reg.put("A31", "Facturas cobradas", s["bold"])
    reg.formula("B31", "=COUNTIF(H2:H21,TRUE)", sum(1 for *_, c in regs if c))
    reg.freeze(1, 0)
    reg.widths({"A": 11, "B": 11, "C": 26, "D:G": 12, "H": 9, "I": 14, "J": 18, "K": 11})
    return b.close()


# ---------------------------------------------------------------------------
# 6. Horario y calendario
# ---------------------------------------------------------------------------
FESTIVOS_2026 = [(dt.date(2026, 1, 1), "Año Nuevo"), (dt.date(2026, 1, 6), "Epifanía del Señor"),
                 (dt.date(2026, 4, 2), "Jueves Santo"), (dt.date(2026, 4, 3), "Viernes Santo"),
                 (dt.date(2026, 5, 1), "Fiesta del Trabajo"), (dt.date(2026, 8, 15), "Asunción de la Virgen"),
                 (dt.date(2026, 10, 12), "Fiesta Nacional de España"), (dt.date(2026, 12, 8), "Inmaculada Concepción"),
                 (dt.date(2026, 12, 25), "Natividad del Señor")]


def horario_calendario(out_dir: str) -> dict:
    b = Book(out_dir, "horario_calendario.xlsx",
             "Horario semanal con celdas combinadas verticales y horizontales, colores, texto girado y horas "
             "hh:mm calculadas con TIME; registro de turnos con [h]:mm (> 24 h) y turno nocturno con MOD; "
             "calendario 2026 con DATE/WEEKDAY, formato condicional por fórmula, festivos, NETWORKDAYS, "
             "WORKDAY y SUMPRODUCT.")
    s = _styles(b)
    hor = b.sheet("Horario")
    tur = b.sheet("Turnos")
    cal = b.sheet("Calendario 2026")
    hor.activate()
    time_f = b.fmt(F.TIME, align="center")
    hours_f = b.fmt(F.HOURS)
    hours_b = b.fmt(F.HOURS, bold=True, top=1)

    hor.merge("A1:G1", "Horario semanal · 2º ESO B", s["title"])
    hor.ws.set_row(0, 26)
    hor.row("A2", ["Hora", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes"], s["hdr"])
    for k in range(12):
        r = 3 + k
        minutes = 8 * 60 + 30 * k
        v = minutes / 1440
        f = "=TIME(8,0,0)" if k == 0 else f"=A{r - 1}+TIME(0,30,0)"
        hor.formula(f"A{r}", f, v, time_f)
    colors = {"Matemáticas": "#FCE4D6", "Lengua": "#E2EFDA", "Inglés": "#DDEBF7", "Historia": "#FFF2CC",
              "Ed. Física": "#EDEDED", "Tecnología": "#E4DFEC", "Música": "#F8CBAD", "Tutoría": "#D9E1F2"}
    fmts = {k: b.fmt(bg_color=v, align="center", valign="vcenter", text_wrap=True, border=1)
            for k, v in colors.items()}
    plan = {  # column -> list of (first_row, last_row, subject)
        "B": [(3, 4, "Matemáticas"), (5, 6, "Lengua"), (8, 9, "Inglés"), (10, 11, "Historia"), (12, 14, "Ed. Física")],
        "C": [(3, 4, "Lengua"), (5, 6, "Tecnología"), (8, 9, "Matemáticas"), (10, 11, "Música"), (12, 14, "Inglés")],
        "D": [(3, 4, "Inglés"), (5, 6, "Matemáticas"), (8, 9, "Lengua"), (10, 11, "Tecnología"), (12, 14, "Tutoría")],
        "E": [(3, 4, "Historia"), (5, 6, "Inglés"), (8, 9, "Ed. Física"), (10, 11, "Lengua"), (12, 14, "Matemáticas")],
        "F": [(3, 4, "Música"), (5, 6, "Historia"), (8, 9, "Matemáticas"), (10, 11, "Inglés"), (12, 14, "Lengua")],
    }
    for col, blocks in plan.items():
        for r0, r1, subj in blocks:
            hor.merge(f"{col}{r0}:{col}{r1}", subj, fmts[subj])
    hor.merge("B7:F7", "Recreo", b.fmt(italic=True, align="center", bg_color="#FFFFFF", border=1))
    hor.merge("G3:G14", "Turno de mañana", b.fmt(rotation=90, align="center", valign="vcenter", bold=True,
                                                    bg_color="#F2F2F2"))
    hor.expect("B3", "Matemáticas")
    hor.expect("B7", "Recreo")
    hor.freeze(2, 1)
    hor.widths({"A": 8, "B:F": 15, "G": 5})
    for r in range(2, 14):
        hor.ws.set_row(r, 22)

    # Turnos
    tur.row("A1", ["Empleado", "Fecha", "Entrada", "Salida", "Pausa (min)", "Horas", "Horas decimales"], s["hdr"])
    shifts = [("Ana Ruiz", 9, (8, 0), (16, 30), 30), ("Ana Ruiz", 10, (8, 0), (17, 15), 45),
              ("Ana Ruiz", 11, (9, 30), (18, 0), 30), ("Ana Ruiz", 12, (8, 0), (15, 0), 0),
              ("Ana Ruiz", 13, (8, 0), (14, 0), 0), ("Jorge Peña", 9, (22, 0), (6, 0), 30),
              ("Jorge Peña", 10, (22, 0), (6, 0), 30), ("Jorge Peña", 11, (21, 30), (6, 15), 45),
              ("Jorge Peña", 12, (22, 0), (5, 30), 15), ("Jorge Peña", 14, (14, 0), (22, 0), 30)]
    worked = []
    for i, (emp, day, (h0, m0), (h1, m1), pausa) in enumerate(shifts):
        r = i + 2
        t0, t1 = (h0 * 60 + m0) / 1440, (h1 * 60 + m1) / 1440
        mins = ((h1 * 60 + m1) - (h0 * 60 + m0)) % 1440 - pausa
        hours = mins / 1440
        worked.append((emp, hours))
        tur.put(f"A{r}", emp)
        tur.put(f"B{r}", dt.date(2026, 3, day), s["date"])
        tur.put(f"C{r}", t0, time_f, expect=i in (0, 5))
        tur.put(f"D{r}", t1, time_f, expect=i in (0, 5))
        tur.put(f"E{r}", pausa)
        tur.formula(f"F{r}", f"=MOD(D{r}-C{r},1)-E{r}/1440", hours, hours_f)
        tur.formula(f"G{r}", f"=ROUND(F{r}*24,2)", F.excel_round(mins / 60, 2), s["plain2"])
    total_h = sum(h for _, h in worked)
    tur.put("A13", "Total semana", s["bold"])
    tur.formula("F13", "=SUM(F2:F11)", total_h, hours_b)
    tur.formula("G13", "=ROUND(F13*24,2)", F.excel_round(total_h * 24, 2), s["plain2"])
    for k, emp in enumerate(["Ana Ruiz", "Jorge Peña"]):
        r = 14 + k
        h = sum(x for e, x in worked if e == emp)
        tur.put(f"A{r}", emp)
        tur.formula(f"F{r}", f"=SUMIF($A$2:$A$11,A{r},$F$2:$F$11)", h, hours_f)
    tur.widths({"A": 14, "B": 11, "C:D": 8, "E": 11, "F": 8, "G": 15})

    # Calendario 2026
    cal.merge("A1:H1", "Calendario 2026", s["title"])
    dayhdr = b.fmt(bold=True, align="center", bg_color="#D9E1F2")
    dayf = b.fmt(F.DAY, align="center")
    month_f = b.fmt(F.MONTH_YEAR, bold=True, align="center", bg_color="#BDD7EE")
    grey = b.wb.add_format({"font_color": "#BFBFBF"})
    red = b.wb.add_format({"font_color": "#C00000"})
    for mi, m in enumerate((1, 2)):
        top = 3 + mi * 10  # 1-based Excel row of the month title
        cal.merge(f"A{top}:G{top}", "", month_f)
        cal.formula(f"A{top}", f"=DATE(2026,{m},1)", dt.date(2026, m, 1), month_f)
        cal.row(f"A{top + 1}", list("LMXJVSD"), dayhdr)
        first = dt.date(2026, m, 1)
        start = first - dt.timedelta(days=first.isoweekday() - 1)
        for w in range(6):
            for d in range(7):
                r = top + 2 + w
                col = "ABCDEFG"[d]
                day = start + dt.timedelta(days=w * 7 + d)
                if w == 0 and d == 0:
                    f = f"=DATE(2026,{m},1)-WEEKDAY(DATE(2026,{m},1),2)+1"
                elif d == 0:
                    f = f"=G{r - 1}+1"
                else:
                    f = f"={'ABCDEFG'[d - 1]}{r}+1"
                cal.formula(f"{col}{r}", f, day, dayf, expect=(w == 0 or (w == 5 and d == 6)))
        block = f"A{top + 2}:G{top + 7}"
        cal.cond(block, {"type": "formula", "criteria": f"=MONTH(A{top + 2})<>{m}", "format": grey})
        cal.cond(f"F{top + 2}:G{top + 7}", {"type": "formula", "criteria": f"=MONTH(F{top + 2})={m}", "format": red})
    cal.row("J2", ["Festivo", "Descripción"], s["hdr"])
    hol = set()
    for i, (d, name) in enumerate(FESTIVOS_2026):
        cal.put(f"J{3 + i}", d, s["date"])
        cal.put(f"K{3 + i}", name)
        hol.add(d)
    cal.put("J14", "Laborables enero", s["bold"])
    cal.formula("K14", "=NETWORKDAYS(DATE(2026,1,1),DATE(2026,1,31),J3:J11)",
                F.networkdays(dt.date(2026, 1, 1), dt.date(2026, 1, 31), hol))
    cal.put("J15", "Laborables 1er trimestre", s["bold"])
    cal.formula("K15", "=NETWORKDAYS(DATE(2026,1,1),DATE(2026,3,31),J3:J11)",
                F.networkdays(dt.date(2026, 1, 1), dt.date(2026, 3, 31), hol))
    cal.put("J16", "Entrega (+20 laborables desde 15/01)", s["bold"])
    cal.formula("K16", "=WORKDAY(DATE(2026,1,15),20,J3:J11)", F.workday(dt.date(2026, 1, 15), 20, hol), s["date"])
    cal.put("J17", "Día de la semana del 12/10", s["bold"])
    cal.formula("K17", "=DATE(2026,10,12)", dt.date(2026, 10, 12), b.fmt(F.DAYNAME))
    cal.put("J18", "Festivos en día laborable", s["bold"])
    cal.formula("K18", "=SUMPRODUCT((WEEKDAY(J3:J11,2)<6)*1)", sum(1 for d in hol if d.isoweekday() < 6))
    cal.put("J19", "Fecha larga", s["bold"])
    cal.formula("K19", "=K16", F.workday(dt.date(2026, 1, 15), 20, hol), s["date_long"])
    cal.widths({"A:G": 5, "H": 3, "J": 34, "K": 26})
    return b.close()


ALL = [presupuesto_familiar, cuenta_resultados, clientes_inventario, informe_ventas, facturas, horario_calendario]
