import { describe, expect, it } from "vitest";
import type { BlockKey, BlockRequest, CellBlock, EngineEvent, SheetInfo, WorkbookEngine } from "@/engine/contract";
import { MemoryEngine } from "@/engine/memory-engine";
import type { CellAddress, Direction, DocumentId, StyleId } from "@/engine/types";
import { EngineDataSource, type DataSourceListener } from "@/grid/data/DataSource";
import { AxisModel } from "@/grid/geometry/AxisModel";
import { visibleDataEdge } from "@/grid/data/dataEdge";

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await tick();
}

class Recorder implements DataSourceListener {
  loaded: BlockKey[][] = [];
  invalidated = 0;
  infos: SheetInfo[] = [];
  structures: string[] = [];
  styleChanges = 0;
  onBlocksLoaded(keys: ReadonlyArray<BlockKey>): void {
    this.loaded.push([...keys]);
  }
  onDataInvalidated(): void {
    this.invalidated++;
  }
  onSheetInfo(info: SheetInfo): void {
    this.infos.push(info);
  }
  onStructure(axis: "row" | "col", insert: boolean, index: number, count: number): void {
    this.structures.push(`${axis}:${insert ? "+" : "-"}${index}x${count}`);
  }
  onStylesChanged(): void {
    this.styleChanges++;
  }
}

/** Wraps an engine to record requests and to emulate `knownVersions` (unchanged blocks omitted). */
function spy(engine: WorkbookEngine) {
  const requests: BlockRequest[] = [];
  const styleRequests: StyleId[][] = [];
  let honorKnown = false;
  const wrapped: WorkbookEngine = Object.create(engine);
  wrapped.fetchBlocks = async (doc: DocumentId, req: BlockRequest): Promise<CellBlock[]> => {
    requests.push(req);
    const blocks = await engine.fetchBlocks(doc, req);
    if (!honorKnown || !req.knownVersions) return blocks;
    return blocks.filter((b) => {
      const i = req.keys.findIndex((k) => k.br === b.br && k.bc === b.bc);
      return req.knownVersions![i] !== b.version;
    });
  };
  wrapped.getStyles = async (doc, ids) => {
    styleRequests.push([...ids]);
    return engine.getStyles(doc, ids);
  };
  wrapped.subscribe = (l) => engine.subscribe(l);
  return { engine: wrapped, requests, styleRequests, honor: (v: boolean) => (honorKnown = v) };
}

async function setup() {
  const mem = new MemoryEngine();
  const info = await mem.newDocument();
  const doc = info.doc;
  const sheet = info.activeSheet;
  await mem.apply(doc, [
    { type: "setCells", sheet, cells: [{ row: 0, col: 0, input: "hola" }, { row: 70, col: 20, input: "42" }] },
    { type: "setStyle", sheet, ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], patch: { bold: true, fill: "#ff0000" } },
  ]);
  const s = spy(mem);
  const rec = new Recorder();
  const src = new EngineDataSource(s.engine, doc, sheet, rec);
  await src.load();
  return { mem, doc, sheet, s, rec, src };
}

