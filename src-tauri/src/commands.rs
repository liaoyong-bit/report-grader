// Tauri 命令层：前端经 tauri-bridge 调用的全部后端能力
use crate::{db, scan};
use rusqlite::params;
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

/// 用系统默认程序打开指定文件。path 支持三种形式：
/// ① 绝对路径（直接打开）② 相对报告文件夹（base 为空）③ 相对导出位置（base 指定）。
/// 此前用 `cmd /C start "" "path"`——Rust 传参转义引号后 cmd 无法识别，导致"Windows 找不到文件"；
/// 改用 explorer 直接打开（explorer <文件> 会用默认关联程序打开）。
#[tauri::command]
pub fn open_external(folder: String, path: String, base: Option<String>) -> Result<(), String> {
    let root = match base.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(b) => std::path::PathBuf::from(b),
        None => std::path::PathBuf::from(&folder),
    };
    let p = Path::new(&path);
    let full = if p.is_absolute() { p.to_path_buf() } else { root.join(&path) };
    if !full.exists() { return Err(format!("文件不存在: {}", full.to_string_lossy())); }
    let target = full.to_string_lossy().into_owned();
    match std::process::Command::new("explorer").arg(&target).spawn() {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("打开失败: {e}")),
    }
}

/// 准备盘点：状态总表数据（挂靠/新增/批改状态）+ 缺交名单
#[tauri::command]
pub fn prep_overview(folder: String) -> Result<db::PrepOverview, String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("当前文件夹尚未初始化批次")?;
    db::prep_overview(&conn, bid)
}

/// 读取持久化的批改范围（进入批改面板时调用）
#[tauri::command]
pub fn get_grading_scope(folder: String) -> Result<(Option<String>, Vec<String>), String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("当前文件夹尚未初始化批次")?;
    db::get_scope(&conn, bid)
}

/// 保存批改范围（批改范围确定时调用）
#[tauri::command]
pub fn save_grading_scope(folder: String, range: String, selected: Vec<String>) -> Result<(), String> {
    let conn = db::open(&folder)?;
    let bid = db::get_or_create_batch(&conn, "", "")?;
    db::save_scope(&conn, bid, &range, &selected)
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

/// 标记错误报告（交错）：原始文件留在原处不动，立即清空全部成绩与批阅信息，
/// 删除 renamed/ 中的改名副本，状态置 excluded —— 不再出现在成绩表/改名包/带批阅痕迹导出中。
#[tauri::command]
pub fn mark_report_bad(folder: String, report_key: String) -> Result<(), String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("未找到批次")?;
    let rid = db::report_id_by_key(&conn, bid, &report_key)?.ok_or("未找到报告")?;
    let rnp: String = conn
        .query_row("SELECT renamed_path FROM reports WHERE id=?1", params![rid], |r| r.get(0))
        .map_err(|e| format!("读取改名路径失败: {e}"))?;
    if !rnp.trim().is_empty() {
        let p = Path::new(&folder).join(&rnp);
        if p.exists() { let _ = fs::remove_file(&p); }   // 删除改名副本（best-effort）
    }
    conn.execute("DELETE FROM report_items WHERE report_id=?1", params![rid])
        .map_err(|e| format!("清空题项成绩失败: {e}"))?;
    conn.execute(
        "UPDATE reports SET match_status='excluded', renamed_path='', draft='{}', final_scores='{}', \
         teacher='', submit_status='pending', submitted_at=NULL, updated_at=datetime('now','localtime') WHERE id=?1",
        params![rid],
    )
    .map_err(|e| format!("更新报告状态失败: {e}"))?;
    dbglog(&format!("mark_report_bad key={report_key} rid={rid} cleared+excluded"));
    Ok(())
}

/// 核对前处理：把原始文件夹【顶层】的 Word 文档(.doc/.docx)转成同名文字版 PDF，仍放在原始文件夹。
/// **幂等**：同名 PDF 已存在则跳过（此前转换过就不重复转换）；跳过 ~$ 临时锁文件。
/// 走本机 Office COM（Word → KWPS → WPS 依次兜底），路径经环境变量传给 PowerShell，避免中文命令行编码问题。
/// 返回 (新生成的 PDF 文件名, 因已存在而跳过的 Word 名)。
#[tauri::command]
pub async fn convert_word_docs(folder: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || convert_word_docs_impl(&folder))
        .await
        .map_err(|e| format!("Word 转换任务失败: {e}"))?
}

