// 数据层：SQLite 四表（batches/students/reports/report_items）+ 目录常量
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value as Json;
use std::fs;
use std::path::Path;
pub const DATA_DIR: &str = "data";
pub const SOURCE_DIR: &str = "source_files";
pub const OUTPUT_DIR: &str = "output";
pub const RENAME_DIR: &str = "renamed";
pub const TEMPLATE_DIR: &str = "template";
pub const DB_NAME: &str = "grading.db";

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct StudentIn {
    pub no: String,
    pub name: String,
    #[serde(default)]
    pub cls: String,
    #[serde(default)]
    pub report_name: String,
}

#[derive(Clone)]
pub struct Student {
    pub id: i64,
    pub no: String,
    pub name: String,
    pub cls: String,
    pub report_name: String,
}

#[derive(Clone)]
pub struct ReportRec {
    pub id: i64,
    pub batch_id: i64,
    pub student_id: Option<i64>,
    pub source_path: String,
    pub renamed_path: String,
    pub orig_name: String,
    pub match_status: String,
    pub submit_status: String,
}

/// 打开（或创建）文件夹对应的数据库，并建好四表
pub fn open(folder: &str) -> Result<Connection, String> {
    let data_dir = Path::new(folder).join(DATA_DIR);
    fs::create_dir_all(&data_dir).map_err(|e| format!("创建 data 目录失败: {e}"))?;
    let conn = Connection::open(data_dir.join(DB_NAME))
        .map_err(|e| format!("打开数据库失败: {e}"))?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS batches(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             name TEXT NOT NULL,
             teacher TEXT DEFAULT '',
             created_at TEXT DEFAULT (datetime('now','localtime'))
         );
         CREATE TABLE IF NOT EXISTS students(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             batch_id INTEGER NOT NULL,
             student_no TEXT NOT NULL,
             name TEXT NOT NULL,
             class TEXT DEFAULT '',
             report_name TEXT DEFAULT '',
             UNIQUE(batch_id, student_no)
         );
         CREATE TABLE IF NOT EXISTS reports(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             batch_id INTEGER NOT NULL,
             student_id INTEGER,
             source_path TEXT DEFAULT '',
             renamed_path TEXT DEFAULT '',
             orig_name TEXT DEFAULT '',
             match_status TEXT DEFAULT 'matched',
             submit_status TEXT DEFAULT 'pending',
             draft TEXT DEFAULT '{}',
             final_scores TEXT DEFAULT '{}',
             teacher TEXT DEFAULT '',
             locate_json TEXT DEFAULT '{}',
             submitted_at TEXT,
             created_at TEXT DEFAULT (datetime('now','localtime')),
             updated_at TEXT DEFAULT (datetime('now','localtime'))
         );
         CREATE TABLE IF NOT EXISTS batch_items(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             batch_id INTEGER NOT NULL,
             item_index INTEGER NOT NULL,
             item_name TEXT NOT NULL,
             max_score INTEGER DEFAULT 0,
             score_page INTEGER DEFAULT 0,
             score_x REAL DEFAULT 0,
             title_rect TEXT DEFAULT '{}',
             total_region TEXT DEFAULT '{}',
             title_img TEXT DEFAULT '',
             UNIQUE(batch_id, item_index)
         );
         CREATE TABLE IF NOT EXISTS report_items(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             report_id INTEGER NOT NULL,
             item_index INTEGER NOT NULL,
             item_name TEXT DEFAULT '',
             max_score INTEGER DEFAULT 0,
             score INTEGER DEFAULT 0,
             activated INTEGER DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS users(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             username TEXT UNIQUE NOT NULL,
             name TEXT NOT NULL,
             pwd_hash TEXT NOT NULL,
             created_at TEXT DEFAULT (datetime('now','localtime'))
         );
         CREATE TABLE IF NOT EXISTS batch_basic_fields(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             batch_id INTEGER NOT NULL,
             field_type TEXT NOT NULL,
             page INTEGER DEFAULT 0,
             rect TEXT DEFAULT '{}',
             UNIQUE(batch_id, field_type)
         );
         CREATE TABLE IF NOT EXISTS batch_settings(
             batch_id INTEGER NOT NULL,
             s_key TEXT NOT NULL,
             s_value TEXT DEFAULT '',
             PRIMARY KEY(batch_id, s_key)
         );",
    )
    .map_err(|e| format!("建表失败: {e}"))?;
    // 迁移：老库补新增列（新库已含）
    ensure_column(&conn, "reports", "locate_json", "locate_json TEXT DEFAULT '{}'")?;
    ensure_column(&conn, "batch_items", "title_img", "title_img TEXT DEFAULT ''")?;
    ensure_column(&conn, "reports", "ocr_no", "ocr_no TEXT DEFAULT ''")?;
    ensure_column(&conn, "reports", "ocr_name", "ocr_name TEXT DEFAULT ''")?;
    ensure_column(&conn, "reports", "ocr_class", "ocr_class TEXT DEFAULT ''")?;
    ensure_column(&conn, "reports", "ocr_exp", "ocr_exp TEXT DEFAULT ''")?;
    ensure_column(&conn, "reports", "report_name", "report_name TEXT DEFAULT ''")?;
    ensure_column(&conn, "students", "report_name", "report_name TEXT DEFAULT ''")?;
    Ok(conn)
}

