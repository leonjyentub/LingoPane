//! Shared discovery of the Python interpreter for the Docling and PDF-render
//! subprocesses. Previously duplicated almost verbatim in docling.rs and
//! renderer.rs.

use std::{
    collections::HashSet,
    path::PathBuf,
    process::Command,
    sync::{Mutex, OnceLock},
};

/// Ordered list of interpreters to try. An explicit `requested` path short-
/// circuits everything else; otherwise env override → managed runtimes →
/// bundled venv → PATH.
pub fn python_candidates(requested: Option<&str>) -> Vec<String> {
    if let Some(requested) = requested.map(str::trim).filter(|path| !path.is_empty()) {
        return vec![requested.to_string()];
    }

    let mut candidates = Vec::new();

    if let Ok(configured) = std::env::var("LINGOPANE_DOCLING_PYTHON") {
        if !configured.trim().is_empty() {
            candidates.push(configured);
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let application_support = PathBuf::from(&home)
            .join("Library/Application Support/com.leonjye.lingopane/docling-runtime");
        add_python_if_present(
            &mut candidates,
            application_support.join("current/bin/python"),
        );
        add_python_if_present(
            &mut candidates,
            application_support.join(".venv/bin/python"),
        );
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

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.clone()))
        .collect()
}

pub fn add_python_if_present(candidates: &mut Vec<String>, path: PathBuf) {
    if path.is_file() {
        candidates.push(path.to_string_lossy().into_owned());
    }
}

fn pymupdf_python_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn has_pymupdf(python: &str) -> bool {
    Command::new(python)
        .arg("-c")
        .arg("import pymupdf")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Interpreter that can `import pymupdf`, cached for the process. A cached hit
/// is re-verified cheaply; if the environment changed underneath us it falls
/// back to a full scan.
pub fn python_with_pymupdf() -> Result<String, String> {
    let mut cache = pymupdf_python_cache()
        .lock()
        .map_err(|_| "Python 探測快取無法鎖定".to_string())?;

    if let Some(cached) = cache.as_deref() {
        if has_pymupdf(cached) {
            return Ok(cached.to_string());
        }
        *cache = None;
    }

    for candidate in python_candidates(None) {
        if has_pymupdf(&candidate) {
            *cache = Some(candidate.clone());
            return Ok(candidate);
        }
    }
    Err("找不到安裝了 PyMuPDF 的 Python".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_path_short_circuits_the_scan() {
        assert_eq!(
            python_candidates(Some(" /tmp/venv/bin/python ")),
            vec!["/tmp/venv/bin/python"]
        );
    }

    #[test]
    fn only_adds_existing_runtime_paths() {
        let mut candidates = Vec::new();
        add_python_if_present(&mut candidates, PathBuf::from("/path/that/does/not/exist"));
        assert!(candidates.is_empty());
    }

    #[test]
    fn falls_back_to_path_lookups() {
        let candidates = python_candidates(None);
        assert!(candidates.iter().any(|c| c == "python3"));
    }
}
