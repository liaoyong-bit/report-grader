// Tauri 命令层：前端经 tauri-bridge 调用的全部后端能力
use crate::{db, scan};
use serde::Serialize;
use std::fs;
use std::path::Path;
use tauri_plugin_dialog::DialogExt;

/// 追加一行到调试日志（与前端 append_log 同一文件，便于统一诊断）
fn dbglog(s: &str) {
    use std::io::Write;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) % 86400;
    let line = format!("[{:02}:{:02}:{:02}] RUST {s}", secs/3600, (secs/60)%60, secs%60);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true)
        .open(std::env::temp_dir().join("report_grader_debug.log")) {
        let _ = writeln!(f, "{line}");
    }
}

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
    db::delete_students(&conn, bid)?;   // 重新导入：先清旧名单再写新，避免残留
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

/// 用系统默认程序打开指定文件（挂靠时查看原始报告）
#[tauri::command]
pub fn open_external(folder: String, path: String) -> Result<(), String> {
    let full = Path::new(&folder).join(&path);
    let p = full.to_string_lossy().into_owned();
    let quoted = format!("\"{}\"", p);
    let _ = std::process::Command::new("cmd").args(["/C", "start", "", &quoted]).spawn();
    Ok(())
}

/// 准备盘点：状态总表数据（挂靠/新增/批改状态）+ 缺交名单
#[tauri::command]
pub fn prep_overview(folder: String) -> Result<db::PrepOverview, String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("当前文件夹尚未初始化批次")?;
    db::prep_overview(&conn, bid)
}

/// 名单列表（挂靠下拉用）
#[tauri::command]
pub fn get_roster(folder: String) -> Result<Vec<db::StudentIn>, String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("当前文件夹尚未初始化批次")?;
    let sts = db::get_students(&conn, bid)?;
    Ok(sts.into_iter().map(|s| db::StudentIn { no: s.no, name: s.name, cls: s.cls, report_name: s.report_name }).collect())
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
    let teacher = snapshot.get("teacher").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let json = serde_json::to_string(&snapshot).map_err(|e| format!("序列化失败: {e}"))?;
    dbglog(&format!("save_grading_state key={report_key} done={done} json_len={}", json.len()));
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("未找到批次")?;
    let rid = match db::report_id_by_key(&conn, bid, &report_key) {
        Ok(Some(id)) => id,
        Ok(None) => { dbglog(&format!("  !save 未找到报告 key={report_key}")); return Err("未找到报告".into()); }
        Err(e) => { dbglog(&format!("  !report_id_by_key err={e}")); return Err(format!("定位报告失败: {e}")); }
    };
    let r = db::save_state(&conn, rid, &json, done, &teacher);
    match &r { Ok(_) => dbglog(&format!("  saved rid={rid} done={done} teacher={teacher}")), Err(e) => dbglog(&format!("  !save_state err={e}")) }
    r
}

/// 批改中标记某份报告为错误报告（交错），回退为 excluded，不计入批改/统计/导出
#[tauri::command]
pub fn mark_excluded(folder: String, report_key: String) -> Result<(), String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("未找到批次")?;
    let rid = db::report_id_by_key(&conn, bid, &report_key)?.ok_or("未找到报告")?;
    dbglog(&format!("mark_excluded key={report_key} rid={rid}"));
    db::mark_excluded(&conn, rid)
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
    let rows = db::list_all_grading(&conn, bid)?;
    for r in &rows {
        dbglog(&format!("list_all_grading no={} name={} status={} draft_len={}", r.no, r.name, r.status, r.draft.as_deref().map(str::len).unwrap_or(0)));
    }
    Ok(rows)
}

#[derive(Serialize)]
pub struct StudentOut {
    pub no: String,
    pub name: String,
    pub cls: String,
    pub report_name: String,
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
            .map(|s| StudentOut { no: s.no, name: s.name, cls: s.cls, report_name: s.report_name })
            .collect(),
    })
}

