use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU32, Ordering},
};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

use crate::python_runtime::python_with_pymupdf;

const RENDERER_SOURCE: &str = include_str!("../../tools/pdf_renderer.py");
static ACTIVE_RENDERER_PID: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub pdf_bytes: Vec<u8>,
    pub plan: RenderPlan,
    pub file_name: String,
}

/// Versioned wire contract — mirror of src/lib/renderPlan.ts. `pdf_renderer.py`
/// checks `version` before touching anything else.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlan {
    pub version: u32,
    pub mode: String,
    pub target_language: String,
    pub font_scale: f64,
    pub min_font_scale: f64,
    pub pages: Vec<RenderPagePlan>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPagePlan {
    pub page_number: u32,
    pub width: f64,
    pub height: f64,
    pub blocks: Vec<RenderPlanBlock>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlanBlock {
    pub id: String,
    pub kind: String,
    pub bbox: RenderRect,
    pub font_size: f64,
    #[serde(default)]
    pub text_align: Option<String>,
    #[serde(default)]
    pub emphasis: Option<String>,
    pub text: String,
    #[serde(default)]
    pub mask_rects: Vec<RenderRect>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn terminate_active_renderer() -> bool {
    let pid = ACTIVE_RENDERER_PID.load(Ordering::SeqCst);
    if pid == 0 {
        return false;
    }
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    ACTIVE_RENDERER_PID
        .compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst)
        .ok();
    true
}

pub fn render_pdf(request: &RenderRequest) -> Result<Vec<u8>, String> {
    if request.pdf_bytes.is_empty() {
        return Err("PDF 內容是空的".into());
    }

    let python = python_with_pymupdf()?;
    let plan_json = serde_json::to_string(&request.plan)
        .map_err(|e| format!("序列化 render plan 失敗：{e}"))?;

    let _ = terminate_active_renderer();

    let mut child = Command::new(&python)
        .arg("-c")
        .arg(RENDERER_SOURCE)
        .args(["--plan-json", &plan_json])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("無法啟動 PDF renderer：{e}"))?;

    let pid = child.id();
    ACTIVE_RENDERER_PID.store(pid, Ordering::SeqCst);

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(&request.pdf_bytes).map_err(|e| {
            let _ = child.kill();
            let _ = child.wait();
            let _ =
                ACTIVE_RENDERER_PID.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
            format!("寫入 PDF 資料失敗：{e}")
        })?;
        drop(stdin);
    }

    let output = child.wait_with_output().map_err(|e| {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn frontend_payload() -> serde_json::Value {
        // Exactly the shape src/App.tsx#exportPdf now sends.
        serde_json::json!({
            "pdfBytes": [37, 80, 68, 70],
            "fileName": "doc-translated-faithful.pdf",
            "plan": {
                "version": 1,
                "mode": "faithful",
                "targetLanguage": "zh-TW",
                "fontScale": 0.9,
                "minFontScale": 0.85,
                "pages": [{
                    "pageNumber": 1,
                    "width": 612.0,
                    "height": 792.0,
                    "blocks": [{
                        "id": "p1-b1",
                        "kind": "text",
                        "bbox": { "x": 10.0, "y": 20.0, "width": 100.0, "height": 40.0 },
                        "fontSize": 11.0,
                        "textAlign": "left",
                        "text": "翻譯後的段落",
                        "maskRects": [{ "x": 10.0, "y": 20.0, "width": 60.0, "height": 12.0 }]
                    }]
                }]
            }
        })
    }

    #[test]
    fn deserializes_the_render_plan_payload() {
        let request: RenderRequest =
            serde_json::from_value(frontend_payload()).expect("payload must deserialize");
        assert_eq!(request.plan.version, 1);
        assert_eq!(request.plan.mode, "faithful");
        let block = &request.plan.pages[0].blocks[0];
        assert_eq!(block.kind, "text");
        assert_eq!(block.bbox.width, 100.0);
        assert_eq!(block.font_size, 11.0);
        assert_eq!(block.text, "翻譯後的段落");
        assert_eq!(block.mask_rects.len(), 1);
    }

    #[test]
    fn optional_block_fields_default() {
        let block: RenderPlanBlock = serde_json::from_value(serde_json::json!({
            "id": "b",
            "kind": "heading",
            "bbox": { "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0 },
            "fontSize": 14.0,
            "text": "標題"
        }))
        .expect("block with only required fields must deserialize");
        assert!(block.text_align.is_none());
        assert!(block.emphasis.is_none());
        assert!(block.mask_rects.is_empty());
    }

    #[test]
    fn reserializes_plan_in_camel_case_for_the_python_worker() {
        let request: RenderRequest = serde_json::from_value(frontend_payload()).unwrap();
        let json = serde_json::to_string(&request.plan).unwrap();
        assert!(json.contains("\"minFontScale\""), "got {json}");
        assert!(json.contains("\"pageNumber\""), "got {json}");
        assert!(json.contains("\"fontSize\""), "got {json}");
    }

    #[test]
    fn sanitize_file_name_forces_pdf_extension_and_strips_separators() {
        assert_eq!(sanitize_file_name("a/b:c"), "a-b-c.pdf");
        assert_eq!(sanitize_file_name("report.pdf"), "report.pdf");
        assert_eq!(sanitize_file_name("  "), "translated.pdf");
    }
}
