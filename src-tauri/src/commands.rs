// Tauri 命令层：前端经 tauri-bridge 调用的全部后端能力
use crate::{db, scan};
use serde::Serialize;
use std::fs;
use std::path::Path;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
pub struct BatchInfo {
    pub id: i64,
    pub name: String,
}

#[derive(Serialize)]
pub struct Picked {
    pub folder: String,
    pub has_db: bool,
    pub batch: Option<BatchInfo>,
}

/// 选择报告文件夹：返回是否已有数据库及批次信息
#[tauri::command]
pub async fn pick_pdf_folder(app: tauri::AppHandle) -> Result<Picked, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(path) = picked else {
        return Err("已取消选择".into());
    };
    let folder = path.to_string();
    let has_db = Path::new(&folder).join(db::DATA_DIR).join(db::DB_NAME).exists();
    let mut batch = None;
    if has_db {
        if let Ok(conn) = db::open(&folder) {
            if let Ok(Some((id, name))) = db::find_batch_by_folder(&conn) {
                batch = Some(BatchInfo { id, name });
            }
        }
    }
    Ok(Picked { folder, has_db, batch })
}

/// 初始化批次：建库 + 报告名称 + 导入名单
#[tauri::command]
pub fn init_batch(
    folder: String,
    report_name: String,
    students: Vec<db::StudentIn>,
    teacher: String,
) -> Result<(), String> {
    let conn = db::open(&folder)?;
    let bid = db::get_or_create_batch(&conn, &report_name, &teacher)?;
    db::insert_students(&conn, bid, &students)?;
    Ok(())
}

/// 增量同步（每次打开文件夹自动执行）
#[tauri::command]
pub fn sync_folder(folder: String) -> Result<scan::SyncResult, String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("未找到批次")?;
    scan::sync_folder(&conn, &folder, bid)
}

/// 处理未匹配：student_no 为空 = 不导入；否则挂到该学生并生成改名版
#[tauri::command]
pub fn resolve_unmatched(folder: String, path: String, student_no: String) -> Result<(), String> {
    let conn = db::open(&folder)?;
    scan::resolve_unmatched(&conn, &folder, &path, &student_no)
}

/// 读取 PDF 字节（path 为相对所选文件夹的相对路径）
#[tauri::command]
pub fn read_pdf(folder: String, path: String) -> Result<Vec<u8>, String> {
    let full = Path::new(&folder).join(&path);
    fs::read(&full).map_err(|e| format!("读取PDF失败: {e}"))
}

/// 保存批阅状态；snapshot.done=true 视为提交固化
#[tauri::command]
pub fn save_grading_state(
    folder: String,
    report_key: String,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("未找到批次")?;
    let rid = db::report_id_by_key(&conn, bid, &report_key)?.ok_or("未找到报告")?;
    let done = snapshot.get("done").and_then(|v| v.as_bool()).unwrap_or(false);
    let json = serde_json::to_string(&snapshot).map_err(|e| format!("序列化失败: {e}"))?;
    db::save_state(&conn, rid, &json, done)?;
    Ok(())
}

