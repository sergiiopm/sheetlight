import { cellName, MAX_COLS, MAX_ROWS, type CellAddress } from "@/engine/types";

let nextId = 1;

const VISUALLY_HIDDEN: Partial<CSSStyleDeclaration> = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: "0",
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: "0",
};

/**
 * Accessibility for the canvas grid: the focusable scroller is an ARIA grid
 * whose active descendant is a single hidden row/cell mirroring the active
 * cell (address + display text), plus a polite live region that announces
 * it ("B3, Ventas") when it changes. Screen readers never see per-cell DOM.
 */
export class A11yLayer {
  private readonly box: HTMLDivElement;
  private readonly row: HTMLDivElement;
  private readonly cell: HTMLDivElement;
  private readonly live: HTMLDivElement;
  private lastAnnounce = "";
  private timer = 0;

  constructor(root: HTMLElement, private readonly scroller: HTMLElement) {
    const id = nextId++;
    this.box = document.createElement("div");
    Object.assign(this.box.style, VISUALLY_HIDDEN);
    this.box.className = "sl-grid-a11y";
    this.row = document.createElement("div");
    this.row.id = `sl-grid-row-${id}`;
    this.row.setAttribute("role", "row");
    this.cell = document.createElement("div");
    this.cell.id = `sl-grid-cell-${id}`;
    this.cell.setAttribute("role", "gridcell");
    this.cell.setAttribute("aria-selected", "true");
    this.row.appendChild(this.cell);
    this.live = document.createElement("div");
    this.live.setAttribute("role", "status");
    this.live.setAttribute("aria-live", "polite");
    this.live.setAttribute("aria-atomic", "true");
    this.box.append(this.row, this.live);
    root.appendChild(this.box);

    scroller.setAttribute("role", "grid");
    scroller.setAttribute("aria-label", "Hoja de cálculo");
    scroller.setAttribute("aria-rowcount", String(MAX_ROWS));
    scroller.setAttribute("aria-colcount", String(MAX_COLS));
    scroller.setAttribute("aria-multiselectable", "true");
    scroller.setAttribute("aria-owns", this.row.id);
    scroller.setAttribute("aria-activedescendant", this.cell.id);
  }

  setReadOnly(readOnly: boolean): void {
    this.scroller.setAttribute("aria-readonly", String(readOnly));
  }

  /** Text announced for the current active cell (also readable by tests). */
  get announcement(): string {
    return this.lastAnnounce;
  }

  /**
   * Mirror the active cell. `text` is its display text (null while its block
   * loads: the cell is announced again once the text arrives).
   */
  update(cell: CellAddress, text: string | null, selectionLabel: string | null): void {
    const name = cellName(cell);
    const value = text === null ? "" : text === "" ? "vacía" : text;
    this.row.setAttribute("aria-rowindex", String(cell.row + 1));
    this.cell.setAttribute("aria-colindex", String(cell.col + 1));
    this.cell.textContent = value;
    this.cell.setAttribute("aria-label", value ? `${name}, ${value}` : name);
    const message = [name, value, selectionLabel].filter((s) => s).join(", ");
    if (message === this.lastAnnounce) return;
    this.lastAnnounce = message;
    // Debounced: key auto-repeat must not flood the screen reader.
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.live.textContent = message;
    }, 120);
  }

  dispose(): void {
    window.clearTimeout(this.timer);
    this.box.remove();
  }
}