const WORD_CONVERT_SCRIPT: &str = "\
$ErrorActionPreference='Stop'; \
$w=$null; \
foreach($prog in @('Word.Application','KWPS.Application','Wps.Application')){ \
  try { $w = New-Object -ComObject $prog; break } catch { } \
}; \
if (-not $w) { Write-Output 'NO_ENGINE'; exit 2 }; \
try { $w.Visible=$false } catch { }; \
try { $w.DisplayAlerts=0 } catch { }; \
$src=$env:RG_WORD_SRC; $dst=$env:RG_WORD_DST; \
try { \
  $d = $w.Documents.Open($src, $false, $true); \
  $d.SaveAs([ref]$dst, [ref]17); \
  $d.Close($false); \
  Write-Output 'OK' \
} finally { $w.Quit() }";

fn convert_word_docs_impl(folder: &str) -> Result<serde_json::Value, String> {
    let dir = Path::new(folder);
    if !dir.is_dir() { return Err("报告文件夹无效".into()); }
    // 收集顶层 Word 文档（跳过 ~$ 锁文件），按名排序保证稳定
    let mut docs: Vec<PathBuf> = Vec::new();
    for e in fs::read_dir(dir).map_err(|e| format!("读目录失败: {e}"))?.flatten() {
        let p = e.path();
        if !p.is_file() { continue; }
        let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        if ext != "doc" && ext != "docx" { continue; }
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if name.starts_with("~$") { continue; }   // Word/WPS 打开时产生的临时锁文件
        docs.push(p);
    }
    docs.sort();
    let mut converted: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for p in docs {
        let stem = p.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if stem.is_empty() { continue; }
        let dst = dir.join(format!("{stem}.pdf"));
        // —— 幂等核心：已有同名 PDF（此前转换过）→ 跳过，不再调用 Office
        if dst.exists() {
            skipped.push(format!("{stem}.pdf"));
            dbglog(&format!("convert_word_docs 跳过(已存在同名PDF) {stem}.pdf"));
            continue;
        }
        let child = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WORD_CONVERT_SCRIPT])
            .env("RG_WORD_SRC", &p)
            .env("RG_WORD_DST", &dst)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => { failed.push(stem.clone()); dbglog(&format!("convert_word_docs 启动 powershell 失败 {stem}: {e}")); continue; }
        };
        // 单份最长等 180s，超时杀掉，避免 Word 弹框卡死流程
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
        let mut timed_out = false;
        loop {
            match child.try_wait() {
                Ok(Some(_status)) => break,
                Ok(None) => {
                    if std::time::Instant::now() > deadline { let _ = child.kill(); timed_out = true; break; }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                Err(e) => { dbglog(&format!("convert_word_docs 等待失败 {stem}: {e}")); break; }
            }
        }
        let mut so = String::new(); let mut se = String::new();
        if let Some(mut o) = child.stdout.take() { use std::io::Read; let _ = o.read_to_string(&mut so); }
        if let Some(mut e) = child.stderr.take() { use std::io::Read; let _ = e.read_to_string(&mut se); }
        if dst.exists() {
            converted.push(format!("{stem}.pdf"));
            dbglog(&format!("convert_word_docs 转换成功 {stem}.pdf"));
        } else {
            failed.push(stem.clone());
            dbglog(&format!("convert_word_docs 转换失败 {stem}: timeout={timed_out} stdout={} stderr={}", so.trim(), se.trim()));
        }
    }
    dbglog(&format!("convert_word_docs 完成: 转换 {} / 跳过 {} / 失败 {}", converted.len(), skipped.len(), failed.len()));
    Ok(serde_json::json!({ "converted": converted, "skipped": skipped, "failed": failed }))
}

