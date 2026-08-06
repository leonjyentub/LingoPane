use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const DATABASE_FILE: &str = "document-cache.sqlite3";
const MIN_DOCUMENT_LIMIT: u32 = 1;
const MAX_DOCUMENT_LIMIT: u32 = 500;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedCachedDocument {
    pub document_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedDocumentData {
    pub layouts: Vec<CachedLayout>,
    pub translations: Vec<CachedTranslation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedLayout {
    pub page_number: u32,
    pub layout: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTranslation {
    pub page_number: u32,
    pub blocks: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearedCache {
    pub documents: u32,
    pub layouts: u32,
    pub translations: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDocument {
    pub document_id: String,
    pub file_name: String,
    pub file_path: String,
    pub page_count: u32,
    pub last_accessed: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheLayoutRequest {
    pub document_id: String,
    pub analysis_key: String,
    pub page_number: u32,
    pub layout: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheTranslationRequest {
    pub document_id: String,
    pub analysis_key: String,
    pub translation_key: String,
    pub page_number: u32,
    pub blocks: Value,
}

fn unix_timestamp() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .map_err(|error| format!("無法取得快取時間：{error}"))
}

fn normalize_limit(limit: u32) -> u32 {
    limit.clamp(MIN_DOCUMENT_LIMIT, MAX_DOCUMENT_LIMIT)
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("無法取得 App 資料目錄：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("無法建立 App 資料目錄：{error}"))?;
    Ok(directory.join(DATABASE_FILE))
}

fn open_connection(app: &tauri::AppHandle) -> Result<Connection, String> {
    let connection = Connection::open(database_path(app)?).map_err(cache_error)?;
    initialize(&connection)?;
    Ok(connection)
}

fn cache_error(error: rusqlite::Error) -> String {
    format!("文件快取資料庫錯誤：{error}")
}

fn initialize(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS documents (
             id TEXT PRIMARY KEY,
             file_name TEXT NOT NULL,
             file_path TEXT DEFAULT '',
             page_count INTEGER NOT NULL,
             last_accessed INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS page_layouts (
             document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
             analysis_key TEXT NOT NULL,
             page_number INTEGER NOT NULL,
             layout_json TEXT NOT NULL,
             updated_at INTEGER NOT NULL,
             PRIMARY KEY (document_id, analysis_key, page_number)
         );
         CREATE TABLE IF NOT EXISTS page_translations (
             document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
             analysis_key TEXT NOT NULL,
             translation_key TEXT NOT NULL,
             page_number INTEGER NOT NULL,
             blocks_json TEXT NOT NULL,
             updated_at INTEGER NOT NULL,
             PRIMARY KEY (document_id, analysis_key, translation_key, page_number)
         );
         CREATE INDEX IF NOT EXISTS documents_last_accessed_idx ON documents(last_accessed DESC);
         PRAGMA table_info(documents);",
        )
        .map_err(cache_error)?;
    // Add file_path column if missing (migration for existing databases)
    let has_file_path: bool = connection
        .prepare("SELECT file_path FROM documents LIMIT 0")
        .is_ok();
    if !has_file_path {
        connection
            .execute_batch("ALTER TABLE documents ADD COLUMN file_path TEXT DEFAULT '';")
            .map_err(cache_error)?;
    }
    Ok(())
}

fn prune_documents(connection: &Connection, limit: u32) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM documents WHERE id IN (
             SELECT id FROM documents ORDER BY last_accessed DESC, rowid DESC LIMIT -1 OFFSET ?1
         )",
            params![normalize_limit(limit)],
        )
        .map_err(cache_error)?;
    Ok(())
}

fn touch_document(connection: &Connection, document_id: &str) -> Result<(), String> {
    connection
        .execute(
            "UPDATE documents SET last_accessed = ?2 WHERE id = ?1",
            params![document_id, unix_timestamp()?],
        )
        .map_err(cache_error)?;
    Ok(())
}

fn clear_all_cached_documents(connection: &Connection) -> Result<ClearedCache, String> {
    let documents = connection
        .query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))
        .map_err(cache_error)?;
    let layouts = connection
        .query_row("SELECT COUNT(*) FROM page_layouts", [], |row| row.get(0))
        .map_err(cache_error)?;
    let translations = connection
        .query_row("SELECT COUNT(*) FROM page_translations", [], |row| {
            row.get(0)
        })
        .map_err(cache_error)?;
    connection
        .execute("DELETE FROM documents", [])
        .map_err(cache_error)?;
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
        .map_err(cache_error)?;
    Ok(ClearedCache {
        documents,
        layouts,
        translations,
    })
}

#[tauri::command]
pub fn open_cached_document(
    app: tauri::AppHandle,
    pdf_bytes: Vec<u8>,
    file_name: String,
    file_path: Option<String>,
    page_count: u32,
    max_documents: u32,
) -> Result<OpenedCachedDocument, String> {
    if pdf_bytes.is_empty() {
        return Err("無法快取空白 PDF".into());
    }
    let document_id = format!("{:x}", Sha256::digest(&pdf_bytes));
    let connection = open_connection(&app)?;
    let resolved_path = file_path.unwrap_or_default();
    connection
        .execute(
            "INSERT INTO documents (id, file_name, file_path, page_count, last_accessed)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
             file_name = excluded.file_name,
             file_path = CASE WHEN excluded.file_path != '' THEN excluded.file_path ELSE documents.file_path END,
             page_count = excluded.page_count,
             last_accessed = excluded.last_accessed",
            params![document_id, file_name, resolved_path, page_count, unix_timestamp()?],
        )
        .map_err(cache_error)?;
    prune_documents(&connection, max_documents)?;
    Ok(OpenedCachedDocument { document_id })
}

#[tauri::command]
pub fn load_cached_document(
    app: tauri::AppHandle,
    document_id: String,
    analysis_key: String,
    translation_key: String,
) -> Result<CachedDocumentData, String> {
    let connection = open_connection(&app)?;
    touch_document(&connection, &document_id)?;

    let mut layout_statement = connection
        .prepare(
            "SELECT page_number, layout_json FROM page_layouts
         WHERE document_id = ?1 AND analysis_key = ?2 ORDER BY page_number",
        )
        .map_err(cache_error)?;
    let layouts = layout_statement
        .query_map(params![document_id, analysis_key], |row| {
            let page_number = row.get::<_, u32>(0)?;
            let json = row.get::<_, String>(1)?;
            Ok((page_number, json))
        })
        .map_err(cache_error)?
        .map(|row| {
            let (page_number, json) = row.map_err(cache_error)?;
            let layout = serde_json::from_str(&json)
                .map_err(|error| format!("快取版面 JSON 已損毀：{error}"))?;
            Ok(CachedLayout {
                page_number,
                layout,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let mut translation_statement = connection
        .prepare(
            "SELECT page_number, blocks_json FROM page_translations
         WHERE document_id = ?1 AND analysis_key = ?2 AND translation_key = ?3
         ORDER BY page_number",
        )
        .map_err(cache_error)?;
    let translations = translation_statement
        .query_map(params![document_id, analysis_key, translation_key], |row| {
            Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(cache_error)?
        .map(|row| {
            let (page_number, json) = row.map_err(cache_error)?;
            let blocks = serde_json::from_str(&json)
                .map_err(|error| format!("快取翻譯 JSON 已損毀：{error}"))?;
            Ok(CachedTranslation {
                page_number,
                blocks,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(CachedDocumentData {
        layouts,
        translations,
    })
}

#[tauri::command]
pub fn set_document_cache_limit(app: tauri::AppHandle, max_documents: u32) -> Result<(), String> {
    let connection = open_connection(&app)?;
    prune_documents(&connection, max_documents)
}

#[tauri::command]
pub fn clear_document_cache(app: tauri::AppHandle) -> Result<ClearedCache, String> {
    let connection = open_connection(&app)?;
    clear_all_cached_documents(&connection)
}

#[tauri::command]
pub fn list_recent_documents(
    app: tauri::AppHandle,
    limit: u32,
) -> Result<Vec<RecentDocument>, String> {
    let connection = open_connection(&app)?;
    let limit = limit.clamp(1, 50);
    let mut statement = connection
        .prepare(
            "SELECT id, file_name, COALESCE(file_path, ''), page_count, last_accessed
             FROM documents
             WHERE COALESCE(file_path, '') != ''
             ORDER BY last_accessed DESC
             LIMIT ?1",
        )
        .map_err(cache_error)?;
    let documents = statement
        .query_map(params![limit], |row| {
            Ok(RecentDocument {
                document_id: row.get(0)?,
                file_name: row.get(1)?,
                file_path: row.get(2)?,
                page_count: row.get(3)?,
                last_accessed: row.get(4)?,
            })
        })
        .map_err(cache_error)?
        .filter_map(|row| row.ok())
        .collect();
    Ok(documents)
}

#[tauri::command]
pub fn save_cached_layout(
    app: tauri::AppHandle,
    request: CacheLayoutRequest,
) -> Result<(), String> {
    let connection = open_connection(&app)?;
    let json = serde_json::to_string(&request.layout)
        .map_err(|error| format!("無法序列化 PDF 版面：{error}"))?;
    connection.execute(
        "INSERT INTO page_layouts (document_id, analysis_key, page_number, layout_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(document_id, analysis_key, page_number) DO UPDATE SET
             layout_json = excluded.layout_json,
             updated_at = excluded.updated_at",
        params![request.document_id, request.analysis_key, request.page_number, json, unix_timestamp()?],
    ).map_err(cache_error)?;
    touch_document(&connection, &request.document_id)
}

#[tauri::command]
pub fn save_cached_translation(
    app: tauri::AppHandle,
    request: CacheTranslationRequest,
) -> Result<(), String> {
    let connection = open_connection(&app)?;
    let json = serde_json::to_string(&request.blocks)
        .map_err(|error| format!("無法序列化頁面翻譯：{error}"))?;
    connection
        .execute(
            "INSERT INTO page_translations
             (document_id, analysis_key, translation_key, page_number, blocks_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(document_id, analysis_key, translation_key, page_number) DO UPDATE SET
             blocks_json = excluded.blocks_json,
             updated_at = excluded.updated_at",
            params![
                request.document_id,
                request.analysis_key,
                request.translation_key,
                request.page_number,
                json,
                unix_timestamp()?
            ],
        )
        .map_err(cache_error)?;
    touch_document(&connection, &request.document_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::OptionalExtension;

    #[test]
    fn prunes_oldest_documents_and_cascades_pages() {
        let connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        for index in 1..=4 {
            connection.execute(
                "INSERT INTO documents (id, file_name, page_count, last_accessed) VALUES (?1, ?2, 1, ?3)",
                params![format!("doc-{index}"), format!("{index}.pdf"), index],
            ).unwrap();
            connection.execute(
                "INSERT INTO page_layouts (document_id, analysis_key, page_number, layout_json, updated_at)
                 VALUES (?1, 'fast', 1, '{}', ?2)",
                params![format!("doc-{index}"), index],
            ).unwrap();
        }
        prune_documents(&connection, 2).unwrap();
        let documents: i64 = connection
            .query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))
            .unwrap();
        let layouts: i64 = connection
            .query_row("SELECT COUNT(*) FROM page_layouts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(documents, 2);
        assert_eq!(layouts, 2);
        let oldest: Option<String> = connection
            .query_row("SELECT id FROM documents WHERE id = 'doc-1'", [], |row| {
                row.get(0)
            })
            .optional()
            .unwrap();
        assert!(oldest.is_none());
    }

    #[test]
    fn clamps_document_limit() {
        assert_eq!(normalize_limit(0), 1);
        assert_eq!(normalize_limit(30), 30);
        assert_eq!(normalize_limit(999), 500);
    }

    #[test]
    fn clears_documents_layouts_and_translations() {
        let connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        connection.execute(
            "INSERT INTO documents (id, file_name, page_count, last_accessed) VALUES ('doc', 'test.pdf', 1, 1)",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO page_layouts (document_id, analysis_key, page_number, layout_json, updated_at)
             VALUES ('doc', 'fast', 1, '{}', 1)",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO page_translations (document_id, analysis_key, translation_key, page_number, blocks_json, updated_at)
             VALUES ('doc', 'fast', 'translation', 1, '[]', 1)",
            [],
        ).unwrap();

        let cleared = clear_all_cached_documents(&connection).unwrap();
        assert_eq!(cleared.documents, 1);
        assert_eq!(cleared.layouts, 1);
        assert_eq!(cleared.translations, 1);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM documents", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM page_layouts", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM page_translations", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