/// 若表缺少某列则 ALTER TABLE 补上（幂等迁移）
fn ensure_column(conn: &Connection, table: &str, col: &str, ddl: &str) -> Result<(), String> {
    let cnt: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name=?1"),
            [col],
            |r| r.get(0),
        )
        .map_err(|e| format!("检查列失败: {e}"))?;
    if cnt == 0 {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {ddl}"), [])
            .map(|_| ())
            .map_err(|e| format!("添加列 {table}.{col} 失败: {e}"))?;
    }
    Ok(())
}

/* ---------------- 批次 ---------------- */
pub fn get_or_create_batch(conn: &Connection, name: &str, teacher: &str) -> Result<i64, String> {
    // 同一文件夹只应有一个批次：若已存在则复用，避免重复导入名单时新建批次导致框选/评分项跟丢
    if let Some((id, _)) = find_batch_by_folder(conn)? {
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO batches(name, teacher) VALUES(?1, ?2)",
        params![name, teacher],
    )
    .map_err(|e| format!("创建批次失败: {e}"))?;
    Ok(conn.last_insert_rowid())
}

pub fn get_batch(conn: &Connection, id: i64) -> Result<Option<(i64, String)>, String> {
    conn.query_row(
        "SELECT id, name FROM batches WHERE id=?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| format!("查询批次失败: {e}"))
}

/// 返回某文件夹下已存在的批次（若数据库存在且至少一条批次）
pub fn find_batch_by_folder(conn: &Connection) -> Result<Option<(i64, String)>, String> {
    conn.query_row(
        "SELECT id, name FROM batches ORDER BY id DESC LIMIT 1",
        (),
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| format!("查询批次失败: {e}"))
}

/* ---------------- 批次设置（批改范围持久化） ---------------- */
/// 返回 (批改范围类型, select 模式勾选的报告 key 列表)
pub fn get_scope(conn: &Connection, batch_id: i64) -> Result<(Option<String>, Vec<String>), String> {
    let mut range: Option<String> = None;
    let mut selected: Vec<String> = Vec::new();
    {
        let mut st = conn
            .prepare("SELECT s_key, s_value FROM batch_settings WHERE batch_id=?1")
            .map_err(|e| format!("读设置失败: {e}"))?;
        let rows = st
            .query_map(params![batch_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| format!("读设置失败: {e}"))?;
        for row in rows {
            let (k, v) = row.map_err(|e| format!("解析设置失败: {e}"))?;
            if k == "grading_scope_range" {
                range = if v.trim().is_empty() { None } else { Some(v) };
            } else if k == "grading_scope_selected" && !v.trim().is_empty() {
                if let Ok(arr) = serde_json::from_str::<Vec<String>>(&v) { selected = arr; }
            }
        }
    }
    Ok((range, selected))
}

/// 保存批改范围（类型 + select 勾选列表）到数据库，供下次进入批改直接复用
pub fn save_scope(conn: &Connection, batch_id: i64, range: &str, selected: &[String]) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO batch_settings(batch_id, s_key, s_value) VALUES(?1,'grading_scope_range',?2)",
        params![batch_id, range],
    )
    .map_err(|e| format!("保存批改范围类型失败: {e}"))?;
    let js = serde_json::to_string(selected).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT OR REPLACE INTO batch_settings(batch_id, s_key, s_value) VALUES(?1,'grading_scope_selected',?2)",
        params![batch_id, js],
    )
    .map_err(|e| format!("保存批改范围选择失败: {e}"))?;
    Ok(())
}

