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
            commands::pack_renamed_zip,
            commands::scan_save_struct,
            commands::save_template,
            commands::append_log,
            commands::pick_template,
            commands::list_all_grading,
            commands::get_batch_info,
            commands::save_roster,
            commands::save_batch_items,
            commands::get_batch_items,
            commands::get_template_path,
            commands::ocr_image_b64,
            commands::ocr_image_b64_words,
            commands::save_scan_text,
            commands::apply_renames,
            commands::save_report_locate,
            commands::get_report_locate,
            commands::locate_init,
            commands::locate_reset,
            commands::locate_set_ocr,
            commands::locate_set_match,
            commands::locate_get_rows,
            commands::create_user,
            commands::login,
            commands::change_password,
            commands::list_users,
            commands::save_basic_fields,
            commands::get_basic_fields,
            commands::save_report_ocr,
            commands::prep_overview,
            commands::get_grading_scope,
            commands::save_grading_scope,
            commands::open_external,
            commands::get_roster,
            commands::recover_roster,
            commands::mark_excluded,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
