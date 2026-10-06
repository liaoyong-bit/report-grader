/* Tauri 桥接层 v2
 * Tauri 环境下（打包成 exe）：
 *  - 覆盖"载入报告文件夹"：pick_pdf_folder → 无库弹初始化向导 / 有库增量同步 → 渲染三态列表
 *  - 读取 PDF 字节 → read_pdf
 *  - 批阅进度持久化 → save_grading_state（done=true 即视为提交固化）
 *  - 导出产物写入 output/ → save_to_output
 * 纯浏览器环境（直接打开 index.html）本文件不生效，走 app.js 默认的文件选择逻辑。
 * 依赖：加载顺序必须在 app.js 之后（使用 window.__app 暴露的接口）。
 */
(function () {
  if (!window.__TAURI__) return; // 非 Tauri 环境

  const { invoke } = window.__TAURI__.core;
  const app = window.__app;

  // 调试日志 → 系统临时目录 report_grader_debug.log
  function log(line){
    try { invoke('append_log', { line: new Date().toISOString().slice(11,19) + ' ' + line }); } catch(e){}
  }
  log('=== bridge LOADED, withGlobalTauri OK, selectReport=' + typeof app.selectReport + ' reports=' + app.S.reports.length);

  // 后端返回的字节构造 file-like 对象（喂给 app.js 的加载/渲染）
  // Tauri invoke 返回的 Vec<u8> 在 JS 里是 number[]（非 Uint8Array），需先转换
  function toFile(name, path, data){
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    return { name, _path: path, arrayBuffer: async () => ab };
  }

  // 把后端同步结果构建成前端 reports 数组并渲染
  function buildReports(syncResult){
    app.S.reports = [];
    for(const it of (syncResult.reports || [])){
      const r = {
        id: it.path || (it.no + '_' + it.name),
        name: it.path || ((it.no||'') + '_' + (it.name||'')),
        path: it.path || null,
        student: { no: it.no, name: it.name, cls: it.cls },
        missing: !it.path,
      };
      app.initReportState(r);
      app.S.reports.push(r);
    }
    app.renderReportList();
    log('buildReports n=' + app.S.reports.length);
  }

  // —— 载入报告文件夹（覆盖 app.js 默认行为）
  document.getElementById('btnLoadFolder').onclick = async () => {
    try {
      log('click btnLoadFolder');
      const picked = await invoke('pick_pdf_folder'); // {folder, hasDb, batch}
      const hasDb = picked && (picked.has_db !== undefined ? picked.has_db : picked.hasDb);
      log('pick_pdf_folder → folder=' + (picked ? picked.folder : 'null') + ' hasDb=' + hasDb);
      if(!picked || !picked.folder){ return; }
      app.S.folder = picked.folder;
      app.S.mode = 'tauri';

      if(hasDb){
        // 已有库 → 停在准备面板；有模板框选才同步，否则引导先设置模板
        try{ await maybeSyncAfterRoster(); }
        catch(e){ app.setErr('⚠ 同步失败: ' + e); }
      } else {
        // 无库 → 停在准备面板，右侧名单管理区引导初始化（不弹向导）
        app.S.needsInit = true;
        app.refreshPrepOverview();
        app.setDetect('该文件夹尚未初始化，请在右侧「导入学生名单」');
      }
    } catch(e) { app.setErr('⚠ ' + e); }
  };

  window.__bridge = window.__bridge || {};
  window.__bridge.log = log;   // 供 app.js 记录导出等操作日志

  // —— 初始化批次（向导"开始"）
  window.__bridge.initBatch = async (folder, reportName, students) => {
    try {
      await invoke('init_batch', { folder, reportName, students, teacher: app.S.teacher });
      await invoke('save_roster', { folder, reportName, students });   // 名单+报告名存到 source_files
      app.setDetect('✅ 批次已初始化，请先设置模板框选，保存后再扫描识别');
      app.S.pendingItemsSetup = true;
      if(app.S.inPrep){ app.refreshPrepOverview(); }
      else { app.showPrep(); app.refreshPrepOverview(); }
    } catch(e) { app.setErr('⚠ ' + e); }
  };

  // —— 模板框选已保存才同步扫描；未就绪则先引导设置模板
  async function maybeSyncAfterRoster(){
    let hasSetup = false;
    try{
      const bf = await invoke('get_basic_fields', { folder: app.S.folder });
      const items = await invoke('get_batch_items', { folder: app.S.folder });
      hasSetup = !!((bf && bf.length) || (items && items.length));
    }catch(e){}
    if(hasSetup){
      // 统一走「核对原始报告」刷新批次（扫描 + OCR 挂靠 + 改名）
      if(window.__app && window.__app.runSourceVerify){ await window.__app.runSourceVerify(); }
      else { const sync = await invoke('sync_folder', { folder: app.S.folder }); buildReports(sync); }
      if(app.S.inPrep){ app.refreshPrepOverview(); }
    } else {
      app.S.pendingItemsSetup = true;
      app.setDetect('请先点「设置模板（框选）」框选基本信息与题目分值，保存后再扫描识别');
      if(app.S.inPrep){ app.refreshPrepOverview(); }
      else { app.showPrep(); app.refreshPrepOverview(); }
    }
  }

  // —— 处理未匹配：挂到某学生 / 不导入
  // —— 已有批次提示：继续使用 → 增量同步进界面
  document.getElementById('btnBatchKeep').onclick = async () => {
    document.getElementById('batchMask').style.display = 'none';
    try { await maybeSyncAfterRoster(); }
    catch(e) { app.setErr('⚠ ' + e); }
  };
  // —— 已有批次提示：重新设置 → 打开初始化向导
  document.getElementById('btnBatchReset').onclick = () => {
    document.getElementById('batchMask').style.display = 'none';
    app.openWizard();
  };
  // —— 挂载报告完成后再进评分项设置，避免两个弹窗叠加
  document.getElementById('btnUnmatchDone').onclick = () => {
    document.getElementById('unmatchMask').style.display = 'none';
    if(app.S.pendingItemsSetup){ app.S.pendingItemsSetup = false; app.ensureItemsSetup(); }
    if(app.S.inPrep){ app.refreshPrepOverview(); }
    else if(app.S.reports.length){ app.selectReport(0); }
  };
  window.__bridge.resolveUnmatched = async (folder, item, action) => {
    try {
      const studentNo = action === '__skip' ? '' : action;
      await invoke('resolve_unmatched', { folder, path: item.path, studentNo });
      const sync = await invoke('sync_folder', { folder });   // 重新同步刷新
      buildReports(sync);
      app.setDetect('✅ 已处理：' + item.name);
    } catch(e) { app.setErr('⚠ ' + e); }
  };

  // —— 评分项模板：固化 / 读取 / 模板文件检测 / 读模板PDF
  window.__bridge.saveBatchItems = async (folder, items) => { await invoke('save_batch_items', { folder, items }); };
  window.__bridge.getBatchItems = async (folder) => { return await invoke('get_batch_items', { folder }); };
  window.__bridge.getTemplatePath = async (folder) => { return await invoke('get_template_path', { folder }); };
  window.__bridge.readPdf = async (folder, path) => { return await invoke('read_pdf', { folder, path }); };
  window.__bridge.pickTemplate = async (folder) => { return await invoke('pick_template', { folder }); };
  window.__bridge.ocrImageB64 = async (b64) => { return await invoke('ocr_image_b64', { b64 }); };
  window.__bridge.ocrImageB64Words = async (b64) => { return await invoke('ocr_image_b64_words', { b64 }); };
  window.__bridge.saveScanText = async (folder, name, text) => { await invoke('save_scan_text', { folder, name, text }); };
  window.__bridge.applyRenames = async (folder) => { return await invoke('apply_renames', { folder }); };
  window.__bridge.saveReportLocate = async (folder, reportKey, locateJson) => { await invoke('save_report_locate', { folder, reportKey, locateJson }); };
  window.__bridge.getReportLocate = async (folder, reportKey) => { return await invoke('get_report_locate', { folder, reportKey }); };
  window.__bridge.locateInit = async (folder, reportKey, rows) => { return await invoke('locate_init', { folder, reportKey, rows }); };
  window.__bridge.locateSetOcr = async (folder, id, text) => { await invoke('locate_set_ocr', { folder, id, text }); };
  window.__bridge.locateSetMatch = async (folder, id, itemIndex) => { await invoke('locate_set_match', { folder, id, itemIndex }); };
  window.__bridge.locateGetRows = async (folder, reportKey) => { return await invoke('locate_get_rows', { folder, reportKey }); };
  window.__bridge.createUser = async (username, name, password) => { return await invoke('create_user', { username, name, password }); };
  window.__bridge.login = async (username, password) => { return await invoke('login', { username, password }); };
  window.__bridge.listUsers = async () => { return await invoke('list_users', {}); };
  window.__bridge.changePassword = async (username, oldPassword, newPassword) => { return await invoke('change_password', { username, oldPassword, newPassword }); };
  window.__bridge.saveBasicFields = async (folder, fields) => { await invoke('save_basic_fields', { folder, fields }); };
  window.__bridge.getBasicFields = async (folder) => { return await invoke('get_basic_fields', { folder }); };
  window.__bridge.saveReportOcr = async (folder, reportKey, no, name, cls, exp) => { await invoke('save_report_ocr', { folder, reportKey, no, name, class: cls, exp }); };
  window.__bridge.syncFolder = async (folder) => { return await invoke('sync_folder', { folder }); };
  window.__bridge.markExcluded = async (folder, reportKey) => { await invoke('mark_excluded', { folder, reportKey }); };
  window.__bridge.prepOverview = async (folder) => { return await invoke('prep_overview', { folder }); };
  window.__bridge.getRoster = async (folder) => { return await invoke('get_roster', { folder }); };
  window.__bridge.openExternal = async (folder, path) => { return await invoke('open_external', { folder, path }); };

  // —— 首次打开某份报告时从磁盘读入 PDF
  // 关键：app.js 里列表点击 li.onclick 与"下一份"逻辑调用的都是【全局 selectReport】，
  // 而 initBatch/buildReports 自动选第一个用的是 app.selectReport —— 两者必须同时覆盖。
  const origSelect = app.selectReport;
  const wrappedSelect = async function(idx){
    const r = app.S.reports[idx];
    log('selectReport idx=' + idx + ' exists=' + (r?'yes':'NO') +
        ' missing=' + (r ? r.missing : '-') + ' hasPdf=' + (r ? !!r.pdf : '-') +
        ' path=' + (r ? r.path : '?') + ' folder=' + (app.S.folder || '?'));
    if(r && !r.missing && !r.pdf){
      try {
        log('  read_pdf → folder=' + (app.S.folder||'?') + ' path=' + (r.path||'?'));
        const data = await invoke('read_pdf', { folder: app.S.folder, path: r.path });
        log('  read_pdf ok, type=' + (data instanceof Uint8Array ? 'Uint8Array' : Array.isArray(data) ? 'Array len=' + data.length : typeof data));
        const file = toFile(r.name, r.path, data);
        const bytes = await file.arrayBuffer();
        log('  getDocument start, bytes=' + bytes.byteLength);
        const pdfData = bytes.slice(0);   // 副本给 pdf.js（解析会 detach 传入的 buffer），原件 bytes 保留给导出用
        const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
        r.pdf = pdf; r.bytes = bytes; r.file = file;
        log('  getDocument OK, pages=' + (pdf && pdf.numPages));
      } catch(e) {
        const msg = String(e && e.message ? e.message : e);
        r.pdfError = '文件夹[' + (app.S.folder||'?') + '] 路径[' + (r.path||'?') + '] → ' + msg;
        app.setErr('读取报告失败: ' + msg);
        log('  ERROR ' + msg);
      }
    } else {
      log('  NO-LOAD: missing=' + (r ? r.missing : 'r为空') + ' hasPdf=' + (r ? !!r.pdf : '-'));
    }
    return origSelect.call(this, idx);
  };
  app.selectReport = wrappedSelect;
  window.selectReport = wrappedSelect;

  // —— 批阅进度持久化 → 后端数据库（done=true 视为提交，由后端固化；localStorage 由 app.js 兜底）
  window.__backendPersist = (r, snap) => {
    if(!app.S.folder) return;
    invoke('save_grading_state', { folder: app.S.folder, reportKey: r.name, snapshot: snap })
      .catch(e => log('save_grading_state 失败: ' + String(e && e.message || e)));
  };

  // —— 导出产物写入 output/（替代浏览器下载）
  window.__bridge.saveToOutput = async (name, bytes) => {
    await invoke('save_to_output', { folder: app.S.folder, name, data: Array.from(bytes) });

  // ---- 全量成绩清单（所有学生，供保存全部成绩 CSV / 批阅概览表格）
  window.__bridge.getAllGrades = async () => {
    return await invoke('list_all_grading', { folder: app.S.folder });
  };
  };

  // —— 名单模板下载：Tauri 下弹系统保存对话框写文件（覆盖浏览器 downloadBlob）
  document.getElementById('btnDownloadTpl').onclick = async () => {
    try {
      if(!window.ExcelJS){ app.setErr('exceljs 未加载，无法生成模板'); return; }
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('学生名单');
      ws.columns = [
        { header: '学号', key: 'no', width: 16 },
        { header: '姓名', key: 'name', width: 12 },
        { header: '班级', key: 'cls', width: 18 },
      ];
      ws.addRow({ no: '2024010101', name: '张三', cls: '2024级临床1班' });
      ws.addRow({ no: '2024010102', name: '李四', cls: '2024级临床1班' });
      const buf = await wb.xlsx.writeBuffer();
      await invoke('save_template', { data: Array.from(new Uint8Array(buf)), suggested: '学生名单模板.xlsx' });
      app.setDetect('✅ 已保存名单模板');
    } catch(e){ app.setErr('保存模板失败: ' + e); }
  };

  // 启动标记：桥接激活时状态区可见，用于确认 Tauri 后端已连接
  if(app.setDetect) app.setDetect('Tauri 后端已连接 ✓');

  console.log('[tauri-bridge] Tauri 能力已启用');
})();
//（注：内容由AI生成）
