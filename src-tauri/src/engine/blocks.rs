//! Binary block encoder for `engine_fetch_blocks`. The wire format is
//! specified in `src/engine/block-codec.ts` (the TypeScript decoder); both
//! sides are checked against `tests/fixtures/blocks-golden.bin`.

use super::types::{BlockKey, CellKind, SheetId, BLOCK_SIZE};

pub const BLOCKS_MAGIC: u32 = 0x3142_4C53; // "SLB1"
pub const BLOCK_STATE_FULL: u32 = 0;
pub const BLOCK_STATE_UNCHANGED: u32 = 1;
pub const BLOCK_STATE_EMPTY: u32 = 2;

/// Per-cell data a backend writes into a block.
pub struct BlockCells {
    texts: Vec<String>,
    style_ids: Vec<u32>,
    kinds: Vec<u8>,
    flags: Vec<u8>,
    non_empty: bool,
}

impl Default for BlockCells {
    fn default() -> Self {
        Self::new()
    }
}

impl BlockCells {
    pub fn new() -> Self {
        Self {
            texts: vec![String::new(); BLOCK_SIZE],
            style_ids: vec![0; BLOCK_SIZE],
            kinds: vec![0; BLOCK_SIZE],
            flags: vec![0; BLOCK_SIZE],
            non_empty: false,
        }
    }

    /// Resets to all-empty, keeping allocations.
    pub fn clear(&mut self) {
        for text in &mut self.texts {
            text.clear();
        }
        self.style_ids.fill(0);
        self.kinds.fill(0);
        self.flags.fill(0);
        self.non_empty = false;
    }

    /// `index` = row_in_block * BLOCK_COLS + col_in_block.
    pub fn set(&mut self, index: usize, text: &str, kind: CellKind, style_id: u32, flags: u8) {
        let slot = &mut self.texts[index];
        slot.clear();
        slot.push_str(text);
        self.kinds[index] = kind as u8;
        self.style_ids[index] = style_id;
        self.flags[index] = flags;
        if kind != CellKind::Empty || style_id != 0 || flags != 0 || !text.is_empty() {
            self.non_empty = true;
        }
    }

    pub fn is_empty(&self) -> bool {
        !self.non_empty
    }

    /// Content hash used as the block version (equal hash => identical content).
    pub fn content_hash(&self) -> u32 {
        let mut hash: u32 = 0x811c_9dc5;
        let mut feed = |bytes: &[u8]| {
            for byte in bytes {
                hash ^= u32::from(*byte);
                hash = hash.wrapping_mul(0x0100_0193);
            }
        };
        for i in 0..BLOCK_SIZE {
            feed(self.texts[i].as_bytes());
            feed(&[0xff, self.kinds[i], self.flags[i]]);
            feed(&self.style_ids[i].to_le_bytes());
        }
        hash
    }
}

/// Accumulates the response for one `fetchBlocks` call.
pub struct BlocksWriter {
    buf: Vec<u8>,
    count: u32,
}

impl BlocksWriter {
    pub fn new(sheet: SheetId) -> Self {
        let mut buf = Vec::with_capacity(16 + 4 * (24 + 10_244));
        put_u32(&mut buf, BLOCKS_MAGIC);
        put_u32(&mut buf, 0); // count, patched in finish()
        put_u32(&mut buf, sheet);
        put_u32(&mut buf, 0);
        Self { buf, count: 0 }
    }

    pub fn unchanged(&mut self, key: BlockKey, version: u32) {
        self.header(key, version, BLOCK_STATE_UNCHANGED, 0);
    }

    pub fn empty(&mut self, key: BlockKey, version: u32) {
        self.header(key, version, BLOCK_STATE_EMPTY, 0);
    }

    /// Writes a block; uses the compact `empty` state when nothing is set.
    pub fn block(&mut self, key: BlockKey, version: u32, cells: &BlockCells) {
        if cells.is_empty() {
            self.empty(key, version);
            return;
        }
        let text_bytes: usize = cells.texts.iter().map(String::len).sum();
        self.header(key, version, BLOCK_STATE_FULL, text_bytes as u32);

        // UTF-16 offsets so JS can slice the decoded string directly.
        let mut offset: u32 = 0;
        for text in &cells.texts {
            put_u32(&mut self.buf, offset);
            offset += text.encode_utf16().count() as u32;
        }
        put_u32(&mut self.buf, offset);
        for style in &cells.style_ids {
            put_u32(&mut self.buf, *style);
        }
        self.buf.extend_from_slice(&cells.kinds);
        self.buf.extend_from_slice(&cells.flags);
        for text in &cells.texts {
            self.buf.extend_from_slice(text.as_bytes());
        }
        while self.buf.len() % 4 != 0 {
            self.buf.push(0);
        }
    }

    pub fn finish(mut self) -> Vec<u8> {
        self.buf[4..8].copy_from_slice(&self.count.to_le_bytes());
        self.buf
    }

    fn header(&mut self, key: BlockKey, version: u32, state: u32, text_bytes: u32) {
        put_u32(&mut self.buf, key.br);
        put_u32(&mut self.buf, key.bc);
        put_u32(&mut self.buf, version);
        put_u32(&mut self.buf, state);
        put_u32(&mut self.buf, text_bytes);
        put_u32(&mut self.buf, 0);
        self.count += 1;
    }
}

fn put_u32(buf: &mut Vec<u8>, value: u32) {
    buf.extend_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::types::{cell_flag, BLOCK_COLS};

    /// Same content as `goldenBlocks()` in `tests/unit/block-codec.test.ts`.
    fn golden() -> Vec<u8> {
        let mut writer = BlocksWriter::new(3);
        let mut cells = BlockCells::new();
        cells.set(0, "Año", CellKind::Text, 0, 0);
        cells.set(1, "1.234,5", CellKind::Number, 2, cell_flag::FORMULA);
        cells.set(BLOCK_COLS as usize, "😀 ok", CellKind::Text, 1, 0);
        cells.set(BLOCK_SIZE - 1, "#DIV/0!", CellKind::Error, 0, cell_flag::FORMULA);
        writer.block(BlockKey { br: 0, bc: 1 }, 7, &cells);
        writer.unchanged(BlockKey { br: 1, bc: 1 }, 9);
        writer.empty(BlockKey { br: 2, bc: 1 }, 11);
        writer.finish()
    }

    #[test]
    fn matches_golden_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/blocks-golden.bin");
        let expected = std::fs::read(&path).expect("golden fixture (generate with the TS test)");
        assert_eq!(golden(), expected);
    }

    #[test]
    fn empty_cells_write_compact_block() {
        let mut writer = BlocksWriter::new(1);
        writer.block(BlockKey { br: 0, bc: 0 }, 1, &BlockCells::new());
        assert_eq!(writer.finish().len(), 16 + 24);
    }

    #[test]
    fn hash_changes_with_content() {
        let mut a = BlockCells::new();
        let b = BlockCells::new();
        assert_eq!(a.content_hash(), b.content_hash());
        a.set(5, "x", CellKind::Text, 0, 0);
        assert_ne!(a.content_hash(), b.content_hash());
    }
}
