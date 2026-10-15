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
| `save_to_output` | 导出产物写入 `output/`（name 支持"子目录/文件名"，逐段清洗防穿越） |
| `read_font` | 读系统中文字体（白名单 simhei/simfang/simkai/stkaiti 的 .ttf）供 pdf-lib 嵌入批注 |

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

## 扫描版处理：文字分块 + 逐块 OCR（v0.1.111 分块稳健性修复版）

> 变更：**不再识别表格结构**（横线/竖线/网格/格子已全部停用并注释保留），
> 改为挖掘"汉字小间隔挤在一起"的像素特征分块，逐块送 OCR，块的位置与识别文本落库。
> v0.1.111 修复并发 OCR 串号、同段/标题误合并、下划线文字拆块等问题（见下方"v0.1.111 修复"）。

**分块算法 `detectTextBlocks()`（前端，纯像素层）**
1. **墨迹掩码**：灰度 < 200。扫描件的浅灰底纹（≈230/242）天然落在阈值外，无需逐行洗底纹；
2. **估字符尺度**：逐像素行墨迹投影 → 文字行带 → 粗中位数 m0 后取 [0.4×m0, 2×m0] 区间内的行带
   再取中位数 = 字高（剔除表格粘连巨型带与页边小噪点带的干扰）；
3. **去长直线 + 记屏障**：横向候选 run ≥3 字宽、纵向候选 run ≥1.6 字高；
   "真直线"要求 run 内逐行/列的连续墨迹跨度 ≤0.35×字高（占六成以上），
   **纵向线还要求两端（±3px）顶着已删除的横线** —— 大号标题的竖笔画、上下两行文字的对齐竖笔画
   因此不会被误删，而表格框线整条细且端点接横线，会被删掉并登记为 barrier；
4. **字符尺度膨胀 + 连通域**：横向 `0.55×字宽`、纵向 `0.25×字高` 可分离窗口膨胀（遇屏障截断）
   取 8 连通域。横向半径覆盖模板的加大字距（字隙可达 0.4~0.5 字宽）；纵向只保字符完整；
5. **⑥ 同行横向合并**：同一行被标点/空隙拆开的段（如「）」「（20分）」、下划线空隙）
   缝 ≤1.6×字宽、纵向重叠 ≥一半、缝里无表格竖线 → 并回一块；
6. **⑦ 行带级段落归并**：行带先按行聚成行单元，再纵向归并成段——
   行距 ≤0.85×字高 → 同段；行距 ≤1.0×字高且字号相近 → 同段；
   字号突变（比值 ≥1.25，大标题→正文）→ 标题独立成块；
   间隙行里**重叠区之外**存在"横向长"被删横线（表格线贯穿整行，必然延伸到文字之外）→ 不同段
   （紧贴文字的下划线、竖直边框都不会误判为分隔线）。

**流程**
```
逐页 analyzeScanPage（渲染 → 底纹置白 → floodTextRegion 去页边 → detectTextBlocks）
  → 全部块入库 scan_block 拿 KEY(id)
  → 按页渲一次 scale4 画布 → 裁出该页所有块 → 4 路并发 Windows OCR → 按 KEY 写回识别文本
  → 从库读回全部块 → 预览呈现块框 + OCR 文本
  → 标题匹配（行级打分）：OCR 行按块内像素行带落位后，在"行"上匹配题目标题
```

**数据表 `data/locate.sqlite` / `scan_block`**

| 列 | 含义 |
|---|---|
| `id` | 全局唯一 KEY（前端持此编号写回 OCR 结果） |
| `report_key` | 报告键（原始文件名） |
| `page_index` / `seq` | 页码 / 页内顺序 |
| `top` `bottom` `left` `right` | 块位置（0-1 比例，相对整页） |
| `text` / `ocr_done` | OCR 识别结果 / 是否已识别 |

**相关命令**：`block_reset` / `block_init` / `block_set_ocr` / `block_get_rows`
（旧的 `scan_save_struct` 与 `pdf_hline/pdf_vline/pdf_cell/pdf_tline` 写入链路已停用、注释保留）

**预览**：`扫描文字块预览` 弹窗 —— 左栏页图叠加块框（编号=数据库 KEY，**标题命中块绿色并标"题n"**，
悬停看识别文本与位置），右栏块表（KEY / 页 / 序号 / 纵向位置% / 左右位置% / 命中 / OCR 识别内容）。

