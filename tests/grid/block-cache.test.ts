import { describe, expect, it } from "vitest";
import { BLOCK_SIZE, type BlockKey } from "@/engine/contract";
import { BlockCache } from "@/grid/data/BlockCache";
import type { GridBlock } from "@/grid/data/GridBlock";

function block(br: number, bc: number, version: number, text = `${br}:${bc}`): GridBlock {
  const texts = new Array<string | null>(BLOCK_SIZE).fill(null);
  texts[0] = text;
  return { br, bc, version, texts, kinds: new Uint8Array(BLOCK_SIZE), styleIds: new Uint32Array(BLOCK_SIZE), flags: new Uint8Array(BLOCK_SIZE) };
}

interface Call {
  keys: BlockKey[];
  known: ReadonlyArray<number> | undefined;
  priority: 0 | 1;
  resolve: (b: GridBlock[]) => void;
}

function setup(capacity = 4) {
  const calls: Call[] = [];
  const loaded: BlockKey[][] = [];
  const cache = new BlockCache(
    (keys, known, priority) => new Promise((resolve) => calls.push({ keys: [...keys], known, priority, resolve })),
    capacity,
    (keys) => loaded.push([...keys]),
  );
  cache.setUsedRange({ r0: 0, c0: 0, r1: 64 * 10 - 1, c1: 16 * 2 - 1 });
  return { cache, calls, loaded };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("BlockCache", () => {
  it("requests missing blocks once, never known-empty ones, and serves arrivals synchronously", async () => {
    const { cache, calls, loaded } = setup();
    cache.ensure([{ br: 0, bc: 0 }, { br: 0, bc: 5 }, { br: 20, bc: 0 }], 0);
    cache.ensure([{ br: 0, bc: 0 }], 0);
    expect(calls).toHaveLength(1);
    expect(calls[0].keys).toEqual([{ br: 0, bc: 0 }]);
    expect(cache.isKnownEmpty(0, 5)).toBe(true);
    expect(cache.get(0, 0)).toBeUndefined();
    calls[0].resolve([block(0, 0, 1)]);
    await flush();
    expect(cache.get(0, 0)?.texts[0]).toBe("0:0");
    expect(loaded).toEqual([[{ br: 0, bc: 0 }]]);
  });

  it("keeps serving stale blocks and refreshes them with known versions", async () => {
    const { cache, calls } = setup();
    cache.ensure([{ br: 1, bc: 1 }], 0);
    calls[0].resolve([block(1, 1, 7)]);
    await flush();
    cache.invalidate([{ r0: 64, c0: 16, r1: 64, c1: 16 }]);
    expect(cache.isStale(1, 1)).toBe(true);
    expect(cache.get(1, 1)?.version).toBe(7);
    cache.ensure([{ br: 1, bc: 1 }], 0);
    expect(calls[1].known).toEqual([7]);
    // Engine says unchanged (block omitted): it is fresh again.
    calls[1].resolve([]);
    await flush();
    expect(cache.isStale(1, 1)).toBe(false);
    expect(cache.stats.unchangedBlocks).toBe(1);
  });

  it("an invalidation during a fetch re-marks the arriving block stale", async () => {
    const { cache, calls } = setup();
    cache.ensure([{ br: 2, bc: 0 }], 0);
    cache.invalidateAll();
    calls[0].resolve([block(2, 0, 1)]);
    await flush();
    // The data may predate the change: shown, but refetched.
    expect(cache.get(2, 0)?.version).toBe(1);
    expect(cache.isStale(2, 0)).toBe(true);
    cache.ensure([{ br: 2, bc: 0 }], 0);
    expect(calls).toHaveLength(2);
    expect(calls[1].known).toEqual([1]);
    calls[1].resolve([block(2, 0, 2)]);
    await flush();
    expect(cache.get(2, 0)?.version).toBe(2);
    expect(cache.isStale(2, 0)).toBe(false);
    // Whole-sheet ranges walk the cache instead of the range.
    cache.invalidate([{ r0: 0, c0: 0, r1: 1_048_575, c1: 16_383 }]);
    expect(cache.isStale(2, 0)).toBe(true);
  });

  it("evicts least recently used blocks beyond capacity", async () => {
    const { cache, calls } = setup(3);
    for (let br = 0; br < 3; br++) {
      cache.ensure([{ br, bc: 0 }], 0);
      calls[br].resolve([block(br, 0, 1)]);
      await flush();
    }
    cache.ensure([{ br: 0, bc: 0 }], 0); // touch 0: 1 is now the oldest
    cache.ensure([{ br: 3, bc: 0 }], 0);
    calls[3].resolve([block(3, 0, 1)]);
    await flush();
    expect(cache.get(1, 0)).toBeUndefined();
    expect(cache.get(0, 0)).toBeDefined();
    expect(cache.get(3, 0)).toBeDefined();
  });

  it("drops responses that predate a structural shift", async () => {
    const { cache, calls, loaded } = setup();
    cache.ensure([{ br: 4, bc: 0 }], 0);
    cache.shift("row", 0, 10, true, 1_048_576);
    calls[0].resolve([block(4, 0, 1)]);
    await flush();
    expect(cache.get(4, 0)).toBeUndefined();
    expect(loaded.at(-1)).toEqual([]);
  });
});
