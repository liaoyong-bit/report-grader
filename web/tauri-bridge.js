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
        // 已有批次 → 增量同步（自动识别新放入的 PDF）
        const sync = await invoke('sync_folder', { folder: picked.folder });
        buildReports(sync);
        if(sync.unmatched && sync.unmatched.length){ app.showUnmatched(sync.unmatched); }
        app.setDetect('✅ 已同步批次：' + (picked.batch ? picked.batch.name : '') +
          (sync.added ? '，新增 ' + sync.added + ' 份' : ''));
        if(app.S.reports.length){ app.selectReport(0); }
      } else {
        // 无数据库 → 初始化向导（报告名称 + 名单 + 模板）
        app.openWizard();
      }
    } catch(e) { app.setErr('⚠ ' + e); }
  };

  window.__bridge = window.__bridge || {};

  // —— 初始化批次（向导"开始"）
  window.__bridge.initBatch = async (folder, reportName, students) => {
    try {
      await invoke('init_batch', { folder, reportName, students, teacher: app.S.teacher });
      const sync = await invoke('sync_folder', { folder });
      buildReports(sync);
      if(sync.unmatched && sync.unmatched.length){ app.showUnmatched(sync.unmatched); }
      app.setDetect('✅ 批次已初始化并扫描报告');
      if(app.S.reports.length){ app.selectReport(0); }
    } catch(e) { app.setErr('⚠ ' + e); }
  };

  // —— 处理未匹配：挂到某学生 / 不导入
  window.__bridge.resolveUnmatched = async (folder, item, action) => {
    try {
      const studentNo = action === '__skip' ? '' : action;
      await invoke('resolve_unmatched', { folder, path: item.path, studentNo });
      const sync = await invoke('sync_folder', { folder });   // 重新同步刷新
      buildReports(sync);
      app.setDetect('✅ 已处理：' + item.name);
    } catch(e) { app.setErr('⚠ ' + e); }
  };

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
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
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
    try { invoke('save_grading_state', { folder: app.S.folder, reportKey: r.name, snapshot: snap }); }
    catch(e){ /* 忽略，回退 localStorage */ }
  };

  // —— 导出产物写入 output/（替代浏览器下载）
  window.__bridge.saveToOutput = async (name, bytes) => {
    await invoke('save_to_output', { folder: app.S.folder, name, data: Array.from(bytes) });
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