/// 导出产物写入输出目录（name 支持 "子目录/文件名.pdf"，逐段清洗防目录穿越；
/// base 为空时写入 报告文件夹/output/，否则写入用户指定的导出位置）
#[tauri::command]
pub fn save_to_output(folder: String, name: String, data: Vec<u8>, base: Option<String>) -> Result<String, String> {
    let out_dir = match base.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(b) => std::path::PathBuf::from(b),
        None => Path::new(&folder).join(db::OUTPUT_DIR),
    };
    let rel: std::path::PathBuf = name
        .split(['/', '\\'])
        .filter(|seg| !seg.is_empty() && *seg != "." && *seg != "..")
        .map(|seg| {
            let safe: String = seg
                .chars()
                .map(|c| if ":*?\"<>|".contains(c) { '_' } else { c })
                .collect();
            std::path::PathBuf::from(safe)
        })
        .fold(std::path::PathBuf::new(), |acc, p| acc.join(p));
    if rel.as_os_str().is_empty() { return Err("非法的导出文件名".into()); }
    let path = out_dir.join(&rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建导出目录失败: {e}"))?;
    }
    fs::write(&path, &data).map_err(|e| format!("写入输出失败: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 读取系统中文字体（白名单，仅 .ttf 单字体文件，pdf-lib 可嵌入），供导出批注用
#[tauri::command]
pub fn read_font(name: String) -> Result<Vec<u8>, String> {
    const ALLOW: [&str; 4] = ["simhei.ttf", "simfang.ttf", "simkai.ttf", "stkaiti.ttf"];
    if !ALLOW.contains(&name.to_lowercase().as_str()) {
        return Err(format!("不支持的字体: {name}"));
    }
    let win = std::env::var("windir").unwrap_or_else(|_| "C:\\Windows".to_string());
    let p = Path::new(&win).join("Fonts").join(&name);
    fs::read(&p).map_err(|e| format!("读取字体失败({name}): {e}"))
}

/// 将 renamed/ 目录下所有改名报告打包为一个 ZIP，写入导出位置（base 为空=报告文件夹/output/）
#[tauri::command]
pub fn pack_renamed_zip(folder: String, base: Option<String>) -> Result<String, String> {
    pack_dir_zip_impl(&folder, db::RENAME_DIR, "改名文件包.zip", base.as_deref().map(str::trim).filter(|s| !s.is_empty()), false)
}

/// 通用子目录打包：sub 相对【导出位置】（save_to_output 写出的产物目录，如 "带批阅痕迹"），
/// 打包为 导出位置/<zip_name>
#[tauri::command]
pub fn pack_dir_zip(folder: String, sub: String, zip_name: String, base: Option<String>) -> Result<String, String> {
    pack_dir_zip_impl(&folder, &sub, &zip_name, base.as_deref().map(str::trim).filter(|s| !s.is_empty()), true)
}

fn pack_dir_zip_impl(folder: &str, sub: &str, zip_name: &str, base: Option<&str>, sub_in_base: bool) -> Result<String, String> {
    let out_dir = match base {
        Some(b) if !b.is_empty() => std::path::PathBuf::from(b),
        _ => Path::new(folder).join(db::OUTPUT_DIR),
    };
    // sub_in_base=true：sub 相对导出位置（导出产物目录）；false：sub 相对报告文件夹（renamed/）
    let src = if sub_in_base { out_dir.join(sub) } else { Path::new(folder).join(sub) };
    if !src.exists() { return Err(format!("目录不存在: {sub}，请先执行相应步骤")); }
    fs::create_dir_all(&out_dir).map_err(|e| format!("创建输出目录失败: {e}"))?;
    let safe_zip: String = zip_name.chars().map(|c| if ":*?\"<>|".contains(c) { '_' } else { c }).collect();
    let out_path = out_dir.join(&safe_zip);
    let f = fs::File::create(&out_path).map_err(|e| format!("创建 zip 失败: {e}"))?;
    let mut zw = zip::ZipWriter::new(f);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut count = 0i32;
    let mut total = 0u64;
    for entry in fs::read_dir(&src).map_err(|e| format!("读取目录 {sub} 失败: {e}"))? {
        let ent = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        let p = ent.path();
        if !p.is_file() { continue; }
        let fname = ent.file_name().to_string_lossy().into_owned();
        zw.start_file(&fname, opts).map_err(|e| format!("写入 zip 条目失败: {e}"))?;
        let mut fp = fs::File::open(&p).map_err(|e| format!("打开文件失败: {e}"))?;
        let n = std::io::copy(&mut fp, &mut zw).map_err(|e| format!("写入 zip 失败: {e}"))?;
        total += n;
        count += 1;
    }
    zw.finish().map_err(|e| format!("完成 zip 失败: {e}"))?;
    dbglog(&format!("pack_dir_zip sub={sub} count={count} total={total} -> {}", out_path.to_string_lossy()));
    Ok(format!("已打包 {count} 份 → {}", out_path.to_string_lossy()))
}

/* —— 【已停用】保存一份报告的扫描结构数据（表结构识别产物：横线/竖线/格子/文字行）
   按新需求改为"文字分块 + 逐块 OCR"，该命令不再由前端调用；代码保留，暂不删除。
#[tauri::command]
pub fn scan_save_struct(folder: String, report_key: String, pages: Vec<db::ScanPage>) -> Result<i64, String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.map(|b| b.0).ok_or("未找到批次")?;
    let rid = db::report_id_by_key(&conn, bid, &report_key)?.ok_or("未找到报告")?;
    let n = db::save_pdf_scan(&conn, bid, rid, &report_key, &pages)?;
    dbglog(&format!("scan_save_struct report={} pages={} scan_id={}", report_key, pages.len(), n));
    Ok(n)
}
*/

// ==================== 扫描文字块（表结构识别已停用，改为"文字分块 + 逐块 OCR"） ====================
/// 重置文字块表：清空并重置自增 id（每份报告扫描前调用一次）
#[tauri::command]
pub fn block_reset(folder: String) -> Result<(), String> {
    let conn = db::open_locate(&folder)?;
    db::block_reset(&conn)
}

/// 写入一份报告的全部文字块：先清空该报告旧块，逐块插入并返回全局唯一 KEY(id) 列表（与传入 rows 顺序一致）
#[tauri::command]
pub fn block_init(folder: String, report_key: String, rows: Vec<serde_json::Value>) -> Result<Vec<i64>, String> {
    let conn = db::open_locate(&folder)?;
    db::block_clear(&conn, &report_key)?;
    let mut ids = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        let page = r.get("pageIndex").and_then(|v| v.as_i64()).unwrap_or(0);
        let seq = r.get("seq").and_then(|v| v.as_i64()).unwrap_or(i as i64);
        let top = r.get("top").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let bottom = r.get("bottom").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let left = r.get("left").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let right = r.get("right").and_then(|v| v.as_f64()).unwrap_or(1.0);
        let id = db::block_insert(&conn, &report_key, page, seq, top, bottom, left, right)?;
        ids.push(id);
    }
    dbglog(&format!("block_init key={report_key} blocks={}", ids.len()));
    Ok(ids)
}

/// 按 KEY(id) 写回某块的 OCR 识别结果
#[tauri::command]
pub fn block_set_ocr(folder: String, id: i64, text: String) -> Result<(), String> {
    let conn = db::open_locate(&folder)?;
    let r = db::block_set_ocr(&conn, id, &text);
    if let Err(ref e) = r { dbglog(&format!("block_set_ocr id={id} ERR={e}")); }
    r
}

/// 读取某份报告全部文字块（KEY/页码/序号/位置比例/OCR 文本），供预览渲染
#[tauri::command]
pub fn block_get_rows(folder: String, report_key: String) -> Result<Vec<serde_json::Value>, String> {
    let conn = db::open_locate(&folder)?;
    let r = db::block_rows(&conn, &report_key);
    match &r {
        Ok(rows) => dbglog(&format!("block_get_rows key={report_key} rows={}", rows.len())),
        Err(e) => dbglog(&format!("block_get_rows key={report_key} ERR={e}")),
    }
    r
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

// ==================== 独立定位库(locate.sqlite) ====================
/// 重置定位库：清空全部行并重置自增 id（每次定位前调用，避免数据膨胀）
#[tauri::command]
pub fn locate_reset(folder: String) -> Result<(), String> {
    let conn = db::open_locate(&folder)?;
    db::locate_reset(&conn)
}

/// 初始化某份报告的扫描行：先清空旧行，逐行入库并返回全局唯一 KEY(id) 列表(与传入 rows 顺序对应)
#[tauri::command]
pub fn locate_init(folder: String, report_key: String, rows: Vec<serde_json::Value>) -> Result<Vec<i64>, String> {
    let conn = db::open_locate(&folder)?;
    db::locate_clear(&conn, &report_key)?;
    let mut ids = Vec::new();
    for r in rows {
        let page = r.get("pageIndex").and_then(|v| v.as_i64()).unwrap_or(0);
        let top = r.get("top").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let bottom = r.get("bottom").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let left = r.get("left").and_then(|v| v.as_f64()).unwrap_or(0.02);
        let right = r.get("right").and_then(|v| v.as_f64()).unwrap_or(0.98);
        let cell = r.get("cell").and_then(|v| v.as_str()).unwrap_or("{}");
        let id = db::locate_insert(&conn, &report_key, page, top, bottom, left, right, cell)?;
        ids.push(id);
    }
    dbglog(&format!("locate_init key={report_key} rows={}", ids.len()));
    Ok(ids)
}

/// 逐行写回 OCR 识别结果(绑定 KEY=id)
#[tauri::command]
pub fn locate_set_ocr(folder: String, id: i64, text: String) -> Result<(), String> {
    let conn = db::open_locate(&folder)?;
    let r = db::locate_set_ocr(&conn, id, &text);
    if let Err(ref e) = r { dbglog(&format!("locate_set_ocr id={id} ERR={e}")); }
    r
}

/// 记录某行匹配到的题目索引(绑定 KEY=id)
#[tauri::command]
pub fn locate_set_match(folder: String, id: i64, item_index: i64) -> Result<(), String> {
    let conn = db::open_locate(&folder)?;
    let r = db::locate_set_match(&conn, id, item_index);
    if let Err(ref e) = r { dbglog(&format!("locate_set_match id={id} ERR={e}")); }
    r
}

/// 读取某份报告全部定位行(含 KEY、页码、m-n 位置、OCR 文本、匹配结果)，供渲染与取位置
#[tauri::command]
pub fn locate_get_rows(folder: String, report_key: String) -> Result<Vec<serde_json::Value>, String> {
    let conn = db::open_locate(&folder)?;
    let r = db::locate_rows(&conn, &report_key);
    match &r {
        Ok(rows) => dbglog(&format!("locate_get_rows key={report_key} rows={}", rows.len())),
        Err(e) => dbglog(&format!("locate_get_rows key={report_key} ERR={e}")),
    }
    r
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

// —— Windows 自带 OCR（Windows.Media.Ocr）识别图片中的文字（engine="paddle" 时改用 PaddleOCR）
#[tauri::command]
pub async fn ocr_image_b64(b64: String, engine: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if engine.as_deref() == Some("paddle") { paddle_ocr_text(&b64) } else { ocr_b64_impl(&b64) }
    })
    .await
    .map_err(|e| format!("OCR 任务失败: {e}"))?
}

// 临时文件名：进程ID + 原子递增序号 + 纳秒时间戳，保证多路并发调用互不覆盖
// （此前固定文件名 rg_ocr_tmp.png 在前端 4 路并发 OCR 时互相覆盖，导致不同块识别出相同文本、
//   甚至文件被先完成的调用删除后读取失败返回空文本）
static OCR_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn unique_ocr_tmp(tag: &str) -> std::path::PathBuf {
    let n = OCR_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("rg_ocr_{}_{}_{}_{}.png", tag, std::process::id(), n, t))
}