/// 把"名单 + 报告名称"写成 CSV 存到 source_files，供查看/迁移
/// 覆盖式：写入前删除 source_files 下旧的名单 CSV，保证同一文件夹只有一份最新名单
#[tauri::command]
pub fn save_roster(folder: String, report_name: String, students: Vec<db::StudentIn>) -> Result<String, String> {
    let src_dir = Path::new(&folder).join(db::SOURCE_DIR);
    fs::create_dir_all(&src_dir).map_err(|e| format!("创建 source_files 失败: {e}"))?;
    // 删除旧的 _名单_*.csv
    if let Ok(rd) = fs::read_dir(&src_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("_名单_") && name.ends_with(".csv") {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    let safe: String = report_name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let path = src_dir.join(format!("_名单_{}.csv", safe));
    let mut csv = String::from("\u{feff}学号,姓名,班级,报告名称\n");
    for s in &students {
        csv.push_str(&format!("{},{},{},{}\n", s.no, s.name, s.cls, s.report_name));
    }
    fs::write(&path, csv).map_err(|e| format!("写入名单失败: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 删库后从 source_files/ 名单 CSV 自动恢复名单并重建批次（有名单就自动摘录）
#[tauri::command]
pub fn recover_roster(folder: String, teacher: String) -> Result<Vec<db::StudentIn>, String> {
    let src_dir = Path::new(&folder).join(db::SOURCE_DIR);
    let mut csv_path: Option<std::path::PathBuf> = None;
    if let Ok(rd) = fs::read_dir(&src_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("_名单_") && name.ends_with(".csv") {
                csv_path = Some(e.path());
                break;
            }
        }
    }
    let path = csv_path.ok_or("source_files 中未找到名单文件（_名单_*.csv）")?;
    let content = fs::read_to_string(&path).map_err(|e| format!("读取名单失败: {e}"))?;
    let mut list: Vec<db::StudentIn> = Vec::new();
    for (idx, raw) in content.lines().enumerate() {
        if idx == 0 { continue; }   // 跳过表头
        let line = raw.trim_start_matches('\u{feff}').trim();
        if line.is_empty() { continue; }
        let p: Vec<&str> = line.split(',').collect();
        let no = p.get(0).unwrap_or(&"").trim().to_string();
        let name = p.get(1).unwrap_or(&"").trim().to_string();
        let cls = p.get(2).unwrap_or(&"").trim().to_string();
        let rn = p.get(3).unwrap_or(&"").trim().to_string();
        if no.is_empty() && name.is_empty() { continue; }
        list.push(db::StudentIn { no, name, cls, report_name: rn });
    }
    if list.is_empty() { return Err("名单文件内容为空".into()); }
    let conn = db::open(&folder)?;
    let bid = db::get_or_create_batch(&conn, &folder, &teacher)?;
    db::delete_students(&conn, bid)?;
    db::insert_students(&conn, bid, &list)?;
    dbglog(&format!("recover_roster 恢复名单 {} 人", list.len()));
    Ok(list)
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

/// 保存某份报告的标题定位结果（供下次复用）
#[tauri::command]
pub fn save_report_locate(folder: String, report_key: String, locate_json: String) -> Result<(), String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("未找到批次")?;
    let rid = db::report_id_by_key(&conn, bid, &report_key)?.ok_or("未找到报告")?;
    dbglog(&format!("save_report_locate key={report_key} len={}", locate_json.len()));
    db::save_report_locate(&conn, rid, &locate_json)
}

/// 读取某份报告的标题定位结果
#[tauri::command]
pub fn get_report_locate(folder: String, report_key: String) -> Result<Option<String>, String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("未找到批次")?;
    let rid = db::report_id_by_key(&conn, bid, &report_key)?.ok_or("未找到报告")?;
    db::get_report_locate(&conn, rid)
}

// ==================== 登录账号 ====================
fn hash_pwd(pwd: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(pwd.as_bytes());
    let d = h.finalize();
    d.iter().map(|b| format!("{:02x}", b)).collect()
}

fn open_users(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| format!("获取数据目录失败: {e}"))?;
    db::open_users_dir(&dir)
}

#[tauri::command]
pub fn create_user(app: tauri::AppHandle, username: String, name: String, password: String) -> Result<(), String> {
    let conn = open_users(&app)?;
    dbglog(&format!("create_user username={username} name={name}"));
    db::create_user(&conn, &username, &name, &hash_pwd(&password))
}

#[tauri::command]
pub fn login(app: tauri::AppHandle, username: String, password: String) -> Result<Option<String>, String> {
    let conn = open_users(&app)?;
    match db::find_user(&conn, &username)? {
        Some((name, h)) => {
            if h == hash_pwd(&password) { Ok(Some(name)) } else { Ok(None) }
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn change_password(app: tauri::AppHandle, username: String, old_password: String, new_password: String) -> Result<(), String> {
    let conn = open_users(&app)?;
    match db::find_user(&conn, &username)? {
        Some((_, h)) => {
            if h != hash_pwd(&old_password) { return Err("原密码不正确".into()); }
            db::update_password(&conn, &username, &hash_pwd(&new_password))
        }
        None => Err("账号不存在".into()),
    }
}

#[tauri::command]
pub fn list_users(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let conn = open_users(&app)?;
    db::list_users(&conn)
}

// ==================== 基本信息框选设置 ====================
#[tauri::command]
pub fn save_basic_fields(folder: String, fields: Vec<(String, i64, String)>) -> Result<(), String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("当前文件夹尚未初始化批次")?;
    db::save_basic_fields(&conn, bid, &fields)
}

#[tauri::command]
pub fn get_basic_fields(folder: String) -> Result<Vec<(String, i64, String)>, String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("当前文件夹尚未初始化批次")?;
    db::get_basic_fields(&conn, bid)
}

// ==================== 报告 OCR 识别结果 ====================
#[tauri::command]
pub fn save_report_ocr(folder: String, report_key: String, no: String, name: String, class: String, exp: String) -> Result<(), String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("未找到批次")?;
    let rid = db::report_id_by_key(&conn, bid, &report_key)?.ok_or("未找到报告")?;
    dbglog(&format!("save_report_ocr key={report_key} no={no} name={name} class={class} exp={exp}"));
    db::save_report_ocr(&conn, rid, &no, &name, &class, &exp)
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

// —— Windows 自带 OCR（Windows.Media.Ocr）识别图片中的文字
#[tauri::command]
pub async fn ocr_image_b64(b64: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ocr_b64_impl(&b64))
        .await
        .map_err(|e| format!("OCR 任务失败: {e}"))?
}

fn ocr_b64_impl(b64: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let tmp = std::env::temp_dir().join("rg_ocr_tmp.png");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写临时图片失败: {e}"))?;
    let r = ocr_file_with_com(&tmp.to_string_lossy());
    let _ = std::fs::remove_file(&tmp);
    r
}

// ============ OCR 带坐标（行级）—— 供扫描版标题定位 ============
/// 识别整图并返回"行"列表 [{text, top(距顶0-1), left(距左0-1)}]，top/left 相对图片宽高归一化
#[tauri::command]
pub async fn ocr_image_b64_words(b64: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || ocr_words_impl(&b64))
        .await
        .map_err(|e| format!("OCR 任务失败: {e}"))?
}
fn ocr_words_impl(b64: &str) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let tmp = std::env::temp_dir().join("rg_ocr_words_tmp.png");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写临时图片失败: {e}"))?;
    let r = ocr_words_with_com(&tmp.to_string_lossy());
    let _ = std::fs::remove_file(&tmp);
    r
}
fn ocr_words_with_com(path: &str) -> Result<serde_json::Value, String> {
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
    unsafe {
        if let Err(e) = RoInitialize(RO_INIT_MULTITHREADED) {
            return Err(format!("RoInitialize 失败: {e}"));
        }
    }
    let r = ocr_words_file(path);
    unsafe { RoUninitialize(); }
    r
}
fn ocr_words_file(path: &str) -> Result<serde_json::Value, String> {
    use windows::core::HSTRING;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Globalization::Language;
    let hpath = HSTRING::from(path);
    let mut diag = String::new();
    let engine = (|| -> Result<OcrEngine, String> {
        match OcrEngine::TryCreateFromUserProfileLanguages() {
            Ok(e) => return Ok(e),
            Err(e) => diag.push_str(&format!("用户语言引擎失败:{e}; ")),
        }
        for tag in ["zh-CN", "zh-Hans-CN", "zh-SG", "en-US", "zh-HK"] {
            match Language::CreateLanguage(&HSTRING::from(tag)) {
                Ok(l) => match OcrEngine::TryCreateFromLanguage(&l) {
                    Ok(e) => return Ok(e),
                    Err(e) => diag.push_str(&format!("{tag}:{e}; ")),
                },
                Err(e) => diag.push_str(&format!("CreateLanguage({tag}):{e}; ")),
            }
        }
        Err(format!("所有语言均无法创建 OCR 引擎。诊断:{diag}"))
    })()?;
    let file = StorageFile::GetFileFromPathAsync(&hpath)
        .map_err(|e| format!("打开文件失败: {e}"))?
        .get()
        .map_err(|e| format!("等待打开文件失败: {e}"))?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|e| format!("打开流失败: {e}"))?
        .get()
        .map_err(|e| format!("等待打开流失败: {e}"))?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| format!("创建解码器失败: {e}"))?
        .get()
        .map_err(|e| format!("等待解码器失败: {e}"))?;
    let bmp = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| format!("获取位图失败: {e}"))?
        .get()
        .map_err(|e| format!("等待位图失败: {e}"))?;
    let res = engine
        .RecognizeAsync(&bmp)
        .map_err(|e| format!("识别失败: {e}"))?
        .get()
        .map_err(|e| format!("等待识别失败: {e}"))?;
    let pw = bmp.PixelWidth().unwrap_or(0) as f32;
    let ph = bmp.PixelHeight().unwrap_or(0) as f32;
    let mut out: Vec<serde_json::Value> = Vec::new();
    for line in res.Lines().map_err(|e| format!("读取行失败: {e}"))? {
        let mut text = String::new();
        let mut top_min = f32::MAX;
        let mut left_min = f32::MAX;
        for w in line.Words().map_err(|e| format!("读取词失败: {e}"))? {
            let wr = w.BoundingRect().map_err(|e| format!("读取词框失败: {e}"))?;
            if wr.Y < top_min { top_min = wr.Y; }
            if wr.X < left_min { left_min = wr.X; }
            text.push_str(&w.Text().map_err(|e| format!("读取词文本失败: {e}"))?.to_string());
        }
        if text.trim().is_empty() { continue; }
        let top = if ph > 0.0 && top_min != f32::MAX { top_min / ph } else { 0.0 };
        let left = if pw > 0.0 && left_min != f32::MAX { left_min / pw } else { 0.0 };
        out.push(serde_json::json!({"text": text, "top": top, "left": left}));
    }
    Ok(serde_json::Value::Array(out))
}

