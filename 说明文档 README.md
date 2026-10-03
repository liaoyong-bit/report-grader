# 实验报告批阅系统（Tauri v2 · Rust + JS）

面向实验报告 PDF 的批阅桌面工具：前端用 pdf.js 渲染 PDF 并做文字层定位、pdf-lib 写回得分；Rust 后端负责建 SQLite 数据库存批阅状态、读学生名单、扫描/改名/登记报告、管理目录结构。界面三栏（左=报告列表+统计，中=PDF预览+得分叠加，右=学生信息+评分导出）。

> 关键结论：目标样张《医用物理仿真实验报告_张三.pdf》为**文字版 PDF**（非扫描图），三项检测走文字层即可，不依赖 OCR。

---

## 目录结构

```
（项目根 = GitHub 仓库根）
├─ index.html / app.js / tauri-bridge.js   # 前端
├─ 说明文档 README.md
├─ .gitignore
└─ src-tauri/                    # Rust 后端（Tauri v2）
   ├─ Cargo.toml / build.rs
   ├─ tauri.conf.json / capabilities/default.json
   ├─ icons/                     # 预置图标（可自行替换）
   └─ src/
      ├─ main.rs / lib.rs        # 入口 + 命令注册
      ├─ db.rs                   # SQLite 四表 + CRUD
      ├─ scan.rs                 # 增量同步（扫描/匹配/改名/登记）
      └─ commands.rs             # 全部 Tauri 命令
└─ .github/workflows/build.yml   # GitHub Actions 自动编译 Windows exe
```

> 运行后，所选文件夹下自动生成三个目录（随文件夹整体迁移）：
> - `data/`：SQLite 数据库（`data/grading.db`）
> - `source_files/`：改名版 PDF（`学号_姓名_班级_报告名称.pdf`）
> - `output/`：导出产物（成绩单 + 带批阅痕迹 PDF）

---

## 已实现功能

### 前端（三栏工作台）
- 教师登录（姓名持久化、回车即入、自动聚焦）
- 载入报告：单/多 PDF、报告文件夹；Tauri 下走原生文件夹对话框
- 自动识别：基本信息（姓名/学号/班级/实验名）、统分区、五大标题行
- 评分：五项打分、实时总分、未批灰/已批绿
- 预览叠加：标题行"得分：N"、统分区数字回填
- 键盘：←/→ 切项并全选分数、Enter 确认移下一项、Ctrl+Enter 提交下一份、数字限定
- 已批语义：**提交过 = 已批**；提交前须全部项目已批
- 进度持久化：localStorage 兜底 + 后端数据库（`__backendPersist`）
- canvas 渲染缓存：打分仅刷新叠加层，resize 才全量重渲
- 导出：带分 PDF / CSV / JSON（Tauri 下写入 `output/`）

### Rust 后端（Tauri 命令）
| 命令 | 作用 |
|---|---|
| `pick_pdf_folder` | 选文件夹，返回是否已有数据库及批次 |
| `init_batch` | 初始化：建库 + 报告名称 + 导入名单 |
| `sync_folder` | 增量同步：扫描子目录 PDF → 匹配/改名/登记 → 返回三态列表 |
| `resolve_unmatched` | 处理未匹配：挂到学生 / 不导入 |
| `read_pdf` | 读 PDF 字节给前端 |
| `save_grading_state` | 保存批阅草稿/提交固化 |
| `save_to_output` | 导出产物写入 `output/` |

### 数据库四表
`batches`（批次）/ `students`（名单）/ `reports`（报告+批阅状态）/ `report_items`（逐项评分）。批阅状态存 `reports.draft`（草稿）与 `final_scores`（提交固化），`done=true` 视为提交。

---

## 使用方式

### 方式一：直接浏览器使用（开发/快速预览，无需 Rust）
双击 `index.html`。pdf.js/pdf-lib 走 CDN（离线需放 `lib/`）。此模式走 localStorage 持久化、文件选择导入，不启用数据库与名单三态。

### 方式二：打包成 Windows exe（正式使用）
用 GitHub Actions 编译（本地无需 Rust）。

---

## 编译与发布（GitHub Actions）

### 第一次：推送仓库
1. 到 GitHub 新建一个仓库（建议 **Public**，免费 CI；Private 有每月分钟数限制）。
2. 用 git 把 **本项目根目录** 作为仓库根推上去（不要把内层 `新建文件夹/` 历史副本推上去，`.gitignore` 已排除）：
   ```bash
   cd "E:\新建文件夹 (2)"
   git init
   git add .
   git commit -m "init"
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git branch -M main
   git push -u origin main
   ```
3. push 会自动触发 `build.yml`，在仓库 **Actions** 页看到构建任务。

### 编译成功后拿 exe
- 进入 Actions 页 → 点最新一次成功的 build → 底部 **Artifacts** → 下载 zip，内含安装包 `.msi` / `.exe`。
- 本地解压运行即可（Windows 自带 WebView2）。

### 之后每次改代码
再次 `git add . && git commit -m "..." && git push` 即自动重新编译。

> 若 Actions 构建报错：日志里会给出 Rust 编译错误，把红色报错信息发我，我在本地改好你再重新 push。

---

## 键盘操作速查
| 按键 | 作用 |
|---|---|
| ← / → | 切换打分项，自动全选该框分数 |
| Enter（输入框内） | 确认当前并移到下一项；评分框内同时标记该题已批 |
| Ctrl+Enter / 「提交并下一份」 | 提交当前并切下一份（须全部项目已批） |
| ↑ / ↓ | 焦点非输入框时阻止预览区误滚动 |
| PgUp / PgDn | 预览区翻页 |

---

## 检测算法说明（已在真实 PDF 上验证）
- 统分区：定位"分值"行 → 取数字序列（30/20/20/20/10/100）及列中心 x → 定位"得分"行基线。
- 五大标题：逐行匹配 `^[一二三四五]、` → 序号对应项目 → 取基线 y 与 `（N分）` 满分。
- 基本信息：`姓名/学号` 同基线取值；`班级/实验名称` 跨基线容差取值。
- 导出坐标：pdf-lib 以左下为原点，`pdfLibY = 页高 - 文字层 y`。

---

## 已知限制 / 下一步
- 检测依赖模板精确匹配（多模板适配列为后续）。
- 扫描件（无文字层）需 OCR（后续评估）。
- 增量同步 V1 按文件名识别；同名内容变化校验（文件指纹）放 V2。
- 名单导入格式：Excel/CSV（学号/姓名/班级），向导内可下载模板。

---

#（注：内容由 AI 生成，随开发进度持续更新）