fn ocr_b64_impl(b64: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let tmp = unique_ocr_tmp("txt");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写临时图片失败: {e}"))?;
    let r = ocr_file_with_com(&tmp.to_string_lossy());
    let _ = std::fs::remove_file(&tmp);
    r
}

// ============ OCR 带坐标（行级）—— 供扫描版标题定位 ============
/// 识别整图并返回"行"列表 [{text, top(距顶0-1), left(距左0-1)}]，top/left 相对图片宽高归一化
#[tauri::command]
pub async fn ocr_image_b64_words(b64: String, engine: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if engine.as_deref() == Some("paddle") { paddle_ocr_words(&b64) } else { ocr_words_impl(&b64) }
    })
    .await
    .map_err(|e| format!("OCR 任务失败: {e}"))?
}
fn ocr_words_impl(b64: &str) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let tmp = unique_ocr_tmp("words");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写临时图片失败: {e}"))?;
    let r = ocr_words_with_com(&tmp.to_string_lossy());
    let _ = std::fs::remove_file(&tmp);
    r
}

// ==================== PaddleOCR（oar-ocr 本地 ONNX 推理，可选引擎）====================
// 引擎构建一次常驻；模型经 auto-download 特性在首次使用时从 ModelScope 下载到 ~/.oar（需联网一次，之后离线可用）。
type PaddleEngine = oar_ocr::oarocr::ocr::OAROCR;
static PADDLE_OCR: std::sync::OnceLock<Result<PaddleEngine, String>> = std::sync::OnceLock::new();