**标题匹配（v0.1.110 行级打分）**
- 候选是"块的 OCR 行"（按块内像素行带落位），不再是整块 —— 标题与正文合块时也能精确到行；
- 打分：完全相等 100 / 以标题开头 90 / 包含标题 74（按行长惩罚）/ 模糊（最长公共子串 ≥82%）62；
- **汇总表头淘汰**：一行里同时出现 ≥2 个题目名 → 判为"评分项目"汇总表，不参与定位；
- **满分括号加分**：行内带正确「（N分）」→ +12；同分近似取文档更靠后的候选（正文标题在汇总表之后）；
- 命中后 `titleY_pct` = 命中行纵向中心（批改打分线），`titleX_pct` = 整页文字区右缘（打分横向对齐）。

**可调参数**：`detectTextBlocks(data,W,H,region,{inkGray, rRatio, minLineW, minLineH})`
—— 灰度阈值（默认200）/ 横向膨胀半径（字宽倍数，默认0.55）/ 横竖线判定（字宽倍数，默认 3 与 1.6）。

**v0.1.111 修复清单**
- **OCR 并发串号**：Rust 端两处 OCR 命令此前共用固定临时文件 `rg_ocr_tmp.png` / `rg_ocr_words_tmp.png`，
  前端 4 路并发时互相覆盖 → 不同块识别出相同文本、甚至读到的临时文件已被删除 → 空文本。
  现改为"进程ID+序号+纳秒时间戳"唯一文件名；
- **去线误删文字**：正交厚度判据会误删大号标题的竖笔画、上下两行文字的同列竖笔画；
  改为"整条 run 逐行/列连续墨迹跨度都细 + 纵向线两端接已删横线"才判为线；
- **标题/段落误合并**：膨胀不再负责纵向合段，改为行带级显式归并（字号突变断开、
  分隔线判据=间隙行里重叠区之外的横向长 barrier），标题独立成块、段落整段一块；
- **行带左右边界 bug**：行带关闭前的残行（如 1px 残线）会把带的 left/right 覆盖成 1px 宽。

---

## v0.1.118（四项：统分区/导出按钮/标记交错/PaddleOCR）

- **非扫描版统分区无分修复**：`stampSummaryRow` 此前只依赖库内文字块（scan_block），而文字层 PDF
  （非扫描版）没有 OCR 块 → 统分区回填不了。现拆为 `stampSummaryRowBlocks`（扫描版，原逻辑）+
  `stampSummaryRowText`（兜底）：pdf.js 抽文字层按行分组，找「分值」行求各列 x 中心、
  「得分」行求回填 y，坐标与 pdf-lib 同为用户空间可直接互用；pdf.js 与 pdf-lib 坐标系一致，
  无需换算。导出时把 PDF 字节传入，扫描版块定位失败自动走文字层。
- **导出面板顶部「开始导出」按钮移除**：原为占位（点击只提示"待接入"），导出入口只有工具栏的
  「▶ 导出勾选项(N)」。
- **「标记交错」按钮逻辑补全**（批改面板）：新增 Rust 命令 `mark_report_bad` —— 立即清空该报告
  全部成绩（draft/final_scores/report_items/teacher/submitted_at）、删除 renamed/ 中的改名副本、
  状态置 excluded。原始文件留在原处不动，不再出现在成绩表、改名文件包、带批阅痕迹导出中
  （这些查询均只取 matched）。仍需两次点击确认。
- **内置 PaddleOCR（可选识别引擎）**：Rust 侧引入 `oar-ocr`（ONNX Runtime + PP-OCR 模型本地推理），
  `ocr_image_b64` / `ocr_image_b64_words` 新增 `engine` 参数（"paddle" 走 PaddleOCR，缺省 Windows OCR）；
  准备面板大蓝条（操作按钮行）新增「识别引擎：系统OCR / PaddleOCR」单选（localStorage 持久化，
  核对与定位的 OCR 均跟随）。模型在首次使用时自动下载到 `~/.oar`（需联网一次，之后离线可用）；
  引擎构建一次常驻进程。

---

## v0.1.117 热修（改名覆盖真凶：apply_renames）

**根因**：v0.1.115/116 只给 `scan.rs` 的两处改名点加了防覆盖（`unique_rename_name`），
但「核对原始报告」实际调用的改名入口是 **`commands.rs::apply_renames`**（前端 `runSourceVerify`
→ `syncFolder` 之后单独调 `applyRenames`），它仍按 `学号_姓名_班级_报告名.pdf` 直接 `fs::copy`——
同一学生「文字版 + 扫描版」两份报告命名完全相同，后一份**直接覆盖**前一份：
- `renamed/` 只剩 2 个文件 → 「改名文件包」2 份；
- 两份报告 `renamed_path` 相同 → 「带批阅痕迹」两次写入同一输出名 → 只剩 2 份（日志实证：同名打印两次）；
- 成绩表也少一行。
而 `repair_renamed` 只在 `sync_folder` 末尾跑，位于 `applyRenames` **之前**，同一次核对无法自愈。