/// 保存扫描版全文 OCR 还原文本到"扫描版识别"目录（每份报告一个 .txt，作为资产）
#[tauri::command]
pub fn save_scan_text(folder: String, name: String, text: String) -> Result<String, String> {
    let dir = Path::new(&folder).join("扫描版识别");
    fs::create_dir_all(&dir).map_err(|e| format!("创建扫描版识别目录失败: {e}"))?;
    let safe: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let path = dir.join(format!("{}.txt", safe));
    fs::write(&path, text).map_err(|e| format!("写入还原文本失败: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn ocr_file_with_com(path: &str) -> Result<String, String> {
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
    unsafe {
        if let Err(e) = RoInitialize(RO_INIT_MULTITHREADED) {
            return Err(format!("RoInitialize 失败: {e}"));
        }
    }
    let r = ocr_file(path);
    unsafe { RoUninitialize(); }
    r
}

fn ocr_file(path: &str) -> Result<String, String> {
    use windows::core::HSTRING;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Globalization::Language;
    let hpath = HSTRING::from(path);
    let mut diag = String::new();
    let engine = (|| -> Result<OcrEngine, String> {
        match OcrEngine::TryCreateFromUserProfileLanguages() {
            Ok(e) => return Ok(e),
            Err(e) => diag.push_str(&format!("用户语言引擎失败:{e}; ")),
        }
        for tag in ["zh-CN", "zh-Hans-CN", "zh-SG", "en-US", "zh-HK"] {
            match Language::CreateLanguage(&HSTRING::from(tag)) {
                Ok(l) => match OcrEngine::TryCreateFromLanguage(&l) {
                    Ok(e) => return Ok(e),
                    Err(e) => diag.push_str(&format!("{tag}:{e}; ")),
                },
                Err(e) => diag.push_str(&format!("CreateLanguage({tag}):{e}; ")),
            }
        }
        Err(format!("所有语言均无法创建 OCR 引擎。诊断:{diag}"))
    })()?;
    let file = StorageFile::GetFileFromPathAsync(&hpath)
        .map_err(|e| format!("打开文件失败: {e}"))?
        .get()
        .map_err(|e| format!("等待打开文件失败: {e}"))?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|e| format!("打开流失败: {e}"))?
        .get()
        .map_err(|e| format!("等待打开流失败: {e}"))?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| format!("创建解码器失败: {e}"))?
        .get()
        .map_err(|e| format!("等待解码器失败: {e}"))?;
    let bmp = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| format!("获取位图失败: {e}"))?
        .get()
        .map_err(|e| format!("等待位图失败: {e}"))?;
    let res = engine
        .RecognizeAsync(&bmp)
        .map_err(|e| format!("识别失败: {e}"))?
        .get()
        .map_err(|e| format!("等待识别失败: {e}"))?;
    let text = res.Text().map_err(|e| format!("读取识别文本失败: {e}"))?;
    Ok(text.to_string())
}