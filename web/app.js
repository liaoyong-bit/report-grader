/* 实验报告批阅系统 — 前端逻辑
 * 检测目标(对应需求图1/图2/图3):
 *  1) 基本信息(姓名/班级/学号/实验名称) —— 图1
 *  2) 统分区(评分项目/分值/得分, 30/20/20/20/10/100) —— 图2
 *  3) 五大作答框上端标题行位置 —— 图3(得分"得分：N"叠加在标题行最右端)
 * 三栏布局: 左=报告列表+底部统计, 中=PDF预览(自适应+得分叠加), 右=学生信息+评分
 *
 * 本轮前端完善(P0-1/2/3/4 + P1-5):
 *  P0-1 批阅进度持久化：localStorage 过渡(关闭不丢)，预留后端 __backendPersist 接口
 *  P0-2 键盘：Enter=确认当前分数并移到下一项；Ctrl+Enter=提交并下一份；
 *            左右键切到打分框立即全选已有分数；打分框仅允许输入数字
 *  P0-3 已批语义：统一"提交过=已批"，去除"满分自动标记已批"
 *  P0-4 已批项可点击重开，重开后保留已保存分数与状态
 *  P1-5 canvas 只渲染一次并缓存，打分仅更新叠加层 DOM，resize 才全量重渲
 */
'use strict';

/* ==================== 全局状态 ==================== */
const S = {
  pdfjsOk: false,
  pdflibOk: false,
  teacher: localStorage.getItem('teacher') || '',
  reports: [],            // {id,name,student,pdf,bytes,path,done,missing,...}
  current: null,          // 当前报告对象
  pdfDoc: null,
  selectedItem: 0,
  folder: null,           // Tauri 模式：当前批次文件夹
  batch: null,            // 批次信息 {id,name}
  students: [],           // 名单 [{no,name,cls}]
  unmatched: [],          // 未匹配文件 [{path,name,srcName}]
  mode: 'browser',        // 'browser' | 'tauri'
};

const ITEM_NAMES = [
  '实验目的与原理',
  '实验仪器与装置',
  '实验内容与操作过程',
  '实验数据与处理',
  '实验结果与分析讨论'
];

/* ==================== DOM 引用 ==================== */
const $ = id => document.getElementById(id);
const el = {
  loginMask: $('loginMask'), loginName: $('loginName'),
  btnLoginConfirm: $('btnLoginConfirm'), btnLoginCancel: $('btnLoginCancel'),
  teacherLabel: $('teacherLabel'), btnLogin: $('btnLogin'),
  btnOpen: $('btnOpen'), btnLoadFolder: $('btnLoadFolder'),
  reportList: $('reportList'),
  statTotal: $('statTotal'), statDone: $('statDone'), statPending: $('statPending'),
  pdfHost: $('pdfHost'), pdfEmpty: $('pdfEmpty'),
  inpId: $('inpId'), inpName: $('inpName'), inpClass: $('inpClass'), inpExp: $('inpExp'),
  scoreRows: $('scoreRows'), totalVal: $('totalVal'),
  btnSubmitNext: $('btnSubmitNext'),
  btnExport: $('btnExport'), btnSaveRecord: $('btnSaveRecord'), btnExportJson: $('btnExportJson'),
  stFile: $('stFile'), stDetect: $('stDetect'), stErr: $('stErr'),
  fileInput: $('fileInput'), dirInput: $('dirInput'),
  statMissing: $('statMissing'),
  wizardMask: $('wizardMask'), wizReportName: $('wizReportName'),
  btnDownloadTpl: $('btnDownloadTpl'), btnImportStudents: $('btnImportStudents'),
  btnWizardStart: $('btnWizardStart'), btnWizardCancel: $('btnWizardCancel'),
  rosterInput: $('rosterInput'),
  unmatchMask: $('unmatchMask'), unmatchList: $('unmatchList'), btnUnmatchDone: $('btnUnmatchDone'),
};

/* ==================== 批阅进度持久化（P0-1） ====================
 * 过渡方案：浏览器 localStorage（关闭不丢）。
 * 后端数据库就绪后，在 tauri-bridge.js 里定义 window.__backendPersist，
 * saveState 会优先调用它写库，localStorage 作为纯浏览器/离线兜底。
 */