describe("EngineDataSource (against MemoryEngine)", () => {
  it("loads SheetInfo and blocks, with style definitions fetched before the block is shown", async () => {
    const { src, rec, s } = await setup();
    expect(rec.infos).toHaveLength(1);
    expect(src.used).toEqual({ r0: 0, c0: 0, r1: 70, c1: 20 });
    src.cache.ensure([{ br: 0, bc: 0 }, { br: 1, bc: 1 }, { br: 9, bc: 9 }], 0);
    await settle();
    // Block (9, 9) is outside the used range: never requested.
    expect(s.requests.flatMap((r) => r.keys)).toEqual([{ br: 0, bc: 0 }, { br: 1, bc: 1 }]);
    expect(src.cellText(0, 0)).toBe("hola");
    expect(src.cellText(70, 20)).toBe("42");
    const b = src.cache.get(0, 0)!;
    const sid = b.styleIds[0];
    expect(sid).not.toBe(0);
    expect(s.styleRequests.flat()).toContain(sid);
    expect(src.style(sid).bold).toBe(true);
    expect(rec.loaded.length).toBeGreaterThan(0);
  });

  it("cells event marks blocks stale; the refetch sends knownVersions and skips unchanged blocks", async () => {
    const { mem, doc, sheet, src, rec, s } = await setup();
    src.cache.ensure([{ br: 0, bc: 0 }, { br: 1, bc: 1 }], 0);
    await settle();
    s.requests.length = 0;
    s.honor(true);
    await mem.apply(doc, [{ type: "setCells", sheet, cells: [{ row: 1, col: 1, input: "nuevo" }] }]);
    await settle();
    expect(rec.invalidated).toBeGreaterThan(0);
    // Stale blocks keep rendering last-known data until refreshed.
    expect(src.cellText(0, 0)).toBe("hola");
    src.cache.ensure([{ br: 0, bc: 0 }, { br: 1, bc: 1 }], 0);
    await settle();
    const refresh = s.requests.find((r) => r.knownVersions);
    expect(refresh).toBeDefined();
    expect(refresh!.knownVersions!.length).toBe(refresh!.keys.length);
    // MemoryEngine keeps the version on cell edits, so the spy reports "unchanged": the cache keeps the old block.
    expect(src.cache.stats.unchangedBlocks).toBeGreaterThan(0);
    expect(src.cache.isStale(0, 0)).toBe(false);
    s.honor(false);
  });

  it("a cells event beyond the used range grows it so the new block is fetched", async () => {
    const { mem, doc, sheet, src } = await setup();
    expect(src.cache.isKnownEmpty(100, 50)).toBe(true);
    await mem.apply(doc, [{ type: "setCells", sheet, cells: [{ row: 6400, col: 800, input: "lejos" }] }]);
    await settle();
    expect(src.cache.isKnownEmpty(100, 50)).toBe(false);
    src.cache.ensure([{ br: 100, bc: 50 }], 0);
    await settle();
    expect(src.cellText(6400, 800)).toBe("lejos");
  });

  it("sheetInfo events reload geometry (coalesced)", async () => {
    const { mem, doc, sheet, rec } = await setup();
    await mem.apply(doc, [{ type: "setColWidths", sheet, cols: [3], size: 120 }]);
    await settle();
    const last = rec.infos[rec.infos.length - 1];
    expect(last.colOverrides).toEqual([{ index: 3, size: 120, hidden: undefined }]);
    // One apply = sheetData + sheetInfo events, but only one reload.
    expect(rec.infos.length).toBe(2);
  });

  it("ignores events of other sheets and documents", async () => {
    const { mem, doc, src, rec } = await setup();
    const res = await mem.apply(doc, [{ type: "addSheet", name: "Otra" }]);
    const other = res.created[0];
    const before = rec.invalidated;
    await mem.apply(doc, [{ type: "setCells", sheet: other, cells: [{ row: 0, col: 0, input: "x" }] }]);
    const doc2 = await mem.newDocument();
    await mem.apply(doc2.doc, [{ type: "setCells", sheet: doc2.activeSheet, cells: [{ row: 0, col: 0, input: "y" }] }]);
    await settle();
    expect(rec.invalidated).toBe(before);
    expect(src.cellText(0, 0)).toBe(null); // not fetched yet; untouched
  });

  it("structure events shift cached blocks locally before the refetch", async () => {
    const { doc, sheet, src, rec, mem } = await setup();
    src.cache.ensure([{ br: 0, bc: 0 }, { br: 0, bc: 1 }, { br: 1, bc: 0 }, { br: 1, bc: 1 }], 0);
    await settle();
    // Emit a structure event as the native engine would (MemoryEngine only sends sheetData).
    const emit = (e: EngineEvent) => (mem as unknown as { emit(e: EngineEvent): void }).emit(e);
    emit({ type: "structure", doc, sheet, axis: "row", op: "insert", index: 0, count: 2 });
    expect(rec.structures).toEqual(["row:+0x2"]);
    expect(src.cellText(2, 0)).toBe("hola");
    expect(src.cellText(0, 0)).toBe(null);
    expect(src.cellText(72, 20)).toBe("42");
    expect(src.cache.isStale(0, 0)).toBe(true);
    // Delete them again: back where they were.
    emit({ type: "structure", doc, sheet, axis: "row", op: "delete", index: 0, count: 2 });
    expect(src.cellText(0, 0)).toBe("hola");
    expect(src.cellText(70, 20)).toBe("42");
    // Column insert inside block 0 shifts within and across block columns.
    emit({ type: "structure", doc, sheet, axis: "col", op: "insert", index: 5, count: 17 });
    expect(src.cellText(0, 0)).toBe("hola");
    expect(src.cellText(70, 37)).toBe("42");
  });

  it("styles events refresh the style table", async () => {
    const { doc, src, rec, mem, s } = await setup();
    src.cache.ensure([{ br: 0, bc: 0 }], 0);
    await settle();
    s.styleRequests.length = 0;
    (mem as unknown as { emit(e: EngineEvent): void }).emit({ type: "styles", doc });
    await settle();
    expect(rec.styleChanges).toBe(1);
    expect(s.styleRequests.length).toBe(1);
  });

  it("autofit samples come with their styles", async () => {
    const { src } = await setup();
    const samples = await src.columnSamples(0, 10);
    expect(samples.map((x) => x.text)).toEqual(["hola"]);
    expect(src.hasStyle(samples[0].styleId)).toBe(true);
  });

  it("Ctrl+Arrow through the engine skips hidden rows", async () => {
    const { mem, doc, sheet, src } = await setup();
    // A1:A10 filled, rows 5..9 hidden (0-based 4..8).
    await mem.apply(doc, [{ type: "setCells", sheet, cells: Array.from({ length: 10 }, (_, r) => ({ row: r, col: 3, input: String(r) })) }]);
    const rows = new AxisModel(1_048_576, 20);
    const cols = new AxisModel(16_384, 64);
    for (let r = 4; r <= 9; r++) rows.setHidden(r, true);
    await settle();
    // Row 9 (the last filled) is hidden too: Excel stops at the last visible filled cell (row 3).
    expect(await src.findDataEdge({ row: 0, col: 3 }, "down", rows, cols)).toEqual({ row: 3, col: 3 });
  });
});