**修复**：
- `apply_renames` 改用 `unique_rename_name`（目标名被占用或磁盘已存在 → 追加 `_2/_3`），
  并在末尾补一次 `repair_renamed`；
- `scan.rs` 的 `unique_rename_name` / `repair_renamed` 提升为 `pub(crate)` 供 `commands.rs` 复用。

**验证步骤（旧数据无需删除）**：安装 v0.1.117 → 选报告文件夹 → 重新点「核对原始报告」→
`renamed/` 应出现 3 份（张三、张三_2、李四）→ 成绩表 3 行 → 改名包 / 带批阅痕迹包均 3 份。

---

## v0.1.116 热修（日志定位的三处）

- **教师/时间戳缺失根因**：Tauri invoke 返回的 Vec<u8> 是普通 Array，pdf-lib 嵌入字体只认
  Uint8Array/ArrayBuffer → 嵌入报 "of type NaN" 静默失败 → 所有中文批注（教师/时间戳）没盖上。
  `loadCJKBytes` 现统一转 Uint8Array。
- **带批阅痕迹.zip 打包失败**：打包基准错误（在报告文件夹根找产物子目录，而产物写在
  导出位置下）。`pack_dir_zip` 的 sub 改为相对导出位置；`pack_renamed_zip`（renamed/）
  保持相对报告文件夹。
- **改名覆盖自愈**：新增 `repair_renamed`（sync_folder 末尾自动执行）——matched 报告的
  改名文件磁盘缺失、或多报告共用同一 renamed_path（历史覆盖遗留）时，自动从源文件
  重新生成唯一改名版（_2/_3）并更新登记。**旧数据无需删除，重新「核对原始报告」即可修复**。
- **大题分数下加教师/时间戳**：每个大题旁红字「N/满分」的下一行居中盖
  「教师  yyyy-mm-dd hh:mm」（7.5pt 红字，与分数同基准）；统分区旁与首页页脚保留。

---

## 导出问题修复与逻辑重构（v0.1.115）

**交互重构（单一导出入口）**：
- 去掉右侧选项区里的第二套「导出」按钮——导出入口**只有顶栏一个**「▶ 导出勾选项(N)」，
  按钮实时显示勾选数量；想单独导某项就只勾它；
- 预览区顶部新增**「最近一次导出结果」清单**：每项任务 ✓/✗ + 结果说明 + 产物文件
  （点击直接用系统程序打开，存的是落盘绝对路径）。

**数据修复**：
- **成绩总表按报告逐份列出**：`list_all_grading` 从"每学生取最新一份"改为按 reports 逐行
  （LEFT JOIN 学生），同一学生两份报告两行都出；Excel 批阅教师列改为按报告从草稿读取；
- **改名防覆盖**（scan.rs `unique_rename_name`）：目标名已被其他报告登记或磁盘已存在时
  自动追加 `_2`/`_3` —— 修复同一学生"文字版+扫描版"两份报告 renamed/ 互相覆盖、
  导致成绩表少一份的根因（历史被覆盖的文件需重新核对生成）；
- **预览点击"找不到文件"修复**：`open_external` 弃用 `cmd /C start`（Rust 引号转义
  cmd 无法识别，文件存在也报找不到），改 `explorer <文件>` 直接打开；并支持绝对路径
  与"文件不存在"明确报错。

**盖章增强（带批阅痕迹）**：
- **统分区「评分」行回填**：利用库内文字块定位（「分值」标签行各列给出列中心，
  「得分」标签行给出回填行纵坐标），各题得分+总分盖红字到评分行；文字层版报告
  无像素块数据自动跳过（保留大题旁红字）；
- **批阅教师+时间戳按报告从库读取**（draft 的 teacher/submittedAt），盖在评分行下方
  显眼处 + 首页页脚；不再用当前会话值/当前时间。

---

## 导出面板补全（v0.1.114）

- **修复「导出拿不到分数」**：scope 批改流程的 `r.name` 只是文件名（basename），
  `__backendPersist` 用它做 reportKey 被 `report_id_by_key` 的完整路径精确匹配拒绝，
  **批阅草稿从未入库**。现改为 `reportKey: r.key || r.name`（r.key=原始文件名），
  并在 Rust 侧 `report_id_by_key` 增加 renamed_path 的文件名部分兜底匹配（双保险）。