const STORE_PREFIX = 'gb_';
function stateKey(r){ return STORE_PREFIX + encodeURIComponent(r.name); }
function snapshot(r){
  return {
    scores: r.scores, activated: r.activated, maxs: r.maxs, basic: r.basic,
    teacher: r.teacher || S.teacher, done: r.done, submittedAt: r.submittedAt
  };
}
function saveState(r){
  if(window.__backendPersist){ try{ window.__backendPersist(r, snapshot(r)); }catch(e){ /* 后端不可用时回退本地 */ } }
  try{ localStorage.setItem(stateKey(r), JSON.stringify(snapshot(r))); }catch(e){ /* 存储满/禁用时忽略 */ }
}
function loadState(r){
  try{ const raw = localStorage.getItem(stateKey(r)); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
}
function initReportState(r){
  const s = loadState(r);
  r.scores    = (s && Array.isArray(s.scores))    ? s.scores    : [0,0,0,0,0];
  r.activated = (s && Array.isArray(s.activated)) ? s.activated : [false,false,false,false,false];
  r.maxs      = (s && Array.isArray(s.maxs))      ? s.maxs      : null;
  r.basic     = (s && s.basic)                    ? s.basic     : null;
  r.done      = !!(s && s.done);
  r.submittedAt = (s && s.submittedAt) || null;
}

/* ==================== 登录 ==================== */
function applyLogin(){
  el.teacherLabel.textContent = S.teacher ? ('批阅教师：' + S.teacher) : '游客(未登录)';
}
function confirmLogin(){
  const v = el.loginName.value.trim();
  if(!v){ el.loginName.focus(); return; }
  S.teacher = v; localStorage.setItem('teacher', v); applyLogin();
  el.loginMask.style.display = 'none';
}
el.btnLoginConfirm.onclick = confirmLogin;
// 登录框内输入姓名后按回车，等价点击"确认登录"直接进入
el.loginName.addEventListener('keydown', (e)=>{
  if(e.key === 'Enter'){ e.preventDefault(); confirmLogin(); }
});
el.btnLoginCancel.onclick = () => {
  S.teacher = ''; localStorage.removeItem('teacher'); applyLogin();
  el.loginMask.style.display = 'none';
};
el.btnLogin.onclick = () => { el.loginName.value = S.teacher; el.loginMask.style.display='flex'; el.loginName.focus(); };
applyLogin();
el.loginName.focus();   // 进入登录框即自动聚焦到姓名输入框，方便直接输入

/* ==================== 库加载与初始化 ==================== */
function initLibs(){
  ensureLibs(()=>{
    S.pdfjsOk = !!(window.pdfjsLib);
    S.pdflibOk = !!(window.PDFLib);
    if(S.pdfjsOk){
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
      el.stDetect.textContent = 'pdf.js ' + pdfjsLib.version + (S.pdflibOk ? ' / pdf-lib 就绪' : ' (pdf-lib未加载,导出受限)');
    } else {
      el.stErr.textContent = '⚠ 未能加载 pdf.js，请检查网络或 lib 目录';
    }
  });
}
initLibs();

/* ==================== 文件选择 ==================== */
el.btnOpen.onclick = () => el.fileInput.click();
el.btnLoadFolder.onclick = () => el.dirInput.click();

el.fileInput.onchange = async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if(!files.length) return;
  await loadReports(files);
};
el.dirInput.onchange = async (e) => {
  const files = Array.from(e.target.files || []).filter(f=>/\.pdf$/i.test(f.name));
  e.target.value = '';
  if(!files.length){ setErr('该文件夹没有 PDF 文件'); return; }
  await loadReports(files);
};

async function loadReports(files){
  if(!S.pdfjsOk){ setErr('pdf.js 未就绪，无法读取报告'); return; }
  for(const file of files){
    const bytes = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({data: bytes}).promise;
    const r = { id: file.name+'_'+Date.now(), name: file.name, pdf, bytes, file, _path: file._path };
    initReportState(r);      // 从持久化恢复批阅进度（P0-1）
    S.reports.push(r);
  }
  renderReportList();
  if(S.reports.length) selectReport(S.reports.length-1);
  setFile('已载入 ' + files.length + ' 份报告');
  setErr('');
}

function reportLabel(r){
  return (r.student && r.student.no) ? (r.student.no + '_' + (r.student.name||'')) : r.name;
}
function reportState(r){
  if(r.missing) return {cls:'miss', txt:'待提交'};
  if(r.done)    return {cls:'done', txt:'已批'};
  return {cls:'todo', txt:'待批'};
}
function renderReportList(){
  el.reportList.innerHTML = '';
  S.reports.forEach((r,i)=>{
    const li = document.createElement('li');
    li.textContent = reportLabel(r);
    const st = document.createElement('span');
    const s = reportState(r);
    st.className = 'state ' + s.cls;
    st.textContent = s.txt;
    li.appendChild(st);
    li.onclick = ()=> selectReport(i);   // 已批项同样可点击重开（P0-4）
    el.reportList.appendChild(li);
  });
  updateStats();
}
// 底部统计：总计(黑)/已批(绿)/待批(橙)/待提交(红)
function updateStats(){
  const total = S.reports.length;
  const done = S.reports.filter(r=>r.done).length;
  const missing = S.reports.filter(r=>r.missing).length;
  el.statTotal.textContent = total;
  el.statDone.textContent = done;
  el.statPending.textContent = total - done - missing;
  el.statMissing.textContent = missing;
}