/* ---------------- 学生 ---------------- */
// ==================== 登录账号（users） ====================
pub fn create_user(conn: &Connection, username: &str, name: &str, pwd_hash: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO users(username, name, pwd_hash) VALUES(?1,?2,?3)",
        params![username, name, pwd_hash],
    )
    .map(|_| ())
    .map_err(|e| format!("创建账号失败: {e}"))
}

/// 返回 (name, pwd_hash)
pub fn find_user(conn: &Connection, username: &str) -> Result<Option<(String, String)>, String> {
    conn.query_row(
        "SELECT name, pwd_hash FROM users WHERE username=?1",
        params![username],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| format!("查询账号失败: {e}"))
}

pub fn update_password(conn: &Connection, username: &str, pwd_hash: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE users SET pwd_hash=?2 WHERE username=?1",
        params![username, pwd_hash],
    )
    .map(|_| ())
    .map_err(|e| format!("修改密码失败: {e}"))
}

pub fn list_users(conn: &Connection) -> Result<Vec<String>, String> {
    let mut st = conn
        .prepare("SELECT username FROM users ORDER BY id")
        .map_err(|e| format!("查询账号失败: {e}"))?;
    let rows = st
        .query_map([], |r| r.get(0))
        .map_err(|e| format!("读取账号失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("解析账号失败: {e}"))?);
    }
    Ok(out)
}

/// 全局用户库：位于应用数据目录下的 users.db（与报告文件夹无关，登录账号全局有效）
pub fn open_users_dir(dir: &std::path::Path) -> Result<Connection, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    let conn = Connection::open(dir.join("users.db")).map_err(|e| format!("打开用户库失败: {e}"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS users(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             username TEXT UNIQUE NOT NULL,
             name TEXT NOT NULL,
             pwd_hash TEXT NOT NULL,
             created_at TEXT DEFAULT (datetime('now','localtime'))
         );",
    )
    .map_err(|e| format!("建用户表失败: {e}"))?;
    Ok(conn)
}

// ==================== 基本信息框选设置（batch_basic_fields） ====================
pub fn save_basic_fields(
    conn: &Connection,
    batch_id: i64,
    fields: &[(String, i64, String)],
) -> Result<(), String> {
    conn.execute("DELETE FROM batch_basic_fields WHERE batch_id=?1", params![batch_id])
        .map_err(|e| format!("清空框选设置失败: {e}"))?;
    for (ft, page, rect) in fields {
        conn.execute(
            "INSERT INTO batch_basic_fields(batch_id, field_type, page, rect) VALUES(?1,?2,?3,?4)",
            params![batch_id, ft, page, rect],
        )
        .map_err(|e| format!("保存框选设置失败: {e}"))?;
    }
    Ok(())
}

pub fn get_basic_fields(conn: &Connection, batch_id: i64) -> Result<Vec<(String, i64, String)>, String> {
    let mut st = conn
        .prepare("SELECT field_type, page, rect FROM batch_basic_fields WHERE batch_id=?1 ORDER BY id")
        .map_err(|e| format!("查询框选设置失败: {e}"))?;
    let rows = st
        .query_map(params![batch_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| format!("读取框选设置失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("解析框选设置失败: {e}"))?);
    }
    Ok(out)
}

// ==================== 报告 OCR 识别结果 ====================
pub fn save_report_ocr(
    conn: &Connection,
    report_id: i64,
    no: &str,
    name: &str,
    class: &str,
    exp: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE reports SET ocr_no=?1, ocr_name=?2, ocr_class=?3, ocr_exp=?4, updated_at=datetime('now','localtime') WHERE id=?5",
        params![no, name, class, exp, report_id],
    )
    .map(|_| ())
    .map_err(|e| format!("保存识别结果失败: {e}"))
}

pub fn insert_students(conn: &Connection, batch_id: i64, list: &[StudentIn]) -> Result<(), String> {    let mut st = conn
        .prepare(
            "INSERT INTO students(batch_id, student_no, name, class, report_name) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(batch_id, student_no) DO UPDATE SET name=excluded.name, class=excluded.class, report_name=excluded.report_name",
        )
        .map_err(|e| format!("准备名单插入失败: {e}"))?;
    for s in list {
        st.execute(params![batch_id, s.no, s.name, s.cls, s.report_name])
            .map_err(|e| format!("写入名单失败: {e}"))?;
    }
    Ok(())
}

/// 清空某批次全部学生（重新导入名单前先删旧，避免残留）
pub fn delete_students(conn: &Connection, batch_id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM students WHERE batch_id=?1", params![batch_id])
        .map(|_| ())
        .map_err(|e| format!("清空名单失败: {e}"))
}

pub fn get_students(conn: &Connection, batch_id: i64) -> Result<Vec<Student>, String> {
    let mut st = conn
        .prepare("SELECT id, student_no, name, class, report_name FROM students WHERE batch_id=?1 ORDER BY student_no")
        .map_err(|e| format!("准备名单查询失败: {e}"))?;
    let rows = st
        .query_map(params![batch_id], |r| {
            Ok(Student { id: r.get(0)?, no: r.get(1)?, name: r.get(2)?, cls: r.get(3)?, report_name: r.get(4)? })
        })
        .map_err(|e| format!("查询名单失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("解析名单失败: {e}"))
}

fn row_to_student(r: &rusqlite::Row) -> rusqlite::Result<Student> {
    Ok(Student { id: r.get(0)?, no: r.get(1)?, name: r.get(2)?, cls: r.get(3)?, report_name: r.get(4)? })
}

pub fn find_student_by_no(conn: &Connection, batch_id: i64, no: &str) -> Result<Option<Student>, String> {
    conn.query_row(
        "SELECT id, student_no, name, class, report_name FROM students WHERE batch_id=?1 AND student_no=?2",
        params![batch_id, no],
        row_to_student,
    )
    .optional()
    .map_err(|e| format!("按学号查询失败: {e}"))
}

pub fn find_student_by_name(conn: &Connection, batch_id: i64, name: &str) -> Result<Option<Student>, String> {
    conn.query_row(
        "SELECT id, student_no, name, class, report_name FROM students WHERE batch_id=?1 AND name=?2 LIMIT 1",
        params![batch_id, name],
        row_to_student,
    )
    .optional()
    .map_err(|e| format!("按姓名查询失败: {e}"))
}

pub fn find_student_by_id(conn: &Connection, id: i64) -> Result<Option<Student>, String> {
    conn.query_row(
        "SELECT id, student_no, name, class, report_name FROM students WHERE id=?1",
        params![id],
        row_to_student,
    )
    .optional()
    .map_err(|e| format!("按 ID 查询失败: {e}"))
}

/* ---------------- 报告 ---------------- */
fn row_to_report(r: &rusqlite::Row) -> rusqlite::Result<ReportRec> {
    Ok(ReportRec {
        id: r.get(0)?,
        batch_id: r.get(1)?,
        student_id: r.get(2)?,
        source_path: r.get(3)?,
        renamed_path: r.get(4)?,
        orig_name: r.get(5)?,
        match_status: r.get(6)?,
        submit_status: r.get(7)?,
    })
}

fn report_where(conn: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<Option<ReportRec>, String> {
    conn.query_row(sql, p, row_to_report).optional().map_err(|e| format!("查询报告失败: {e}"))
}

pub fn report_by_rename(conn: &Connection, batch_id: i64, rename: &str) -> Result<Option<ReportRec>, String> {
    report_where(conn, "SELECT id,batch_id,student_id,source_path,renamed_path,orig_name,match_status,submit_status FROM reports WHERE batch_id=?1 AND renamed_path=?2", params![batch_id, rename])
}

pub fn report_by_source(conn: &Connection, batch_id: i64, src: &str) -> Result<Option<ReportRec>, String> {
    report_where(conn, "SELECT id,batch_id,student_id,source_path,renamed_path,orig_name,match_status,submit_status FROM reports WHERE batch_id=?1 AND source_path=?2", params![batch_id, src])
}

pub fn insert_report(
    conn: &Connection,
    batch_id: i64,
    student_id: Option<i64>,
    source: &str,
    rename: &str,
    orig: &str,
    match_status: &str,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO reports(batch_id,student_id,source_path,renamed_path,orig_name,match_status)
         VALUES(?1,?2,?3,?4,?5,?6)",
        params![batch_id, student_id, source, rename, orig, match_status],
    )
    .map_err(|e| format!("登记报告失败: {e}"))?;
    Ok(conn.last_insert_rowid())
}

pub fn mark_excluded(conn: &Connection, report_id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE reports SET match_status='excluded', updated_at=datetime('now','localtime') WHERE id=?1",
        params![report_id],
    )
    .map(|_| ())
    .map_err(|e| format!("更新排除失败: {e}"))
}

pub fn attach_student(conn: &Connection, report_id: i64, student_id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE reports SET student_id=?1, match_status='matched', updated_at=datetime('now','localtime') WHERE id=?2",
        params![student_id, report_id],
    )
    .map(|_| ())
    .map_err(|e| format!("挂靠学生失败: {e}"))
}

pub fn set_renamed(conn: &Connection, report_id: i64, rename_rel: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE reports SET renamed_path=?1, updated_at=datetime('now','localtime') WHERE id=?2",
        params![rename_rel, report_id],
    )
    .map(|_| ())
    .map_err(|e| format!("更新改名版失败: {e}"))
}

pub fn list_reports(conn: &Connection, batch_id: i64) -> Result<Vec<ReportRec>, String> {
    let mut st = conn
        .prepare("SELECT id,batch_id,student_id,source_path,renamed_path,orig_name,match_status,submit_status FROM reports WHERE batch_id=?1")
        .map_err(|e| format!("准备报告查询失败: {e}"))?;
    let rows = st
        .query_map(params![batch_id], row_to_report)
        .map_err(|e| format!("查询报告失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("解析报告失败: {e}"))
}

/// 保存批阅状态；snapshot.done=true 时视为提交固化，并记录批阅教师
pub fn save_state(conn: &Connection, report_id: i64, draft_json: &str, done: bool, teacher: &str) -> Result<(), String> {
    if done {
        conn.execute(
            "UPDATE reports SET draft=?1, final_scores=?1, teacher=?2, submit_status='submitted',
             submitted_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?3",
            params![draft_json, teacher, report_id],
        )
        .map(|_| ())
        .map_err(|e| format!("保存状态失败: {e}"))
    } else {
        conn.execute(
            "UPDATE reports SET draft=?1, updated_at=datetime('now','localtime') WHERE id=?2",
            params![draft_json, report_id],
        )
        .map(|_| ())
        .map_err(|e| format!("保存草稿失败: {e}"))
    }
}

/// 保存某份报告的标题定位结果（locate_json），供下次复用
pub fn save_report_locate(conn: &Connection, report_id: i64, json: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE reports SET locate_json=?1, updated_at=datetime('now','localtime') WHERE id=?2",
        params![json, report_id],
    )
    .map(|_| ())
    .map_err(|e| format!("保存定位失败: {e}"))
}

pub fn get_report_locate(conn: &Connection, report_id: i64) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT locate_json FROM reports WHERE id=?1",
        params![report_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| format!("读取定位失败: {e}"))
}

/// 按改名版文件名或源文件名定位报告 id
pub fn report_id_by_key(conn: &Connection, batch_id: i64, key: &str) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT id FROM reports WHERE batch_id=?1 AND (renamed_path=?2 OR source_path=?2 OR orig_name=?2) ORDER BY id DESC LIMIT 1",
        params![batch_id, key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| format!("定位报告失败: {e}"))
}

