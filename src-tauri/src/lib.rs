// Phase 1 contract stubs: remove the `allow`s once each module is wired in.
#[allow(dead_code)]
mod charts;
#[allow(dead_code)]
mod csv_store;
#[allow(dead_code)]
mod engine;
mod files;
#[allow(dead_code)]
mod xlsx_package;

use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Extensions Sheetlight accepts from the command line ("Open with", double click).
const WORKBOOK_EXTENSIONS: [&str; 3] = [".xlsx", ".xls", ".csv"];

struct LaunchState {
    paths: Mutex<Vec<String>>,
}

fn workbook_paths_from_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .map(|arg| arg.trim().trim_matches('"'))
        .filter(|arg| {
            if arg.is_empty() || arg.starts_with('-') {
                return false;
            }
            let lower = arg.to_ascii_lowercase();
            WORKBOOK_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
        })
        .map(ToString::to_string)
        .collect()
}

fn focus_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn take_launch_paths(state: tauri::State<LaunchState>) -> Vec<String> {
    state
        .paths
        .lock()
        .map(|mut paths| std::mem::take(&mut *paths))
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // A second launch ("Open with" while running) hands its files to this
        // window instead of starting another instance.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = workbook_paths_from_args(&argv);
            if !paths.is_empty() {
                let _ = app.emit("open-files", paths);
            }
            focus_main(app);
        }))
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();
            app.manage(LaunchState {
                paths: Mutex::new(workbook_paths_from_args(&args)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            files::read_file_b64,
            files::write_file_b64,
            take_launch_paths,
            engine::commands::engine_new_document,
            engine::commands::engine_open_document,
            engine::commands::engine_get_document_info,
            engine::commands::engine_save_document,
            engine::commands::engine_close_document,
            engine::commands::engine_get_sheet_info,
            engine::commands::engine_fetch_blocks,
            engine::commands::engine_get_styles,
            engine::commands::engine_find_data_edge,
            engine::commands::engine_get_column_text_samples,
            engine::commands::engine_get_cell,
            engine::commands::engine_get_range_values,
            engine::commands::engine_get_selection_stats,
            engine::commands::engine_find,
            engine::commands::engine_get_filter_values,
            engine::commands::engine_get_charts,
            engine::commands::engine_apply,
            engine::commands::engine_undo,
            engine::commands::engine_redo,
            engine::commands::engine_copy,
            engine::commands::engine_list_functions
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sheetlight");
}

#[cfg(test)]
mod tests {
    use super::workbook_paths_from_args;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn keeps_only_workbook_paths() {
        let paths = workbook_paths_from_args(&args(&[
            "sheetlight.exe",
            "--flag",
            "\"C:\\Datos\\Presupuesto.XLSX\"",
            "C:\\Datos\\notas.txt",
            "C:\\Datos\\antiguo.xls",
            "C:\\Datos\\ventas.csv",
        ]));
        assert_eq!(
            paths,
            vec![
                "C:\\Datos\\Presupuesto.XLSX",
                "C:\\Datos\\antiguo.xls",
                "C:\\Datos\\ventas.csv",
            ]
        );
    }
}