/* ==================== 选中报告 & 检测 ==================== */
async function selectReport(idx){
  const r = S.reports[idx];
  S.current = r;
  el.pdfHost.innerHTML = '<div id="pdfEmpty"><div class="big">⏳</div>正在解析报告...</div>';
  el.scoreRows.innerHTML = '';
  setFile('解析中: ' + r.name);

  // 待提交：名单里有名字但尚未收到报告文件
  if(r.missing){
    el.pdfHost.innerHTML = '<div id="pdfEmpty"><div class="big">📭</div>该学生尚未提交报告</div>';
    setFile(reportLabel(r) + '（未提交）');
    setDetect('状态: 待提交');
    el.inpId.value   = (r.student && r.student.no)  || '';
    el.inpName.value = (r.student && r.student.name)|| '';
    el.inpClass.value= (r.student && r.student.cls) || '';
    el.inpExp.value  = '';
    return;
  }
  // 有报告但 pdf 未就绪：加载失败（真实原因见红字），不要误报"未提交"
  if(!r.pdf){
    el.pdfHost.innerHTML = '<div id="pdfEmpty"><div class="big">⚠</div>报告加载失败：' + (r.pdfError || '请重试') + '</div>';
    setFile(reportLabel(r) + '（加载失败）');
    setDetect('状态: 加载失败');
    el.inpId.value   = (r.student && r.student.no)  || '';
    el.inpName.value = (r.student && r.student.name)|| '';
    el.inpClass.value= (r.student && r.student.cls) || '';
    el.inpExp.value  = '';
    return;
  }

  try{
    const analysis = await analyze(r.pdf);
    r.analysis = analysis;
    // 保留已保存/已恢复的状态，不重置（P0-1 / P0-4 已批可重开）
    if(!r.maxs) r.maxs = analysis.items.map(it=>it.max);
    if(!r.basic) r.basic = analysis.basic;

    // 基本信息回填（优先用持久化的值，含老师手动修正过的）
    el.inpName.value = r.basic.name || '';
    el.inpId.value   = r.basic.id   || '';
    el.inpClass.value= r.basic.cls  || '';
    el.inpExp.value  = r.basic.exp  || '';

    renderPages(r);
    buildScoreRows(r);

    setFile(r.name);
    const d = analysis.detect;
    setDetect(`检测: 基本信息${d.basic?'✓':'✗'} | 统分区${d.table?'✓':'✗'} | 五大标题${d.titles?('✓ '+analysis.items.length+'项'):'✗'}` + (r.done ? ' | 状态:已批' : ''));
  }catch(err){
    setErr('解析失败: ' + err.message);
    el.pdfHost.innerHTML = '<div id="pdfEmpty"><div class="big">⚠</div>无法解析该PDF</div>';
  }
}

/* ==================== 文字层检测 ==================== */
async function getPageText(page){
  const tc = await page.getTextContent();
  const vp1 = page.getViewport({scale:1}); // 用scale=1视口把"距底"y换算成"距顶"，排序/找下一行用
  const items = [];
  const walk = (arr)=>{
    for(const it of arr){
      if(it.items){ walk(it.items); continue; }
      if(typeof it.str !== 'string' || !it.str) continue;
      const t = it.transform;
      const pt = vp1.convertToViewportPoint(t[4], t[5]);
      items.push({
        str: it.str,
        x: t[4],          // PDF用户空间x(距左)
        y: t[5],          // PDF用户空间y(距底) —— 叠加层定位用(convertToViewportPoint需要它)
        yTop: pt[1],      // 距顶 —— 页面排版顺序/找"下一行"用
        w: it.width||0, h: it.height||0,
        fontSize: Math.abs(t[3])||0
      });
    }
  };
  walk(tc.items);
  return items;
}

function groupLines(items, tol=3){
  // 按"距顶"y分组并自上而下排序；保留原始距底y(l.yUser)供叠加层定位
  const lines = [];
  for(const it of items){
    let line = lines.find(l => Math.abs(l.y - it.yTop) <= tol);
    if(!line){ line = {y: it.yTop, items: []}; lines.push(line); }
    line.items.push(it);
  }
  for(const l of lines){
    l.items.sort((a,b)=>a.x-b.x);
    l.text = l.items.map(i=>i.str).join('');
    l.yUser = l.items[0].y;   // 距底y，叠加层定位用
  }
  lines.sort((a,b)=>a.y-b.y);
  return lines;
}

const BASIC_LABELS = ['姓名','班级','学号','实验名称'];
const NEXT_LINE_MAX_DIST = 32;   // 标题与"填写要求"行的最大垂直距离(pt)

