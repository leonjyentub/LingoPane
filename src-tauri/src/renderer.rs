use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU32, Ordering},
};

const RENDERER_SOURCE: &str = include_str!("../../tools/pdf_renderer.py");
const BABELDOC_SOURCE: &str = include_str!("../../tools/babeldoc_worker.py");
static ACTIVE_RENDERER_PID: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub pdf_bytes: Vec<u8>,
    pub pages: Vec<RenderPage>,
    pub translations: std::collections::HashMap<String, String>,
    pub mode: String,
    pub font_scale: f64,
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
    pub source_bbox: BBox,
    pub source_style: SourceStyle,
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

    let worker_source = match request.mode.as_str() {
        "adaptive" => BABELDOC_SOURCE,
        _ => RENDERER_SOURCE,
    };

    let mut child = Command::new(&python)
        .arg("-c")
        .arg(worker_source)
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

#[tauri::command]
pub async fn render_translated_pdf(request: RenderRequest) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || render_pdf(&request))
        .await
        .map_err(|e| format!("PDF 渲染工作執行失敗：{e}"))?
}

#[tauri::command]
pub async fn cancel_pdf_render() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(terminate_active_renderer)
        .await
        .map_err(|e| format!("取消 PDF 渲染失敗：{e}"))
}