/// 全量成绩清单：每个学生一行（取最新匹配报告），供"保存全部成绩 CSV / 批阅概览表格"
#[derive(serde::Serialize)]
pub struct GradeRow {
    pub no: String,
    pub name: String,
    pub cls: String,
    pub status: String,   // submitted / pending / missing
    pub draft: Option<String>,
    pub fname: String,
}

pub fn list_all_grading(conn: &Connection, batch_id: i64) -> Result<Vec<GradeRow>, String> {
    let mut st = conn
        .prepare(
            "SELECT s.student_no, s.name, s.class,
               COALESCE((SELECT r.submit_status FROM reports r
                         WHERE r.batch_id=?1 AND r.student_id=s.id AND r.match_status='matched'
                         ORDER BY r.id DESC LIMIT 1),'missing'),
               (SELECT r.draft FROM reports r
                 WHERE r.batch_id=?1 AND r.student_id=s.id AND r.match_status='matched'
                 ORDER BY r.id DESC LIMIT 1),
               (SELECT r.orig_name FROM reports r
                 WHERE r.batch_id=?1 AND r.student_id=s.id AND r.match_status='matched'
                 ORDER BY r.id DESC LIMIT 1)
             FROM students s WHERE s.batch_id=?1
             ORDER BY s.student_no",
        )
        .map_err(|e| format!("准备成绩查询失败: {e}"))?;
    let rows = st
        .query_map(params![batch_id], |r| {
            Ok(GradeRow {
                no: r.get(0)?,
                name: r.get(1)?,
                cls: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                status: r.get(3)?,
                draft: r.get(4)?,
                fname: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
            })
        })
        .map_err(|e| format!("查询成绩失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("解析成绩失败: {e}"))
}

/// 准备盘点：每份报告一行（挂靠/新增/批改状态），缺交名单单独列出 —— 供准备面板状态总表
#[derive(serde::Serialize)]
pub struct PrepRow {
    pub key: String,
    pub path: String,
    pub fname: String,
    pub ocr_no: String,
    pub ocr_name: String,
    pub ocr_class: String,
    pub ocr_exp: String,
    pub report_name: String,
    pub renamed_path: String,
    pub stu_no: String,
    pub stu_name: String,
    pub stu_cls: String,
    pub locate_status: String, // pending(待定位) / auto(已自动定位) / manual(已人工定位)
    pub matched: bool, // 已挂靠到名单
    pub is_new: bool,  // 未挂靠 → 需挂靠/新增
    pub graded: bool,  // 已有打分
    pub done: bool,    // 已批
}
#[derive(serde::Serialize)]
pub struct PrepMissing {
    pub no: String,
    pub name: String,
    pub cls: String,
}
#[derive(serde::Serialize)]
pub struct PrepOverview {
    pub rows: Vec<PrepRow>,
    pub missing: Vec<PrepMissing>,
}

pub fn prep_overview(conn: &Connection, batch_id: i64) -> Result<PrepOverview, String> {
    let mut rows_out = Vec::new();
    {
        let mut st = conn
            .prepare(
                "SELECT r.id, r.orig_name, r.source_path, r.student_id, r.ocr_no, r.ocr_name, r.ocr_class, r.ocr_exp,
                        r.report_name, r.renamed_path, r.submit_status, r.locate_json,
                        EXISTS(SELECT 1 FROM report_items ri WHERE ri.report_id=r.id AND ri.score>0 AND ri.activated=1)
                 FROM reports r WHERE r.batch_id=?1 AND r.match_status IN ('matched','unmatched')
                 ORDER BY r.orig_name",
            )
            .map_err(|e| format!("准备盘点查询失败: {e}"))?;
        let rows = st
            .query_map(params![batch_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, String>(9)?,
                    r.get::<_, String>(10)?,
                    r.get::<_, String>(11)?,
                    r.get::<_, bool>(12)?,
                ))
            })
            .map_err(|e| format!("读取准备盘点失败: {e}"))?;
        for row in rows {
            let (rid, orig, src, sid, no, nm, cl, ex, rn, rnp, submit, locj, graded) =
                row.map_err(|e| format!("解析准备盘点失败: {e}"))?;
            let (sno, sname, scls) = match sid {
                Some(sid) => match find_student_by_id(conn, sid)? {
                    Some(s) => (s.no, s.name, s.cls),
                    None => (String::new(), String::new(), String::new()),
                },
                None => (String::new(), String::new(), String::new()),
            };
            let locate_status = {
                let v: Json = serde_json::from_str(&locj).unwrap_or(Json::Null);
                let n = v.get("items").and_then(|a| a.as_array()).map(|a| a.len()).unwrap_or(0);
                if n == 0 { "pending".to_string() }
                else if v.get("source").and_then(|s| s.as_str()) == Some("manual") { "manual".to_string() }
                else { "auto".to_string() }
            };
            rows_out.push(PrepRow {
                key: orig.clone(),
                path: src,
                fname: orig,
                ocr_no: no, ocr_name: nm, ocr_class: cl, ocr_exp: ex,
                report_name: rn,
                renamed_path: rnp,
                stu_no: sno, stu_name: sname, stu_cls: scls,
                locate_status,
                matched: sid.is_some(),
                is_new: sid.is_none(),
                graded,
                done: submit == "submitted",
            });
        }
    }
    let mut missing = Vec::new();
    {
        let mut st = conn
            .prepare(
                "SELECT s.student_no, s.name, s.class FROM students s
                 WHERE s.batch_id=?1 AND NOT EXISTS(
                     SELECT 1 FROM reports r
                     WHERE r.batch_id=s.batch_id AND r.student_id=s.id AND r.match_status='matched'
                 ) ORDER BY s.student_no",
            )
            .map_err(|e| format!("缺交名单查询失败: {e}"))?;
        let rows = st
            .query_map(params![batch_id], |r| {
                Ok(PrepMissing { no: r.get(0)?, name: r.get(1)?, cls: r.get::<_, Option<String>>(2)?.unwrap_or_default() })
            })
            .map_err(|e| format!("读取缺交名单失败: {e}"))?;
        for r in rows {
            missing.push(r.map_err(|e| format!("解析缺交名单失败: {e}"))?);
        }
    }
    Ok(PrepOverview { rows: rows_out, missing })
}