async function analyze(pdf){
  const n = pdf.numPages;
  const result = {
    basic: { name:'', id:'', cls:'', exp:'' },
    items: [],           // {name, max, titleY, pageIndex}
    scoreCols: null,
    detect: { basic:false, table:false, titles:false }
  };
  const foundIdx = new Set();

  for(let p=0; p<n; p++){
    const page = await pdf.getPage(p+1);
    const items = await getPageText(page);
    const lines = groupLines(items);
    const vp = page.getViewport({scale:1});
    const pw = vp.width;

    // --- 图1 基本信息 ---
    if(p===0){
      const byLabel = {};
      for(const it of items){
        for(const lb of BASIC_LABELS){
          if(it.str.trim() === lb){ byLabel[lb] = it; }
        }
      }
      const valueRight = (labelIt)=>{
        // 单元格可能跨多行显示(如"班级"的"班"在第二行)，按行重建，避免x排序错位
        const stop = BASIC_LABELS.filter(x=>x!==labelIt.str);
        const seg = items
          .filter(i=>i.str.trim()!=='' && Math.abs(i.y - labelIt.y)<=8 && i.x > labelIt.x + labelIt.w*0.5)
          .sort((a,b)=>a.x-b.x);
        const rowLines = [];   // 按yTop分组为行
        for(const i of seg){
          if(stop.includes(i.str.trim())) break;   // 遇到下一标签即停
          let ln = rowLines.find(l=>Math.abs(l.y - i.yTop)<=3);
          if(!ln){ ln={y:i.yTop, items:[]}; rowLines.push(ln); }
          ln.items.push(i);
        }
        rowLines.sort((a,b)=>a.y-b.y);             // 行按自上而下
        let out='';
        for(const l of rowLines){ l.items.sort((a,b)=>a.x-b.x); out += l.items.map(i=>i.str).join(''); }
        return out;
      };
      if(byLabel['姓名'])   result.basic.name  = valueRight(byLabel['姓名']);
      if(byLabel['学号'])   result.basic.id    = valueRight(byLabel['学号']);
      if(byLabel['班级'])   result.basic.cls   = valueRight(byLabel['班级']);
      if(byLabel['实验名称']) result.basic.exp = valueRight(byLabel['实验名称']);
      if(result.basic.name || result.basic.id || result.basic.cls) result.detect.basic = true;
    }

    // --- 图2 统分区(第1页) ---
    if(p===0){
      const fenzi = items.find(it=>it.str.trim()==='分值');
      if(fenzi){
        const row = items.filter(i=>Math.abs(i.y-fenzi.y)<=4).sort((a,b)=>a.x-b.x);
        const nums = row.filter(i=>/^\d+$/.test(i.str.trim()));
        const scoreX = nums.map(i=> i.x + i.w/2);
        const scoreRow = items.find(it=>it.str.trim()==='得分');
        const scoreY = scoreRow ? scoreRow.y : (fenzi.y + 21);
        result.scoreCols = { x: scoreX, y: scoreY, pageIndex:0 };
        const maxs = nums.map(i=>parseInt(i.str.trim(),10));
        result.detect.table = scoreX.length>=6;
        if(result.detect.table){
          for(let i=0;i<ITEM_NAMES.length;i++) result.items[i] = result.items[i] || {name:ITEM_NAMES[i], max:maxs[i], titleY:null, pageIndex:null};
        }
      }
    }

    // --- 图3 五大标题行：必须"下一行以【填写要求】开头"，过滤统分表格里的"一、" ---
    for(let i=0;i<lines.length;i++){
      const l = lines[i];
      const t = l.text;
      if(!/^[一二三四五六七]、/.test(t)) continue;

      // 找下一行(垂直距离<=NEXT_LINE_MAX_DIST)，校验以"填写要求"开头
      let next = null;
      for(let j=i+1;j<lines.length;j++){
        if(lines[j].y > l.y && lines[j].y - l.y <= NEXT_LINE_MAX_DIST){ next = lines[j]; break; }
      }
      if(!next || !next.text.startsWith('填写要求')) continue; // 表格干扰行被拒

      const m = t.match(/^([一二三四五六七])、(.*?)(（\s*\d+\s*分）)?/);
      if(!m) continue;
      const idx = ['一','二','三','四','五','六','七'].indexOf(m[1]);
      if(idx===undefined || idx>=ITEM_NAMES.length) continue;

      const maxM = t.match(/（\s*(\d+)\s*分）/);
      const max = maxM ? parseInt(maxM[1],10) : (result.items[idx] && result.items[idx].max) || 0;
      // titleY 用"距底"y(l.yUser)：叠加层通过 convertToViewportPoint 定位需要距底坐标
      result.items[idx] = { name: ITEM_NAMES[idx], max, titleY: l.yUser, pageIndex: p };
      foundIdx.add(idx);
    }
  }

  result.detect.titles = foundIdx.size >= 3;
  for(let i=0;i<ITEM_NAMES.length;i++){
    if(!result.items[i]) result.items[i] = {name:ITEM_NAMES[i], max:(result.items[i]&&result.items[i].max)||0, titleY:null, pageIndex:null};
  }
  return result;
}

/* ==================== 渲染所有页面(自适应中间栏) + 得分叠加（P1-5 缓存） ==================== */
async function renderPages(r){
  el.pdfHost.innerHTML = '';
  const centerEl = document.getElementById('center');
  const availW = Math.max(240, centerEl.clientWidth - 32); // 中间栏可用宽度(去掉padding)
  r._rendered = { titleOv: [], tableOv: [] };   // 缓存叠加层节点，供打分时局部刷新

  for(let p=0; p<r.pdf.numPages; p++){
    const page = await r.pdf.getPage(p+1);
    const vp1 = page.getViewport({scale:1});
    const scale = availW / vp1.width;          // 自适应：让页面宽度填满中间栏
    const vp = page.getViewport({scale});

    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap';
    wrap.style.width = vp.width + 'px';
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    wrap.appendChild(canvas);
    el.pdfHost.appendChild(wrap);

    const task = page.render({canvasContext: canvas.getContext('2d'), viewport: vp});
    await task.promise;
    addOverlays(r, wrap, p, vp, page);
  }
  fillOverlays(r);   // 叠加层文本统一填充
}

function px2(x,y,vp){ return vp.convertToViewportPoint(x,y); }

