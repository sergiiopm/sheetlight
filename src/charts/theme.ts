/**
 * Office 2013–2022 default chart look: theme accents, Calibri-like body font,
 * gray text, light gray gridlines, white chart area. Charts are white in dark
 * mode too, like Excel.
 */

/** accent1..6, then darker (lumMod 60%) and lighter (lumMod 80% + lumOff 20%) variants. */
export const OFFICE_PALETTE: ReadonlyArray<string> = [
  "#4472C4",
  "#ED7D31",
  "#A5A5A5",
  "#FFC000",
  "#5B9BD5",
  "#70AD47",
  "#264478",
  "#9E480E",
  "#636363",
  "#997300",
  "#255E91",
  "#43682B",
  "#698ED0",
  "#F1975A",
  "#B7B7B7",
  "#FFCD33",
  "#7CAFDD",
  "#8CC168",
];

export function paletteColor(index: number): string {
  const n = OFFICE_PALETTE.length;
  return OFFICE_PALETTE[((index % n) + n) % n];
}

export const CHART_FONT_FAMILY = 'Calibri, Carlito, "Segoe UI", Arial, sans-serif';

/** Point sizes converted to CSS px (1pt = 4/3 px). */
export const CHART_STYLE = {
  background: "#FFFFFF",
  border: "#D9D9D9",
  text: "#595959",
  gridline: "#D9D9D9",
  axisLine: "#D9D9D9",
  titleSize: (14 * 4) / 3,
  axisTitleSize: (10 * 4) / 3,
  labelSize: (9 * 4) / 3,
  legendSize: (9 * 4) / 3,
  /** Line series width (2.25pt). */
  lineWidth: 3,
  /** Marker diameter (size 5 ≈ 5pt). */
  markerSize: 7,
  padding: 10,
} as const;

export function font(sizePx: number, bold = false): string {
  return `${bold ? "bold " : ""}${sizePx.toFixed(2)}px ${CHART_FONT_FAMILY}`;
}

/** Relative luminance (0..1) of `#rrggbb`, for picking label colors on fills. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1;
  const v = parseInt(m[1], 16);
  const ch = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((v >> 16) & 255) + 0.7152 * ch((v >> 8) & 255) + 0.0722 * ch(v & 255);
}

export function normalizeColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}
