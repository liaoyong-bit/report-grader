// 数据层：SQLite 四表（batches/students/reports/report_items）+ 目录常量
use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::path::Path;

pub const DATA_DIR: &str = "data";
pub const SOURCE_DIR: &str = "source_files";
pub const OUTPUT_DIR: &str = "output";
pub const DB_NAME: &str = "grading.db";

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct StudentIn {
    pub no: String,
    pub name: String,
    #[serde(default)]
    pub cls: String,
}

#[derive(Clone)]
pub struct Student {
    pub id: i64,
    pub no: String,
    pub name: String,
    pub cls: String,
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
             submitted_at TEXT,
             created_at TEXT DEFAULT (datetime('now','localtime')),
             updated_at TEXT DEFAULT (datetime('now','localtime'))
         );
         CREATE TABLE IF NOT EXISTS report_items(
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             report_id INTEGER NOT NULL,
             item_index INTEGER NOT NULL,
             item_name TEXT DEFAULT '',
             max_score INTEGER DEFAULT 0,
             score INTEGER DEFAULT 0,
             activated INTEGER DEFAULT 0
         );",
    )
    .map_err(|e| format!("建表失败: {e}"))?;
    Ok(conn)
}

/* ---------------- 批次 ---------------- */
pub fn get_or_create_batch(conn: &Connection, name: &str, teacher: &str) -> Result<i64, String> {
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

/* ---------------- 学生 ---------------- */
pub fn insert_students(conn: &Connection, batch_id: i64, list: &[StudentIn]) -> Result<(), String> {
    let mut st = conn
        .prepare("INSERT OR REPLACE INTO students(batch_id, student_no, name, class) VALUES(?1,?2,?3,?4)")
        .map_err(|e| format!("准备名单插入失败: {e}"))?;
    for s in list {
        st.execute(params![batch_id, s.no, s.name, s.cls])
            .map_err(|e| format!("写入名单失败: {e}"))?;
    }
    Ok(())
}

pub fn get_students(conn: &Connection, batch_id: i64) -> Result<Vec<Student>, String> {
    let mut st = conn
        .prepare("SELECT id, student_no, name, class FROM students WHERE batch_id=?1 ORDER BY student_no")
        .map_err(|e| format!("准备名单查询失败: {e}"))?;
    let rows = st
        .query_map(params![batch_id], |r| {
            Ok(Student { id: r.get(0)?, no: r.get(1)?, name: r.get(2)?, cls: r.get(3)? })
        })
        .map_err(|e| format!("查询名单失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("解析名单失败: {e}"))
}

fn row_to_student(r: &rusqlite::Row) -> rusqlite::Result<Student> {
    Ok(Student { id: r.get(0)?, no: r.get(1)?, name: r.get(2)?, cls: r.get(3)? })
}

pub fn find_student_by_no(conn: &Connection, batch_id: i64, no: &str) -> Result<Option<Student>, String> {
    conn.query_row(
        "SELECT id, student_no, name, class FROM students WHERE batch_id=?1 AND student_no=?2",
        params![batch_id, no],
        row_to_student,
    )
    .optional()
    .map_err(|e| format!("按学号查询失败: {e}"))
}

pub fn find_student_by_name(conn: &Connection, batch_id: i64, name: &str) -> Result<Option<Student>, String> {
    conn.query_row(
        "SELECT id, student_no, name, class FROM students WHERE batch_id=?1 AND name=?2 LIMIT 1",
        params![batch_id, name],
        row_to_student,
    )
    .optional()
    .map_err(|e| format!("按姓名查询失败: {e}"))
}

pub fn find_student_by_id(conn: &Connection, id: i64) -> Result<Option<Student>, String> {
    conn.query_row(
        "SELECT id, student_no, name, class FROM students WHERE id=?1",
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

/// 保存批阅状态；snapshot.done=true 时视为提交固化
pub fn save_state(conn: &Connection, report_id: i64, draft_json: &str, done: bool) -> Result<(), String> {
    if done {
        conn.execute(
            "UPDATE reports SET draft=?1, final_scores=?1, submit_status='submitted',
             submitted_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?2",
            params![draft_json, report_id],
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

/// 按改名版文件名或源文件名定位报告 id
pub fn report_id_by_key(conn: &Connection, batch_id: i64, key: &str) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT id FROM reports WHERE batch_id=?1 AND (renamed_path=?2 OR source_path=?2 OR orig_name=?2) LIMIT 1",
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