function addOverlays(r, wrap, pageIndex, vp, page){
  const a = r.analysis;
  const pageWidthPt = page.getViewport({scale:1}).width;

  // 标题行得分：格式"得分：N"，放在PDF文字区最右端内侧(不溢出页面)。文本由 fillOverlays 统一填。
  a.items.forEach((it, i)=>{
    if(it.pageIndex===pageIndex && it.titleY!=null){
      const rightX = pageWidthPt - 52;          // 文字区最右侧向内收一点
      const pt = px2(rightX, it.titleY, vp);
      const ov = document.createElement('div');
      ov.className = 'ov-score ov-title-score';
      ov.style.left = (pt[0]-120) + 'px';
      ov.style.top  = (pt[1]-22) + 'px';
      ov.style.width = '120px'; ov.style.textAlign='right';
      ov.dataset.jumpPage = pageIndex; ov.dataset.jumpY = it.titleY;
      wrap.appendChild(ov);
      r._rendered.titleOv.push({ node: ov, itemIndex: i });
    }
  });

  // 统分区得分回填(第1页)
  if(a.scoreCols && a.scoreCols.pageIndex===pageIndex){
    const sc = a.scoreCols;
    for(let i=0;i<sc.x.length;i++){
      const pt = px2(sc.x[i], sc.y, vp);
      const ov = document.createElement('div');
      ov.className = 'ov-score ov-table-score';
      ov.style.left = (pt[0]-6) + 'px';
      ov.style.top  = (pt[1]-14) + 'px';
      ov.style.width='24px'; ov.style.textAlign='center';
      wrap.appendChild(ov);
      r._rendered.tableOv.push(ov);
    }
  }
}

// 只更新叠加层文本，不重渲 canvas（P1-5）
function fillOverlays(r){
  if(!r._rendered) return;
  const total = r.scores.reduce((x,y)=>x+y,0);
  for(const t of r._rendered.titleOv){
    t.node.textContent = '得分：' + String(r.scores[t.itemIndex]||0);
  }
  const vals = [...r.scores, total];
  r._rendered.tableOv.forEach((node,i)=>{ node.textContent = String(vals[i]||0); });
}

function refreshOverlays(r){
  // 打分时只刷新叠加层文本；若未渲染过则先渲染
  if(!r || !r._rendered){ if(r) renderPages(r); return; }
  fillOverlays(r);
}

/* ==================== 评分面板 ==================== */
/* 已批标记（P0-3 修订）：仅在评分框内按 Enter 确认时才置为已批并变绿；
 * 单纯聚焦或输入数字不改变已批状态。 */
function markItemGraded(r, i){
  if(!r || !r.activated || r.activated[i]) return;
  r.activated[i] = true;
  const inp = S.scoreInputs && S.scoreInputs[i];
  if(inp){ inp.classList.remove('ungraded'); inp.classList.add('graded'); }
}
function buildScoreRows(r){
  el.scoreRows.innerHTML = '';
  const a = r.analysis;
  const inputs = [];
  a.items.forEach((it,i)=>{
    const max = (r.maxs && r.maxs[i] != null) ? r.maxs[i] : it.max;
    const row = document.createElement('div');
    row.className = 'score-row';
    const nm = document.createElement('span'); nm.className='name'; nm.textContent = (i+1)+'. '+it.name;
    const mx = document.createElement('span'); mx.className='max'; mx.textContent = '满分'+max;
    const inp = document.createElement('input');
    inp.type='number'; inp.min=0; inp.max=max; inp.inputMode='numeric';
    inp.value = (r.scores[i]!=null ? r.scores[i] : 0);
    inp.classList.add(r.activated[i] ? 'graded' : 'ungraded');   // 恢复时保留已批阅样式
    // 输入/聚焦都不算"已批"：只有在该评分框内按 Enter 确认后才标记已批并变绿（见 markItemGraded）
    inp.addEventListener('input', ()=>{
      const clean = inp.value.replace(/[^0-9]/g,'');
      if(clean !== inp.value) inp.value = clean;
      let n = clean==='' ? 0 : parseInt(clean,10);
      if(n>max){ n=max; inp.value=n; }
      r.scores[i]=n; updateTotal(r); refreshOverlays(r); saveState(r);
    });
    // 聚焦 → 记录当前项、立即全选已有分数以便直接输入（P0-2），不视为已批
    inp.addEventListener('focus', ()=>{
      S.selectedItem = i;
      inp.select();
      jumpToItem(i);
    });
    const cur = document.createElement('span'); cur.className='cur'; cur.textContent = '';
    row.appendChild(nm); row.appendChild(mx); row.appendChild(cur); row.appendChild(inp);
    el.scoreRows.appendChild(row);
    inputs.push(inp);
  });
  updateTotal(r);
  S.scoreInputs = inputs;   // 供全局 ← → 键切换焦点
}
function updateTotal(r){
  const total = r.scores.reduce((x,y)=>x+y,0);
  const maxAll = r.analysis.items.reduce((x,y)=>x+y.max,0);
  el.totalVal.textContent = total + ' / ' + maxAll;
  // P0-3：已批只由"提交"决定，满不满分都不自动标记已批
}

// 学生信息手动修改 → 更新 r.basic 并保存（P0-1）
['inpId','inpName','inpClass','inpExp'].forEach(id=>{
  el[id].addEventListener('change', ()=>{
    const r = S.current; if(!r) return;
    r.basic = { name:el.inpName.value, id:el.inpId.value, cls:el.inpClass.value, exp:el.inpExp.value };
    saveState(r);
  });
});

