// 增量同步：扫描文件夹 PDF → 对比登记 → 新增文件匹配/改名/登记 → 返回列表
use crate::db;
use rusqlite::Connection;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(serde::Serialize, Clone)]
pub struct SyncItem {
    pub no: String,
    pub name: String,
    pub cls: String,
    pub path: Option<String>, // 改名版相对路径；无文件时为 None（待提交）
    pub status: String,       // submitted / pending / missing
}

#[derive(serde::Serialize, Clone)]
pub struct UnmatchedItem {
    pub path: String,
    pub name: String,
}

#[derive(serde::Serialize, Default)]
pub struct SyncResult {
    pub reports: Vec<SyncItem>,
    pub unmatched: Vec<UnmatchedItem>,
    pub added: usize,
}

/// 从文件名提取第一段连续数字（>=4 位视为学号）
fn extract_no(name: &str) -> Option<String> {
    let mut cur = String::new();
    for ch in name.chars() {
        if ch.is_ascii_digit() {
            cur.push(ch);
        } else if !cur.is_empty() {
            if cur.len() >= 4 {
                return Some(cur);
            }
            cur.clear();
        }
    }
    if cur.len() >= 4 { Some(cur) } else { None }
}

/// 清理文件名中的非法字符
fn clean(s: &str) -> String {
    s.chars().filter(|c| !"\\/:*?\"<>|".contains(*c)).collect()
}

/// 递归收集所有 PDF（跳过 data / source_files / output 及隐藏目录）
fn collect_pdfs(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if name == db::DATA_DIR || name == db::SOURCE_DIR || name == db::OUTPUT_DIR || name.starts_with('.') {
                continue;
            }
            collect_pdfs(&p, out);
        } else if p.extension().map(|e| e.to_string_lossy().to_lowercase()) == Some("pdf".into()) {
            out.push(p);
        }
    }
}

/// 增量同步入口
pub fn sync_folder(conn: &Connection, folder: &str, batch_id: i64) -> Result<SyncResult, String> {
    let batch_name = db::get_batch(conn, batch_id)?.map(|b| b.1).unwrap_or_default();
    let folder_p = Path::new(folder);
    let source_dir = folder_p.join(db::SOURCE_DIR);
    fs::create_dir_all(&source_dir).map_err(|e| format!("创建 source_files 失败: {e}"))?;

    let mut pdfs: Vec<PathBuf> = Vec::new();
    collect_pdfs(folder_p, &mut pdfs);

    let existing = db::list_reports(conn, batch_id)?;
    let source_reg: HashSet<String> = existing
        .iter()
        .filter(|r| !r.source_path.is_empty())
        .map(|r| r.source_path.clone())
        .collect();

    let mut result = SyncResult::default();

    for p in pdfs {
        let rel = p
            .strip_prefix(folder_p)
            .map(|x| x.to_string_lossy().into_owned())
            .unwrap_or_default();
        if rel.is_empty() || source_reg.contains(&rel) {
            continue;
        }
        let fname = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let in_source = p.parent() == Some(source_dir.as_path());
        let no = extract_no(&fname);

        if in_source {
            // 已在 source_files 内（可能是用户放入的改名版）
            if existing.iter().any(|r| r.renamed_path == rel) {
                continue;
            }
            let st = no.as_ref().and_then(|n| db::find_student_by_no(conn, batch_id, n).ok().flatten());
            match st {
                Some(s) => {
                    db::insert_report(conn, batch_id, Some(s.id), &rel, &rel, &fname, "matched")?;
                    result.added += 1;
                }
                None => {
                    db::insert_report(conn, batch_id, None, &rel, &rel, &fname, "unmatched")?;
                    result.unmatched.push(UnmatchedItem { path: rel.clone(), name: fname });
                }
            }
        } else {
            // 普通 PDF：解析学号匹配名单 → 复制改名版
            let st = no.as_ref().and_then(|n| db::find_student_by_no(conn, batch_id, n).ok().flatten());
            match st {
                Some(s) => {
                    let rename = format!(
                        "{}_{}_{}_{}.pdf",
                        s.no,
                        clean(&s.name),
                        clean(&s.cls),
                        clean(&batch_name)
                    );
                    let rel_rename = format!("{}/{}", db::SOURCE_DIR, rename);
                    fs::copy(&p, source_dir.join(&rename))
                        .map_err(|e| format!("生成改名版失败: {e}"))?;
                    db::insert_report(conn, batch_id, Some(s.id), &rel, &rel_rename, &fname, "matched")?;
                    result.added += 1;
                }
                None => {
                    db::insert_report(conn, batch_id, None, &rel, "", &fname, "unmatched")?;
                    result.unmatched.push(UnmatchedItem { path: rel.clone(), name: fname });
                }
            }
        }
    }

    // 重新拉取登记，构建"学生维度"三态列表
    let reports = db::list_reports(conn, batch_id)?;
    let students = db::get_students(conn, batch_id)?;
    for s in students {
        let rep = reports
            .iter()
            .find(|r| r.student_id == Some(s.id) && r.match_status == "matched");
        match rep {
            Some(r) => {
                let status = if r.submit_status == "submitted" { "submitted" } else { "pending" };
                result.reports.push(SyncItem {
                    no: s.no,
                    name: s.name,
                    cls: s.cls,
                    path: Some(r.renamed_path.clone()),
                    status: status.to_string(),
                });
            }
            None => {
                result.reports.push(SyncItem {
                    no: s.no,
                    name: s.name,
                    cls: s.cls,
                    path: None,
                    status: "missing".to_string(),
                });
            }
        }
    }

    Ok(result)
}

/// 处理未匹配：student_no 为空 → 不导入；否则挂到该学生并生成改名版
pub fn resolve_unmatched(
    conn: &Connection,
    folder: &str,
    path: &str,
    student_no: &str,
) -> Result<(), String> {
    let batch_id = db::find_batch_by_folder(conn)?.map(|b| b.0).ok_or("未找到批次")?;
    let rep = db::report_by_source(conn, batch_id, path)?.ok_or("未找到该报告记录")?;
    if student_no.is_empty() {
        db::mark_excluded(conn, rep.id)?;
        return Ok(());
    }
    let st = db::find_student_by_no(conn, batch_id, student_no)?.ok_or("名单中无该学号")?;
    db::attach_student(conn, rep.id, st.id)?;
    // 生成改名版
    let batch_name = db::get_batch(conn, batch_id)?.map(|b| b.1).unwrap_or_default();
    let folder_p = Path::new(folder);
    let source_dir = folder_p.join(db::SOURCE_DIR);
    fs::create_dir_all(&source_dir).map_err(|e| format!("创建 source_files 失败: {e}"))?;
    let rename = format!(
        "{}_{}_{}_{}.pdf",
        st.no,
        clean(&st.name),
        clean(&st.cls),
        clean(&batch_name)
    );
    let rel_rename = format!("{}/{}", db::SOURCE_DIR, rename);
    let src = folder_p.join(&path);
    fs::copy(&src, source_dir.join(&rename))
        .map_err(|e| format!("生成改名版失败: {e}"))?;
    db::set_renamed(conn, rep.id, &rel_rename)?;
    Ok(())
}
