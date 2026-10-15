//! Formulas and results for the most-used functions (the PLAN's "~150 most
//! used", grouped like Excel's function library), evaluated by the engine
//! actor on a fresh workbook. Expected values are Excel's (hand-checked
//! against Excel's documentation; numeric ones recomputed independently).
//!
//! Formulas are en-US (`,` separates arguments). Deviations are listed in
//! `KNOWN` with the reason; the `#[ignore]`d strict twin fails while any is
//! open. Every function in the table must be in `listFunctions`.

mod common;

use std::f64::consts::PI;

use common::actor::Actor;
use common::{numbers_match, Report};
use sheetlight_lib::engine::types::*;

#[derive(Debug, Clone, Copy)]
enum Want {
    N(f64),
    T(&'static str),
    B(bool),
    E(&'static str),
}
use Want::*;

/// Data block the formulas refer to (A1 notation, en-US input).
const DATA: &[(&str, &str)] = &[
    ("A1", "1"), ("A2", "2"), ("A3", "3"), ("A4", "4"), ("A5", "5"),
    ("B1", "10"), ("B2", "20"), ("B3", "30"), ("B4", "40"), ("B5", "50"),
    ("C1", "Madrid"), ("C2", "Sevilla"), ("C3", "Madrid"), ("C4", "Bilbao"), ("C5", "Madrid"),
    ("D1", "TRUE"), ("D2", "FALSE"), ("D3", "TRUE"), ("D5", "x"),
    ("E1", "2"), ("E2", "4"), ("E3", "4"), ("E4", "4"), ("E5", "5"), ("E6", "5"), ("E7", "7"), ("E8", "9"),
    ("G1", "ene"), ("H1", "feb"), ("I1", "mar"), ("J1", "abr"),
    ("G2", "100"), ("H2", "200"), ("I2", "300"), ("J2", "400"),
];

/// 2025-03-15 as an Excel serial (1900 system).
const MAR15: f64 = 45731.0;

const CASES: &[(&str, Want)] = &[
    // ---- math & trig
    ("=SUM(A1:A5)", N(15.0)),
    ("=SUM(A1:A5,2)", N(17.0)),
    ("=ABS(-3)", N(3.0)),
    ("=ROUND(2.345,2)", N(2.35)),
    ("=ROUND(-2.5,0)", N(-3.0)),
    ("=ROUND(1234.5,-2)", N(1200.0)),
    ("=ROUNDUP(2.341,2)", N(2.35)),
    ("=ROUNDDOWN(2.349,2)", N(2.34)),
    ("=INT(-2.5)", N(-3.0)),
    ("=TRUNC(-2.5)", N(-2.0)),
    ("=MOD(10,3)", N(1.0)),
    ("=MOD(-10,3)", N(2.0)),
    ("=POWER(2,10)", N(1024.0)),
    ("=2^10", N(1024.0)),
    ("=SQRT(16)", N(4.0)),
    ("=SQRT(-1)", E("#NUM!")),
    ("=EXP(0)", N(1.0)),
    ("=LN(1)", N(0.0)),
    ("=LOG(100)", N(2.0)),
    ("=LOG(8,2)", N(3.0)),
    ("=LOG10(1000)", N(3.0)),
    ("=PI()", N(PI)),
    ("=SIGN(-5)", N(-1.0)),
    ("=CEILING(4.3,1)", N(5.0)),
    ("=CEILING.MATH(-4.3)", N(-4.0)),
    ("=FLOOR(4.7,1)", N(4.0)),
    ("=FLOOR.MATH(-4.3)", N(-5.0)),
    ("=MROUND(10,3)", N(9.0)),
    ("=EVEN(3)", N(4.0)),
    ("=ODD(2)", N(3.0)),
    ("=FACT(5)", N(120.0)),
    ("=COMBIN(5,2)", N(10.0)),
    ("=PERMUT(5,2)", N(20.0)),
    ("=GCD(12,18)", N(6.0)),
    ("=LCM(4,6)", N(12.0)),
    ("=QUOTIENT(7,2)", N(3.0)),
    ("=PRODUCT(A1:A5)", N(120.0)),
    ("=SUMSQ(A1:A3)", N(14.0)),
    ("=SUMPRODUCT(A1:A5,B1:B5)", N(550.0)),
    ("=SUMPRODUCT((C1:C5=\"Madrid\")*B1:B5)", N(90.0)),
    ("=SUMIF(C1:C5,\"Madrid\",B1:B5)", N(90.0)),
    ("=SUMIF(A1:A5,\">2\")", N(12.0)),
    ("=SUMIFS(B1:B5,C1:C5,\"Madrid\",A1:A5,\">1\")", N(80.0)),
    ("=SUBTOTAL(9,A1:A5)", N(15.0)),
    ("=SUBTOTAL(1,A1:A5)", N(3.0)),
    ("=SUBTOTAL(109,A1:A5)", N(15.0)),
    ("=RADIANS(180)", N(PI)),
    ("=DEGREES(PI())", N(180.0)),
    ("=SIN(0)", N(0.0)),
    ("=COS(0)", N(1.0)),
    ("=TAN(0)", N(0.0)),
    ("=ASIN(1)", N(PI / 2.0)),
    ("=ACOS(1)", N(0.0)),
    ("=ATAN(1)", N(PI / 4.0)),
    ("=ATAN2(1,1)", N(PI / 4.0)),
    ("=SINH(0)", N(0.0)),
    ("=COSH(0)", N(1.0)),
    ("=TANH(0)", N(0.0)),
    ("=SQRTPI(1)", N(1.772_453_850_905_516)),
    ("=MULTINOMIAL(2,3)", N(10.0)),
    ("=ROMAN(1999)", T("MCMXCIX")),
    ("=ARABIC(\"MCMXCIX\")", N(1999.0)),
    ("=BASE(255,16)", T("FF")),
    ("=DECIMAL(\"FF\",16)", N(255.0)),
    ("=RANDBETWEEN(7,7)", N(7.0)),
    ("=AND(RAND()>=0,RAND()<1)", B(true)),
    // ---- statistics
    ("=AVERAGE(A1:A5)", N(3.0)),
    ("=AVERAGEA(D1:D5)", N(0.5)),
    ("=AVERAGEIF(C1:C5,\"Madrid\",B1:B5)", N(30.0)),
    ("=AVERAGEIFS(B1:B5,C1:C5,\"Madrid\",A1:A5,\">1\")", N(40.0)),
    ("=COUNT(A1:D5)", N(10.0)),
    ("=COUNTA(D1:D5)", N(4.0)),
    ("=COUNTBLANK(D1:D5)", N(1.0)),
    ("=COUNTIF(C1:C5,\"Madrid\")", N(3.0)),
    ("=COUNTIF(C1:C5,\"m*\")", N(3.0)),
    ("=COUNTIF(B1:B5,\"<>30\")", N(4.0)),
    ("=COUNTIFS(C1:C5,\"Madrid\",B1:B5,\">=30\")", N(2.0)),
    ("=MAX(B1:B5)", N(50.0)),
    ("=MIN(B1:B5)", N(10.0)),
    ("=MAXA(D1:D5)", N(1.0)),
    ("=MINA(D1:D5)", N(0.0)),
    ("=MAXIFS(B1:B5,C1:C5,\"Madrid\")", N(50.0)),
    ("=MINIFS(B1:B5,C1:C5,\"Madrid\")", N(10.0)),
    ("=MEDIAN(E1:E8)", N(4.5)),
    ("=MODE(E1:E8)", N(4.0)),
    ("=MODE.SNGL(E1:E8)", N(4.0)),
    ("=LARGE(B1:B5,2)", N(40.0)),
    ("=SMALL(B1:B5,2)", N(20.0)),
    ("=RANK(30,B1:B5)", N(3.0)),
    ("=RANK.EQ(40,B1:B5,1)", N(4.0)),
    ("=RANK.AVG(4,E1:E8,1)", N(3.0)),
    ("=STDEV.P(E1:E8)", N(2.0)),
    ("=STDEVP(E1:E8)", N(2.0)),
    ("=STDEV.S(E1:E8)", N(2.138_089_935_299_395)),
    ("=STDEV(E1:E8)", N(2.138_089_935_299_395)),
    ("=VAR.P(E1:E8)", N(4.0)),
    ("=VARP(E1:E8)", N(4.0)),
    ("=VAR.S(E1:E8)", N(4.571_428_571_428_571)),
    ("=VAR(E1:E8)", N(4.571_428_571_428_571)),
    ("=AVEDEV(E1:E8)", N(1.5)),
    ("=DEVSQ(E1:E8)", N(32.0)),
    ("=GEOMEAN(1,2,4)", N(2.0)),
    ("=HARMEAN(1,2,4)", N(1.714_285_714_285_714_2)),
    ("=TRIMMEAN(E1:E8,0.25)", N(4.833_333_333_333_333)),
    ("=PERCENTILE(A1:A5,0.25)", N(2.0)),
    ("=PERCENTILE.INC(A1:A5,0.9)", N(4.6)),
    ("=QUARTILE(A1:A5,3)", N(4.0)),
    ("=QUARTILE.INC(A1:A5,1)", N(2.0)),
    ("=PERCENTRANK.INC(A1:A5,3)", N(0.5)),
    ("=CORREL(A1:A5,B1:B5)", N(1.0)),
    ("=PEARSON(A1:A5,B1:B5)", N(1.0)),
    ("=RSQ(B1:B5,A1:A5)", N(1.0)),
    ("=SLOPE(B1:B5,A1:A5)", N(10.0)),
    ("=INTERCEPT(B1:B5,A1:A5)", N(0.0)),
    ("=FORECAST(6,B1:B5,A1:A5)", N(60.0)),
    ("=FORECAST.LINEAR(7,B1:B5,A1:A5)", N(70.0)),
    ("=COVARIANCE.P(A1:A5,B1:B5)", N(20.0)),
    ("=COVARIANCE.S(A1:A5,B1:B5)", N(25.0)),
    ("=COVAR(A1:A5,B1:B5)", N(20.0)),
    ("=NORM.S.DIST(0,TRUE)", N(0.5)),
    ("=NORM.DIST(10,10,2,TRUE)", N(0.5)),
    ("=NORM.INV(0.5,10,2)", N(10.0)),
    ("=NORM.S.INV(0.5)", N(0.0)),
    ("=STANDARDIZE(12,10,2)", N(1.0)),
    ("=BINOM.DIST(2,5,0.5,FALSE)", N(0.3125)),
    ("=POISSON.DIST(2,3,FALSE)", N(0.224_041_807_655_387_75)),
    ("=EXPON.DIST(1,1,TRUE)", N(0.632_120_558_828_557_7)),
    ("=FISHER(0.5)", N(0.549_306_144_334_054_8)),
    ("=GAMMA(5)", N(24.0)),
    ("=GAMMALN(5)", N(3.178_053_830_347_945_6)),
    ("=PHI(0)", N(0.398_942_280_401_432_7)),
    ("=CONFIDENCE.NORM(0.05,1,100)", N(0.195_996_398_454_005_4)),
    ("=PERMUTATIONA(3,2)", N(9.0)),
    ("=COMBINA(3,2)", N(6.0)),
    // ---- logical
    ("=IF(A1>0,\"sí\",\"no\")", T("sí")),
    ("=IF(A1>5,\"sí\")", B(false)),
    ("=IFERROR(1/0,\"error\")", T("error")),
    ("=IFNA(NA(),\"n/d\")", T("n/d")),
    ("=IFS(A2=1,\"a\",A2=2,\"b\")", T("b")),
    ("=SWITCH(A3,1,\"uno\",3,\"tres\",\"otro\")", T("tres")),
    ("=SWITCH(A4,1,\"uno\",\"otro\")", T("otro")),
    ("=AND(TRUE,A1=1)", B(true)),
    ("=OR(FALSE,A1=2)", B(false)),
    ("=NOT(FALSE)", B(true)),
    ("=XOR(TRUE,TRUE)", B(false)),
    ("=TRUE()", B(true)),
    ("=FALSE()", B(false)),
    // ---- information
    ("=ISBLANK(D4)", B(true)),
    ("=ISNUMBER(A1)", B(true)),
    ("=ISTEXT(C1)", B(true)),
    ("=ISNONTEXT(A1)", B(true)),
    ("=ISLOGICAL(D1)", B(true)),
    ("=ISERROR(1/0)", B(true)),
    ("=ISERR(NA())", B(false)),
    ("=ISNA(NA())", B(true)),
    ("=ISEVEN(4)", B(true)),
    ("=ISODD(3)", B(true)),
    ("=ISFORMULA(A1)", B(false)),
    ("=ISREF(A1)", B(true)),
    ("=N(TRUE)", N(1.0)),
    ("=NA()", E("#N/A")),
    ("=TYPE(\"a\")", N(2.0)),
    ("=ERROR.TYPE(1/0)", N(2.0)),
    ("=SHEET()", N(1.0)),
    ("=SHEETS()", N(1.0)),
    ("=1/0", E("#DIV/0!")),
    ("=\"a\"+1", E("#VALUE!")),
    ("=NOFUNCTION(1)", E("#NAME?")),
    // ---- lookup & reference
    ("=VLOOKUP(3,A1:C5,3,FALSE)", T("Madrid")),
    ("=VLOOKUP(2.5,A1:B5,2,TRUE)", N(20.0)),
    ("=VLOOKUP(9,A1:C5,3,FALSE)", E("#N/A")),
    ("=HLOOKUP(\"mar\",G1:J2,2,FALSE)", N(300.0)),
    ("=INDEX(B1:B5,4)", N(40.0)),
    ("=INDEX(A1:C5,2,3)", T("Sevilla")),
    ("=MATCH(30,B1:B5,0)", N(3.0)),
    ("=MATCH(35,B1:B5,1)", N(3.0)),
    ("=INDEX(C1:C5,MATCH(40,B1:B5,0))", T("Bilbao")),
    ("=XLOOKUP(\"Bilbao\",C1:C5,B1:B5)", N(40.0)),
    ("=XLOOKUP(\"Vigo\",C1:C5,B1:B5,\"no está\")", T("no está")),
    ("=XMATCH(40,B1:B5)", N(4.0)),
    ("=LOOKUP(3,A1:A5,B1:B5)", N(30.0)),
    ("=CHOOSE(2,\"a\",\"b\",\"c\")", T("b")),
    ("=OFFSET(A1,2,1)", N(30.0)),
    ("=SUM(OFFSET(A1,0,0,3,1))", N(6.0)),
    ("=INDIRECT(\"B2\")", N(20.0)),
    ("=ADDRESS(2,3)", T("$C$2")),
    ("=COLUMN(C5)", N(3.0)),
    ("=ROW(C5)", N(5.0)),
    ("=COLUMNS(A1:D5)", N(4.0)),
    ("=ROWS(A1:D5)", N(5.0)),
    ("=HYPERLINK(\"https://example.com\",\"enlace\")", T("enlace")),
    ("=SUM(SEQUENCE(4))", N(10.0)),
    ("=ROWS(UNIQUE(C1:C5))", N(3.0)),
    ("=INDEX(SORT(B1:B5,1,-1),1)", N(50.0)),
    ("=SUM(FILTER(B1:B5,C1:C5=\"Madrid\"))", N(90.0)),
    ("=COLUMNS(TRANSPOSE(A1:A5))", N(5.0)),
    // ---- text
    ("=LEFT(\"Sheetlight\",5)", T("Sheet")),
    ("=RIGHT(\"Sheetlight\",5)", T("light")),
    ("=MID(\"Sheetlight\",6,5)", T("light")),
    ("=LEN(\"año\")", N(3.0)),
    ("=LOWER(\"ÁRBOL\")", T("árbol")),
    ("=UPPER(\"ñandú\")", T("ÑANDÚ")),
    ("=PROPER(\"josé garcía\")", T("José García")),
    ("=TRIM(\"  a   b \")", T("a b")),
    ("=CONCATENATE(\"a\",\"b\",1)", T("ab1")),
    ("=CONCAT(C1:C2)", T("MadridSevilla")),
    ("=TEXTJOIN(\", \",TRUE,C1:C3)", T("Madrid, Sevilla, Madrid")),
    ("=\"a\"&\"b\"&1", T("ab1")),
    ("=SUBSTITUTE(\"a-b-c\",\"-\",\"/\")", T("a/b/c")),
    ("=SUBSTITUTE(\"a-b-c\",\"-\",\"/\",2)", T("a-b/c")),
    ("=REPLACE(\"abcdef\",2,3,\"X\")", T("aXef")),
    ("=FIND(\"l\",\"Sheetlight\")", N(6.0)),
    ("=SEARCH(\"L\",\"Sheetlight\")", N(6.0)),
    ("=FIND(\"z\",\"abc\")", E("#VALUE!")),
    ("=REPT(\"ab\",3)", T("ababab")),
    ("=EXACT(\"a\",\"A\")", B(false)),
    ("=VALUE(\"12.5\")", N(12.5)),
    ("=TEXT(0.25,\"0%\")", T("25%")),
    ("=TEXT(DATE(2025,3,15),\"yyyy-mm-dd\")", T("2025-03-15")),
    ("=CHAR(65)", T("A")),
    ("=CODE(\"A\")", N(65.0)),
    ("=UNICHAR(8364)", T("€")),
    ("=UNICODE(\"€\")", N(8364.0)),
    ("=CLEAN(CHAR(7)&\"a\")", T("a")),
    ("=T(\"a\")", T("a")),
    ("=T(1)", T("")),
    ("=FIXED(1234.567,1)", T("1,234.6")),
    ("=NUMBERVALUE(\"1.234,5\",\",\",\".\")", N(1234.5)),
    ("=TEXTBEFORE(\"ana@correo.es\",\"@\")", T("ana")),
    ("=TEXTAFTER(\"ana@correo.es\",\"@\")", T("correo.es")),
    ("=VALUETOTEXT(123)", T("123")),
    ("=REGEXTEST(\"abc123\",\"[0-9]+\")", B(true)),
    // ---- date & time
    ("=DATE(2025,3,15)", N(MAR15)),
    ("=DATE(2025,14,1)", N(46054.0)),
    ("=YEAR(DATE(2025,3,15))", N(2025.0)),
    ("=MONTH(DATE(2025,3,15))", N(3.0)),
    ("=DAY(DATE(2025,3,15))", N(15.0)),
    ("=WEEKDAY(DATE(2025,3,15))", N(7.0)),
    ("=WEEKDAY(DATE(2025,3,15),2)", N(6.0)),
    ("=WEEKNUM(DATE(2025,3,15))", N(11.0)),
    ("=ISOWEEKNUM(DATE(2025,3,15))", N(11.0)),
    ("=EDATE(DATE(2025,1,31),1)", N(45716.0)),
    ("=EOMONTH(DATE(2025,2,10),0)", N(45716.0)),
    ("=DAYS(DATE(2025,3,15),DATE(2025,1,1))", N(73.0)),
    ("=DATE(2025,3,15)-DATE(2025,1,1)", N(73.0)),
    ("=DATEDIF(DATE(2020,5,10),DATE(2025,3,15),\"Y\")", N(4.0)),
    ("=DATEDIF(DATE(2020,5,10),DATE(2025,3,15),\"M\")", N(58.0)),
    ("=DAYS360(DATE(2025,1,1),DATE(2025,12,31))", N(360.0)),
    ("=NETWORKDAYS(DATE(2025,3,3),DATE(2025,3,14))", N(10.0)),
    ("=WORKDAY(DATE(2025,3,14),1)", N(45733.0)),
    ("=TIME(12,30,0)", N(0.520_833_333_333_333_3)),
    ("=HOUR(TIME(12,30,45))", N(12.0)),
    ("=MINUTE(TIME(12,30,45))", N(30.0)),
    ("=SECOND(TIME(12,30,45))", N(45.0)),
    ("=DATEVALUE(\"2025-03-15\")", N(MAR15)),
    ("=TIMEVALUE(\"12:00\")", N(0.5)),
    ("=YEARFRAC(DATE(2025,1,1),DATE(2025,7,1))", N(0.5)),
    ("=TODAY()>45000", B(true)),
    ("=NOW()>=TODAY()", B(true)),
    // ---- financial
    ("=PMT(0.05/12,360,200000)", N(-1_073.643_246_024_279_7)),
    ("=FV(0.05,10,-100)", N(1_257.789_253_554_883_7)),
    ("=PV(0.05,10,-100)", N(772.173_492_918_481_8)),
    ("=NPV(0.1,100,200,300)", N(481.592_787_377_911_24)),
    ("=IRR({-1000,300,400,500})", N(0.088_963_394_693_350_02)),
    ("=NPER(0.01,-100,1000)", N(10.588_644_459_423_23)),
    ("=RATE(10,-100,800)", N(0.042_774_978_035_111_266)),
    ("=IPMT(0.1/12,1,36,8000)", N(-66.666_666_666_666_67)),
    ("=PPMT(0.1/12,1,36,8000)", N(-191.470_830_884_034_06)),
    ("=MIRR({-1000,300,400,500},0.1,0.12)", N(0.098_156_692_446_315_53)),
    ("=SLN(10000,1000,5)", N(1800.0)),
    ("=SYD(10000,1000,5,1)", N(3000.0)),
    ("=DB(10000,1000,5,1)", N(3690.0)),
    ("=DDB(10000,1000,5,1)", N(4000.0)),
    ("=EFFECT(0.1,12)", N(0.104_713_067_441_296_83)),
    ("=NOMINAL(0.104713067441297,12)", N(0.1)),
    // ---- engineering
    ("=DEC2BIN(10)", T("1010")),
    ("=BIN2DEC(\"1010\")", N(10.0)),
    ("=DEC2HEX(255)", T("FF")),
    ("=HEX2DEC(\"FF\")", N(255.0)),
    ("=DEC2OCT(8)", T("10")),
    ("=OCT2DEC(\"10\")", N(8.0)),
    ("=BITAND(12,10)", N(8.0)),
    ("=BITOR(12,10)", N(14.0)),
    ("=BITXOR(12,10)", N(6.0)),
    ("=DELTA(1,1)", N(1.0)),
    ("=GESTEP(5,4)", N(1.0)),
    ("=CONVERT(1,\"km\",\"m\")", N(1000.0)),
    ("=ERF(1)", N(0.842_700_792_949_714_9)),
    // ---- operators, precedence, references
    ("=-2^2", N(4.0)),
    ("=2+3*4", N(14.0)),
    ("=(2+3)*4", N(20.0)),
    ("=10%", N(0.1)),
    ("=A1=1", B(true)),
    ("=\"abc\"<\"abd\"", B(true)),
    ("=\"A\"=\"a\"", B(true)),
    ("=SUM($A$1:A2)", N(3.0)),
    ("=SUM(A1:A5 A3:B3)", N(3.0)),
    ("=SUM((A1:A2,B1:B2))", N(33.0)),
];

/// Deviations accepted for now: (formula, reason). Keep in sync with the
/// strict test below; remove an entry when the engine matches Excel.
const KNOWN: &[(&str, &str)] = &[
    (
        "=SUM(A1:A5 A3:B3)",
        "BUG (IronCalc parser): the intersection operator (space between references) is rejected on input with \
         'Hay un problema con esta fórmula'; Excel returns the intersection A3:A3",
    ),
    (
        "=SUM((A1:A2,B1:B2))",
        "BUG (IronCalc parser): the union operator (parenthesized reference list) is rejected on input; \
         Excel sums both areas",
    ),
];

fn a1(a1: &str) -> (u32, u32) {
    let at = common::parse_a1(a1);
    (at.row, at.col)
}

fn matches(got: &CellValue, want: Want) -> bool {
    match (got, want) {
        (CellValue::Number { value }, N(w)) => numbers_match(*value, w) || (w == 0.0 && value.abs() < 1e-12),
        (CellValue::Text { value }, T(w)) => value == w,
        (CellValue::Empty, T("")) => true,
        (CellValue::Bool { value }, B(w)) => *value == w,
        (CellValue::Error { value }, E(w)) => value == w,
        _ => false,
    }
}

/// Column where formula i lives (rows 0..n): far right of the data block.
const OUT_COL: u32 = 12;

fn evaluate() -> Vec<(&'static str, Want, CellValue, String)> {
    let actor = Actor::start();
    let info = actor.new_document();
    let (doc, sheet) = (info.doc, info.active_sheet);
    let cells: Vec<CellInput> = DATA
        .iter()
        .map(|(at, v)| {
            let (row, col) = a1(at);
            CellInput { row, col, input: v.to_string(), num_fmt: None }
        })
        .collect();
    actor.apply(doc, vec![EngineOp::SetCells { sheet, cells }]).expect("data block");
    // One formula per apply: a formula the engine rejects must not hide the rest.
    let mut rejected = std::collections::HashMap::new();
    for (i, (f, _)) in CASES.iter().enumerate() {
        let cells = vec![CellInput { row: i as u32, col: OUT_COL, input: f.to_string(), num_fmt: None }];
        if let Err(e) = actor.apply(doc, vec![EngineOp::SetCells { sheet, cells }]) {
            rejected.insert(i, format!("rejected on input: {e}"));
        }
    }
    let range = CellRange { r0: 0, c0: OUT_COL, r1: CASES.len() as u32 - 1, c1: OUT_COL };
    let values = actor.call(move |s| s.range_values(doc, sheet, range)).expect("getRangeValues");
    CASES
        .iter()
        .enumerate()
        .map(|(i, (f, want))| {
            let input = actor.cell(doc, sheet, i as u32, OUT_COL).input;
            let got = match rejected.get(&i) {
                Some(why) => CellValue::Error { value: why.clone() },
                None => values.values[i][0].clone(),
            };
            (*f, *want, got, input)
        })
        .collect()
}

fn run(strict: bool) {
    let mut report = Report::default();
    for (formula, want, got, _) in evaluate() {
        report.checked += 1;
        let known = KNOWN.iter().find(|(f, _)| *f == formula);
        match (matches(&got, want), known) {
            (true, Some(_)) => report.stale.push(formula.to_string()),
            (true, None) => {}
            (false, Some((_, why))) => report.known.push(format!("{formula}: got {got:?}, want {want:?} ({why})")),
            (false, None) => report.fail(format!("{formula}: got {got:?}, want {want:?}")),
        }
    }
    if strict {
        report.assert_no_known_gaps("function results (strict)");
    } else {
        report.assert_ok("function results");
    }
}

#[test]
fn functions_return_excel_results() {
    run(false);
}

#[test]
#[ignore = "strict twin: fails while KNOWN lists engine deviations from Excel"]
fn functions_return_excel_results_strict() {
    run(true);
}

#[test]
fn formulas_keep_their_en_us_text() {
    // The formula bar shows what was typed (canonical en-US), function names upper-case.
    let mut bad = Vec::new();
    for (formula, _, _, input) in evaluate() {
        let simple = !formula.contains('{') && !formula.contains(" A3") && !formula.contains("((");
        if simple && input.to_uppercase().replace(' ', "") != formula.to_uppercase().replace(' ', "") {
            bad.push(format!("{formula} -> {input}"));
        }
    }
    let known: Vec<&str> = KNOWN_TEXT.iter().map(|(f, _)| *f).collect();
    let unexpected: Vec<&String> = bad.iter().filter(|b| !known.iter().any(|k| b.starts_with(&format!("{k} ->")))).collect();
    assert!(unexpected.is_empty(), "formula text changed:\n  {}", unexpected.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n  "));
}

/// Formulas whose text the engine rewrites (formula bar shows something else).
const KNOWN_TEXT: &[(&str, &str)] = &[];

#[test]
fn every_tested_function_is_listed() {
    let names: std::collections::HashSet<String> =
        sheetlight_lib::engine::actor::function_names().into_iter().map(|f| f.name).collect();
    let mut tested = std::collections::BTreeSet::new();
    for (formula, _) in CASES {
        let bytes = formula.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i].is_ascii_uppercase() {
                let start = i;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'.') {
                    i += 1;
                }
                if bytes.get(i) == Some(&b'(') && !formula[..start].ends_with('"') {
                    tested.insert(formula[start..i].to_string());
                }
            }
            i += 1;
        }
    }
    tested.remove("NOFUNCTION");
    let missing: Vec<_> = tested.iter().filter(|n| !names.contains(*n)).collect();
    assert!(missing.is_empty(), "not in listFunctions: {missing:?}");
    assert!(tested.len() >= 150, "only {} distinct functions covered", tested.len());
    eprintln!("{} distinct functions covered", tested.len());
}
