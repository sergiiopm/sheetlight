import type { BorderSpec, CellStyle, HAlign, VAlign } from "@/engine/contract";
import type { StyleId } from "@/engine/types";
import type { GridTheme } from "./theme";

/** A CellStyle with defaults applied and fonts pre-built for the current scale. */
export interface ResolvedStyle {
  readonly font: string;
  /** Font size in device px. */
  readonly fontPx: number;
  readonly color: string;
  readonly fill: string | null;
  readonly hAlign: HAlign;
  readonly vAlign: VAlign;
  readonly wrap: boolean;
  /** 0 none, 1 single, 2 double. */
  readonly underline: 0 | 1 | 2;
  readonly strike: boolean;
  readonly indent: number;
  readonly borderTop: BorderSpec | null;
  readonly borderRight: BorderSpec | null;
  readonly borderBottom: BorderSpec | null;
  readonly borderLeft: BorderSpec | null;
  readonly hasBorders: boolean;
}

/** Quote a font family for the canvas `font` shorthand when needed. */
function familyList(family: string, fallback: string): string {
  const f = family.trim();
  if (f === "") return fallback;
  const quoted = /^["']/.test(f) || !/\s/.test(f) || f.includes(",") ? f : `"${f}"`;
  return `${quoted}, ${fallback}`;
}

/**
 * Resolves style ids to render-ready styles for one scale (dpr * zoom).
 * The cache is invalidated when the scale, theme or style table changes.
 */
export class StyleResolver {
  private cache = new Map<StyleId, ResolvedStyle>();
  private scale = 1;

  constructor(
    private theme: GridTheme,
    private readonly lookup: (id: StyleId) => CellStyle,
  ) {}

  setScale(scale: number): void {
    if (scale !== this.scale) {
      this.scale = scale;
      this.cache.clear();
    }
  }

  setTheme(theme: GridTheme): void {
    if (theme !== this.theme) {
      this.theme = theme;
      this.cache.clear();
    }
  }

  /** Forget resolved entries (style definitions changed or arrived). */
  reset(): void {
    this.cache.clear();
  }

  get(id: StyleId): ResolvedStyle {
    let r = this.cache.get(id);
    if (!r) {
      r = this.resolve(this.lookup(id));
      this.cache.set(id, r);
    }
    return r;
  }

  private resolve(s: CellStyle): ResolvedStyle {
    const t = this.theme;
    const pt = s.fontSize ?? t.defaultFontSizePt;
    const fontPx = Math.round(((pt * 4) / 3) * this.scale * 10) / 10;
    const family = s.fontFamily ? familyList(s.fontFamily, t.defaultFontFamily) : t.defaultFontFamily;
    const font = `${s.italic ? "italic " : ""}${s.bold ? "bold " : ""}${fontPx}px ${family}`;
    const borderTop = s.borderTop ?? null;
    const borderRight = s.borderRight ?? null;
    const borderBottom = s.borderBottom ?? null;
    const borderLeft = s.borderLeft ?? null;
    return {
      font,
      fontPx,
      color: s.color ?? t.defaultTextColor,
      fill: s.fill ?? null,
      hAlign: s.hAlign ?? "general",
      vAlign: s.vAlign ?? "bottom",
      wrap: s.wrap === true || s.hAlign === "justify",
      underline: s.underline === "double" ? 2 : s.underline ? 1 : 0,
      strike: s.strike ?? false,
      indent: s.indent ?? 0,
      borderTop,
      borderRight,
      borderBottom,
      borderLeft,
      hasBorders: !!(borderTop || borderRight || borderBottom || borderLeft),
    };
  }
}