- **导出位置可设置**：导出面板顶部工具栏「更改导出位置」——默认 `报告文件夹/output/`，
  可改为任意文件夹（存 localStorage 应用级偏好 `rg_exportDir`）；成绩表/ZIP/带批阅痕迹
  全部跟随该位置（Rust `save_to_output`/`pack_renamed_zip` 增加可选 `base` 参数）。
- **「全部导出」按钮**：顶部工具栏新增——按左侧勾选（成绩表→改名文件包→带批阅痕迹）
  依次执行，实时显示进度与完成数；左侧勾选默认全选。
- **带批阅痕迹打包+预览**：盖章导出完成后自动打包 `带批阅痕迹.zip` 到导出位置；
  预览文件名可点击——已导出的（标 ✏️）直接打开盖章版 PDF，未导出的打开改名后原始文件。

---

## 批阅状态存储修正（v0.1.113）

**问题**：用户删除报告文件夹内软件生成的 `data/` 后重跑，未批改的报告却带着旧分数 ——
批阅状态除了写文件夹数据库，还同步写了一份到 **WebView2 localStorage**（系统目录
`%LOCALAPPDATA%\com.reportgrader.desktop\` 下，不在报告文件夹），且读取时 localStorage
优先级更高，删文件夹数据后状态被系统缓存"复活"。

**修正**（`grading.db` 本就在 `文件夹/data/`，无需迁移位置）：
- Tauri 模式**禁用 localStorage 存取批阅状态**（`loadState` 直接返回空、`saveState` 只写库）；
- `loadReportsFromScope` 装载列表后，从 `reports.draft`（saveState 写入的完整快照：
  scores/activated/maxs/basic/done/submittedAt）按原始文件名批量恢复状态；
- `initReportState` 不再让空状态覆盖库里的提交标记（`done`）；
- localStorage 仅纯浏览器模式兜底使用；`teacher`/快捷键等应用级偏好仍存 localStorage（与文件夹无关）。

**语义**：删掉报告文件夹里的 `data/` = 批阅状态彻底清空（分数、定位、提交状态全部随文件夹走）。

---

## 导出面板（v0.1.112 重做）

| 项目 | 行为 |
|---|---|
| **学生成绩总表** | Excel（exceljs），列勾选动态生效。 |
| **改名后的原始文件** | 打包 `renamed/` 目录 → `output/改名文件包.zip`；打包预览中**点击文件名**用系统默认 PDF 程序打开该文件（`open_external`）。 |
| **带批阅痕迹的原始文件** | **库驱动批量导出**：`prep_overview`（已挂靠改名的报告）+ `list_all_grading`（成绩，按原始文件名匹配）+ `get_report_locate`（打分位置）→ 在**改名后的 PDF** 上，每题标题行右缘（`titleX_pct`，往左收 8px）盖红字「得分/满分」（12pt，基线下移 0.3 字号视觉居中于 `titleY_pct` 行）——与批改界面红字同一位置；首页页脚灰色小字「批阅教师：X　批阅时间：yyyy-mm-dd hh:mm」（需中文字体，读系统 simhei.ttf）。逐份写 `output/带批阅痕迹/<改名文件名>`；未批阅的报告自动跳过；结束报成功/跳过/失败计数。 |
| ~~批阅报告~~ | 【已移除】自制排版汇总 PDF，用户不需要；`exportReportPdfs` 代码保留备用。 |

- 旧版「带批阅痕迹」`exportOne`（数据源=批改会话内存 `S.reports`、坐标依赖模板框选）已停用保留。
- **中文字体链路**：pdf-lib 嵌入自定义字体必须注册 fontkit —— 新增 `web/lib/fontkit.umd.min.js`（@pdf-lib/fontkit 1.1.1，index.html 引入），
  Rust `read_font` 读系统 simhei.ttf → 前端 `embedFont(bytes, {subset:true})` 子集嵌入（页脚仅增 ~4KB，不嵌则全字体 ≈10MB/份）。
  无字体可用时自动降级：分数照常盖（纯数字），仅省略中文页脚。
- 修复：`tauri-bridge.js` 中 `getAllGrades` 误嵌进 `saveToOutput` 函数体（导致桥接未注册、总表走浏览器兜底）。

---

## 已知限制 / 下一步
- 检测依赖模板精确匹配（多模板适配列为后续）。
- 扫描件走"文字分块 + 逐块 OCR"（v0.1.111 行带合并分块）；标题定位已精确到 OCR 行（行带级），
  极少数标题与正文行完全粘连无法分行时回退整块中心。
- 增量同步 V1 按文件名识别；同名内容变化校验（文件指纹）放 V2。
- 名单导入格式：Excel/CSV（学号/姓名/班级），向导内可下载模板。

---

#（注：内容由 AI 生成，随开发进度持续更新）