/// 导出产物写入 output/ 目录
#[tauri::command]
pub fn save_to_output(folder: String, name: String, data: Vec<u8>) -> Result<String, String> {
    let out_dir = Path::new(&folder).join(db::OUTPUT_DIR);
    fs::create_dir_all(&out_dir).map_err(|e| format!("创建 output 失败: {e}"))?;
    let safe: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let path = out_dir.join(&safe);
    fs::write(&path, &data).map_err(|e| format!("写入 output 失败: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 全量成绩清单（所有学生），供"保存全部成绩 CSV / 批阅概览表格"
#[tauri::command]
pub fn list_all_grading(folder: String) -> Result<Vec<db::GradeRow>, String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("当前文件夹尚未初始化批次")?;
    db::list_all_grading(&conn, bid)
}

#[derive(Serialize)]
pub struct StudentOut {
    pub no: String,
    pub name: String,
    pub cls: String,
}

#[derive(Serialize)]
pub struct BatchInfoDetail {
    pub report_name: String,
    pub count: usize,
    pub students: Vec<StudentOut>,
}

/// 读取当前批次信息（报告名称 + 学生名单），供"已有批次提示"对话框
#[tauri::command]
pub fn get_batch_info(folder: String) -> Result<BatchInfoDetail, String> {
    let conn = db::open(&folder)?;
    let (bid, name) = db::find_batch_by_folder(&conn)?.ok_or("当前文件夹尚未初始化批次")?;
    let students = db::get_students(&conn, bid)?;
    Ok(BatchInfoDetail {
        report_name: name,
        count: students.len(),
        students: students
            .into_iter()
            .map(|s| StudentOut { no: s.no, name: s.name, cls: s.cls })
            .collect(),
    })
}

/// 把"名单 + 报告名称"写成 CSV 存到 source_files，供查看/迁移
#[tauri::command]
pub fn save_roster(folder: String, report_name: String, students: Vec<db::StudentIn>) -> Result<String, String> {
    let src_dir = Path::new(&folder).join(db::SOURCE_DIR);
    fs::create_dir_all(&src_dir).map_err(|e| format!("创建 source_files 失败: {e}"))?;
    let safe: String = report_name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let path = src_dir.join(format!("_名单_{}.csv", safe));
    let mut csv = String::from("\u{feff}学号,姓名,班级,报告名称\n");
    for s in &students {
        csv.push_str(&format!("{},{},{},{}\n", s.no, s.name, s.cls, report_name));
    }
    fs::write(&path, csv).map_err(|e| format!("写入名单失败: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 保存名单模板：弹系统保存对话框，用户选位置后写入（供"下载名单模板"使用）
#[tauri::command]
pub fn save_template(app: tauri::AppHandle, data: Vec<u8>, suggested: String) -> Result<(), String> {
    let picked = app
        .dialog()
        .file()
        .set_file_name(&suggested)
        .add_filter("Excel", &["xlsx"])
        .blocking_save_file();
    let Some(path) = picked else {
        return Ok(()); // 用户取消
    };
    let p = path.as_path().ok_or("保存路径无效")?;
    fs::write(p, &data).map_err(|e| format!("保存模板失败: {e}"))
}

/// 选择模板 PDF：弹系统文件对话框选模板，自动复制到所选文件夹/template/ 并返回相对路径
#[tauri::command]
pub fn pick_template(app: tauri::AppHandle, folder: String) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .blocking_pick_file();
    let Some(path) = picked else { return Ok(None); };
    let Some(p) = path.as_path() else { return Ok(None); };
    let tdir = std::path::Path::new(&folder).join("template");
    std::fs::create_dir_all(&tdir).map_err(|e| format!("创建 template 目录失败: {e}"))?;
    let fname = p
        .file_name()
        .ok_or("模板文件名无效")?
        .to_string_lossy()
        .into_owned();
    let dst = tdir.join(&fname);
    std::fs::copy(p, &dst).map_err(|e| format!("复制模板失败: {e}"))?;
    Ok(Some(format!("template/{}", fname)))
}

/// 追加调试日志到系统临时目录（用于定位运行期问题）
#[tauri::command]
pub fn append_log(line: String) -> Result<(), String> {    use std::io::Write;
    let path = std::env::temp_dir().join("report_grader_debug.log");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开日志失败: {e}"))?;
    writeln!(f, "{}", line).map_err(|e| format!("写日志失败: {e}"))
}

/// 保存批次评分项模板（固化：题名/满分/统分区等）
#[tauri::command]
pub fn save_batch_items(folder: String, items: Vec<db::BatchItem>) -> Result<(), String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("当前文件夹尚未初始化批次")?;
    db::save_batch_items(&conn, bid, &items)
}

/// 读取批次评分项模板
#[tauri::command]
pub fn get_batch_items(folder: String) -> Result<Vec<db::BatchItem>, String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("当前文件夹尚未初始化批次")?;
    db::get_batch_items(&conn, bid)
}

/// 检测 template/ 目录下第一个 PDF 模板文件（相对路径或 null）
#[tauri::command]
pub fn get_template_path(folder: String) -> Result<Option<String>, String> {
    let tpl_dir = Path::new(&folder).join(db::TEMPLATE_DIR);
    if !tpl_dir.exists() { return Ok(None); }
    let mut names: Vec<String> = fs::read_dir(&tpl_dir)
        .map_err(|e| format!("读取 template 目录失败: {e}"))?
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().map(|x| x.to_string_lossy().to_lowercase()) == Some("pdf".into()) {
                Some(p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
            } else { None }
        })
        .collect();
    names.sort();
    Ok(names.first().map(|n| format!("{}/{}", db::TEMPLATE_DIR, n)))
}

#[tauri::command]
pub fn ocr_image(app: tauri::AppHandle, bytes: Vec<u8>) -> Result<String, String> {
    let res = app.path().resource_dir().map_err(|e| e.to_string())?;
    let tess_path = res.join("chi_sim.traineddata");
    if !tess_path.exists() {
        return Err(format!("未找到 OCR 语言包: {}", tess_path.display()));
    }
    let mut lt = leptess::LepTess::new(Some(&res), Some("chi_sim"))
        .map_err(|e| format!("初始化 OCR 失败: {e}"))?;
    let _ = lt.set_variable("tessedit_pageseg_mode", "6");
    lt.set_image_from_mem(&bytes).map_err(|e| format!("读取图片失败: {e}"))?;
    let txt = lt.get_utf8_text().map_err(|e| format!("识别失败: {e}"))?;
    Ok(txt.trim().to_string())
}
