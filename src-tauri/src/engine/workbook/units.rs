//! Size units. The contract uses CSS px at 100% zoom; IronCalc's API uses its
//! own "pixels": row height = points × 1.5625 (`ROW_HEIGHT_FACTOR`) and column
//! width = characters × 9 (`COLUMN_WIDTH_FACTOR`), while the stored `Row.height`
//! is points and `Col.width` is characters (the xlsx values).
//!
//! Conversions (Excel at 96 dpi, Calibri 11, max digit width 7 px):
//! - rows: CSS px = points × 4/3 (15 pt → 20 px);
//! - cols: CSS px = round(chars × 7 + 5) for chars ≥ 1, round(chars × 12)
//!   below (8.43 chars → 64 px), and the inverse for setting widths.

use ironcalc_base::{COLUMN_WIDTH_FACTOR, ROW_HEIGHT_FACTOR};

/// Excel's default row height (15 pt) in CSS px.
pub const DEFAULT_ROW_PX: f64 = 20.0;
/// Excel's default column width (8.43 chars) in CSS px.
pub const DEFAULT_COL_PX: f64 = 64.0;

pub fn points_to_px(points: f64) -> f64 {
    round2(points * 4.0 / 3.0)
}

pub fn px_to_points(px: f64) -> f64 {
    px * 3.0 / 4.0
}

/// CSS px → value for `UserModel::set_rows_height`.
pub fn px_to_ic_row(px: f64) -> f64 {
    px_to_points(px) * ROW_HEIGHT_FACTOR
}

pub fn chars_to_px(chars: f64) -> f64 {
    if chars < 1.0 {
        (chars * 12.0).round()
    } else {
        (chars * 7.0 + 5.0).round()
    }
}

pub fn px_to_chars(px: f64) -> f64 {
    let chars = if px < 12.0 { px / 12.0 } else { (px - 5.0) / 7.0 };
    (chars * 256.0).round() / 256.0
}

/// CSS px → value for `UserModel::set_columns_width`.
pub fn px_to_ic_col(px: f64) -> f64 {
    px_to_chars(px) * COLUMN_WIDTH_FACTOR
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excel_defaults_round_trip() {
        assert_eq!(points_to_px(15.0), 20.0);
        assert_eq!(chars_to_px(8.43), 64.0);
        assert_eq!(chars_to_px(px_to_chars(64.0)), 64.0);
        assert_eq!(chars_to_px(px_to_chars(120.0)), 120.0);
        assert_eq!(chars_to_px(px_to_chars(8.0)), 8.0);
        assert!((px_to_ic_row(20.0) / ROW_HEIGHT_FACTOR - 15.0).abs() < 1e-9);
    }
}
