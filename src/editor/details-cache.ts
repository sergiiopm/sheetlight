import type { CellDetails, EngineEvent, WorkbookEngine } from "@/engine/contract";
import { rangeContains, type CellAddress, type DocumentId, type SheetId } from "@/engine/types";

/**
 * Small LRU of `CellDetails` for one document, shared by the formula bar
 * (shows the active cell's input while idle) and the edit session (F2 needs
 * the input synchronously when possible). Entries are dropped on engine
 * events that may have changed them; listeners are told so they can refetch.
 */
export class CellDetailsCache {
  private readonly entries = new Map<string, CellDetails>();
  private readonly inflight = new Map<string, Promise<CellDetails>>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  /** Bumped on every invalidation; fetches started before it are not cached. */
  private generation = 0;

  constructor(
    private readonly engine: WorkbookEngine,
    private readonly doc: DocumentId,
    private readonly maxEntries = 256,
  ) {
    this.unsubscribe = engine.subscribe((event) => this.onEvent(event));
  }

  peek(sheet: SheetId, cell: CellAddress): CellDetails | undefined {
    return this.entries.get(key(sheet, cell));
  }

  get(sheet: SheetId, cell: CellAddress): Promise<CellDetails> {
    const k = key(sheet, cell);
    const hit = this.entries.get(k);
    if (hit) {
      // refresh LRU position
      this.entries.delete(k);
      this.entries.set(k, hit);
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(k);
    if (pending) return pending;
    const generation = this.generation;
    const promise = this.engine.getCell(this.doc, sheet, cell).then(
      (details) => {
        this.inflight.delete(k);
        if (generation === this.generation) {
          this.entries.set(k, details);
          if (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) this.entries.delete(oldest);
          }
        }
        return details;
      },
      (error: unknown) => {
        this.inflight.delete(k);
        throw error;
      },
    );
    this.inflight.set(k, promise);
    return promise;
  }

  /** Called after any invalidation (the formula bar refetches its cell). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.inflight.clear();
    this.notify();
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
    this.entries.clear();
  }

  private onEvent(event: EngineEvent): void {
    if (!("doc" in event) || event.doc !== this.doc) return;
    switch (event.type) {
      case "cells": {
        this.generation += 1;
        this.inflight.clear();
        for (const k of [...this.entries.keys()]) {
          const [sheet, row, col] = k.split(":").map(Number);
          if (sheet === event.sheet && event.ranges.some((r) => rangeContains(r, row, col))) this.entries.delete(k);
        }
        this.notify();
        break;
      }
      case "sheetData":
      case "structure":
      case "styles":
      case "backendChanged":
        this.clear();
        break;
      default:
        break;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function key(sheet: SheetId, cell: CellAddress): string {
  return `${sheet}:${cell.row}:${cell.col}`;
}