fn paddle_engine() -> Result<&'static PaddleEngine, String> {
    let r = PADDLE_OCR.get_or_init(|| {
        // PP-OCRv5 mobile 三件套（裸文件名经 auto-download 从 ModelScope 取到 ~/.oar，校验 SHA-256）
        match oar_ocr::oarocr::OAROCRBuilder::new(
            "pp-ocrv5_mobile_det.onnx",
            "pp-ocrv5_mobile_rec.onnx",
            "ppocrv5_dict.txt",
        ).build() {
            Ok(e) => Ok(e),
            Err(e) => Err(format!("PaddleOCR 初始化失败（首次使用需联网自动下载模型；失败请重启应用重试）: {e}")),
        }
    });
    r.as_ref().map_err(|e| e.clone())
}

/// PaddleOCR 公共流程：base64 → 临时图片 → 推理 → [(文本, 置信度, left0-1, top0-1, right0-1, bottom0-1)]
fn paddle_ocr_regions(b64: &str) -> Result<Vec<(String, f32, f32, f32, f32, f32)>, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let (iw, ih) = {
        let dim = image::load_from_memory(&bytes).map_err(|e| format!("图片解码失败: {e}"))?;
        (dim.width() as f32, dim.height() as f32)
    };
    if iw <= 0.0 || ih <= 0.0 { return Err("图片尺寸无效".into()); }
    let tmp = unique_ocr_tmp("paddle");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写临时图片失败: {e}"))?;
    let eng = paddle_engine()?;
    let img = oar_ocr::utils::load_image(&tmp).map_err(|e| format!("读图失败: {e}"))?;
    let _ = std::fs::remove_file(&tmp);
    let results = eng.predict(vec![img]).map_err(|e| format!("PaddleOCR 推理失败: {e}"))?;
    let mut out = Vec::new();
    if let Some(r) = results.first() {
        for reg in &r.text_regions {
            let (text, conf) = match reg.text_with_confidence() { Some(v) => v, None => continue };
            let bb = &reg.bounding_box;
            out.push((text.to_string(), conf, bb.x_min()/iw, bb.y_min()/ih, bb.x_max()/iw, bb.y_max()/ih));
        }
    }
    Ok(out)
}

