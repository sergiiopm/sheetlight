/**
 * Visual constants of the grid. Sizes are CSS px at zoom 100% unless noted.
 * Colors are concrete (canvas needs them); they follow the app palette in
 * `src/index.css` (zinc neutrals + the green `--brand` accent).
 */
export interface GridTheme {
  readonly name: "light" | "dark";
  readonly background: string;
  readonly gridline: string;
  readonly placeholder: string;
  readonly headerBg: string;
  readonly headerText: string;
  readonly headerLine: string;
  readonly headerFont: string;
  readonly headerFontSizePx: number;
  readonly headerHeight: number;
  readonly hiddenMarker: string;
  readonly frozenLine: string;
  readonly defaultFontFamily: string;
  readonly defaultFontSizePt: number;
  readonly defaultTextColor: string;
  readonly cellPaddingX: number;
  readonly cellPaddingY: number;
  readonly selectionFill: string;
  readonly selectionBorder: string;
  readonly headerSelectedBg: string;
  readonly headerSelectedText: string;
  readonly headerSelectedLine: string;
  readonly headerAllSelectedBg: string;
  readonly fillHandleRing: string;
  readonly fillPreview: string;
  readonly resizeGuide: string;
  readonly marquee: string;
  readonly filterButtonBg: string;
  readonly filterButtonBorder: string;
  readonly filterButtonGlyph: string;
  readonly filterActiveGlyph: string;
  readonly overlayHostBg: string;
}

const FONT = 'Calibri, Carlito, "Segoe UI", sans-serif';
const HEADER_FONT = '"Segoe UI", system-ui, sans-serif';

export const LIGHT_THEME: GridTheme = {
  name: "light",
  background: "#ffffff",
  gridline: "#e1e1e3",
  placeholder: "#f4f4f5",
  headerBg: "#f4f4f5",
  headerText: "#52525b",
  headerLine: "#d4d4d8",
  headerFont: HEADER_FONT,
  headerFontSizePx: 11,
  headerHeight: 20,
  hiddenMarker: "#71717b",
  frozenLine: "#a1a1aa",
  defaultFontFamily: FONT,
  defaultFontSizePt: 11,
  defaultTextColor: "#000000",
  cellPaddingX: 3,
  cellPaddingY: 2,
  selectionFill: "rgba(37, 152, 77, 0.12)",
  selectionBorder: "#1f8a45",
  headerSelectedBg: "#d6eedd",
  headerSelectedText: "#14532d",
  headerSelectedLine: "#1f8a45",
  headerAllSelectedBg: "#c3e6cd",
  fillHandleRing: "#ffffff",
  fillPreview: "#71717b",
  resizeGuide: "#1f8a45",
  marquee: "#1f8a45",
  filterButtonBg: "#ffffff",
  filterButtonBorder: "#a1a1aa",
  filterButtonGlyph: "#3f3f46",
  filterActiveGlyph: "#1f8a45",
  overlayHostBg: "transparent",
};

export const DARK_THEME: GridTheme = {
  name: "dark",
  background: "#1c1c1f",
  gridline: "#323236",
  placeholder: "#26262a",
  headerBg: "#232327",
  headerText: "#a1a1aa",
  headerLine: "#3a3a3f",
  headerFont: HEADER_FONT,
  headerFontSizePx: 11,
  headerHeight: 20,
  hiddenMarker: "#a1a1aa",
  frozenLine: "#6b6b73",
  defaultFontFamily: FONT,
  defaultFontSizePt: 11,
  defaultTextColor: "#ececee",
  cellPaddingX: 3,
  cellPaddingY: 2,
  selectionFill: "rgba(83, 190, 112, 0.18)",
  selectionBorder: "#53be70",
  headerSelectedBg: "#22402c",
  headerSelectedText: "#b7ebc5",
  headerSelectedLine: "#53be70",
  headerAllSelectedBg: "#2a5236",
  fillHandleRing: "#1c1c1f",
  fillPreview: "#a1a1aa",
  resizeGuide: "#53be70",
  marquee: "#53be70",
  filterButtonBg: "#2a2a2e",
  filterButtonBorder: "#5a5a61",
  filterButtonGlyph: "#d4d4d8",
  filterActiveGlyph: "#53be70",
  overlayHostBg: "transparent",
};

/** Theme matching the app (`dark` class on `<html>`, see `src/lib/theme.ts`). */
export function currentAppTheme(): GridTheme {
  if (typeof document === "undefined") return LIGHT_THEME;
  return document.documentElement.classList.contains("dark") ? DARK_THEME : LIGHT_THEME;
}