describe("visibleDataEdge vs brute force", () => {
  /** Excel Ctrl+Arrow on a compressed (visible-only) line. */
  function bruteVisible(filled: boolean[], hidden: boolean[], from: number, step: 1 | -1): number {
    const vis: number[] = [];
    for (let i = 0; i < filled.length; i++) if (!hidden[i]) vis.push(i);
    const k0 = vis.indexOf(from);
    const at = (k: number) => filled[vis[k]];
    const n = vis.length;
    if (k0 + step < 0 || k0 + step >= n) return from;
    let k = k0;
    if (at(k) && at(k + step)) {
      while (k + step >= 0 && k + step < n && at(k + step)) k += step;
      return vis[k];
    }
    k += step;
    while (k >= 0 && k < n && !at(k)) k += step;
    if (k < 0) return vis[0];
    if (k >= n) return vis[n - 1];
    return vis[k];
  }

  /** The engine's raw Ctrl+Arrow (ignores hidden). */
  function rawEdge(filled: boolean[], from: number, step: 1 | -1): number {
    const n = filled.length;
    if (from + step < 0 || from + step >= n) return from;
    let i = from;
    if (filled[i] && filled[i + step]) {
      while (i + step >= 0 && i + step < n && filled[i + step]) i += step;
      return i;
    }
    i += step;
    while (i >= 0 && i < n && !filled[i]) i += step;
    return i < 0 ? 0 : i >= n ? n - 1 : i;
  }

  it("matches on random lines with hidden runs", async () => {
    let seed = 9;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const N = 80;
    let calls = 0;
    for (let trial = 0; trial < 300; trial++) {
      const filled = Array.from({ length: N }, () => rnd() < 0.45);
      const hidden = Array.from({ length: N }, () => false);
      for (let h = 0; h < 4; h++) {
        const at = Math.floor(rnd() * N);
        const len = 1 + Math.floor(rnd() * 6);
        for (let j = at; j < Math.min(N, at + len); j++) hidden[j] = true;
      }
      const rows = new AxisModel(N, 20);
      hidden.forEach((h, i) => h && rows.setHidden(i, true));
      const cols = new AxisModel(10, 64);
      const probe = {
        rawEdge: async (f: CellAddress, d: Direction) => {
          calls++;
          return { row: rawEdge(filled, f.row, d === "down" ? 1 : -1), col: f.col };
        },
        filled: async (row: number) => filled[row],
      };
      for (let from = 0; from < N; from += 5) {
        if (hidden[from]) continue;
        for (const dir of ["down", "up"] as const) {
          const got = await visibleDataEdge(probe, rows, cols, { row: from, col: 0 }, dir);
          let expected = bruteVisible(filled, hidden, from, dir === "down" ? 1 : -1);
          // At the very edge of the line, both stay on the last visible cell.
          if (hidden[expected]) expected = rows.nextVisible(expected, dir === "down" ? -1 : 1);
          expect(got.row, `trial ${trial} from ${from} ${dir}`).toBe(expected);
        }
      }
    }
    expect(calls).toBeGreaterThan(0);
  });
});
