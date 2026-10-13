use base64::{engine::general_purpose::STANDARD, Engine as _};

#[tauri::command]
pub fn read_file_b64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|error| format!("No se pudo leer el archivo: {error}"))?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub fn write_file_b64(path: String, contents: String) -> Result<(), String> {
    let bytes = STANDARD
        .decode(contents.as_bytes())
        .map_err(|error| format!("El contenido a guardar no es válido: {error}"))?;

    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("No se pudo crear la carpeta: {error}"))?;
        }
    }

    std::fs::write(&path, bytes).map_err(|error| format!("No se pudo guardar el archivo: {error}"))
}
