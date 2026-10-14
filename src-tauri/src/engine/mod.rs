//! Native workbook engine (WS2). IronCalc runs here, in the Tauri process, on
//! a dedicated engine thread (actor) that owns every open document.
//!
//! - `types`: serde mirror of `src/engine/contract.ts` (the wire contract).
//! - `blocks`: binary block encoder (`src/engine/block-codec.ts` decodes it).
//! - `backend`: `DocumentBackend` trait implemented by the IronCalc workbook
//!   backend (this module) and the CSV store (`crate::csv_store`).
//! - `commands`: `#[tauri::command]` entry points, one per `WorkbookEngine` method.

pub mod backend;
pub mod blocks;
pub mod commands;
pub mod types;
pub mod workbook;