/// 全文模式：与 Windows OCR res.Text() 对齐（行间 \r\n）
fn paddle_ocr_text(b64: &str) -> Result<String, String> {
    let mut regs = paddle_ocr_regions(b64)?;
    regs.sort_by(|a, b| a.3.partial_cmp(&b.3).unwrap_or(std::cmp::Ordering::Equal));
    Ok(regs.into_iter().map(|r| r.0).collect::<Vec<_>>().join("\r\n"))
}

/// 行级模式：[{text, top(距顶0-1), left(距左0-1)}]，与 ocr_words_file 输出同构
fn paddle_ocr_words(b64: &str) -> Result<serde_json::Value, String> {
    let regs = paddle_ocr_regions(b64)?;
    let lines: Vec<serde_json::Value> = regs.into_iter()
        .map(|r| serde_json::json!({ "text": r.0, "top": r.3, "left": r.2 }))
        .collect();
    Ok(serde_json::json!(lines))
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
        let mut right_max = f32::MIN;
        let mut row_h = 0.0f32;
        for w in line.Words().map_err(|e| format!("读取词失败: {e}"))? {
            let wr = w.BoundingRect().map_err(|e| format!("读取词框失败: {e}"))?;
            if wr.Y < top_min { top_min = wr.Y; }
            if wr.X < left_min { left_min = wr.X; }
            let wrr = wr.X + wr.Width;
            if wrr > right_max { right_max = wrr; }
            if wr.Height > row_h { row_h = wr.Height; }
            text.push_str(&w.Text().map_err(|e| format!("读取词文本失败: {e}"))?.to_string());
        }
        if text.trim().is_empty() { continue; }
        let top = if ph > 0.0 && top_min != f32::MAX { top_min / ph } else { 0.0 };
        let left = if pw > 0.0 && left_min != f32::MAX { left_min / pw } else { 0.0 };
        let right = if pw > 0.0 && right_max != f32::MIN { right_max / pw } else { left };
        let height = if ph > 0.0 && row_h > 0.0 { row_h / ph } else { 0.0 };
        out.push(serde_json::json!({"text": text, "top": top, "left": left, "right": right, "height": height}));
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

/// 对已挂靠(matched)且尚未改名的报告生成改名版：用名单的 学号_姓名_班级_报告名称 构造文件名，
/// 复制原始 PDF 到 renamed/ 下并写库（不改动原始文件）。返回本次改名份数。
#[tauri::command]
pub fn apply_renames(folder: String) -> Result<i32, String> {
    let conn = db::open(&folder)?;
    let bid = db::find_batch_by_folder(&conn)?.ok_or("当前文件夹尚未初始化批次")?.0;
    let rdir = Path::new(&folder).join(db::RENAME_DIR);
    fs::create_dir_all(&rdir).map_err(|e| format!("创建 renamed 目录失败: {e}"))?;
    let mut st = conn
        .prepare(
            "SELECT r.id, r.source_path, r.report_name, r.orig_name,
                    COALESCE(s.student_no,''), COALESCE(s.name,''), COALESCE(s.class,'')
             FROM reports r LEFT JOIN students s ON s.id=r.student_id
             WHERE r.batch_id=?1 AND r.match_status='matched' AND r.renamed_path=''",
        )
        .map_err(|e| format!("准备改名查询失败: {e}"))?;
    let rows = st
        .query_map(params![bid], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(|e| format!("读取改名清单失败: {e}"))?;
    let mut n = 0i32;
    for row in rows {
        let (rid, src, rn, orig, no, name, cls) = row.map_err(|e| format!("解析改名清单失败: {e}"))?;
        let exp = if rn.trim().is_empty() { orig.trim_end_matches(".pdf").to_string() } else { rn };
        let raw = format!("{}_{}_{}_{}.pdf", no, name, cls, exp);
        let fname: String = raw
            .chars()
            .map(|c| if "\\/:*?\"<>| ".contains(c) { '_' } else { c })
            .collect();
        if fname.trim().is_empty() { continue; }
        // 防覆盖：同一学生多份报告（文字版+扫描版）命名相同，直接 copy 会互相覆盖 → 追加 _2/_3
        let fname = crate::scan::unique_rename_name(&conn, bid, &fname, &rdir, Some(rid));
        let dst = rdir.join(&fname);
        let src_full = Path::new(&folder).join(&src);
        if src_full.exists() {
            fs::copy(&src_full, &dst).map_err(|e| format!("复制改名文件失败 {}: {e}", fname))?;
        }
        let rel = format!("{}/{}", db::RENAME_DIR, fname);
        db::set_renamed(&conn, rid, &rel).map_err(|e| format!("写改名库失败: {e}"))?;
        n += 1;
    }
    // 自愈：历史遗留的多份报告共用同一 renamed_path（旧版覆盖产物）→ 从源文件补唯一改名版
    let _ = crate::scan::repair_renamed(&conn, Path::new(&folder), bid);
    dbglog(&format!("apply_renames 改名 {} 份", n));
    Ok(n)
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