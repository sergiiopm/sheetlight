"""Independent Python reference for the values and es-ES display strings that
the corpus files must produce.

Nothing here reads the generated files back: values are computed from the same
input data in plain Python, so the expectations are an independent check of
the engine (IronCalc) and of Sheetlight's es display formatting.

`display()` supports only the number formats the corpus uses (listed in
`FORMATS`). It returns None when the display depends on things we do not want
to pin (e.g. "General" with many significant digits, which Excel adapts to the
column width).
"""
from __future__ import annotations

import calendar
import datetime as dt
from decimal import ROUND_HALF_UP, Decimal

# ---------------------------------------------------------------------------
# Number formats used by the corpus (exact Excel format codes)
# ---------------------------------------------------------------------------
GENERAL = "General"
EUR = '#,##0.00 "€"'
EUR_RED = '#,##0.00 "€";[Red]-#,##0.00 "€"'
# What Excel es-ES writes for the "Moneda" format with the € symbol.
EUR_LOCALE = "#,##0.00\\ [$€-C0A]"
EUR0 = '#,##0 "€"'
NUM2 = "#,##0.00"
NUM0 = "#,##0"
PLAIN2 = "0.00"
PCT0 = "0%"
PCT1 = "0.0%"
PCT2 = "0.00%"
DATE = "dd/mm/yyyy"
DATE_LONG = 'd "de" mmmm "de" yyyy'
MONTH_YEAR = "mmmm yyyy"
DAY = "d"
DAYNAME = "dddd"
TIME = "hh:mm"
HOURS = "[h]:mm"
TEXT = "@"

MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
             "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
DAYS_ES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]

EPOCH = dt.date(1899, 12, 30)


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------
def serial(d: dt.date | dt.datetime) -> float:
    """Excel 1900 date serial (valid after 1900-03-01)."""
    if isinstance(d, dt.datetime):
        delta = d - dt.datetime(1899, 12, 30)
        return delta.days + delta.seconds / 86400
    return float((d - EPOCH).days)


def from_serial(x: float) -> dt.date:
    return EPOCH + dt.timedelta(days=int(x))


def eomonth(d: dt.date, months: int) -> dt.date:
    m = d.month - 1 + months
    y = d.year + m // 12
    m = m % 12 + 1
    return dt.date(y, m, calendar.monthrange(y, m)[1])


def weekday_mon1(d: dt.date) -> int:
    """WEEKDAY(d, 2): Monday = 1 … Sunday = 7."""
    return d.isoweekday()


def networkdays(start: dt.date, end: dt.date, holidays: set[dt.date] = frozenset()) -> int:
    n, d = 0, start
    while d <= end:
        if d.isoweekday() <= 5 and d not in holidays:
            n += 1
        d += dt.timedelta(days=1)
    return n


def workday(start: dt.date, days: int, holidays: set[dt.date] = frozenset()) -> dt.date:
    d, left = start, days
    while left > 0:
        d += dt.timedelta(days=1)
        if d.isoweekday() <= 5 and d not in holidays:
            left -= 1
    return d


# ---------------------------------------------------------------------------
# Financial functions (Excel semantics)
# ---------------------------------------------------------------------------
def pmt(rate: float, nper: int, pv: float, fv: float = 0.0, when: int = 0) -> float:
    if rate == 0:
        return -(pv + fv) / nper
    f = (1 + rate) ** nper
    return -(pv * f + fv) * rate / ((1 + rate * when) * (f - 1))


def fv(rate: float, nper: int, payment: float, pv: float = 0.0, when: int = 0) -> float:
    if rate == 0:
        return -(pv + payment * nper)
    f = (1 + rate) ** nper
    return -(pv * f + payment * (1 + rate * when) * (f - 1) / rate)


def npv(rate: float, values: list[float]) -> float:
    return sum(v / (1 + rate) ** (i + 1) for i, v in enumerate(values))


def irr(values: list[float], guess: float = 0.1) -> float:
    r = guess
    for _ in range(100):
        f = sum(v / (1 + r) ** i for i, v in enumerate(values))
        df = sum(-i * v / (1 + r) ** (i + 1) for i, v in enumerate(values))
        step = f / df
        r -= step
        if abs(step) < 1e-12:
            return r
    raise ValueError("IRR did not converge")


def excel_round(x: float, digits: int = 0) -> float:
    """ROUND(): half away from zero on the 15-significant-digit value."""
    q = Decimal(1).scaleb(-digits)
    d = Decimal(f"{x:.15g}").quantize(q, rounding=ROUND_HALF_UP)
    return float(d)


