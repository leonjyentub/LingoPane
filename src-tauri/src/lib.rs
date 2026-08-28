mod cache;
mod docling;
mod files;
mod limits;
mod llm;
mod renderer;
mod window_controls;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(files::OpenedPdfPaths::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            cache::open_cached_document,
            cache::load_cached_document,
            cache::set_document_cache_limit,
            cache::clear_document_cache,
            cache::list_recent_documents,
            cache::save_cached_layout,
            cache::save_cached_translation,
            docling::probe_docling,
            docling::analyze_pdf_with_docling,
            docling::cancel_docling_analysis,
            files::read_dropped_pdf,
            files::take_opened_pdf_paths,
            llm::save_api_key,
            llm::list_models,
            llm::test_connection,
            llm::cancel_translation,
            llm::translate_blocks,
            renderer::render_translated_pdf,
            renderer::cancel_pdf_render,
            window_controls::start_window_drag,
            window_controls::toggle_window_maximize
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            files::handle_opened_urls(app_handle, &urls);
        }
    });
}