/* ==================== 定位：跳转到指定标题所在位置 ==================== */
function jumpToItem(i){
  const a = S.current && S.current.analysis;
  if(!a) return;
  const it = a.items[i];
  if(!it || it.titleY==null){ setErr('第'+(i+1)+'项标题未能定位'); return; }
  setErr('');
  const el2 = document.querySelector(`.ov-title-score[data-jump-page="${it.pageIndex}"]`);
  if(el2){ el2.scrollIntoView({behavior:'smooth', block:'center'}); }
}

/* ==================== 提交并切换到下一份报告 ==================== */
// 提交前检查：所有评分项都必须已批阅（activated 全为 true），否则拦截
function allItemsGraded(r){
  return !!(r.activated && r.activated.length) && r.activated.every(a=>a===true);
}
function submitAndNext(){
  const r = S.current;
  if(!r) return;
  if(!allItemsGraded(r)){
    const firstUngraded = r.activated.findIndex(a=>!a);
    if(firstUngraded >= 0){
      setErr('还有未批阅的项目，请先完成全部评分后再提交');
      S.selectedItem = firstUngraded;
      if(S.scoreInputs && S.scoreInputs[firstUngraded]){
        S.scoreInputs[firstUngraded].focus();   // 自动跳到第一个未批项
        jumpToItem(firstUngraded);
      }
    } else {
      setErr('尚未完成评分，无法提交');
    }
    return;
  }
  r.done = true;               // P0-3：统一"提交过 = 已批"
  r.submitted = true;
  r.submittedAt = Date.now();
  saveState(r);                // 提交即固化（P0-1）
  renderReportList();          // 刷新列表与三色统计
  const idx = S.reports.indexOf(r);
  if(S.reports.length > 1){
    const next = (idx + 1) % S.reports.length;
    selectReport(next);
    setDetect('✅ 已提交《' + r.name + '》，已切换到下一份');
  } else {
    setDetect('✅ 已提交《' + r.name + '》（共1份）');
  }
}
el.btnSubmitNext.onclick = submitAndNext;

/* ==================== 全局键盘 ==================== */
document.addEventListener('keydown', (e)=>{
  if(!S.current || !S.scoreInputs || !S.scoreInputs.length) return;
  const tag = document.activeElement && document.activeElement.tagName;
  const isInput = (tag === 'INPUT' || tag === 'TEXTAREA');

  // Ctrl+Enter：提交当前报告成绩并切换到下一份（P0-2）
  if(e.ctrlKey && (e.key === 'Enter' || e.key === '\r')){
    e.preventDefault(); submitAndNext(); return;
  }

  // Enter：焦点在输入框内 → 确认当前并移到下一项，不提交（P0-2）
  if(e.key === 'Enter' || e.key === '\r'){
    if(isInput){
      e.preventDefault();
      const info = [el.inpId, el.inpName, el.inpClass, el.inpExp];
      const infoIdx = info.indexOf(document.activeElement);
      if(infoIdx >= 0){
        // 学生信息框：移到下一个信息框；最后一个则跳到第一个评分框
        if(infoIdx < info.length-1){ info[infoIdx+1].focus(); }
        else { S.selectedItem = 0; S.scoreInputs[0].focus(); }
      } else {
        // 评分框：按 Enter 确认 → 标记已批并变色，然后移到下一评分框；最后一个则失焦
        const ci = S.scoreInputs.indexOf(document.activeElement);
        if(ci >= 0){
          markItemGraded(S.current, ci);
          saveState(S.current);
          if(ci < S.scoreInputs.length-1){ S.selectedItem = ci+1; S.scoreInputs[ci+1].focus(); }
          else { document.activeElement.blur(); }
        }
      }
      return;
    }
    return;   // 非输入框：Enter 不再提交（改由按钮 / Ctrl+Enter）
  }

  // ← → 全局切换打分项：切换焦点(自动全选已有分数) + 预览跳转到对应标题（P0-2）
  if(e.key === 'ArrowLeft' || e.key === 'ArrowRight'){
    e.preventDefault();
    if(e.key === 'ArrowLeft') S.selectedItem = Math.max(0, S.selectedItem - 1);
    else                      S.selectedItem = Math.min(S.scoreInputs.length - 1, S.selectedItem + 1);
    S.scoreInputs[S.selectedItem].focus();
    jumpToItem(S.selectedItem);
    return;
  }

  // 上下方向键：焦点不在输入框时阻止预览区默认滚动
  if(e.key === 'ArrowUp' || e.key === 'ArrowDown'){
    if(!isInput){ e.preventDefault(); }
  }
  // PgUp / PgDn：交给浏览器在 #center 滚动容器内自然翻页
});

/* ==================== 导出 ==================== */
async function loadCJKFont(doc){
  // 尝试嵌入中文字体(可选)：若 lib/cjk.ttf 存在则导出"得分："标签；否则仅导出数字
  const urls = ['lib/cjk.ttf','lib/simsun.ttf','lib/msyh.ttf'];
  for(const u of urls){
    try{
      const resp = await fetch(u);
      if(!resp.ok) continue;
      const buf = await resp.arrayBuffer();
      return await doc.embedFont(buf);
    }catch(e){ /* 继续尝试下一个 */ }
  }
  return null;
}

