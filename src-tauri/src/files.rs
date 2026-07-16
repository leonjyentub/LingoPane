use serde::Serialize;
use std::{path::PathBuf, sync::Mutex};
use tauri::{Emitter, Manager};

const MAX_PDF_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedPdf {
    file_name: String,
    pdf_bytes: Vec<u8>,
}

#[derive(Default)]
pub struct OpenedPdfPaths(pub Mutex<Vec<String>>);

fn pdf_path_from_url(url: &tauri::Url) -> Option<String> {
    let path = url.to_file_path().ok()?;
    let is_pdf = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));
    is_pdf.then(|| path.to_string_lossy().into_owned())
}

pub fn handle_opened_urls(app: &tauri::AppHandle, urls: &[tauri::Url]) {
    let paths = urls
        .iter()
        .filter_map(pdf_path_from_url)
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return;
    }
    if let Ok(mut pending) = app.state::<OpenedPdfPaths>().0.lock() {
        pending.extend(paths);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("opened-pdf", ());
}

#[tauri::command]
pub fn take_opened_pdf_paths(
    state: tauri::State<'_, OpenedPdfPaths>,
) -> Result<Vec<String>, String> {
    let mut paths = state
        .0
        .lock()
        .map_err(|_| "無法讀取等待開啟的 PDF".to_string())?;
    Ok(paths.drain(..).collect())
}

#[tauri::command]
pub fn read_dropped_pdf(path: String) -> Result<DroppedPdf, String> {
    let path = PathBuf::from(path);
    let is_pdf = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));
    if !is_pdf {
        return Err("只能拖入 PDF 檔案".into());
    }

    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("無法讀取拖入的檔案：{error}"))?;
    if !metadata.is_file() {
        return Err("拖入的項目不是檔案".into());
    }
    if metadata.len() == 0 {
        return Err("PDF 檔案是空的".into());
    }
    if metadata.len() > MAX_PDF_BYTES {
        return Err("PDF 超過目前的 512 MB 大小限制".into());
    }

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("拖入的文件.pdf")
        .to_string();
    let pdf_bytes = std::fs::read(&path).map_err(|error| format!("無法開啟拖入的 PDF：{error}"))?;
    Ok(DroppedPdf {
        file_name,
        pdf_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_pdf_file_urls_case_insensitively() {
        let url = tauri::Url::parse("file:///tmp/Example.PDF").unwrap();
        assert_eq!(pdf_path_from_url(&url).as_deref(), Some("/tmp/Example.PDF"));
    }

    #[test]
    fn ignores_non_file_and_non_pdf_urls() {
        assert!(
            pdf_path_from_url(&tauri::Url::parse("https://example.com/file.pdf").unwrap())
                .is_none()
        );
        assert!(pdf_path_from_url(&tauri::Url::parse("file:///tmp/notes.txt").unwrap()).is_none());
    }
}