# ---------------------------------------------------------------------------
# es-ES display
# ---------------------------------------------------------------------------
def _fixed(x: float, decimals: int, grouping: bool) -> str:
    """Absolute value with `decimals` decimals, es separators."""
    q = Decimal(1).scaleb(-decimals) if decimals else Decimal(1)
    d = Decimal(f"{abs(x):.15g}").quantize(q, rounding=ROUND_HALF_UP)
    s = f"{d:f}"
    whole, _, frac = s.partition(".")
    if grouping:
        groups = []
        while len(whole) > 3:
            groups.insert(0, whole[-3:])
            whole = whole[:-3]
        groups.insert(0, whole)
        whole = ".".join(groups)
    return whole + ("," + frac if decimals else "")


def _sign(x: float, decimals: int) -> str:
    # Excel shows no minus sign when the value rounds to zero.
    return "-" if x < 0 and Decimal(f"{abs(x):.15g}").quantize(
        Decimal(1).scaleb(-decimals) if decimals else Decimal(1), rounding=ROUND_HALF_UP) != 0 else ""


def general(x: float) -> str | None:
    if x == int(x) and abs(x) < 1e11:
        return str(int(x)).replace("-", "-")
    s = f"{x:.10g}"
    if "e" in s or len(s.replace("-", "").replace(".", "").lstrip("0")) > 9:
        return None  # width-dependent in Excel: do not pin
    return s.replace(".", ",")


def _time_parts(x: float) -> tuple[int, int, int]:
    secs = int(Decimal(f"{x * 86400:.6f}").quantize(Decimal(1), rounding=ROUND_HALF_UP))
    return secs // 3600, (secs % 3600) // 60, secs % 60


def display(value, fmt: str = GENERAL) -> str | None:
    """es-ES display string of `value` under number format `fmt`."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "VERDADERO" if value else "FALSO"
    if isinstance(value, str):
        return value
    x = float(value)
    if fmt == GENERAL:
        return general(x)
    if fmt in (EUR, EUR_LOCALE):
        return _sign(x, 2) + _fixed(x, 2, True) + " €"
    if fmt == EUR_RED:
        return _sign(x, 2) + _fixed(x, 2, True) + " €"
    if fmt == EUR0:
        return _sign(x, 0) + _fixed(x, 0, True) + " €"
    if fmt == NUM2:
        return _sign(x, 2) + _fixed(x, 2, True)
    if fmt == NUM0:
        return _sign(x, 0) + _fixed(x, 0, True)
    if fmt == PLAIN2:
        return _sign(x, 2) + _fixed(x, 2, False)
    if fmt in (PCT0, PCT1, PCT2):
        dec = {PCT0: 0, PCT1: 1, PCT2: 2}[fmt]
        return _sign(x * 100, dec) + _fixed(x * 100, dec, False) + "%"
    if fmt == DATE:
        return from_serial(x).strftime("%d/%m/%Y")
    if fmt == DATE_LONG:
        d = from_serial(x)
        return f"{d.day} de {MONTHS_ES[d.month - 1]} de {d.year}"
    if fmt == MONTH_YEAR:
        d = from_serial(x)
        return f"{MONTHS_ES[d.month - 1]} {d.year}"
    if fmt == DAY:
        return str(from_serial(x).day)
    if fmt == DAYNAME:
        return DAYS_ES[from_serial(x).weekday()]
    if fmt == TIME:
        h, m, _ = _time_parts(x - int(x))
        return f"{h:02d}:{m:02d}"
    if fmt == HOURS:
        h, m, _ = _time_parts(x)
        return f"{h}:{m:02d}"
    raise ValueError(f"unsupported format {fmt!r}")


def _selftest() -> None:
    assert display(1234.5, EUR) == "1.234,50 €"
    assert display(-1234.567, EUR_RED) == "-1.234,57 €"
    assert display(-0.001, EUR) == "0,00 €"
    assert display(1234567.891, NUM2) == "1.234.567,89"
    assert display(0.256, PCT1) == "25,6%"
    assert display(serial(dt.date(2025, 2, 14)), DATE) == "14/02/2025"
    assert display(serial(dt.date(2025, 2, 14)), DATE_LONG) == "14 de febrero de 2025"
    assert display(serial(dt.date(2025, 2, 12)), DAYNAME) == "miércoles"
    assert display(41.5 / 24, HOURS) == "41:30"
    assert display(8.5 / 24, TIME) == "08:30"
    assert display(1234.5) == "1234,5"
    assert display(True) == "VERDADERO"
    assert abs(pmt(0.04 / 12, 240, -200000) - 1211.96) < 0.005
    assert abs(irr([-70000, 12000, 15000, 18000, 21000, 26000]) - 0.086631) < 1e-6
    assert eomonth(dt.date(2025, 2, 14), 0) == dt.date(2025, 2, 28)
    assert excel_round(2.675, 2) == 2.68


if __name__ == "__main__":
    _selftest()
    print("esfmt self-test ok")