async function exportScoredPdf(){
  const r = S.current;
  if(!r){ setErr('请先打开报告'); return; }
  if(!S.pdflibOk){ setErr('pdf-lib 未加载, 无法导出'); return; }
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdfDoc = await PDFDocument.load(r.bytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const cjkFont = await loadCJKFont(pdfDoc);   // 有中文字体才写"得分："，否则只写数字
  const color = rgb(0.82, 0.05, 0.05);
  const a = r.analysis;

  for(let i=0;i<a.items.length;i++){
    const it = a.items[i];
    if(it.titleY==null) continue;
    const page = pdfDoc.getPage(it.pageIndex);
    const H = page.getHeight();
    const W = page.getWidth();
    const y = H - it.titleY;
    const label = '得分：';
    if(cjkFont){
      // 中文字体可渲染"得分："，右对齐到文字区最右端内侧
      const labelW = cjkFont.widthOfTextAtSize(label, 11);
      const num = String(r.scores[i]||0);
      const numW = font.widthOfTextAtSize(num, 11);
      const drawX = W - 70 - numW;   // 分数紧跟标签
      page.drawText(label, { x: drawX - labelW, y, size: 11, font: cjkFont, color });
      page.drawText(num, { x: drawX, y, size: 11, font, color });
    } else {
      // 无中文字体：仅导出数字，避免中文乱码
      const text = String(r.scores[i]||0);
      const w = font.widthOfTextAtSize(text, 11);
      page.drawText(text, { x: W - 70 - w, y, size: 11, font, color });
    }
  }
  // 统分区得分回填
  if(a.scoreCols){
    const sc = a.scoreCols;
    const page = pdfDoc.getPage(sc.pageIndex);
    const H = page.getHeight();
    const total = r.scores.reduce((x,y)=>x+y,0);
    const vals = [...r.scores, total];
    for(let i=0;i<sc.x.length;i++){
      const txt = String(vals[i]||0);
      const w = font.widthOfTextAtSize(txt, 11);
      page.drawText(txt, { x: sc.x[i] - w/2, y: H - sc.y, size: 11, font, color });
    }
  }

  const bytes = await pdfDoc.save();
  const blob = new Blob([bytes], {type:'application/pdf'});
  await deliverExport((r.name.replace(/\.pdf$/i,'') || 'report') + '_已批阅.pdf', blob);
  setErr('');
  setDetect('✅ 已导出带分PDF');
}
el.btnExport.onclick = exportScoredPdf;

function buildRecord(){
  const r = S.current;
  const a = r.analysis;
  const total = r.scores.reduce((x,y)=>x+y,0);
  const maxAll = a.items.reduce((x,y)=>x+y.max,0);
  return {
    teacher: S.teacher,
    studentId: el.inpId.value, name: el.inpName.value, cls: el.inpClass.value, exp: el.inpExp.value,
    fileName: r.name,
    items: a.items.map((it,i)=>({ name: it.name, max: it.max, score: r.scores[i], pageIndex: it.pageIndex })),
    total, maxTotal: maxAll, status: r.done ? '已批' : '待批',
  };
}

async function exportCsv(){
  const r = S.current; if(!r){ setErr('请先打开报告'); return; }
  const rec = buildRecord();
  const head = ['学号','姓名','班级','实验名称','批阅教师','一、'+rec.items[0].name,
    '二、'+rec.items[1].name,'三、'+rec.items[2].name,'四、'+rec.items[3].name,'五、'+rec.items[4].name,'总分','满分','状态','文件名'].join(',');
  const vals = [rec.studentId, rec.name, rec.cls, rec.exp, rec.teacher,
    ...rec.items.map(it=>it.score), rec.total, rec.maxTotal, rec.status, rec.fileName].join(',');
  await deliverExport((rec.studentId||'record')+'-'+rec.name+'-实验报告成绩.csv',
    new Blob(['\ufeff'+head+'\n'+vals+'\n'], {type:'text/csv;charset=utf-8'}));
  setErr(''); setDetect('✅ 已导出CSV');
}
el.btnSaveRecord.onclick = exportCsv;

async function exportJson(){
  const r = S.current; if(!r){ setErr('请先打开报告'); return; }
  await deliverExport((r.name.replace(/\.pdf$/i,'')||'record')+'_批阅记录.json',
    new Blob([JSON.stringify(buildRecord(),null,2)], {type:'application/json'}));
  setDetect('✅ 已导出JSON');
}
el.btnExportJson.onclick = exportJson;

function downloadBlob(blob, name){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 5000);
}

// 导出交付：Tauri 下写入 output/ 目录，否则浏览器下载
async function deliverExport(name, blob){
  if(window.__bridge && window.__bridge.saveToOutput && S.folder){
    try{
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await window.__bridge.saveToOutput(name, bytes);
      setDetect('✅ 已导出到 output/：' + name);
      return;
    }catch(e){ setErr('导出写入失败: ' + e); }
  }
  downloadBlob(blob, name);
}

