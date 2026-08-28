use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicU32, AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;

use crate::limits::MAX_DOCLING_PDF_BYTES as MAX_PDF_BYTES;
use crate::python_runtime::python_candidates;

const WORKER_SOURCE: &str = include_str!("../../tools/docling_worker.py");
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static ACTIVE_WORKER_PID: AtomicU32 = AtomicU32::new(0);
const ANALYSIS_BATCH_SIZE: u32 = 5;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoclingStatus {
    pub available: bool,
    pub worker_version: String,
    pub schema_version: u32,
    pub docling_version: Option<String>,
    pub python_version: String,
    pub python_executable: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentAnalysis {
    pub schema_version: u32,
    pub document_hash: String,
    pub analyzer: AnalyzerInfo,
    pub pages: Vec<AnalyzedPage>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzerInfo {
    pub name: String,
    pub version: String,
    pub worker_version: String,
    pub model_versions: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzedPage {
    pub page_number: u32,
    pub width: f64,
    pub height: f64,
    pub items: Vec<AnalyzedItem>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzedItem {
    pub id: String,
    pub page_number: u32,
    pub kind: String,
    pub source_label: String,
    pub text: String,
    pub bbox: BoundingBox,
    pub reading_order: u32,
    pub level: u32,
    pub confidence: Option<f64>,
    pub font_size: f64,
    pub translatable: bool,
    pub text_align: Option<String>,
    pub emphasis: Option<String>,
    pub table_cell: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundingBox {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchWorkerMessage {
    #[serde(rename = "type")]
    message_type: String,
    batch_start: u32,
    batch_end: u32,
    completed_pages: u32,
    total_pages: u32,
    analysis: DocumentAnalysis,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisBatchEvent {
    analysis_id: u64,
    batch_start: u32,
    batch_end: u32,
    completed_pages: u32,
    total_pages: u32,
    analysis: DocumentAnalysis,
}

struct TemporaryPdf(PathBuf);

impl TemporaryPdf {
    fn create(bytes: &[u8]) -> Result<Self, String> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("無法取得系統時間：{error}"))?
            .as_millis();
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = env::temp_dir().join(format!(
            "lingopane-docling-{}-{timestamp}-{sequence}.pdf",
            std::process::id()
        ));
        fs::write(&path, bytes).map_err(|error| format!("無法建立 Docling 暫存 PDF：{error}"))?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TemporaryPdf {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn run_worker(python: &str, arguments: &[&str]) -> std::io::Result<Output> {
    Command::new(python)
        .arg("-c")
        .arg(WORKER_SOURCE)
        .args(arguments)
        .output()
}

fn parse_worker_json<T: for<'de> Deserialize<'de>>(stdout: &[u8]) -> Result<T, String> {
    if let Ok(parsed) = serde_json::from_slice(stdout) {
        return Ok(parsed);
    }
    let text = String::from_utf8_lossy(stdout);
    text.lines()
        .rev()
        .find_map(|line| serde_json::from_str(line).ok())
        .ok_or_else(|| format!("Docling worker 未回傳有效 JSON：{}", text.trim()))
}

fn probe_docling_sync(requested_python: Option<&str>) -> Result<DoclingStatus, String> {
    let mut fallback_status = None;
    let mut launch_errors = Vec::new();

    for python in python_candidates(requested_python) {
        match run_worker(&python, &["--probe"]) {
            Ok(output) => {
                let mut status = parse_worker_json::<DoclingStatus>(&output.stdout)?;
                status.python_executable = Some(python);
                if status.available {
                    return Ok(status);
                }
                if fallback_status.is_none() {
                    fallback_status = Some(status);
                }
            }
            Err(error) => launch_errors.push(format!("{python}: {error}")),
        }
    }

    if let Some(status) = fallback_status {
        return Ok(status);
    }
    Err(format!(
        "找不到可執行的 Python。請設定 Python 路徑或 LINGOPANE_DOCLING_PYTHON。{}",
        if launch_errors.is_empty() {
            String::new()
        } else {
            format!(" 嘗試結果：{}", launch_errors.join("；"))
        }
    ))
}

#[cfg(test)]
fn analyze_pdf_sync(
    pdf_bytes: Vec<u8>,
    requested_python: Option<String>,
    do_ocr: bool,
) -> Result<DocumentAnalysis, String> {
    if pdf_bytes.is_empty() {
        return Err("PDF 內容是空的".into());
    }
    if pdf_bytes.len() > MAX_PDF_BYTES {
        return Err("Docling prototype 目前只接受 200 MB 以下的 PDF".into());
    }

    let status = probe_docling_sync(requested_python.as_deref())?;
    if !status.available {
        return Err(format!(
            "找到的 Python 尚未安裝可用的 Docling：{}",
            status.error.unwrap_or_else(|| "未知錯誤".into())
        ));
    }
    let python = status
        .python_executable
        .ok_or_else(|| "Docling probe 未回傳 Python 路徑".to_string())?;
    let temporary_pdf = TemporaryPdf::create(&pdf_bytes)?;
    let path = temporary_pdf.path().to_string_lossy().into_owned();
    let mut arguments = vec!["--input", path.as_str()];
    if do_ocr {
        arguments.push("--ocr");
    }
    let output = run_worker(&python, &arguments)
        .map_err(|error| format!("無法啟動 Docling worker：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Docling 分析失敗：{}", stderr.trim()));
    }
    let analysis = parse_worker_json::<DocumentAnalysis>(&output.stdout)?;
    if analysis.schema_version != 1 {
        return Err(format!(
            "不支援的 Docling 分析 schema 版本：{}",
            analysis.schema_version
        ));
    }
    Ok(analysis)
}

fn terminate_active_worker() -> Result<bool, String> {
    let pid = ACTIVE_WORKER_PID.swap(0, Ordering::SeqCst);
    if pid == 0 {
        return Ok(false);
    }
    let status = Command::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map_err(|error| format!("無法中止 Docling worker {pid}：{error}"))?;
    if !status.success() {
        return Err(format!("Docling worker {pid} 無法正常中止"));
    }
    Ok(true)
}

fn merge_batch_analysis(
    combined: &mut Option<DocumentAnalysis>,
    batch: &DocumentAnalysis,
) -> Result<(), String> {
    if batch.schema_version != 1 {
        return Err(format!(
            "不支援的 Docling 分析 schema 版本：{}",
            batch.schema_version
        ));
    }
    if let Some(current) = combined {
        if current.document_hash != batch.document_hash {
            return Err("Docling 批次回傳了不同文件的分析結果".into());
        }
        current.pages.extend(batch.pages.clone());
        current.pages.sort_by_key(|page| page.page_number);
        current.pages.dedup_by_key(|page| page.page_number);
        current.warnings.extend(batch.warnings.clone());
    } else {
        *combined = Some(batch.clone());
    }
    Ok(())
}

// Args mirror the analyze_pdf_with_docling IPC command 1:1; bundling them into
// a struct is deferred to the PR-3 python_runtime extraction.
#[allow(clippy::too_many_arguments)]
fn analyze_pdf_in_batches(
    app: tauri::AppHandle,
    analysis_id: u64,
    pdf_bytes: Vec<u8>,
    requested_python: Option<String>,
    do_ocr: bool,
    page_count: u32,
    priority_page: u32,
    layout_model: String,
) -> Result<DocumentAnalysis, String> {
    if pdf_bytes.is_empty() {
        return Err("PDF 內容是空的".into());
    }
    if pdf_bytes.len() > MAX_PDF_BYTES {
        return Err("Docling prototype 目前只接受 200 MB 以下的 PDF".into());
    }
    if page_count == 0 {
        return Err("PDF 頁數必須大於零".into());
    }

    let status = probe_docling_sync(requested_python.as_deref())?;
    if !status.available {
        return Err(format!(
            "找到的 Python 尚未安裝可用的 Docling：{}",
            status.error.unwrap_or_else(|| "未知錯誤".into())
        ));
    }
    let python = status
        .python_executable
        .ok_or_else(|| "Docling probe 未回傳 Python 路徑".to_string())?;
    let temporary_pdf = TemporaryPdf::create(&pdf_bytes)?;
    let path = temporary_pdf.path().to_string_lossy().into_owned();

    let _ = terminate_active_worker();
    let mut command = Command::new(&python);
    command
        .arg("-c")
        .arg(WORKER_SOURCE)
        .args([
            "--input",
            path.as_str(),
            "--page-count",
            &page_count.to_string(),
            "--batch-size",
            &ANALYSIS_BATCH_SIZE.to_string(),
            "--priority-page",
            &priority_page.to_string(),
            "--layout-model",
            &layout_model,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if do_ocr {
        command.arg("--ocr");
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("無法啟動 Docling 分批 worker：{error}"))?;
    let pid = child.id();
    ACTIVE_WORKER_PID.store(pid, Ordering::SeqCst);
    let stdout = child.stdout.take().ok_or_else(|| {
        let _ = child.kill();
        let _ = child.wait();
        let _ = ACTIVE_WORKER_PID.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
        "無法讀取 Docling worker 輸出".to_string()
    })?;
    let mut combined = None;
    let mut parse_errors = Vec::new();
    let mut processing_error = None;

    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                processing_error = Some(format!("讀取 Docling 批次輸出失敗：{error}"));
                break;
            }
        };
        match serde_json::from_str::<BatchWorkerMessage>(&line) {
            Ok(message) if message.message_type == "batch" => {
                if let Err(error) = merge_batch_analysis(&mut combined, &message.analysis) {
                    processing_error = Some(error);
                    break;
                }
                if let Err(error) = app.emit(
                    "docling-analysis-batch",
                    AnalysisBatchEvent {
                        analysis_id,
                        batch_start: message.batch_start,
                        batch_end: message.batch_end,
                        completed_pages: message.completed_pages,
                        total_pages: message.total_pages,
                        analysis: message.analysis,
                    },
                ) {
                    processing_error = Some(format!("無法傳送 Docling 批次結果：{error}"));
                    break;
                }
            }
            Ok(_) => {}
            Err(error) if !line.trim().is_empty() => parse_errors.push(format!("{error}: {line}")),
            Err(_) => {}
        }
    }

    if let Some(error) = processing_error {
        let _ = child.kill();
        let _ = child.wait();
        let _ = ACTIVE_WORKER_PID.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
        return Err(error);
    }

    let exit_status = child
        .wait()
        .map_err(|error| format!("等待 Docling worker 結束失敗：{error}"))?;
    let _ = ACTIVE_WORKER_PID.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
    if !exit_status.success() {
        return Err("Docling 分析已中止或 worker 執行失敗".into());
    }
    combined.ok_or_else(|| {
        if parse_errors.is_empty() {
            "Docling worker 未回傳任何批次結果".into()
        } else {
            format!("Docling worker 未回傳有效批次：{}", parse_errors.join("；"))
        }
    })
}

#[tauri::command]
pub async fn probe_docling(python_path: Option<String>) -> Result<DoclingStatus, String> {
    tauri::async_runtime::spawn_blocking(move || probe_docling_sync(python_path.as_deref()))
        .await
        .map_err(|error| format!("Docling probe 工作執行失敗：{error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // IPC command surface; args come from the frontend individually
pub async fn analyze_pdf_with_docling(
    app: tauri::AppHandle,
    analysis_id: u64,
    pdf_bytes: Vec<u8>,
    python_path: Option<String>,
    do_ocr: bool,
    page_count: u32,
    priority_page: u32,
    layout_model: Option<String>,
) -> Result<DocumentAnalysis, String> {
    let resolved_layout_model = layout_model.unwrap_or_else(|| "heron".into());
    tauri::async_runtime::spawn_blocking(move || {
        analyze_pdf_in_batches(
            app,
            analysis_id,
            pdf_bytes,
            python_path,
            do_ocr,
            page_count,
            priority_page,
            resolved_layout_model,
        )
    })
    .await
    .map_err(|error| format!("Docling 分析工作執行失敗：{error}"))?
}

#[tauri::command]
pub async fn cancel_docling_analysis() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(terminate_active_worker)
        .await
        .map_err(|error| format!("Docling 取消工作執行失敗：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn analysis_with_page(page_number: u32) -> DocumentAnalysis {
        DocumentAnalysis {
            schema_version: 1,
            document_hash: "same-document".into(),
            analyzer: AnalyzerInfo {
                name: "docling-standard".into(),
                version: "test".into(),
                worker_version: "3".into(),
                model_versions: serde_json::json!({}),
            },
            pages: vec![AnalyzedPage {
                page_number,
                width: 612.0,
                height: 792.0,
                items: vec![],
            }],
            warnings: vec![],
        }
    }

    // Python discovery moved to python_runtime.rs (covered by its own tests).

    #[test]
    fn parses_worker_json_after_log_lines() {
        let output = b"model warmup\n{\"available\":false,\"workerVersion\":\"1\",\"schemaVersion\":1,\"doclingVersion\":null,\"pythonVersion\":\"3.12\",\"pythonExecutable\":null,\"error\":\"missing\"}\n";
        let status = parse_worker_json::<DoclingStatus>(output).unwrap();
        assert!(!status.available);
        assert_eq!(status.schema_version, 1);
    }

    #[test]
    fn merges_out_of_order_batches_by_original_page_number() {
        let mut combined = None;
        merge_batch_analysis(&mut combined, &analysis_with_page(6)).unwrap();
        merge_batch_analysis(&mut combined, &analysis_with_page(1)).unwrap();
        let pages: Vec<u32> = combined
            .unwrap()
            .pages
            .into_iter()
            .map(|page| page.page_number)
            .collect();
        assert_eq!(pages, vec![1, 6]);
    }

    #[test]
    fn rejects_empty_pdf_before_starting_python() {
        let error = analyze_pdf_sync(Vec::new(), None, false).unwrap_err();
        assert_eq!(error, "PDF 內容是空的");
    }
}
