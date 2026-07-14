mod llm;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            llm::save_api_key,
            llm::list_models,
            llm::test_connection,
            llm::translate_blocks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