/* ==================== 状态栏 ==================== */
function setFile(t){ el.stFile.textContent = t; }
function setDetect(t){ el.stDetect.textContent = t; }
function setErr(t){ el.stErr.textContent = t; }

/* 窗口尺寸变化时重新自适应渲染当前报告（仅此时全量重渲 canvas，P1-5） */
window.addEventListener('resize', ()=>{
  if(S.current){ renderPages(S.current); }
});

/* ==================== 名单 / 向导 / 未匹配（Tauri 整合） ==================== */
// —— 名单模板下载（exceljs 生成 xlsx）
function downloadRosterTemplate(){
  if(!window.ExcelJS){ setErr('exceljs 未加载，无法生成模板'); return; }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('学生名单');
  ws.columns = [
    { header: '学号', key: 'no', width: 16 },
    { header: '姓名', key: 'name', width: 12 },
    { header: '班级', key: 'cls', width: 18 },
  ];
  ws.addRow({ no: '2024010101', name: '张三', cls: '2024级临床1班' });
  ws.addRow({ no: '2024010102', name: '李四', cls: '2024级临床1班' });
  wb.xlsx.writeBuffer().then(buf=>{
    downloadBlob(new Blob([buf], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}), '学生名单模板.xlsx');
    setDetect('✅ 已下载名单模板');
  }).catch(()=> setErr('模板生成失败'));
}
el.btnDownloadTpl.onclick = downloadRosterTemplate;

// —— 名单导入解析（xlsx / xls / csv → [{no,name,cls}]）
async function parseRoster(file){
  const ext = (file.name.split('.').pop()||'').toLowerCase();
  if(ext === 'csv'){
    const text = await file.text();
    const rows = text.split(/\r?\n/).filter(Boolean);
    return rows.slice(1).map(line=>{
      const c = line.split(/[,，]/).map(x=>x.trim());
      return { no: c[0]||'', name: c[1]||'', cls: c[2]||'' };
    }).filter(r=>r.no || r.name);
  }
  if(!window.ExcelJS){ setErr('exceljs 未加载，无法解析 Excel'); return []; }
  const buf = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const out = [];
  ws.eachRow((row, rn)=>{
    if(rn === 1) return;   // 跳过表头
    const no   = String(row.getCell(1).value || '').trim();
    const name = String(row.getCell(2).value || '').trim();
    const cls  = String(row.getCell(3).value || '').trim();
    if(no || name) out.push({ no, name, cls });
  });
  return out;
}
el.btnImportStudents.onclick = () => el.rosterInput.click();
el.rosterInput.onchange = async (e)=>{
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if(!f) return;
  const list = await parseRoster(f);
  if(!list.length){ setErr('名单解析为空，请检查模板格式'); return; }
  S.students = list;
  el.wizHint.textContent = '✅ 已导入 ' + list.length + ' 名学生，可点「开始」';
  setDetect('✅ 名单已导入 ' + list.length + ' 人');
};

// —— 初始化向导
function openWizard(){
  el.wizardMask.style.display = 'flex';
  el.wizReportName.focus();
}
function closeWizard(){ el.wizardMask.style.display = 'none'; }
el.btnWizardCancel.onclick = closeWizard;
el.btnWizardStart.onclick = async ()=>{
  const reportName = el.wizReportName.value.trim();
  if(!reportName){ el.wizReportName.focus(); return; }
  if(!S.students.length){ setErr('请先导入学生名单'); return; }
  if(window.__bridge && window.__bridge.initBatch){
    await window.__bridge.initBatch(S.folder, reportName, S.students);
    closeWizard();
  } else {
    setErr('当前为浏览器模式，请用「载入报告文件夹」');
  }
};

// —— 未匹配弹窗
function showUnmatched(list){
  if(!list || !list.length) return;
  S.unmatched = list.slice();
  el.unmatchList.innerHTML = '';
  list.forEach((u)=>{
    const row = document.createElement('div');
    row.className = 'urow';
    const nm = document.createElement('span'); nm.className='uname'; nm.textContent = u.name;
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">— 挂到学生 —</option>' +
      S.students.map(s=>`<option value="${s.no}">${s.no}_${s.name}</option>`).join('') +
      '<option value="__skip">不导入</option>';
    const btn = document.createElement('button'); btn.textContent='确定';
    btn.onclick = async ()=>{
      const v = sel.value;
      if(!v){ setErr('请选择挂靠学生或「不导入」'); return; }
      if(window.__bridge && window.__bridge.resolveUnmatched){
        await window.__bridge.resolveUnmatched(S.folder, u, v);
      }
      row.remove();
      if(!el.unmatchList.children.length){ el.unmatchMask.style.display='none'; }
    };
    row.appendChild(nm); row.appendChild(sel); row.appendChild(btn);
    el.unmatchList.appendChild(row);
  });
  el.unmatchMask.style.display = 'flex';
}
el.btnUnmatchDone.onclick = ()=>{ el.unmatchMask.style.display='none'; };

// —— 暴露给 tauri-bridge 的公共接口
window.__app = { S, el, reportLabel, reportState, renderReportList, updateStats,
  selectReport, loadReports, saveState, initReportState, openWizard, closeWizard,
  showUnmatched, setFile, setDetect, setErr, downloadBlob, buildRecord };

//（注：内容由AI生成）
