//! Native file I/O: binary IPC commands for the webview (no base64), the
//! atomic write helper used by every save, and Spanish error messages.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::ipc::{InvokeBody, Request, Response};

use crate::engine::types::{EngineError, EngineErrorCode};

const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_SHARING_VIOLATION: i32 = 32;
const ERROR_LOCK_VIOLATION: i32 = 33;
const ERROR_HANDLE_DISK_FULL: i32 = 39;
const ERROR_DISK_FULL: i32 = 112;

pub const MSG_IN_USE: &str = "El archivo está abierto en otro programa.";

fn is_sharing_violation(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION))
}

/// Maps an I/O error while reading/opening `path` to an `EngineError`.
pub fn io_error(error: &std::io::Error, path: &str) -> EngineError {
    let _ = path;
    if is_sharing_violation(error) {
        return EngineError::io(MSG_IN_USE);
    }
    match error.kind() {
        std::io::ErrorKind::NotFound => EngineError::not_found("No se encontró el archivo."),
        std::io::ErrorKind::PermissionDenied => EngineError::io("No tienes permiso para abrir el archivo."),
        _ => EngineError::io(format!("No se pudo leer el archivo: {error}")),
    }
}

/// Maps an I/O error while saving `target`.
fn write_error(error: &std::io::Error, target: &Path) -> EngineError {
    if is_sharing_violation(error) {
        return EngineError::io(MSG_IN_USE);
    }
    match error.raw_os_error() {
        Some(ERROR_DISK_FULL | ERROR_HANDLE_DISK_FULL) => return EngineError::io("No hay espacio suficiente en el disco."),
        Some(ERROR_ACCESS_DENIED) => {
            if std::fs::metadata(target).map(|m| m.permissions().readonly()).unwrap_or(false) {
                return EngineError::io("El archivo es de solo lectura.");
            }
            // A file locked by Excel makes the replace fail with "access
            // denied": probe it to tell both cases apart.
            if let Err(probe) = std::fs::OpenOptions::new().append(true).open(target) {
                if is_sharing_violation(&probe) {
                    return EngineError::io(MSG_IN_USE);
                }
            }
            return EngineError::io("No tienes permiso para guardar en esta ubicación.");
        }
        _ => {}
    }
    match error.kind() {
        std::io::ErrorKind::NotFound => EngineError::not_found("La carpeta de destino no existe."),
        std::io::ErrorKind::PermissionDenied => EngineError::io("No tienes permiso para guardar en esta ubicación."),
        _ => EngineError::io(format!("No se pudo guardar el archivo: {error}")),
    }
}

fn temp_path(target: &Path) -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "libro".into());
    let unique = format!(".~{name}.{}-{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
    target.with_file_name(unique)
}

/// Writes `bytes` to `path` atomically: a temp file in the same folder is
/// written and flushed, then renamed over the target. On any failure the
/// original file is left untouched and the temp file removed.
pub fn atomic_write(path: impl AsRef<Path>, bytes: &[u8]) -> Result<(), EngineError> {
    atomic_write_with(path, |file| file.write_all(bytes))
}

/// Like `atomic_write`, streaming the content through `fill` (CSV export).
pub fn atomic_write_with(path: impl AsRef<Path>, fill: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>) -> Result<(), EngineError> {
    let target = path.as_ref();
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(EngineError::not_found("La carpeta de destino no existe."));
        }
    }
    if target.is_dir() {
        return Err(EngineError::new(EngineErrorCode::InvalidOp, "La ruta de destino es una carpeta."));
    }
    // Fail early (and keep the temp file out of the way) when the target is
    // locked by another program.
    if target.exists() {
        if let Err(error) = std::fs::OpenOptions::new().append(true).open(target) {
            return Err(write_error(&error, target));
        }
    }
    let temp = temp_path(target);
    let result = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        fill(&mut file)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, target)
    })();
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            Err(write_error(&error, target))
        }
    }
}

/// Reads a file and returns its bytes as a raw (binary) IPC response.
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Response, EngineError> {
    let bytes = std::fs::read(&path).map_err(|e| io_error(&e, &path))?;
    Ok(Response::new(bytes))
}

/// Writes the raw request body atomically to the path given in the
/// percent-encoded `path` header.
#[tauri::command]
pub fn write_file_bytes(request: Request<'_>) -> Result<(), EngineError> {
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or_else(|| EngineError::new(EngineErrorCode::InvalidOp, "Falta la ruta del archivo."))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(EngineError::new(EngineErrorCode::InvalidOp, "El contenido a guardar no es válido."));
    };
    atomic_write(&path, bytes)
}

/// Decodes `%XX` escapes (UTF-8), as produced by `encodeURIComponent`.
pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(b) = hex {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sheetlight-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_write_replaces_and_cleans_up() {
        let dir = temp_dir("replace");
        let path = dir.join("libro.xlsx");
        atomic_write(&path, b"uno").unwrap();
        atomic_write(&path, b"dos").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"dos");
        let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_write_keeps_original() {
        let dir = temp_dir("keep");
        let path = dir.join("datos.csv");
        std::fs::write(&path, b"original").unwrap();
        let err = atomic_write_with(&path, |f| {
            f.write_all(b"parcial")?;
            Err(std::io::Error::other("boom"))
        })
        .unwrap_err();
        assert_eq!(err.code, EngineErrorCode::Io);
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "temp file removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_folder_is_reported_in_spanish() {
        let err = atomic_write(std::env::temp_dir().join("no-existe-sheetlight/x/libro.xlsx"), b"x").unwrap_err();
        assert_eq!(err.code, EngineErrorCode::NotFound);
        assert_eq!(err.message, "La carpeta de destino no existe.");
    }

    #[cfg(windows)]
    #[test]
    fn locked_file_reports_in_use() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = temp_dir("locked");
        let path = dir.join("abierto.xlsx");
        std::fs::write(&path, b"original").unwrap();
        // Like Excel: open without sharing.
        let lock = std::fs::OpenOptions::new().read(true).write(true).share_mode(0).open(&path).unwrap();
        let err = atomic_write(&path, b"nuevo").unwrap_err();
        assert_eq!(err.message, MSG_IN_USE);
        drop(lock);
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn decodes_percent_paths() {
        assert_eq!(percent_decode("C%3A%5CDatos%5CA%C3%B1o%202026.xlsx"), "C:\\Datos\\Año 2026.xlsx");
        assert_eq!(percent_decode("100%"), "100%");
    }
}