/// 批次评分项模板（固化：题名/满分/统分区/每题打分区等）
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct BatchItem {
    pub item_index: i32,
    pub item_name: String,
    #[serde(default)]
    pub max_score: i32,
    #[serde(default)]
    pub score_page: i32,
    #[serde(default)]
    pub score_x: f64,
    #[serde(default)]
    pub title_rect: String,
    #[serde(default)]
    pub total_region: String,
    #[serde(default)]
    pub title_img: String,
}

pub fn save_batch_items(conn: &Connection, batch_id: i64, items: &[BatchItem]) -> Result<(), String> {
    conn.execute("DELETE FROM batch_items WHERE batch_id=?1", params![batch_id])
        .map_err(|e| format!("清空评分项失败: {e}"))?;
    let mut st = conn
        .prepare(
            "INSERT INTO batch_items(batch_id,item_index,item_name,max_score,score_page,score_x,title_rect,total_region,title_img)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        )
        .map_err(|e| format!("准备评分项写入失败: {e}"))?;
    for it in items {
        st.execute(params![
            batch_id, it.item_index, it.item_name, it.max_score,
            it.score_page, it.score_x, it.title_rect, it.total_region, it.title_img
        ])
        .map_err(|e| format!("写入评分项失败: {e}"))?;
    }
    Ok(())
}

pub fn get_batch_items(conn: &Connection, batch_id: i64) -> Result<Vec<BatchItem>, String> {
    let mut st = conn
        .prepare(
            "SELECT item_index,item_name,max_score,score_page,score_x,title_rect,total_region,title_img
             FROM batch_items WHERE batch_id=?1 ORDER BY item_index",
        )
        .map_err(|e| format!("准备评分项查询失败: {e}"))?;
    let rows = st
        .query_map(params![batch_id], |r| {
            Ok(BatchItem {
                item_index: r.get(0)?,
                item_name: r.get(1)?,
                max_score: r.get(2)?,
                score_page: r.get(3)?,
                score_x: r.get(4)?,
                title_rect: r.get(5)?,
                total_region: r.get(6)?,
                title_img: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
            })
        })
        .map_err(|e| format!("查询评分项失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("解析评分项失败: {e}"))
}

/* ==================== 独立定位库(locate.sqlite) ====================
   定位模块以数据库为唯一数据源：每条扫描行先入库获得全局唯一 KEY(id)，
   再逐行把 OCR 结果写回库，匹配到题目也写回库，最后从库读取渲染/取位置。 */
pub fn open_locate(folder: &str) -> Result<Connection, String> {
    let data_dir = Path::new(folder).join(DATA_DIR);
    fs::create_dir_all(&data_dir).map_err(|e| format!("创建 data 目录失败: {e}"))?;
    let conn = Connection::open(data_dir.join("locate.sqlite"))
        .map_err(|e| format!("打开定位库失败: {e}"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS loc_rows(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             report_key TEXT NOT NULL,
             page_index INTEGER DEFAULT 0,
             top REAL DEFAULT 0, bottom REAL DEFAULT 0,
             left REAL DEFAULT 0, right REAL DEFAULT 0,
             cell TEXT DEFAULT '{}',
             text TEXT DEFAULT '',
             matched_item INTEGER DEFAULT -1,
             processed INTEGER DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_loc_key ON loc_rows(report_key);",
    )
    .map_err(|e| format!("建定位表失败: {e}"))?;
    Ok(conn)
}

pub fn locate_clear(conn: &Connection, report_key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM loc_rows WHERE report_key=?1", params![report_key])
        .map(|_| ())
        .map_err(|e| format!("清空定位行失败: {e}"))
}

pub fn locate_insert(
    conn: &Connection,
    report_key: &str,
    page_index: i64,
    top: f64,
    bottom: f64,
    left: f64,
    right: f64,
    cell: &str,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO loc_rows(report_key,page_index,top,bottom,left,right,cell) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![report_key, page_index, top, bottom, left, right, cell],
    )
    .map_err(|e| format!("插入定位行失败: {e}"))?;
    Ok(conn.last_insert_rowid())
}

pub fn locate_set_ocr(conn: &Connection, id: i64, text: &str) -> Result<(), String> {
    conn.execute("UPDATE loc_rows SET text=?1, processed=1 WHERE id=?2", params![text, id])
        .map(|_| ())
        .map_err(|e| format!("写入OCR结果失败: {e}"))
}

pub fn locate_set_match(conn: &Connection, id: i64, item_index: i64) -> Result<(), String> {
    conn.execute("UPDATE loc_rows SET matched_item=?1 WHERE id=?2", params![item_index, id])
        .map(|_| ())
        .map_err(|e| format!("写入匹配结果失败: {e}"))
}

pub fn locate_rows(conn: &Connection, report_key: &str) -> Result<Vec<serde_json::Value>, String> {
    let mut st = conn
        .prepare(
            "SELECT id,page_index,top,bottom,left,right,cell,text,matched_item,processed
             FROM loc_rows WHERE report_key=?1 ORDER BY page_index,top",
        )
        .map_err(|e| format!("准备查询失败: {e}"))?;
    let rows = st
        .query_map(params![report_key], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, i64>(0)?,
                "page_index": r.get::<_, i64>(1)?,
                "top": r.get::<_, f64>(2)?,
                "bottom": r.get::<_, f64>(3)?,
                "left": r.get::<_, f64>(4)?,
                "right": r.get::<_, f64>(5)?,
                "cell": r.get::<_, String>(6)?,
                "text": r.get::<_, String>(7)?,
                "matched_item": r.get::<_, i64>(8)?,
                "processed": r.get::<_, i64>(9)?,
            }))
        })
        .map_err(|e| format!("查询定位行失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("解析定位行失败: {e}"))
}

/// 重置定位库：清空全部行并重置自增 id，避免每次定位 id 一直累加、数据膨胀
pub fn locate_reset(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DELETE FROM loc_rows;
         DELETE FROM sqlite_sequence WHERE name='loc_rows';",
    )
    .map_err(|e| format!("重置定位库失败: {e}"))?;
    Ok(())
}
