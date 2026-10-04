pub mod commands;
pub mod db;
pub mod scan;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::pick_pdf_folder,
            commands::init_batch,
            commands::sync_folder,
            commands::resolve_unmatched,
            commands::read_pdf,
            commands::save_grading_state,
            commands::save_to_output,
            commands::save_template,
            commands::append_log,
            commands::list_all_grading,
            commands::get_batch_info,
            commands::save_roster,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
