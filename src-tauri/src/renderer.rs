use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU32, Ordering},
};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const RENDERER_SOURCE: &str = include_str!("../../tools/pdf_renderer.py");
static ACTIVE_RENDERER_PID: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub pdf_bytes: Vec<u8>,
    pub pages: Vec<RenderPage>,
    pub translations: std::collections::HashMap<String, String>,
    pub mode: String,
    pub font_scale: f64,
    pub file_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPage {
    pub page_number: u32,
    pub blocks: Vec<RenderBlock>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderBlock {
    pub id: String,
    // The frontend and pdf_renderer.py both spell this "sourceBBox" (double
    // capital); serde's camelCase rule would produce "sourceBbox", so pin it.
    #[serde(rename = "sourceBBox")]
    pub source_bbox: BBox,
    pub source_style: SourceStyle,
    #[serde(default)]
    pub mask_rects: Vec<BBox>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStyle {
    pub font_size: f64,
}

fn python_candidates() -> Vec<String> {
    let mut candidates = Vec::new();

    if let Ok(configured) = std::env::var("LINGOPANE_DOCLING_PYTHON") {
        if !configured.trim().is_empty() {
            candidates.push(configured);
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let application_support = PathBuf::from(&home)
            .join("Library/Application Support/com.leonjye.lingopane/docling-runtime");
        add_python_if_present(&mut candidates, application_support.join("current/bin/python"));
        add_python_if_present(&mut candidates, application_support.join(".venv/bin/python"));
    }

    if let Ok(executable) = std::env::current_exe() {
        if let Some(macos_directory) = executable.parent() {
            add_python_if_present(
                &mut candidates,
                macos_directory.join("../Resources/docling-runtime/bin/python"),
            );
            add_python_if_present(
                &mut candidates,
                macos_directory.join("../Resources/docling-runtime/.venv/bin/python"),
            );
        }
    }

    add_python_if_present(
        &mut candidates,
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/docling-runtime/.venv/bin/python"),
    );

    if let Ok(current_directory) = std::env::current_dir() {
        add_python_if_present(
            &mut candidates,
            current_directory.join("tools/docling-runtime/.venv/bin/python"),
        );
    }

    candidates.extend([
        "python3".to_string(),
        "/opt/homebrew/bin/python3".to_string(),
        "/usr/local/bin/python3".to_string(),
        "python".to_string(),
    ]);

    let mut seen = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.clone()))
        .collect()
}

fn add_python_if_present(candidates: &mut Vec<String>, path: PathBuf) {
    if path.is_file() {
        candidates.push(path.to_string_lossy().into_owned());
    }
}

fn find_python() -> Result<String, String> {
    for candidate in python_candidates() {
        let output = Command::new(&candidate)
            .arg("-c")
            .arg("import fitz; print(fitz.__version__)")
            .output();
        if let Ok(out) = output {
            if out.status.success() {
                return Ok(candidate);
            }
        }
    }
    Err("找不到安裝了 PyMuPDF 的 Python".into())
}

fn terminate_active_renderer() -> bool {
    let pid = ACTIVE_RENDERER_PID.load(Ordering::SeqCst);
    if pid == 0 {
        return false;
    }
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    ACTIVE_RENDERER_PID.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst).ok();
    true
}

pub fn render_pdf(request: &RenderRequest) -> Result<Vec<u8>, String> {
    if request.pdf_bytes.is_empty() {
        return Err("PDF 內容是空的".into());
    }

    let python = find_python()?;
    let pages_json = serde_json::to_string(&request.pages)
        .map_err(|e| format!("序列化頁面資料失敗：{e}"))?;
    let translations_json = serde_json::to_string(&request.translations)
        .map_err(|e| format!("序列化翻譯資料失敗：{e}"))?;

    let _ = terminate_active_renderer();

    let mut child = Command::new(&python)
        .arg("-c")
        .arg(RENDERER_SOURCE)
        .args([
            "--mode",
            &request.mode,
            "--pages-json",
            &pages_json,
            "--translations-json",
            &translations_json,
            "--font-scale",
            &request.font_scale.to_string(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("無法啟動 PDF renderer：{e}"))?;

    let pid = child.id();
    ACTIVE_RENDERER_PID.store(pid, Ordering::SeqCst);

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&request.pdf_bytes)
            .map_err(|e| {
                let _ = child.kill();
                let _ = child.wait();
                let _ = ACTIVE_RENDERER_PID.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
                format!("寫入 PDF 資料失敗：{e}")
            })?;
        drop(stdin);
    }

    let output = child
        .wait_with_output()
        .map_err(|e| {
            let _ = ACTIVE_RENDERER_PID.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
            format!("等待 renderer 結束失敗：{e}")
        })?;

    let _ = ACTIVE_RENDERER_PID.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("PDF 渲染失敗：{stderr}"));
    }

    Ok(output.stdout)
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '\0' => '-',
            other => other,
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() {
        "translated.pdf".to_string()
    } else if cleaned.to_lowercase().ends_with(".pdf") {
        cleaned
    } else {
        format!("{cleaned}.pdf")
    }
}

fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let parent = path.parent().map(PathBuf::from).unwrap_or_default();
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("translated");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("pdf");
    for index in 2..1000 {
        let candidate = parent.join(format!("{stem} ({index}).{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    path
}

#[tauri::command]
pub async fn render_translated_pdf(
    app: tauri::AppHandle,
    request: RenderRequest,
) -> Result<String, String> {
    let file_name = sanitize_file_name(&request.file_name);
    let bytes = tauri::async_runtime::spawn_blocking(move || render_pdf(&request))
        .await
        .map_err(|e| format!("PDF 渲染工作執行失敗：{e}"))??;

    let download_dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("無法取得下載目錄：{e}"))?;
    let output_path = unique_path(download_dir.join(&file_name));
    std::fs::write(&output_path, &bytes).map_err(|e| format!("無法寫入翻譯 PDF：{e}"))?;

    let path_string = output_path.to_string_lossy().into_owned();
    if let Err(error) = app.opener().open_path(path_string.clone(), None::<&str>) {
        eprintln!("翻譯 PDF 已儲存，但無法自動開啟：{error}");
    }
    Ok(path_string)
}

#[tauri::command]
pub async fn cancel_pdf_render() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(terminate_active_renderer)
        .await
        .map_err(|e| format!("取消 PDF 渲染失敗：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_the_frontend_export_payload() {
        // Exactly the shape src/App.tsx#exportPdf sends, including the fields the
        // struct does not model (`type`, `columnId`) which serde must ignore.
        let payload = serde_json::json!({
            "pdfBytes": [37, 80, 68, 70],
            "mode": "faithful",
            "fontScale": 0.9,
            "fileName": "doc-translated-faithful.pdf",
            "translations": { "p1-b1": "翻譯" },
            "pages": [{
                "pageNumber": 1,
                "blocks": [{
                    "id": "p1-b1",
                    "sourceBBox": { "x": 10.0, "y": 20.0, "width": 100.0, "height": 40.0 },
                    "sourceStyle": { "fontSize": 11.0 },
                    "type": "paragraph",
                    "columnId": "left",
                    "maskRects": [{ "x": 10.0, "y": 20.0, "width": 60.0, "height": 12.0 }]
                }]
            }]
        });

        let request: RenderRequest =
            serde_json::from_value(payload).expect("payload must deserialize");
        let block = &request.pages[0].blocks[0];
        assert_eq!(block.source_bbox.width, 100.0);
        assert_eq!(block.source_style.font_size, 11.0);
        assert_eq!(block.mask_rects.len(), 1);
        assert_eq!(request.file_name, "doc-translated-faithful.pdf");
    }

    #[test]
    fn mask_rects_default_to_empty_when_absent() {
        let block: RenderBlock = serde_json::from_value(serde_json::json!({
            "id": "b",
            "sourceBBox": { "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0 },
            "sourceStyle": { "fontSize": 10.0 }
        }))
        .expect("block without maskRects must deserialize");
        assert!(block.mask_rects.is_empty());
    }

    #[test]
    fn reserializes_bbox_as_source_b_box_for_the_python_worker() {
        let block = RenderBlock {
            id: "b".into(),
            source_bbox: BBox {
                x: 1.0,
                y: 2.0,
                width: 3.0,
                height: 4.0,
            },
            source_style: SourceStyle { font_size: 9.0 },
            mask_rects: vec![],
        };
        let json = serde_json::to_string(&block).unwrap();
        assert!(json.contains("\"sourceBBox\""), "got {json}");
    }

    #[test]
    fn sanitize_file_name_forces_pdf_extension_and_strips_separators() {
        assert_eq!(sanitize_file_name("a/b:c"), "a-b-c.pdf");
        assert_eq!(sanitize_file_name("report.pdf"), "report.pdf");
        assert_eq!(sanitize_file_name("  "), "translated.pdf");
    }
}
