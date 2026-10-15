import type {
  BorderPreset,
  BorderStyle,
  CellFormat,
  EngineOp,
  HAlign,
  StylePatch,
  VAlign,
} from "@/engine/contract";
import type { CellRange, SheetId } from "@/engine/types";
import {
  DATE_CODES,
  FRACTION_CODES,
  TIME_CODES,
  analyzeFormat,
  buildAccountingCode,
  buildCurrencyCode,
  buildNumberCode,
  buildPercentCode,
  buildScientificCode,
  type NegativeStyle,
  type NumberCategory,
} from "@/lib/number-formats";

/**
 * State of the "Formato de celdas" dialog (Ctrl+1) and the ops it produces.
 * Pure: the dialog edits a `FormatDraft` initialised from the active cell and
 * `formatCellsOps` turns the *changed* fields into one undo step, so
 * untouched properties of a mixed selection are left alone (Excel).
 */

export interface NumberDraft {
  readonly category: NumberCategory;
  readonly decimals: number;
  readonly thousands: boolean;
  readonly negative: NegativeStyle;
  readonly symbol: string;
  readonly dateCode: string;
  readonly timeCode: string;
  readonly fractionCode: string;
  readonly customCode: string;
}

export interface AlignmentDraft {
  readonly hAlign: HAlign;
  readonly vAlign: VAlign;
  readonly wrap: boolean;
  readonly shrinkToFit: boolean;
  readonly indent: number;
  readonly rotation: number;
  readonly merge: boolean;
}

export interface FontDraft {
  readonly family: string;
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: "none" | "single" | "double";
  readonly strike: boolean;
  /** null = automatic. */
  readonly color: string | null;
}

export interface BorderStroke {
  readonly preset: BorderPreset;
  readonly style: BorderStyle;
  readonly color: string;
}

export interface FormatDraft {
  readonly number: NumberDraft;
  readonly alignment: AlignmentDraft;
  readonly font: FontDraft;
  /** null = no fill. */
  readonly fill: string | null;
  /** Border presets clicked in the dialog, applied in order. */
  readonly borders: ReadonlyArray<BorderStroke>;
}

export const MAX_DECIMALS = 30;

export function clampDecimals(value: number): number {
  return Math.max(0, Math.min(MAX_DECIMALS, Math.round(Number.isFinite(value) ? value : 0)));
}

export function numberDraftFromCode(code: string): NumberDraft {
  const analysis = analyzeFormat(code);
  const category = analysis.category;
  return {
    category,
    decimals: category === "general" || category === "text" ? 2 : analysis.decimals,
    thousands: analysis.thousands,
    negative: analysis.negative,
    symbol: category === "currency" || category === "accounting" ? analysis.symbol : "€",
    dateCode: category === "date" ? code : DATE_CODES[0],
    timeCode: category === "time" ? code : TIME_CODES[0],
    fractionCode: category === "fraction" ? code : FRACTION_CODES[0].code,
    customCode: code,
  };
}

/** Excel number format code for the dialog state. */
export function numberCode(draft: NumberDraft): string {
  const decimals = clampDecimals(draft.decimals);
  switch (draft.category) {
    case "general":
      return "General";
    case "number":
      return buildNumberCode({ decimals, thousands: draft.thousands, negative: draft.negative });
    case "currency":
      return buildCurrencyCode({ decimals, symbol: draft.symbol, negative: draft.negative });
    case "accounting":
      return buildAccountingCode({ decimals, symbol: draft.symbol });
    case "date":
      return draft.dateCode;
    case "time":
      return draft.timeCode;
    case "percent":
      return buildPercentCode(decimals);
    case "fraction":
      return draft.fractionCode;
    case "scientific":
      return buildScientificCode(decimals);
    case "text":
      return "@";
    case "custom":
      return draft.customCode.trim() || "General";
  }
}

export function formatDraft(format: CellFormat | null, defaults: { family: string; size: number }, merged = false): FormatDraft {
  const style = format?.style ?? {};
  return {
    number: numberDraftFromCode(format?.numFmt ?? "General"),
    alignment: {
      hAlign: style.hAlign ?? "general",
      vAlign: style.vAlign ?? "bottom",
      wrap: style.wrap === true,
      shrinkToFit: style.shrinkToFit === true,
      indent: style.indent ?? 0,
      rotation: style.rotation ?? 0,
      merge: merged,
    },
    font: {
      family: style.fontFamily ?? defaults.family,
      size: style.fontSize ?? defaults.size,
      bold: style.bold === true,
      italic: style.italic === true,
      underline: style.underline === "double" ? "double" : style.underline ? "single" : "none",
      strike: style.strike === true,
      color: style.color ?? null,
    },
    fill: style.fill ?? null,
    borders: [],
  };
}

/** The style fields that differ between the initial and the edited draft. */
export function formatPatch(initial: FormatDraft, edited: FormatDraft): StylePatch {
  const patch: { -readonly [K in keyof StylePatch]: StylePatch[K] } = {};
  const code = numberCode(edited.number);
  if (code !== numberCode(initial.number)) patch.numFmt = code;

  const a0 = initial.alignment;
  const a1 = edited.alignment;
  if (a1.hAlign !== a0.hAlign) patch.hAlign = a1.hAlign === "general" ? null : a1.hAlign;
  if (a1.vAlign !== a0.vAlign) patch.vAlign = a1.vAlign === "bottom" ? null : a1.vAlign;
  if (a1.wrap !== a0.wrap) patch.wrap = a1.wrap;
  if (a1.shrinkToFit !== a0.shrinkToFit) patch.shrinkToFit = a1.shrinkToFit;
  if (a1.indent !== a0.indent) patch.indent = Math.max(0, Math.min(15, Math.round(a1.indent)));
  if (a1.rotation !== a0.rotation) patch.rotation = a1.rotation === 255 ? 255 : Math.max(-90, Math.min(90, Math.round(a1.rotation)));

  const f0 = initial.font;
  const f1 = edited.font;
  if (f1.family !== f0.family) patch.fontFamily = f1.family;
  if (f1.size !== f0.size) patch.fontSize = f1.size;
  if (f1.bold !== f0.bold) patch.bold = f1.bold;
  if (f1.italic !== f0.italic) patch.italic = f1.italic;
  if (f1.underline !== f0.underline) patch.underline = f1.underline === "double" ? "double" : f1.underline === "single";
  if (f1.strike !== f0.strike) patch.strike = f1.strike;
  if (f1.color !== f0.color) patch.color = f1.color;

  if (edited.fill !== initial.fill) patch.fill = edited.fill;
  return patch;
}

/** One batch (= one undo step) for the dialog's OK button. */
export function formatCellsOps(
  sheet: SheetId,
  ranges: ReadonlyArray<CellRange>,
  initial: FormatDraft,
  edited: FormatDraft,
): EngineOp[] {
  const ops: EngineOp[] = [];
  const patch = formatPatch(initial, edited);
  if (Object.keys(patch).length > 0) ops.push({ type: "setStyle", sheet, ranges, patch });
  for (const stroke of edited.borders) {
    ops.push({ type: "setBorders", sheet, ranges, preset: stroke.preset, style: stroke.style, color: stroke.color });
  }
  if (edited.alignment.merge !== initial.alignment.merge) {
    if (edited.alignment.merge) {
      for (const range of ranges) {
        if (range.r0 !== range.r1 || range.c0 !== range.c1) ops.push({ type: "merge", sheet, range, mode: "merge" });
      }
    } else {
      ops.push({ type: "unmerge", sheet, ranges });
    }
  }
  return ops;
}
