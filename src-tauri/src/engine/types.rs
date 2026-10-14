//! Serde mirror of the TypeScript contract in `src/engine/contract.ts`.
//! Field names are camelCase on the wire. Keep both files in sync: a change
//! here without the matching change there (or vice versa) is a bug.
//! Rows/cols are 0-based everywhere in this module.

use serde::{Deserialize, Serialize};

pub type DocumentId = u32;
pub type SheetId = u32;
pub type StyleId = u32;
pub type ChartId = u32;

pub const MAX_ROWS: u32 = 1_048_576;
pub const MAX_COLS: u32 = 16_384;

pub const BLOCK_ROWS: u32 = 64;
pub const BLOCK_COLS: u32 = 16;
pub const BLOCK_SIZE: usize = (BLOCK_ROWS * BLOCK_COLS) as usize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CellAddress {
    pub row: u32,
    pub col: u32,
}

/// Inclusive, normalized range (r0 <= r1, c0 <= c1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CellRange {
    pub r0: u32,
    pub c0: u32,
    pub r1: u32,
    pub c1: u32,
}

impl CellRange {
    pub fn contains(&self, row: u32, col: u32) -> bool {
        row >= self.r0 && row <= self.r1 && col >= self.c0 && col <= self.c1
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum CellKind {
    Empty = 0,
    Text = 1,
    Number = 2,
    Bool = 3,
    Error = 4,
    Pending = 5,
}

pub mod cell_flag {
    pub const FORMULA: u8 = 1 << 0;
    pub const COMMENT: u8 = 1 << 1;
    pub const VALIDATION: u8 = 1 << 2;
    pub const SPILL: u8 = 1 << 3;
    pub const HYPERLINK: u8 = 1 << 4;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockKey {
    pub br: u32,
    pub bc: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockRequest {
    pub sheet: SheetId,
    pub keys: Vec<BlockKey>,
    #[serde(default)]
    pub known_versions: Option<Vec<u32>>,
    pub priority: u8,
}

// ---------------------------------------------------------------------------
// Sheets, geometry, styles
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AxisOverride {
    pub index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoFilterInfo {
    pub range: CellRange,
    pub filtered_cols: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SheetMeta {
    pub id: SheetId,
    pub name: String,
    pub hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetInfo {
    pub sheet: SheetId,
    pub row_count: u32,
    pub col_count: u32,
    pub default_row_height: f64,
    pub default_col_width: f64,
    pub used_range: Option<CellRange>,
    pub row_overrides: Vec<AxisOverride>,
    pub col_overrides: Vec<AxisOverride>,
    pub merges: Vec<CellRange>,
    pub frozen_rows: u32,
    pub frozen_cols: u32,
    pub show_grid_lines: bool,
    pub auto_filter: Option<AutoFilterInfo>,
    pub version: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HAlign {
    General,
    Left,
    Center,
    Right,
    Fill,
    Justify,
    CenterContinuous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VAlign {
    Top,
    Middle,
    Bottom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BorderStyle {
    Thin,
    Medium,
    Thick,
    Dashed,
    Dotted,
    Double,
    Hair,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BorderSpec {
    pub style: BorderStyle,
    pub color: String,
}

/// `true`/`false` or `"double"` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Underline {
    Single(bool),
    Double(DoubleTag),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DoubleTag {
    Double,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub underline: Option<Underline>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strike: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub h_align: Option<HAlign>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v_align: Option<VAlign>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shrink_to_fit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_top: Option<BorderSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_right: Option<BorderSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_bottom: Option<BorderSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_left: Option<BorderSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellFormat {
    pub style: CellStyle,
    pub num_fmt: String,
}

// ---------------------------------------------------------------------------
// Cell queries
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum CellValue {
    Empty,
    Number { value: f64 },
    Text { value: String },
    Bool { value: bool },
    Error { value: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellDetails {
    pub sheet: SheetId,
    pub row: u32,
    pub col: u32,
    pub input: String,
    pub value: CellValue,
    pub display: String,
    pub format: CellFormat,
    pub merge: Option<CellRange>,
    pub spill_anchor: Option<CellAddress>,
    pub comment: Option<String>,
    pub hyperlink: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionStats {
    pub count: u64,
    pub numeric_count: u64,
    pub sum: f64,
    pub average: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSample {
    pub text: String,
    pub style_id: StyleId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RangeValues {
    pub range: CellRange,
    pub values: Vec<Vec<CellValue>>,
    pub display: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LookIn {
    Formulas,
    Values,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindQuery {
    pub text: String,
    pub match_case: bool,
    pub whole_cell: bool,
    pub look_in: LookIn,
    pub sheet: Option<SheetId>,
    #[serde(default)]
    pub within: Option<Vec<CellRange>>,
    #[serde(default)]
    pub by_columns: Option<bool>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FindMatch {
    pub sheet: SheetId,
    pub row: u32,
    pub col: u32,
    pub display: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterValue {
    pub value: String,
    pub count: u64,
    pub selected: bool,
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChartType {
    Column,
    Bar,
    Line,
    Pie,
    Area,
    Scatter,
    Doughnut,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartSeries {
    pub name_ref: Option<String>,
    pub name: Option<String>,
    pub categories_ref: Option<String>,
    pub values_ref: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AnchorPoint {
    pub row: u32,
    pub col: u32,
    pub dx: f64,
    pub dy: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ChartAnchor {
    pub from: AnchorPoint,
    pub to: AnchorPoint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LegendPosition {
    None,
    Right,
    Bottom,
    Top,
    Left,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChartGrouping {
    Clustered,
    Stacked,
    PercentStacked,
    Standard,
}

/// Chart without id (as sent by `addChart`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartDraft {
    pub sheet: SheetId,
    #[serde(rename = "type")]
    pub chart_type: ChartType,
    pub title: Option<String>,
    pub series: Vec<ChartSeries>,
    pub anchor: ChartAnchor,
    pub legend: LegendPosition,
    pub grouping: ChartGrouping,
    pub x_axis_title: Option<String>,
    pub y_axis_title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartSpec {
    pub id: ChartId,
    #[serde(flatten)]
    pub draft: ChartDraft,
    pub from_file: bool,
}

/// Chart with id but without `fromFile` (as sent by `updateChart`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChartUpdate {
    pub id: ChartId,
    #[serde(flatten)]
    pub draft: ChartDraft,
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceFormat {
    New,
    Xlsx,
    Xls,
    Csv,
    Ods,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SaveFormat {
    Xlsx,
    Csv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Workbook,
    Csv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FidelityFeature {
    Charts,
    Images,
    Shapes,
    Comments,
    DataValidation,
    AutoFilter,
    ConditionalFormatting,
    PivotTables,
    Tables,
    Macros,
    ExternalLinks,
    Sparklines,
    Slicers,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnSave {
    Preserved,
    Editable,
    Lost,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FidelityWarning {
    pub feature: FidelityFeature,
    pub count: u32,
    pub on_save: OnSave,
}

/// `null` fields = auto-detect. On the wire `delimiter` is one of `,` `;` `\t` `|`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CsvOptions {
    #[serde(default)]
    pub delimiter: Option<String>,
    /// `utf-8` | `utf-16le` | `windows-1252`
    #[serde(default)]
    pub encoding: Option<String>,
    /// `.` | `,`
    #[serde(default)]
    pub decimal: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OpenOptions {
    #[serde(default)]
    pub csv: Option<CsvOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub doc: DocumentId,
    pub source_format: SourceFormat,
    pub backend: BackendKind,
    pub path: Option<String>,
    pub sheets: Vec<SheetMeta>,
    pub active_sheet: SheetId,
    pub warnings: Vec<FidelityWarning>,
    pub csv: Option<CsvOptions>,
    pub loading: bool,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveOptions {
    pub format: SaveFormat,
    #[serde(default)]
    pub sheet: Option<SheetId>,
    #[serde(default)]
    pub csv: Option<CsvOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveResult {
    pub path: String,
    pub format: SaveFormat,
    pub lost: Vec<FidelityFeature>,
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellInput {
    pub row: u32,
    pub col: u32,
    pub input: String,
    #[serde(default)]
    pub num_fmt: Option<String>,
}

/// Partial style change. For `Option<Option<T>>` fields: absent = keep,
/// `null` = reset to default, value = set.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StylePatch {
    #[serde(default, with = "nullable")]
    pub font_family: Option<Option<String>>,
    #[serde(default, with = "nullable")]
    pub font_size: Option<Option<f64>>,
    #[serde(default)]
    pub bold: Option<bool>,
    #[serde(default)]
    pub italic: Option<bool>,
    #[serde(default)]
    pub underline: Option<Underline>,
    #[serde(default)]
    pub strike: Option<bool>,
    #[serde(default, with = "nullable")]
    pub color: Option<Option<String>>,
    #[serde(default, with = "nullable")]
    pub fill: Option<Option<String>>,
    #[serde(default, with = "nullable")]
    pub h_align: Option<Option<HAlign>>,
    #[serde(default, with = "nullable")]
    pub v_align: Option<Option<VAlign>>,
    #[serde(default)]
    pub wrap: Option<bool>,
    #[serde(default)]
    pub shrink_to_fit: Option<bool>,
    #[serde(default)]
    pub indent: Option<u32>,
    #[serde(default)]
    pub rotation: Option<i32>,
    #[serde(default)]
    pub num_fmt: Option<String>,
}

/// Distinguishes a missing field from an explicit `null`.
mod nullable {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn deserialize<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        T: Deserialize<'de>,
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Some)
    }

    pub fn serialize<T, S>(value: &Option<Option<T>>, serializer: S) -> Result<S::Ok, S::Error>
    where
        T: Serialize,
        S: Serializer,
    {
        match value {
            Some(inner) => inner.serialize(serializer),
            None => serializer.serialize_none(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BorderPreset {
    All,
    Outer,
    Inner,
    InnerHorizontal,
    InnerVertical,
    Top,
    Bottom,
    Left,
    Right,
    ThickOuter,
    DoubleBottom,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClearWhat {
    Contents,
    Formats,
    All,
    Comments,
    Hyperlinks,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SortKey {
    pub col: u32,
    pub ascending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PasteSource {
    Internal { clip_id: u32, cut: bool },
    Text { text: String },
    Html { html: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PasteMode {
    All,
    Values,
    Formats,
    Formulas,
    Transpose,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterCriteria {
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeMode {
    Merge,
    MergeCenter,
    MergeAcross,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    Row,
    Col,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShiftDir {
    Right,
    Down,
    Left,
    Up,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellPosition {
    pub sheet: SheetId,
    pub row: u32,
    pub col: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EngineOp {
    // cells
    SetCells { sheet: SheetId, cells: Vec<CellInput> },
    Clear { sheet: SheetId, ranges: Vec<CellRange>, what: ClearWhat },
    Fill { sheet: SheetId, source: CellRange, target: CellRange },
    Paste { sheet: SheetId, target: CellRange, source: PasteSource, mode: PasteMode },
    Sort { sheet: SheetId, range: CellRange, keys: Vec<SortKey>, has_header: bool },
    Replace { query: FindQuery, replacement: String, all: bool, #[serde(default)] at: Option<CellPosition> },
    SetComment { sheet: SheetId, row: u32, col: u32, text: Option<String> },
    SetHyperlink { sheet: SheetId, row: u32, col: u32, url: Option<String> },
    // formatting
    SetStyle { sheet: SheetId, ranges: Vec<CellRange>, patch: StylePatch },
    SetBorders { sheet: SheetId, ranges: Vec<CellRange>, preset: BorderPreset, style: BorderStyle, color: String },
    CopyFormat { sheet: SheetId, source: CellRange, targets: Vec<CellRange> },
    Merge { sheet: SheetId, range: CellRange, mode: MergeMode },
    Unmerge { sheet: SheetId, ranges: Vec<CellRange> },
    // structure & geometry
    InsertRows { sheet: SheetId, index: u32, count: u32 },
    DeleteRows { sheet: SheetId, index: u32, count: u32 },
    InsertCols { sheet: SheetId, index: u32, count: u32 },
    DeleteCols { sheet: SheetId, index: u32, count: u32 },
    InsertCells { sheet: SheetId, range: CellRange, shift: ShiftDir },
    DeleteCells { sheet: SheetId, range: CellRange, shift: ShiftDir },
    SetRowHeights { sheet: SheetId, rows: Vec<u32>, size: Option<f64> },
    SetColWidths { sheet: SheetId, cols: Vec<u32>, size: Option<f64> },
    SetHidden { sheet: SheetId, axis: Axis, indices: Vec<u32>, hidden: bool },
    SetFrozen { sheet: SheetId, rows: u32, cols: u32 },
    SetShowGridLines { sheet: SheetId, show: bool },
    // sheets
    AddSheet { #[serde(default)] name: Option<String>, #[serde(default)] index: Option<u32> },
    DeleteSheet { sheet: SheetId },
    RenameSheet { sheet: SheetId, name: String },
    MoveSheet { sheet: SheetId, index: u32 },
    DuplicateSheet { sheet: SheetId },
    SetSheetHidden { sheet: SheetId, hidden: bool },
    SetSheetColor { sheet: SheetId, color: Option<String> },
    SetActiveSheet { sheet: SheetId },
    // filter
    SetAutoFilter { sheet: SheetId, range: Option<CellRange> },
    FilterColumn { sheet: SheetId, col: u32, criteria: Option<FilterCriteria> },
    // charts
    AddChart { chart: ChartDraft },
    UpdateChart { chart: ChartUpdate },
    DeleteChart { sheet: SheetId, id: ChartId },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectionHint {
    pub sheet: SheetId,
    pub ranges: Vec<CellRange>,
    pub active: CellAddress,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub selection: Option<SelectionHint>,
    pub created: Vec<u32>,
    pub affected: u64,
    pub elapsed_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardData {
    pub clip_id: u32,
    pub text: String,
    pub html: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionName {
    pub name: String,
}

// ---------------------------------------------------------------------------
// Events (emitted as the Tauri event `engine://event`)
// ---------------------------------------------------------------------------

pub const ENGINE_EVENT: &str = "engine://event";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StructureOp {
    Insert,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EngineEvent {
    Cells { doc: DocumentId, sheet: SheetId, ranges: Vec<CellRange> },
    SheetData { doc: DocumentId, sheet: SheetId },
    SheetInfo { doc: DocumentId, sheet: SheetId, version: u32 },
    Structure { doc: DocumentId, sheet: SheetId, axis: Axis, op: StructureOp, index: u32, count: u32 },
    Styles { doc: DocumentId },
    Sheets { doc: DocumentId, sheets: Vec<SheetMeta>, active_sheet: SheetId },
    Charts { doc: DocumentId, sheet: SheetId },
    DocState { doc: DocumentId, dirty: bool, can_undo: bool, can_redo: bool },
    LoadProgress { doc: DocumentId, rows_loaded: u64, bytes_read: u64, bytes_total: u64, done: bool, error: Option<String> },
    BackendChanged { doc: DocumentId, backend: BackendKind },
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineErrorCode {
    NotFound,
    Io,
    Parse,
    Unsupported,
    InvalidOp,
    InvalidFormula,
    SheetName,
    Protected,
    TooLarge,
    Internal,
}

/// Rejection payload of every engine command. `message` is user-facing Spanish.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineError {
    pub code: EngineErrorCode,
    pub message: String,
}

impl EngineError {
    pub fn new(code: EngineErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn unsupported(what: &str) -> Self {
        Self::new(EngineErrorCode::Unsupported, format!("Todavía no disponible: {what}."))
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(EngineErrorCode::NotFound, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(EngineErrorCode::Io, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(EngineErrorCode::Internal, message)
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for EngineError {}

pub type EngineResult<T> = Result<T, EngineError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ops_deserialize_from_camel_case_json() {
        let json = r#"[
            {"type":"setCells","sheet":1,"cells":[{"row":0,"col":0,"input":"=SUM(A2:A3)"},{"row":1,"col":0,"input":"0.5","numFmt":"0%"}]},
            {"type":"setStyle","sheet":1,"ranges":[{"r0":0,"c0":0,"r1":2,"c1":3}],"patch":{"bold":true,"fill":null,"hAlign":"center"}},
            {"type":"paste","sheet":1,"target":{"r0":0,"c0":0,"r1":0,"c1":0},"source":{"kind":"internal","clipId":3,"cut":false},"mode":"values"},
            {"type":"addSheet"},
            {"type":"sort","sheet":1,"range":{"r0":0,"c0":0,"r1":9,"c1":2},"keys":[{"col":1,"ascending":false}],"hasHeader":true}
        ]"#;
        let ops: Vec<EngineOp> = serde_json::from_str(json).expect("ops parse");
        assert_eq!(ops.len(), 5);
        match &ops[1] {
            EngineOp::SetStyle { patch, .. } => {
                assert_eq!(patch.bold, Some(true));
                assert_eq!(patch.fill, Some(None), "explicit null resets");
                assert_eq!(patch.color, None, "absent keeps");
                assert_eq!(patch.h_align, Some(Some(HAlign::Center)));
            }
            other => panic!("unexpected op {other:?}"),
        }
    }

    #[test]
    fn events_serialize_to_camel_case_json() {
        let event = EngineEvent::DocState { doc: 1, dirty: true, can_undo: true, can_redo: false };
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(json, r#"{"type":"docState","doc":1,"dirty":true,"canUndo":true,"canRedo":false}"#);
        let value = serde_json::to_string(&CellValue::Number { value: 2.5 }).unwrap();
        assert_eq!(value, r#"{"type":"number","value":2.5}"#);
    }

    #[test]
    fn chart_spec_is_flat_on_the_wire() {
        let json = r#"{"id":4,"sheet":1,"type":"column","title":"Ventas","series":[{"nameRef":null,"name":"2026","categoriesRef":"Hoja1!$A$2:$A$13","valuesRef":"Hoja1!$B$2:$B$13","color":null}],
            "anchor":{"from":{"row":1,"col":4,"dx":0,"dy":0},"to":{"row":16,"col":11,"dx":0,"dy":0}},
            "legend":"bottom","grouping":"clustered","xAxisTitle":null,"yAxisTitle":null,"fromFile":false}"#;
        let chart: ChartSpec = serde_json::from_str(json).unwrap();
        assert_eq!(chart.id, 4);
        assert_eq!(chart.draft.chart_type, ChartType::Column);
        let back: serde_json::Value = serde_json::to_value(&chart).unwrap();
        assert_eq!(back["type"], "column");
        assert_eq!(back["fromFile"], false);
    }
}
