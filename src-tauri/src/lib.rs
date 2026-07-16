mod cache;
mod docling;
mod llm;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            cache::open_cached_document,
            cache::load_cached_document,
            cache::set_document_cache_limit,
            cache::save_cached_layout,
            cache::save_cached_translation,
            docling::probe_docling,
            docling::analyze_pdf_with_docling,
            docling::cancel_docling_analysis,
            llm::save_api_key,
            llm::list_models,
            llm::test_connection,
            llm::cancel_translation,
            llm::translate_blocks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
