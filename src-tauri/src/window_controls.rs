#[tauri::command]
pub fn start_window_drag(window: tauri::Window) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|error| format!("無法開始拖曳視窗：{error}"))
}

#[tauri::command]
pub fn toggle_window_maximize(window: tauri::Window) -> Result<(), String> {
    let maximized = window
        .is_maximized()
        .map_err(|error| format!("無法讀取視窗大小：{error}"))?;
    if maximized {
        window
            .unmaximize()
            .map_err(|error| format!("無法還原視窗：{error}"))
    } else {
        window
            .maximize()
            .map_err(|error| format!("無法放大視窗：{error}"))
    }
}
