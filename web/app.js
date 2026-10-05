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
  loginMask: $('loginMask'),
  cuUser: $('cuUser'), cuName: $('cuName'), cuPwd: $('cuPwd'), btnCreate: $('btnCreate'), cuErr: $('cuErr'),
  liUser: $('liUser'), liPwd: $('liPwd'), btnLogin2: $('btnLogin2'), liErr: $('liErr'),
  gotoLogin: $('gotoLogin'), gotoCreate: $('gotoCreate'), createPanel: $('createPanel'), loginPanel: $('loginPanel'),
  teacherLabel: $('teacherLabel'), btnLogin: $('btnLogin'),
  btnChangePwd: $('btnChangePwd'), pwdMask: $('pwdMask'), pwdUser: $('pwdUser'),
  pwdOld: $('pwdOld'), pwdNew: $('pwdNew'), pwdNew2: $('pwdNew2'), pwdErr: $('pwdErr'),
  btnPwdSave: $('btnPwdSave'), btnPwdCancel: $('btnPwdCancel'),
  prepView: $('prepView'), main: $('main'), btnPrepFolder: $('btnPrepFolder'), prepFolder: $('prepFolder'),
  pvSelbar: $('pvSelbar'), prepTable: $('prepTable'), prepTbody: $('prepTbody'), prepStats: $('prepStats'),
  prepRoster: $('prepRoster'), btnPrepBack: $('btnPrepBack'), btnPrepStart: $('btnPrepStart'),
  attachMask: $('attachMask'), attachBox: $('attachBox'), attachFile: $('attachFile'),
  attachSel: $('attachSel'), attachErr: $('attachErr'), btnAttachOk: $('btnAttachOk'), btnAttachCancel: $('btnAttachCancel'),
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
  btnOverview: $('btnOverview'), btnHelp: $('btnHelp'),
  helpPanel: $('helpPanel'),
  overviewMask: $('overviewMask'), overviewBody: $('overviewBody'), btnOverviewClose: $('btnOverviewClose'),
  itemMask: $('itemMask'), tplPreview: $('tplPreview'), itemList: $('itemList'), btnItems: $('btnItems'),
  btnItemAdd: $('btnItemAdd'), btnItemSave: $('btnItemSave'), btnItemCancel: $('btnItemCancel'),
  btnTotalMode: $('btnTotalMode'), btnTitleMode: $('btnTitleMode'), btnBasicMode: $('btnBasicMode'), totalInfo: $('totalInfo'), irState: $('irState'), irTpl: $('irTpl'),
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

/* ==================== 登录 / 创建账号 ==================== */
function applyLogin(){
  el.teacherLabel.textContent = S.teacher ? ('批阅教师：' + S.teacher) : '未登录';
}
function showCreate(){ el.createPanel.style.display='block'; el.loginPanel.style.display='none'; el.cuUser.focus(); }
function showLogin(){ el.createPanel.style.display='none'; el.loginPanel.style.display='block'; el.liUser.focus(); }

// 姓名 → 拼音首字母（初始密码）。覆盖常见姓氏/名字用字，识别不出的字跳过。
const PY_INIT = {
  李:'l',王:'w',张:'z',刘:'l',陈:'c',杨:'y',赵:'z',黄:'h',周:'z',吴:'w',徐:'x',孙:'s',胡:'h',朱:'z',高:'g',
  林:'l',何:'h',郭:'g',马:'m',罗:'l',梁:'l',宋:'s',郑:'z',谢:'x',韩:'h',唐:'t',冯:'f',于:'y',董:'d',萧:'x',
  程:'c',曹:'c',袁:'y',邓:'d',许:'x',傅:'f',沈:'s',曾:'z',彭:'p',吕:'l',苏:'s',卢:'l',蒋:'j',蔡:'c',贾:'j',
  丁:'d',魏:'w',薛:'x',叶:'y',余:'y',潘:'p',杜:'d',戴:'d',夏:'x',钟:'z',汪:'w',田:'t',任:'r',姜:'j',范:'f',
  方:'f',石:'s',姚:'y',谭:'t',廖:'l',邹:'z',熊:'x',金:'j',陆:'l',郝:'h',孔:'k',白:'b',崔:'c',康:'k',毛:'m',
  邱:'q',秦:'q',江:'j',史:'s',顾:'g',侯:'h',邵:'s',孟:'m',龙:'l',万:'w',段:'d',雷:'l',钱:'q',汤:'t',尹:'y',
  黎:'l',易:'y',常:'c',武:'w',乔:'q',贺:'h',赖:'l',龚:'g',文:'w',欧:'o',詹:'z',关:'g',焦:'j',柳:'l',
  永:'y',久:'j',伟:'w',芳:'f',娜:'n',敏:'m',静:'j',丽:'l',强:'q',磊:'l',军:'j',洋:'y',勇:'y',艳:'y',杰:'j',
  涛:'t',明:'m',超:'c',秀:'x',霞:'x',平:'p',刚:'g',桂:'g',英:'y',华:'h',玉:'y',梅:'m',红:'h',金:'j',鑫:'x',
  浩:'h',宇:'y',博:'b',瑞:'r',欣:'x',晨:'c',帆:'f',智:'z',慧:'h',凡:'f',凯:'k',文:'w',鹏:'p',飞:'f',翔:'x',
  峰:'f',光:'g',彬:'b',兰:'l',凤:'f',云:'y',洁:'j',琳:'l',琴:'q',萍:'p',雪:'x',春:'c',夏:'x',秋:'q',冬:'d',
  海:'h',波:'b',水:'s',山:'s',东:'d',南:'n',西:'x',北:'b',中:'z',国:'g',梦:'m',思:'s',心:'x',甜:'t',语:'y'
};
function namePinyinInitial(name){
  let s='';
  for(const ch of (name||'')){
    const c = PY_INIT[ch];
    if(c) s+=c;
  }
  return s;
}
el.cuName.addEventListener('input', ()=>{
  const p = namePinyinInitial(el.cuName.value.trim());
  if(p) el.cuPwd.value = p;
});
el.gotoLogin.onclick = showLogin;
el.gotoCreate.onclick = showCreate;

async function doLogin(){
  const u=el.liUser.value.trim(), p=el.liPwd.value;
  if(!u||!p){ el.liErr.textContent='请输入用户名和密码'; return; }
  el.liErr.textContent='';
  if(!window.__bridge || !window.__bridge.login){ el.liErr.textContent='当前环境不支持登录'; return; }
  try{
    const name = await window.__bridge.login(u, p);
    if(name){ S.teacher=name; S.loginUser=u; localStorage.setItem('loginUser',u); applyLogin(); el.loginMask.style.display='none'; showPrep(); }
    else el.liErr.textContent='用户名或密码错误';
  }catch(e){ el.liErr.textContent='登录失败: '+e; }
}
async function doCreate(){
  const u=el.cuUser.value.trim(), n=el.cuName.value.trim(), p=el.cuPwd.value.trim();
  if(!u||!n||!p){ el.cuErr.textContent='用户名 / 姓名 / 初始密码 都要填写'; return; }
  el.cuErr.textContent='';
  if(!window.__bridge){ el.cuErr.textContent='当前环境不支持'; return; }
  try{
    await window.__bridge.createUser(u, n, p);
    const name = await window.__bridge.login(u, p);
    if(name){ S.teacher=name; S.loginUser=u; localStorage.setItem('loginUser',u); applyLogin(); el.loginMask.style.display='none'; showPrep(); }
    else el.cuErr.textContent='创建成功但自动登录失败，请手动登录';
  }catch(e){ el.cuErr.textContent='创建失败: '+e; }
}
el.btnLogin2.onclick = doLogin;
el.liPwd.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); doLogin(); } });
el.btnCreate.onclick = doCreate;
el.cuPwd.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); doCreate(); } });
el.btnLogin.onclick = ()=>{ el.loginMask.style.display='flex'; showLogin(); el.liUser.focus(); };
applyLogin();

// 启动：检查全局用户库 → 无用户显示"创建账号"，有则显示"登录"（bridge 未就绪则轮询等待）
function initLoginGate(){
  if(!window.__bridge){ setTimeout(initLoginGate, 400); return; }
  if(!window.__bridge.listUsers){ el.loginMask.style.display='none'; return; }
  window.__bridge.listUsers().then(us=>{
    if(us && us.length) showLogin(); else showCreate();
    el.loginMask.style.display='flex';
  }).catch(()=>{ el.loginMask.style.display='none'; });
}

/* ==================== 修改密码 ==================== */
el.btnChangePwd.onclick = () => {
  if(!S.loginUser){ alert('请先登录'); return; }
  el.pwdUser.textContent = S.loginUser;
  el.pwdOld.value=''; el.pwdNew.value=''; el.pwdNew2.value=''; el.pwdErr.textContent='';
  el.pwdMask.style.display='flex';
  el.pwdOld.focus();
};
function closePwd(){ el.pwdMask.style.display='none'; }
el.btnPwdCancel.onclick = closePwd;
async function doChangePwd(){
  const oldv=el.pwdOld.value, nv=el.pwdNew.value, n2=el.pwdNew2.value;
  if(!oldv || !nv){ el.pwdErr.textContent='请填写原密码和新密码'; return; }
  if(nv !== n2){ el.pwdErr.textContent='两次输入的新密码不一致'; return; }
  if(nv.length < 4){ el.pwdErr.textContent='新密码至少 4 位'; return; }
  el.pwdErr.textContent='';
  try{
    await window.__bridge.changePassword(S.loginUser, oldv, nv);
    alert('密码修改成功');
    closePwd();
  }catch(e){ el.pwdErr.textContent='修改失败：' + e; }
}
el.btnPwdSave.onclick = doChangePwd;
el.pwdNew2.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); doChangePwd(); } });

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
/* ==================== 准备面板（第一块） ==================== */
S.prepChecked = {}; S.prepFilter = null; S.prepRange = 'increment';
function showPrep(){ S.inPrep = true; el.prepView.style.display='flex'; el.main.style.display='none'; }
function hidePrep(){ S.inPrep = false; el.prepView.style.display='none'; el.main.style.display='flex'; }
async function refreshPrepOverview(){
  if(!window.__bridge || !window.__bridge.prepOverview || !S.folder) return;
  try{
    const ov = await window.__bridge.prepOverview(S.folder);
    S.needsInit=false;
    S.prepOv = ov;
    el.prepFolder.textContent = S.folder;
    renderPrepTable(ov); renderPrepStats(ov); renderPrepRoster(); renderPrepSelbar();
  }catch(e){
    const msg = String(e);
    if(S.needsInit || /初始化|未找到批次/.test(msg)){
      S.needsInit=true;
      el.prepFolder.textContent = S.folder;
      el.prepTbody.innerHTML = '<tr><td colspan="9" style="color:#c62828;padding:24px;text-align:center">该文件夹尚未初始化。<br>请在右侧「名单管理」中导入学生名单完成初始化。</td></tr>';
      el.prepStats.innerHTML = '未初始化';
      el.prepRoster.innerHTML = '<div style="color:#c62828;font-size:13px;margin-bottom:6px">尚未导入学生名单</div>'+
        '<button onclick="window.__app.openPrepImport()">📋 导入学生名单（初始化）</button>';
      el.pvSelbar.innerHTML='';
    } else {
      setErr('准备盘点失败: ' + e);
    }
  }
}
function renderPrepTable(ov){
  const tbody = el.prepTbody; tbody.innerHTML='';
  const addTd = (tr, txt)=>{ const td=document.createElement('td'); td.textContent=(txt==null?'':String(txt)); tr.appendChild(td); };
  (ov.rows||[]).forEach((r,i)=>{
    const tr = document.createElement('tr');
    const tdC = document.createElement('td'); tdC.className='col-check';
    const cb = document.createElement('input'); cb.type='checkbox'; cb.dataset.i = i;
    cb.checked = !!(S.prepChecked && S.prepChecked[i]);
    cb.addEventListener('change', ()=>{ S.prepChecked[i]=cb.checked; });
    tdC.appendChild(cb); tr.appendChild(tdC);
    addTd(tr, r.matched ? r.stu_no : (r.ocr_no||''));
    addTd(tr, r.matched ? r.stu_name : (r.ocr_name||''));
    addTd(tr, r.matched ? r.stu_cls : (r.ocr_class||''));
    addTd(tr, r.report_name || r.ocr_exp || '');
    addTd(tr, r.fname || r.path || '');
    const tdM=document.createElement('td');
    const tm=document.createElement('span'); tm.className='tag '+(r.matched?'mat':'new'); tm.textContent=r.matched?'已挂靠':'待挂靠'; tdM.appendChild(tm); tr.appendChild(tdM);
    const tdG=document.createElement('td');
    const tg=document.createElement('span'); tg.className='tag '+(r.done?'done':'todo'); tg.textContent=r.done?'已批':(r.graded?'部分':'待批'); tdG.appendChild(tg); tr.appendChild(tdG);
    const tdO=document.createElement('td');
    const vb=document.createElement('button'); vb.className='opbtn view'; vb.textContent='查看';
    vb.onclick=()=>{ openAttachOrView(r,false); }; tdO.appendChild(vb);
    if(r.matched){
      const ab=document.createElement('button'); ab.className='opbtn attached'; ab.textContent='已挂靠'; tdO.appendChild(ab);
    } else {
      const ab=document.createElement('button'); ab.className='opbtn attach'; ab.textContent='挂靠';
      ab.onclick=()=>{ openAttachOrView(r,true); }; tdO.appendChild(ab);
    }
    tr.appendChild(tdO);
    tbody.appendChild(tr);
  });
}
function renderPrepStats(ov){
  const rows=ov.rows||[], missing=ov.missing||[];
  const done=rows.filter(r=>r.done).length, todo=rows.filter(r=>!r.done).length, unattach=rows.filter(r=>!r.matched).length;
  el.prepStats.innerHTML =
    '报告 <b>'+rows.length+'</b>' +
    '　缺交 <b class="s-miss">'+missing.length+'</b>' +
    '　待挂靠 <b class="s-new">'+unattach+'</b>' +
    '　已批 <b class="s-done">'+done+'</b>' +
    '　待批 <b class="s-todo">'+todo+'</b>';
}
async function renderPrepRoster(){
  const box=el.prepRoster;
  if(!window.__bridge || !window.__bridge.getRoster || !S.folder){ box.innerHTML='<div style="color:#888;font-size:13px">请先选择报告文件夹</div>'; return; }
  try{
    const list=await window.__bridge.getRoster(S.folder);
    if(!list || !list.length){
      box.innerHTML='<div style="color:#c62828;font-size:13px;margin-bottom:6px">尚未导入学生名单</div>'+
        '<button onclick="window.__app.openPrepImport()">📋 导入学生名单</button>'+
        '<button onclick="window.__app.openWizard()">下载名单模板</button>';
    } else {
      box.innerHTML='<div style="color:#64748b;font-size:12.5px;margin-bottom:6px">已导入 <b>'+list.length+'</b> 名同学</div>'+
        '<button onclick="window.__app.openPrepImport()">查阅 / 重新导入名单</button>';
    }
  }catch(e){ box.innerHTML='<div style="color:#888;font-size:13px">'+e+'</div>'; }
}
function renderPrepSelbar(){
  const el2=el.pvSelbar;
  if(!window.__bridge || !S.folder){ el2.innerHTML=''; return; }
  Promise.all([
    window.__bridge.getBasicFields(S.folder).catch(()=>[]),
    window.__bridge.getBatchItems(S.folder).catch(()=>[])
  ]).then(([bf,items])=>{
    const have = {
      no: bf.some(x=>x[0]==='no'), name: bf.some(x=>x[0]==='name'),
      cls: bf.some(x=>x[0]==='class'), exp: bf.some(x=>x[0]==='exp'),
      items: !!(items && items.length)
    };
    const fieldTag=(txt,ok)=>'<span class="pv-sel '+(ok?'ok':'miss')+'">'+txt+(ok?'✓':'✗')+'</span>';
    el2.innerHTML = fieldTag('学号',have.no)+fieldTag('姓名',have.name)+fieldTag('班级',have.cls)+
      fieldTag('报告名称',have.exp)+fieldTag('题目与分值',have.items)+
      '<button onclick="window.__app.openItemSetup()">设置模板（框选）</button>';
  }).catch(()=>{ el2.innerHTML=''; });
}
async function openAttachOrView(r, doAttach){
  if(doAttach){
    S.attachRow=r; el.attachFile.textContent='文件：'+(r.fname||r.path||''); el.attachErr.textContent='';
    const sel=el.attachSel; sel.innerHTML='';
    try{
      const list=await window.__bridge.getRoster(S.folder);
      if(!list.length){ el.attachErr.textContent='名单为空，请先导入名单'; return; }
      list.forEach(s=>{ const o=document.createElement('option'); o.value=s.no; o.textContent=s.no+'　'+(s.name||'')+'　'+(s.cls||''); sel.appendChild(o); });
      el.attachMask.style.display='flex';
    }catch(e){ el.attachErr.textContent='读取名单失败: '+e; }
  } else {
    alert('进入批改后可查看该报告预览。\n文件：'+(r.fname||r.path||''));
  }
}
async function doAttach(){
  const r=S.attachRow, no=el.attachSel.value;
  if(!no){ el.attachErr.textContent='请选择名单学生'; return; }
  try{
    await window.__bridge.resolveUnmatched(S.folder, {path:r.path}, no);
    el.attachMask.style.display='none';
    refreshPrepOverview();
  }catch(e){ el.attachErr.textContent='挂靠失败: '+e; }
}
el.btnAttachOk.onclick=doAttach;
el.btnAttachCancel.onclick=()=>{ el.attachMask.style.display='none'; };
el.btnPrepFolder.onclick=()=>{ if(el.btnLoadFolder.onclick) el.btnLoadFolder.onclick(); };
el.btnPrepBack.onclick=()=>{ hidePrep(); S.teacher=''; localStorage.removeItem('loginUser'); el.loginMask.style.display='flex'; showLogin(); };
el.btnPrepStart.onclick=()=>{
  const range=document.querySelector('input[name="prepRange"]:checked');
  const rv = range ? range.value : 'increment';
  S.prepRange = rv;
  const rows = (S.prepOv && S.prepOv.rows) || [];
  if(rv==='select'){
    const checked=Object.keys(S.prepChecked||{}).filter(i=>S.prepChecked[i]).map(Number);
    if(!checked.length){ setErr('请先在左侧表中勾选要批改的报告'); return; }
    S.prepFilter=new Set(checked.map(i=>(rows[i]||{}).key).filter(Boolean));
  } else if(rv==='increment'){
    S.prepFilter=new Set(rows.filter(r=>!r.done).map(r=>r.key).filter(Boolean));
  } else { S.prepFilter=null; }
  setErr('');
  hidePrep();
  if(S.reports && S.reports.length){ selectReport(0); setDetect('已进入批改'); }
  else setDetect('已进入批改界面，请载入报告');
};
window.prepBasicField = async function(){
  if(!S.folder){ setErr('请先选报告文件夹'); return; }
  if(!window.__bridge || !window.__bridge.readPdf){ setErr('仅 Tauri 模式支持'); return; }
  const tplPath = await window.__bridge.getTemplatePath(S.folder).catch(()=>null);
  if(!tplPath){ setErr('请先把空白模板 PDF 放到所选文件夹的 template/ 子目录'); return; }
  S.tplPath = tplPath;
  await openItemSetup();
  setItemMode('basic');
};
window.openPrepImport = function(){ openWizard(); };

initLibs();
initLoginGate();

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
    // 用批次评分项模板覆盖题名/满分（每题位置仍由 analyze 定位）
    if(S.itemsTemplate && S.itemsTemplate.length){
      S.itemsTemplate.forEach((tpl,i)=>{ if(analysis.items[i]){ analysis.items[i].name = tpl.item_name; analysis.items[i].max = tpl.max_score; analysis.items[i].score_x = tpl.score_x; } });
    }
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
      result.items[idx] = { name: ITEM_NAMES[idx], max, titleY: l.yUser, titleX: l.items[0].x, pageIndex: p };
      foundIdx.add(idx);
    }
  }

  result.detect.titles = foundIdx.size >= 3;
  for(let i=0;i<ITEM_NAMES.length;i++){
    if(!result.items[i]) result.items[i] = {name:ITEM_NAMES[i], max:(result.items[i]&&result.items[i].max)||0, titleY:null, titleX:null, pageIndex:null};
  }
  return result;
}

/* ============ 扫描版标题找图定位（用框选保存的标题图在报告页匹配） ============ */
function loadImg(src){ return new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error('图像加载失败')); i.src=src; }); }

// 用标题图(模板裁剪)在报告页面canvas上做模板匹配，返回最佳 {pageIndex,yUser,xUser,avg}
async function matchTitleInReport(r, titleImgSrc){
  try{
    const tplImg = await loadImg(titleImgSrc);
    const tw=96; const th=Math.max(4, Math.round(tplImg.height*tw/tplImg.width));
    const tp=document.createElement('canvas'); tp.width=tw; tp.height=th;
    const tpctx=tp.getContext('2d'); tpctx.drawImage(tplImg,0,0,tw,th);
    const tpd=tpctx.getImageData(0,0,tw,th).data;
    let best=null;
    for(let p=0;p<r.pdf.numPages;p++){
      const pg=r._pages[p]; if(!pg||!pg.canvas) continue;
      const cv=pg.canvas; const sc=tw/cv.width;
      const ph=Math.max(th+1, Math.round(cv.height*sc));
      const pc=document.createElement('canvas'); pc.width=tw; pc.height=ph;
      const pctx=pc.getContext('2d'); pctx.drawImage(cv,0,0,tw,ph);
      const imgd=pctx.getImageData(0,0,tw,ph).data;
      let bestAvg=1e9, bestY=0;
      const cnt=tw*th*3;
      for(let y0=0;y0<=ph-th;y0+=1){
        let diff=0;
        for(let ty=0;ty<th;ty++){
          const pRow=(y0+ty)*tw, tRow=ty*tw;
          for(let x=0;x<tw;x++){
            const po=(pRow+x)*4, to=(tRow+x)*4;
            diff += Math.abs(imgd[po]-tpd[to]) + Math.abs(imgd[po+1]-tpd[to+1]) + Math.abs(imgd[po+2]-tpd[to+2]);
          }
        }
        const avg=diff/cnt;
        if(avg<bestAvg){ bestAvg=avg; bestY=y0; }
      }
      const py=bestY/sc;
      const pt=pg.vp.convertToPdfPoint(0,py);
      const cand={ pageIndex:p, yUser:pt[1], xUser:pt[0], avg:bestAvg };
      if(!best || cand.avg<best.avg) best=cand;
    }
    return best;
  }catch(e){ return null; }
}

async function autoLocateTitles(r){
  const log=(m)=>{ if(window.__bridge && window.__bridge.log) window.__bridge.log('[定位] '+m); };
  if(!window.__bridge || !r || !r.analysis || !r.analysis.items) return;
  if(!S.itemsFull){
    try{ S.itemsFull = await window.__bridge.getBatchItems(S.folder); }
    catch(e){ S.itemsFull=[]; log('getBatchItems失败(可能未设置评分项): '+e); }
  }
  const full=(S.itemsFull||[]).filter(x=>x.item_index>=0 && x.title_img);
  log('itemsFull='+((S.itemsFull||[]).length)+' 含标题图='+full.length);
  if(!full.length){ log('无标题图，跳过找图'); return; }
  // 已存定位 → 直接复用
  if(window.__bridge.getReportLocate){
    try{
      const j=await window.__bridge.getReportLocate(S.folder, r.name);
      if(j){ log('复用已存定位 '+j.length+'B'); const loc=JSON.parse(j); (loc.items||[]).forEach(li=>{ const it=r.analysis.items[li.item_index]; if(it){ it.titleY=li.titleY; it.pageIndex=li.pageIndex; if(li.titleX!=null) it.titleX=li.titleX; } }); return; }
      else log('无已存定位，开始找图');
    }catch(e){ log('读定位失败: '+e); }
  }
  // 找图定位
  const locItems=[]; let changed=false;
  for(const tpl of full){
    const it=r.analysis.items[tpl.item_index]; if(!it) continue;
    if(it.titleY!=null){ locItems.push({item_index:tpl.item_index, titleY:it.titleY, pageIndex:it.pageIndex, titleX:it.titleX}); continue; }
    const found=await matchTitleInReport(r, tpl.title_img);
    log('题'+tpl.item_index+' 匹配avg='+(found?found.avg.toFixed(0):'null')+' 命中='+(!!(found&&found.avg<60)));
    if(found && found.avg<60){
      it.titleY=found.yUser; it.pageIndex=found.pageIndex; it.titleX=found.xUser;
      locItems.push({item_index:tpl.item_index, titleY:it.titleY, pageIndex:it.pageIndex, titleX:it.titleX});
      changed=true;
    }
  }
  log('找图完成 命中='+locItems.length+' 变化='+changed);
  if(changed && window.__bridge.saveReportLocate){
    const json=JSON.stringify({items:locItems});
    try{ await window.__bridge.saveReportLocate(S.folder, r.name, json); log('已保存定位 len='+json.length); }catch(e){ log('保存定位失败: '+e); }
    await renderPages(r);   // 重建，让打分区出现在定位后的标题行
  }
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
    if(!r._pages) r._pages = {};
    r._pages[p] = { canvas, vp };   // 供扫描版找图定位
    wrap.appendChild(canvas);
    el.pdfHost.appendChild(wrap);

    const task = page.render({canvasContext: canvas.getContext('2d'), viewport: vp});
    await task.promise;
    addOverlays(r, wrap, p, vp, page);
  }
  fillOverlays(r);   // 叠加层文本统一填充
  await autoLocateTitles(r);   // 扫描版标题找图定位（渲染后有页面canvas）
}

function px2(x,y,vp){ return vp.convertToViewportPoint(x,y); }

function addOverlays(r, wrap, pageIndex, vp, page){
  const a = r.analysis;
  const pageWidthPt = page.getViewport({scale:1}).width;

  // 标题行得分：格式"得分：N"，放在PDF文字区最右端内侧(不溢出页面)。文本由 fillOverlays 统一填。
  a.items.forEach((it, i)=>{
    if(it.pageIndex===pageIndex && it.titleY!=null){
      const rightX = (it.score_x!=null) ? it.score_x : (pageWidthPt - 52);
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

async function ensureLoaded(r){
  if(r.bytes && r.analysis) return;
  if(window.__bridge && window.__bridge.readPdf && S.folder){
    const data = await window.__bridge.readPdf(S.folder, r.path);
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const bytes = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    r.bytes = bytes;
    const pdfData = bytes.slice(0);
    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    r.pdf = pdf;
  }
  if(r.pdf && !r.analysis){
    const analysis = await analyze(r.pdf);
    if(S.itemsTemplate && S.itemsTemplate.length){
      S.itemsTemplate.forEach((tpl,i)=>{ if(analysis.items[i]){ analysis.items[i].name=tpl.item_name; analysis.items[i].max=tpl.max_score; analysis.items[i].score_x=tpl.score_x; } });
    }
    r.analysis = analysis;
  }
}

async function exportOne(r){
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdfDoc = await PDFDocument.load(r.bytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const cjkFont = await loadCJKFont(pdfDoc);
  const color = rgb(0.82, 0.05, 0.05);
  const a = r.analysis;
  for(let i=0;i<a.items.length;i++){
    const it = a.items[i];
    if(it.titleY==null) continue;
    const page = pdfDoc.getPage(it.pageIndex);
    const W = page.getWidth();
    const baseX = (it.score_x!=null) ? it.score_x : (W - 70);
    const y = it.titleY;            // PDF 用户空间 y(距底)，直接使用（修复坐标偏移）
    const label = '得分：';
    if(cjkFont){
      const labelW = cjkFont.widthOfTextAtSize(label, 11);
      const num = String(r.scores[i]||0);
      const numW = font.widthOfTextAtSize(num, 11);
      const drawX = baseX - numW;
      page.drawText(label, { x: drawX - labelW, y, size: 11, font: cjkFont, color });
      page.drawText(num, { x: drawX, y, size: 11, font, color });
    } else {
      const text = String(r.scores[i]||0);
      const w = font.widthOfTextAtSize(text, 11);
      page.drawText(text, { x: baseX - w, y, size: 11, font, color });
    }
  }
  if(a.scoreCols){
    const sc = a.scoreCols;
    const page = pdfDoc.getPage(sc.pageIndex);
    const total = r.scores.reduce((x,y)=>x+y,0);
    const vals = [...r.scores, total];
    for(let i=0;i<sc.x.length;i++){
      const txt = String(vals[i]||0);
      const w = font.widthOfTextAtSize(txt, 11);
      page.drawText(txt, { x: sc.x[i] - w/2, y: sc.y, size: 11, font, color });   // 修复 y
    }
  }
  const bytes = await pdfDoc.save();
  const blob = new Blob([bytes], {type:'application/pdf'});
  await deliverExport((r.name.replace(/\.pdf$/i,'') || 'report') + '_已批阅.pdf', blob);
}

async function exportScoredPdf(){
  try{
    if(!S.pdflibOk){ setErr('pdf-lib 未加载, 无法导出（检查 web/lib 目录）'); return; }
    const list = (S.reports||[]).filter(r=>r && !r.missing);
    if(!list.length){ setErr('没有可导出的报告'); return; }
    setDetect('⏳ 正在导出 ' + list.length + ' 份...');
    let ok=0, fail=0;
    for(const r of list){
      try{
        await ensureLoaded(r);
        if(!r.analysis){ fail++; continue; }
        await exportOne(r);
        ok++;
      }catch(e){
        fail++;
        if(window.__bridge && window.__bridge.log){ window.__bridge.log('exportOne 失败 '+(r.name||'')+': '+(e&&e.message?e.message:e)); }
      }
    }
    setErr('');
    setDetect('✅ 已导出 ' + ok + ' 份' + (fail ? '，失败 ' + fail + ' 份' : '') + ' 到 output/');
  }catch(e){
    setErr('导出失败: ' + (e && e.message ? e.message : e));
  }
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

async function fetchAllGrades(){
  if(window.__bridge && window.__bridge.getAllGrades && S.folder){
    return await window.__bridge.getAllGrades();
  }
  // 浏览器兜底：从当前 reports 构建
  return S.reports.filter(r=>r && r.student).map(r=>({
    no: (r.student&&r.student.no)||'', name: (r.student&&r.student.name)||'',
    cls: (r.student&&r.student.cls)||'',
    status: r.done ? 'submitted' : (r.missing ? 'missing' : 'pending'),
    draft: JSON.stringify({ scores: r.scores||[], maxs: r.maxs||[] }),
    fname: r.name||''
  }));
}

// 解析全量成绩 → 表格行（供 CSV 与概览表格共用）
function gradesToTable(rows){
  return (rows||[]).map(g=>{
    let scores=[], maxs=[];
    try{ const d = JSON.parse(g.draft||'{}'); scores = d.scores||[]; maxs = d.maxs||[]; }catch(e){}
    const total = (scores||[]).reduce((x,y)=>x+(Number(y)||0),0)||0;
    const maxTotal = (maxs||[]).reduce((x,y)=>x+(Number(y)||0),0)||0;
    return {
      no: g.no||'', name: g.name||'', cls: g.cls||'',
      scores, maxs, total, maxTotal,
      status: g.status==='submitted' ? '已批' : (g.status==='missing' ? '待提交' : '待批'),
      fname: g.fname||''
    };
  });
}
function csvEscape(v){ v = String(v==null?'':v); return /[",\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; }
function dateStamp(){ const d=new Date(); return d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0'); }

async function exportExcel(){
  if(!S.reports.length){ setErr('还没有报告可导出'); return; }
  if(!window.ExcelJS){ setErr('exceljs 未加载，无法导出Excel'); return; }
  let rows;
  try { rows = await fetchAllGrades(); } catch(e){ setErr('读取成绩失败: '+e); return; }
  const items = gradesToTable(rows);
  const n = Math.max(0, ...items.map(it=>it.scores.length));
  const head = ['学号','姓名','班级','批阅教师'];
  for(let i=0;i<n;i++) head.push('第'+(i+1)+'项');
  head.push('总分','满分','状态','文件名');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('全部成绩');
  ws.addRow(head);
  ws.getRow(1).font = { bold: true };
  items.forEach(it=>{
    const row = [it.no, it.name, it.cls, S.teacher||''];
    for(let i=0;i<n;i++) row.push(it.scores[i]||'');
    row.push(it.total, it.maxTotal||'', it.status, it.fname);
    ws.addRow(row);
  });
  const buf = await wb.xlsx.writeBuffer();
  await deliverExport('全部成绩_'+dateStamp()+'.xlsx',
    new Blob([buf], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  setErr(''); setDetect('已导出全部成绩Excel（'+items.length+'人）');
}
el.btnSaveRecord.onclick = exportExcel;

/* —— 批阅概览（表格弹窗）与 帮助 —— */
async function showOverview(){
  if(!S.reports.length){ setErr('还没有报告'); return; }
  let rows;
  try { rows = await fetchAllGrades(); } catch(e){ setErr('读取成绩失败: '+e); return; }
  const items = gradesToTable(rows);
  const n = Math.max(0, ...items.map(it=>it.scores.length));
  let h = '<table class="ov-table"><thead><tr><th>学号</th><th>姓名</th><th>班级</th>';
  for(let i=0;i<n;i++) h += '<th>第'+(i+1)+'项</th>';
  h += '<th>总分</th><th>满分</th><th>状态</th></tr></thead><tbody>';
  items.forEach(it=>{
    h += '<tr><td>'+(it.no||'')+'</td><td>'+(it.name||'')+'</td><td>'+(it.cls||'')+'</td>';
    for(let i=0;i<n;i++) h += '<td>'+(it.scores[i]||'')+'</td>';
    h += '<td>'+it.total+'</td><td>'+(it.maxTotal||'')+'</td>';
    h += '<td class="stc-'+it.status+'">'+it.status+'</td></tr>';
  });
  h += '</tbody></table>';
  el.overviewBody.innerHTML = h;
  el.overviewMask.style.display = 'flex';
}
el.btnOverview.onclick = showOverview;
el.btnOverviewClose.onclick = ()=> { el.overviewMask.style.display = 'none'; };

function toggleHelp(){
  const p = el.helpPanel;
  p.style.display = (p.style.display === 'none' || !p.style.display) ? 'block' : 'none';
}
el.btnHelp.onclick = toggleHelp;
// 点帮助面板以外的任意位置即关闭
document.addEventListener('click', (e)=>{
  const p = el.helpPanel;
  if(p && p.style.display === 'block' && !p.contains(e.target) && e.target !== el.btnHelp){
    p.style.display = 'none';
  }
});

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
function openWizard(){ el.wizardMask.style.display = 'flex'; }
function closeWizard(){ el.wizardMask.style.display = 'none'; }
el.btnWizardCancel.onclick = closeWizard;
el.btnWizardStart.onclick = async ()=>{
  if(!S.students.length){ setErr('请先导入学生名单'); return; }
  if(window.__bridge && window.__bridge.initBatch){
    await window.__bridge.initBatch(S.folder, '', S.students);   // 报告名称在挂靠/OCR 后补，向导中不再设置
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
  showUnmatched, setFile, setDetect, setErr, downloadBlob, buildRecord,
  openItemSetup, ensureItemsSetup,
  showPrep, hidePrep, refreshPrepOverview, openPrepImport, prepBasicField };

//（注：内容由AI生成）
/* ==================== 评分项模板设置（步骤一） ==================== */
let S_ITEMS = [];        // 手动添加的项
let S_TPL_RECTS = [];    // 模板框选矩形 {x,y,w,h,pageIndex,text,item_name,max_score}
let S_BASIC_MODE = false;   // 框选基本信息模式
let S_BASIC_FIELDS = [];    // 基本信息框 {type,label,pageIndex,x,y,w,h,text}（no/name/class/exp）
let S_ocrWorker = null;  // OCR worker（懒加载，复用）
let S_tplScale = 1;      // 模板预览缩放（冗余引用，避免误删）

// 进入批次后：若还没有评分项模板则弹设置框；已有则直接用
async function ensureItemsSetup(force){
  if(!window.__bridge || !window.__bridge.getBatchItems){ return; }
  const items = await window.__bridge.getBatchItems(S.folder).catch(e=>{ setErr('⚠ '+e); return null; });
  if(items && items.length && !force){
    S.totalRegion = (items.find(x=>x.item_index<0)||{}).total_region || null;
    S.itemsTemplate = items.filter(x=>x.item_index>=0).map(x=>({item_name:x.item_name, max_score:x.max_score, score_x:x.score_x||0}));
    if(window.__bridge.log) window.__bridge.log('已存在评分项 N='+S.itemsTemplate.length+' 项，直接沿用（force='+(force?1:0)+'）');
    setDetect('已设置 '+S.itemsTemplate.length+' 项评分项，如需修改点「✏️ 设置评分项」');
    return;
  }
  const tplPath = await window.__bridge.getTemplatePath(S.folder).catch(()=>null);
  if(!tplPath){
    // 无模板：显示引导遮罩，提示教师把空白模板 PDF 放到 template/ 子目录
    const g=document.getElementById('tplGuideMask');
    if(g){
      const gp=document.getElementById('tplGuidePath');
      if(gp) gp.textContent = S.folder.replace(/[\\\/]+$/,'') + '\\template\\';
      g.style.display='flex';
      const ok=document.getElementById('btnTplGuideOk');
      ok.onclick = async ()=>{
        const tp = await window.__bridge.getTemplatePath(S.folder).catch(()=>null);
        if(!tp){ setErr('还没检测到模板，请确认已放入 template/ 目录'); return; }
        g.style.display='none';
        S.tplPath=tp;
        await openItemSetup();
      };
      const sk=document.getElementById('btnTplGuideSkip');
      sk.onclick = ()=>{ g.style.display='none'; };
    } else {
      setErr('请先把空白模板 PDF 放到所选文件夹的 template/ 子目录，再重新载入');
    }
    return;
  }
  S.tplPath = tplPath;
  await openItemSetup();
}

async function openItemSetup(){
  try{
    if(!window.__bridge || !window.__bridge.readPdf){ setErr('仅 Tauri 模式支持评分项设置'); return; }
    el.itemMask.style.display='flex';
    if(!S.tplPath){
      const tp = await window.__bridge.getTemplatePath(S.folder).catch(()=>null);
      if(tp) S.tplPath = tp;
    }
    renderTplBar();
    if(S.tplPath){ await loadTemplatePreview(); }
  }catch(e){ setErr('加载模板失败: '+e); }
}
function renderTplBar(){
  const host=el.irTpl; if(!host) return;
  if(S.tplPath){
    host.innerHTML = '<div class="ir-tpl-ok">✓ 模板已载入</div><div class="ir-tpl-path">'+S.tplPath+'</div><button onclick="window.pickTpl()">重新指定模板</button>';
  } else {
    host.innerHTML = '<div class="ir-tpl-miss">✗ 尚未指定模板</div><div class="ir-tpl-hint">必须先指定空白模板 PDF，才能开始框选。</div><button onclick="window.pickTpl()">指定模板</button>';
  }
  const disabled = !S.tplPath;
  [el.btnBasicMode,el.btnTitleMode,el.btnTotalMode,el.btnItemAdd].forEach(b=>{ if(b){ b.style.pointerEvents=disabled?'none':'auto'; b.style.opacity=disabled?0.5:1; } });
}
async function loadTemplatePreview(){
  try{
    const bytes = await window.__bridge.readPdf(S.folder, S.tplPath);
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    S.tplPdf = pdf;
    renderTemplatePreview();
  }catch(e){ setErr('加载模板失败: '+e); }
}
window.pickTpl = async function(){
  if(!window.__bridge || !window.__bridge.pickTemplate){ setErr('仅 Tauri 模式支持'); return; }
  const tp = await window.__bridge.pickTemplate(S.folder).catch(e=>{ setErr('⚠ '+e); return null; });
  if(tp){ S.tplPath = tp; renderTplBar(); await loadTemplatePreview(); }
};

let S_TOTAL_RECT = null;   // 统分区框选 {x,y,w,h,count}
let S_TOTAL_MODE = false;

function renderTemplatePreview(){
  const pre = el.tplPreview;
  pre.innerHTML='';
  S_ITEMS=[]; S_TPL_RECTS=[]; S_TOTAL_RECT=null; S_TOTAL_MODE=false; S_BASIC_MODE=false; S_BASIC_FIELDS=[]; S.selBox=null;
  setItemMode('title');
  if(el.totalInfo) el.totalInfo.style.display='none';
  const inner=document.createElement('div');
  inner.style.position='relative'; inner.style.width='100%';
  pre.appendChild(inner);
  S.tplInner=inner;
  S.tplTextCache={};   // 重置每页文本层缓存
  renderItemList();   // 渲染前先显示表格（含空占位），避免"没有表格"的观感
  S.tplPdf.getPage(1).then(async (page1)=>{
    const pvp1 = page1.getViewport({scale:1});
    const availW = Math.max(300, pre.clientWidth-4);
    const scale = availW / pvp1.width;
    S.tplScale = scale;
    const numPages = S.tplPdf.numPages;
    const pages = [];
    let totalH = 0;
    for(let pi=1; pi<=numPages; pi++){
      const page = await S.tplPdf.getPage(pi);
      const vp = page.getViewport({scale});
      const canvas=document.createElement('canvas');
      canvas.width=vp.width; canvas.height=vp.height;
      canvas.style.position='absolute'; canvas.style.left='0'; canvas.style.top=totalH+'px';
      canvas.dataset.page=pi;
      inner.appendChild(canvas);
      await page.render({canvasContext:canvas.getContext('2d'), viewport:vp}).promise;
      pages[pi]={ canvas, vp, height: vp.height, offset: totalH };
      totalH += vp.height;
    }
    inner.style.height=totalH+'px';
    S.tplPages=pages; S.tplTotalH=totalH;
    S.tplVp=pages[1].vp; S.tplPage=pages[1];
    S.tplTextItems=await getPageText(page1);
    bindTemplateDrag();
    renderItemList();
    if(window.__bridge && window.__bridge.log) window.__bridge.log('模板渲染完成 页数='+numPages+' 高='+Math.round(totalH));
  }).catch(e=>setErr('渲染模板失败: '+e));
}

function pageByAbsY(absY){
  const ps=S.tplPages; if(!ps) return 1;
  for(let pi=1; pi<ps.length; pi++){
    if(absY>=ps[pi].offset && absY < ps[pi].offset+ps[pi].height) return pi;
  }
  return Math.max(1, (ps?ps.length-1:1));
}

function bindTemplateDrag(){
  const pre = el.tplPreview;
  let drag=null;
  const xAbs=(e,r)=> e.clientX - r.left;
  const yAbs=(e,r)=> e.clientY - r.top + pre.scrollTop;
  pre.onmousedown=(e)=>{
    const t=e.target;
    if(t && t.classList){
      if(t.classList.contains('tpl-del')){      // 右上角删除按钮
        const i=parseInt(t.dataset.idx,10);
        S_TPL_RECTS.splice(i,1); S.selBox=null;
        renderTitleBoxes(); renderItemList(); renderScoreBoxes();
        e.preventDefault(); e.stopPropagation(); return;
      }
      if(t.classList.contains('tpl-resize')){   // 右下角缩放手柄
        drag={mode:'resize', idx:parseInt(t.dataset.idx,10), x0:e.clientX, y0:e.clientY};
        return;
      }
      if(t.classList.contains('tpl-basic-del')){   // 基本信息框删除
        const i=parseInt(t.dataset.bidx,10);
        S_BASIC_FIELDS.splice(i,1);
        renderBasicBoxes(); renderItemList();
        e.preventDefault(); e.stopPropagation(); return;
      }
      if(t.classList.contains('tpl-basic')){   // 基本信息框移动
        drag={mode:'bmove', bidx:parseInt(t.dataset.bidx,10), x0:e.clientX, y0:e.clientY};
        return;
      }
      const boxEl = t.classList.contains('tpl-box') ? t : (t.closest ? t.closest('.tpl-box') : null);
      const scoreEl = t.classList.contains('tpl-score') ? t : (t.closest ? t.closest('.tpl-score') : null);
      const hitEl = boxEl || scoreEl;
      if(hitEl && !hitEl.classList.contains('active') && hitEl.dataset.idx!=null){
        S.selBox = parseInt(hitEl.dataset.idx,10);
        renderTitleBoxes();
        const isScore = !!scoreEl;
        drag={mode:isScore?'score':'move', idx:S.selBox, x0:e.clientX, y0:e.clientY};
        return;
      }
    }
    S.selBox=null; renderTitleBoxes();
    const r=pre.getBoundingClientRect();
    drag={mode:'new', x0:xAbs(e,r), y0:yAbs(e,r)};
  };
  pre.onmousemove=(e)=>{
    if(!drag) return;
    const r=pre.getBoundingClientRect();
    if(drag.mode==='new'){
      const x=xAbs(e,r), y=yAbs(e,r);
      const box=Math.min(drag.x0,x), bbox=Math.min(drag.y0,y);
      const w=Math.abs(x-drag.x0), h=Math.abs(y-drag.y0);
      pre.querySelectorAll('.tpl-box.active').forEach(n=>n.remove());
      const d=document.createElement('div');
      d.className='tpl-box active';
      d.style.left=box+'px'; d.style.top=bbox+'px'; d.style.width=w+'px'; d.style.height=h+'px';
      (S.tplInner||pre).appendChild(d);
    } else if(drag.mode==='bmove'){
      const br=S_BASIC_FIELDS[drag.bidx]; if(!br) return;
      const dx=e.clientX-drag.x0, dy=e.clientY-drag.y0;
      drag.x0=e.clientX; drag.y0=e.clientY;
      br.x=Math.max(0, Math.round(br.x+dx)); br.y=Math.max(0, Math.round(br.y+dy));
      renderBasicBoxes();
    } else {
      const rt=S_TPL_RECTS[drag.idx];
      if(!rt) return;
      const dx=e.clientX-drag.x0, dy=e.clientY-drag.y0;
      drag.x0=e.clientX; drag.y0=e.clientY;
      if(drag.mode==='score'){
        const ndx = Math.max(0, Math.round(rt.scoreX + dx));
        S_TPL_RECTS.forEach(rt2=>{ rt2.scoreX = ndx; });   // 打分区统一对齐同一竖列，调一个全联动
        renderScoreBoxes();
      } else if(drag.mode==='resize'){
        rt.w=Math.max(14, Math.round(rt.w+dx));
        rt.h=Math.max(12, Math.round(rt.h+dy));
        renderTitleBoxes(); renderScoreBoxes();
      } else {
        rt.x=Math.max(0, Math.round(rt.x+dx));
        rt.y=Math.max(0, Math.round(rt.y+dy));
        renderTitleBoxes(); renderScoreBoxes();
      }
    }
  };
  pre.onmouseup=(e)=>{
    if(!drag) return;
    const r=pre.getBoundingClientRect();
    if(drag.mode==='new'){
      const x0=drag.x0,y0=drag.y0,x=xAbs(e,r),y=yAbs(e,r);
      const box=Math.min(x0,x),bbox=Math.min(y0,y),w=Math.abs(x-x0),h=Math.abs(y-y0);
      if(w>=8 && h>=8){
        pre.querySelectorAll('.tpl-box.active').forEach(n=>n.remove());
        if(S_BASIC_MODE){
          addBasicBox(box,bbox,w,h);
        } else if(S_TOTAL_MODE){
          setItemMode('title');
          S_TOTAL_RECT={x:box,y:bbox,w:w,h:h,count:Math.max(1,S_TPL_RECTS.length+1)};
          renderTotalBox();
        } else {
          addTemplateBox(box,bbox,w,h);
        }
      } else {
        pre.querySelectorAll('.tpl-box.active').forEach(n=>n.remove());
      }
    }
    drag=null;
  };
}

// 从 OCR 识别出的标题中提取括号内分数，如 "一、实验目的与原理（30分）" → {title:"一、实验目的与原理", score:30}
function parseTitleScore(txt){
  let title=(txt||'').replace(/\s+/g,' ').trim();
  let score='';
  const m=title.match(/[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/);
  if(m){ score=m[1]; title=title.replace(m[0],'').trim(); }
  return { title, score: score?Number(score):'' };
}

function addTemplateBox(box,bbox,w,h){
  const pi = pageByAbsY(bbox);
  const off = S.tplPages[pi].offset;
  const rt={pageIndex:pi, x:box, y:bbox-off, w:w, h:h, text:'', item_name:'', max_score:20, title_img:''};
  rt.title_img = cropTemplate(rt) || '';   // 存标题裁剪图，供扫描版找图定位
  const pageW = S.tplPages[pi].vp.width;
  rt.scoreX = pageW - 80;   // 打分区默认落在文字区最右（页面右侧留边距），可拖动微调
  el.tplPreview.querySelectorAll('.tpl-box.active').forEach(n=>n.remove());   // 清理拖选残留临时框
  S_TPL_RECTS.push(rt);
  renderTitleBoxes(); renderItemList(); renderScoreBoxes();
  runOcr(rt).then(name=>{
    if(rt && name && name.trim()){
      const p = parseTitleScore(name.trim());
      rt.item_name = p.title;
      if(p.score) rt.max_score = p.score;
      renderItemList();
    }
  }).catch(()=>{});
}

// 基本信息框选：依次框选 学号→姓名→班级→报告名称
function addBasicBox(box,bbox,w,h){
  const pi = pageByAbsY(bbox);
  const off = S.tplPages[pi].offset;
  const types=[['no','学号'],['name','姓名'],['class','班级'],['exp','报告名称']];
  const idx = S_BASIC_FIELDS.length;
  const type = types[idx] || ['ext','字段'+(idx+1)];
  const rt={type:type[0], label:type[1], pageIndex:pi, x:box, y:bbox-off, w:w, h:h, text:''};
  el.tplPreview.querySelectorAll('.tpl-box.active').forEach(n=>n.remove());
  S_BASIC_FIELDS.push(rt);
  renderBasicBoxes(); renderItemList();
  runOcr(rt).then(t=>{
    if(rt && t && t.trim()){
      rt.text = parseBasicValue(t.trim(), type[0]);
      renderBasicBoxes(); renderItemList();
    }
  }).catch(()=>{});
}
function parseBasicValue(txt, type){
  if(type==='no'){ const m=(txt||'').match(/\d{4,}/); return m ? m[0] : txt; }   // 学号取数字串
  return txt.replace(/\s+/g,' ').trim();
}
function renderBasicBoxes(){
  const pre = el.tplPreview;
  const host = S.tplInner||pre;
  pre.querySelectorAll('.tpl-basic').forEach(n=>n.remove());
  S_BASIC_FIELDS.forEach((rt,i)=>{
    const off=S.tplPages[rt.pageIndex].offset;
    const d=document.createElement('div'); d.className='tpl-basic'; d.dataset.bidx=i;
    d.style.left=rt.x+'px'; d.style.top=(off+rt.y)+'px'; d.style.width=rt.w+'px'; d.style.height=rt.h+'px';
    d.style.pointerEvents='auto'; d.style.cursor='move';
    d.title='基本信息框：'+rt.label+'（拖动移动）';
    const lab=document.createElement('div'); lab.className='tpl-basic-label';
    lab.textContent=rt.label+(rt.text?('：'+rt.text):'');
    d.appendChild(lab);
    const dl=document.createElement('div'); dl.className='tpl-basic-del'; dl.textContent='×'; dl.dataset.bidx=i;
    d.appendChild(dl);
    host.appendChild(d);
  });
}

function renderTitleBoxes(){
  const pre = el.tplPreview;
  const host = S.tplInner||pre;
  pre.querySelectorAll('.tpl-box:not(.active)').forEach(n=>n.remove());
  S_TPL_RECTS.forEach((rt,i)=>{
    const off=S.tplPages[rt.pageIndex].offset;
    const d=document.createElement('div'); d.className='tpl-box'+(S.selBox===i?' sel':''); d.dataset.idx=i;
    d.style.left=rt.x+'px'; d.style.top=(off+rt.y)+'px'; d.style.width=rt.w+'px'; d.style.height=rt.h+'px';
    d.style.pointerEvents='auto'; d.style.cursor='move';
    d.title='拖动移动；右下角拉大/缩小；右上角删除';
    const idx=document.createElement('span'); idx.className='tpl-idx'; idx.textContent=(i+1)+'.';
    d.appendChild(idx);
    const lab=document.createElement('div'); lab.className='tpl-label';
    lab.textContent=(rt.item_name||('题目'+(i+1)))+(rt.max_score?('　'+rt.max_score+'分'):'');
    d.appendChild(lab);
    const rz=document.createElement('div'); rz.className='tpl-resize'; rz.dataset.idx=i; d.appendChild(rz);
    const dl=document.createElement('div'); dl.className='tpl-del'; dl.textContent='×'; dl.dataset.idx=i; d.appendChild(dl);
    host.appendChild(d);
  });
}

function renderScoreBoxes(){
  const pre = el.tplPreview;
  const host = S.tplInner||pre;
  pre.querySelectorAll('.tpl-score').forEach(n=>n.remove());
  S_TPL_RECTS.forEach((rt,i)=>{
    const off=S.tplPages[rt.pageIndex].offset;
    const d=document.createElement('div'); d.className='tpl-score'; d.dataset.idx=i;
    d.style.left=(rt.scoreX-13)+'px'; d.style.top=(off+rt.y)+'px'; d.style.width='26px'; d.style.height=(rt.h)+'px';
    d.style.pointerEvents='auto'; d.style.cursor='ew-resize';
    d.title='拖动可左右调整打分区位置';
    host.appendChild(d);
  });
}

async function textLayerMatch(rt){
  try{
    if(!S.tplPdf || !S.tplPages) return '';
    if(!S.tplTextCache) S.tplTextCache={};
    if(!S.tplTextCache[rt.pageIndex]){
      S.tplTextCache[rt.pageIndex] = await getPageText(await S.tplPdf.getPage(rt.pageIndex));
    }
    const vp = S.tplPages[rt.pageIndex].vp;
    const items = S.tplTextCache[rt.pageIndex] || [];
    const hit=[];
    for(const it of items){
      const p = vp.convertToViewportPoint(it.x, it.y);
      if(p[0]>=rt.x-6 && p[0]<=rt.x+rt.w+6 && p[1]>=rt.y-6 && p[1]<=rt.y+rt.h+6) hit.push(it);
    }
    hit.sort((a,b)=>(a.yTop-b.yTop)||(a.x-b.x));
    return hit.map(i=>i.str.trim()).filter(Boolean).join(' ');
  }catch(e){ return ''; }
}
async function runOcr(rt){
  // 优先文本层识别（模板有文本层时最准，不依赖挂起的 OCR worker）
  try{
    const txt = await textLayerMatch(rt);
    if(txt && txt.trim()) return txt.trim();
  }catch(e){}
  // 后端 Windows OCR 备用（扫描版无文本层时）
  try{
    const img = cropTemplate(rt);
    if(img && window.__bridge && window.__bridge.ocrImageB64){
      const b64 = img.indexOf(',')>=0 ? img.split(',')[1] : img;
      const t = await window.__bridge.ocrImageB64(b64);
      if(t && t.trim()) return t.trim();
    }
    if(window.__bridge && window.__bridge.log) window.__bridge.log('后端 OCR 返回空');
  }catch(e){ if(window.__bridge && window.__bridge.log) window.__bridge.log('后端 OCR 失败: '+String(e&&e.message||e)); }
  return '';
}
async function ensureOcrWorker(){
  if(S_ocrWorker) return S_ocrWorker;
  const abs = (rel)=> new URL(rel, location.href).href;
  const workerPath = abs('./lib/ocr/package/dist/worker.min.js');
  const corePath = abs('./lib/ocr/package/tesseract-core-lstm.wasm.js');
  const langPath = abs('./lib/ocr/');
  if(window.__bridge && window.__bridge.log) window.__bridge.log('OCR 启动 workerPath='+workerPath);
  if(window.__bridge && window.__bridge.log) window.__bridge.log('OCR createWorker 开始(blob模式)');
  S_ocrWorker = await Tesseract.createWorker({
    workerPath, corePath, langPath,
    workerBlobURL: true,
    logger: m=>{ if(window.__bridge && window.__bridge.log && m && m.status) window.__bridge.log('OCR '+m.status); },
    errorHandler: e=>{ if(window.__bridge && window.__bridge.log) window.__bridge.log('OCR worker 错误: '+String(e&&e.message||e)); }
  }).catch(err=>{
    if(window.__bridge && window.__bridge.log) window.__bridge.log('OCR createWorker 失败: '+String(err&&err.message||err));
    throw err;
  });
  if(window.__bridge && window.__bridge.log) window.__bridge.log('OCR createWorker OK');
  await S_ocrWorker.loadLanguage('chi_sim');
  if(window.__bridge && window.__bridge.log) window.__bridge.log('OCR chi_sim 语言已加载');
  await S_ocrWorker.initialize('chi_sim');
  if(window.__bridge && window.__bridge.log) window.__bridge.log('OCR worker 就绪 chi_sim');
  return S_ocrWorker;
}
async function recognizeOcr(img){
  if(!window.Tesseract) throw new Error('OCR 未加载');
  const w = await ensureOcrWorker();
  const { data } = await w.recognize(img);
  return (data && data.text) || '';
}
function cropTemplate(rt){
  const ps=S.tplPages; if(!ps) return null;
  const pg=ps[rt.pageIndex]; if(!pg || !pg.canvas) return null;
  const canvas = pg.canvas;
  const pad=3;
  const out=document.createElement('canvas');
  out.width=Math.max(4, Math.round(rt.w+pad*2));
  out.height=Math.max(4, Math.round(rt.h+pad*2));
  try{ out.getContext('2d').drawImage(canvas, rt.x-pad, rt.y-pad, rt.w+pad*2, rt.h+pad*2, 0, 0, out.width, out.height); }catch(e){ return null; }
  return out.toDataURL('image/png');
}
// 选择模板 PDF（系统对话框）→ 复制到 template/ → 打开框选
async function pickTemplateAndSetup(){
  if(!window.__bridge || !window.__bridge.pickTemplate){ setErr('仅 Tauri 模式支持选择模板'); return; }
  const tpl = await window.__bridge.pickTemplate(S.folder).catch(e=>{ setErr('⚠ '+e); return null; });
  if(!tpl) return;   // 用户取消
  S.tplPath = tpl;
  const g=document.getElementById('tplGuideMask'); if(g) g.style.display='none';
  await openItemSetup();
}
(function bindTplPick(){
  const b1=document.getElementById('btnTplGuidePick');
  if(b1) b1.onclick = ()=> pickTemplateAndSetup();
  const b2=document.getElementById('btnItemPickTpl');
  if(b2) b2.onclick = ()=> pickTemplateAndSetup();
  // 主界面「设置评分项」：强制重新进入框选设置
  if(el.btnItems) el.btnItems.onclick = ()=> ensureItemsSetup(true);
})();

// ==================== 评分项列表渲染 & 按钮绑定（恢复） ====================
function renderItemList(){
  const out=[];
  S_BASIC_FIELDS.forEach((rt,i)=>{
    const div=document.createElement('div'); div.className='irow';
    const no=document.createElement('span'); no.className='ino'; no.textContent=rt.label;
    const val=document.createElement('input'); val.type='text'; val.value=rt.text||''; val.placeholder=rt.label;
    val.style.flex='1'; val.style.color='#6a1b9a';
    val.oninput=()=>{ rt.text=val.value; };
    const del=document.createElement('button'); del.textContent='删';
    del.onclick=()=>{ S_BASIC_FIELDS.splice(i,1); renderBasicBoxes(); renderItemList(); };
    div.appendChild(no); div.appendChild(val); div.appendChild(del);
    out.push(div);
  });
  S_TPL_RECTS.forEach((rt,i)=>{
    const div=document.createElement('div'); div.className='irow';
    const no=document.createElement('span'); no.className='ino'; no.textContent=(i+1)+'.';
    const name=document.createElement('input'); name.type='text';
    name.value=rt.item_name||''; name.placeholder='题名(OCR后自动填入)';
    name.oninput=()=>{ rt.item_name=name.value; };
    const max=document.createElement('input'); max.type='number'; max.min='0'; max.value=rt.max_score; max.placeholder='满分';
    max.oninput=()=>{ rt.max_score=parseInt(max.value,10)||0; };
    const off=document.createElement('input'); off.type='number'; off.min='0'; off.value=Math.round(rt.scoreX||0); off.placeholder='打分区列px';
    off.title='打分区列位置(px)，也可拖动蓝框调整';
    off.oninput=()=>{ rt.scoreX=parseInt(off.value,10)||0; renderScoreBoxes(); };
    const del=document.createElement('button'); del.textContent='删';
    del.onclick=()=>{ S_TPL_RECTS.splice(i,1); renderItemList(); renderTitleBoxes(); renderScoreBoxes(); };
    div.appendChild(no); div.appendChild(name); div.appendChild(max); div.appendChild(off); div.appendChild(del);
    out.push(div);
  });
  S_ITEMS.forEach((it,ix)=>{
    const div=document.createElement('div'); div.className='irow';
    const no=document.createElement('span'); no.className='ino'; no.textContent='+';
    const name=document.createElement('input'); name.type='text'; name.value=it.item_name; name.placeholder='题名';
    name.oninput=()=>{ it.item_name=name.value; };
    const max=document.createElement('input'); max.type='number'; max.min='0'; max.value=it.max_score; max.placeholder='满分';
    max.oninput=()=>{ it.max_score=parseInt(max.value,10)||0; };
    const del=document.createElement('button'); del.textContent='删';
    del.onclick=()=>{ S_ITEMS.splice(ix,1); renderItemList(); };
    div.appendChild(no); div.appendChild(name); div.appendChild(max); div.appendChild(del);
    out.push(div);
  });
  if(S_TOTAL_RECT){
    const div=document.createElement('div'); div.className='irow';
    const no=document.createElement('span'); no.className='ino'; no.textContent='Σ';
    const name=document.createElement('span'); name.textContent='统分区'; name.style.flex='1'; name.style.color='#2e7d32';
    const info=document.createElement('span'); info.textContent='分数 '+(S_TOTAL_RECT.count||1)+' 个'; info.style.color='#888'; info.style.fontSize='12px';
    const del=document.createElement('button'); del.textContent='删';
    del.onclick=()=>{ S_TOTAL_RECT=null; if(typeof renderTotalBox==='function') renderTotalBox(); renderItemList(); };
    div.appendChild(no); div.appendChild(name); div.appendChild(info); div.appendChild(del);
    out.push(div);
  }
  el.itemList.innerHTML='';
  if(!out.length){
    const p=document.createElement('div'); p.className='empty';
    p.textContent='在上方模板上框选题目，题名/满分/打分区列会显示在此，可手动编辑。';
    el.itemList.appendChild(p);
    return;
  }
  out.forEach(n=>el.itemList.appendChild(n));
  renderIrState();
}

function renderIrState(){
  const st=el.irState; if(!st) return;
  const types=S_BASIC_FIELDS.map(b=>b.type);
  const tag=(txt,ok)=>'<span class="ir-tag '+(ok?'ok':'miss')+'">'+txt+(ok?'✓':'✗')+'</span>';
  st.innerHTML = '基本信息：'+tag('学号',types.includes('no'))+tag('姓名',types.includes('name'))+
    tag('班级',types.includes('class'))+tag('报告名称',types.includes('exp'))+
    '<br>题目与分值：'+(S_TPL_RECTS.length ? '<span class="ir-tag ok">已框选 '+S_TPL_RECTS.length+' 题</span>' : '<span class="ir-tag miss">未框选</span>')+
    (S_TOTAL_RECT ? '，统分区✓' : '');
}

function renderTotalBox(){
  const pre = el.tplPreview;
  const host = S.tplInner||pre;
  pre.querySelectorAll('.tpl-total,.tpl-total-dot').forEach(n=>n.remove());
  if(!S_TOTAL_RECT) return;
  const t=S_TOTAL_RECT;
  const d=document.createElement('div'); d.className='tpl-total';
  d.style.left=t.x+'px'; d.style.top=t.y+'px'; d.style.width=t.w+'px'; d.style.height=t.h+'px';
  host.appendChild(d);
  const n=Math.max(1,t.count);
  for(let i=0;i<n;i++){
    const cx=t.x+(i+0.5)*t.w/n;
    const dot=document.createElement('div'); dot.className='tpl-total-dot';
    dot.style.left=cx+'px'; dot.style.top=t.y+'px';
    host.appendChild(dot);
  }
  el.totalInfo.style.display='block';
  el.totalInfo.innerHTML='统分区已框选（绿色框），共 <b>'+n+'</b> 个分数位置（各题分+总分）按等分分布。数量：';
  const inp=document.createElement('input'); inp.type='number'; inp.min='1'; inp.value=n; inp.style.width='56px';
  inp.onchange=()=>{ S_TOTAL_RECT.count=Math.max(1,parseInt(inp.value,10)||1); renderTotalBox(); };
  el.totalInfo.appendChild(inp);
  el.totalInfo.appendChild(document.createTextNode(' 个（改后点任意处应用）'));
}

function setItemMode(mode){
  S_BASIC_MODE = (mode==='basic');
  S_TOTAL_MODE = (mode==='total');
  const t = !S_BASIC_MODE && !S_TOTAL_MODE;
  if(el.btnBasicMode){ el.btnBasicMode.style.background = S_BASIC_MODE ? '#1a73e8' : '#eef1f5'; el.btnBasicMode.style.color = S_BASIC_MODE ? '#fff' : '#555'; }
  if(el.btnTitleMode){ el.btnTitleMode.style.background = t ? '#1a73e8' : '#eef1f5'; el.btnTitleMode.style.color = t ? '#fff' : '#555'; }
  if(el.btnTotalMode){ el.btnTotalMode.style.background = S_TOTAL_MODE ? '#1a73e8' : '#eef1f5'; el.btnTotalMode.style.color = S_TOTAL_MODE ? '#fff' : '#555'; }
  if(el.totalInfo){
    if(S_TOTAL_MODE){ el.totalInfo.style.display='block'; el.totalInfo.textContent='正在框选统分区：在预览上拖选统分表整行区域（一条线框出所有分数所在处）。'; }
    else { el.totalInfo.style.display='none'; }
  }
}
el.btnBasicMode.onclick=()=>{ setItemMode('basic'); if(window.__bridge&&window.__bridge.log) window.__bridge.log('进入框选基本信息模式'); };
el.btnTitleMode.onclick=()=>{ setItemMode('title'); };
el.btnTotalMode.onclick=()=>{ setItemMode('total'); };
el.btnItemAdd.onclick=()=>{ S_ITEMS.push({item_name:'', max_score:20}); renderItemList(); };
el.btnItemCancel.onclick=()=>{ el.itemMask.style.display='none'; };
// Delete/Backspace 删除选中框
document.addEventListener('keydown',(e)=>{
  if((e.key==='Delete' || e.key==='Backspace') && el.itemMask && el.itemMask.style.display==='flex' && S.selBox!=null){
    e.preventDefault();
    S_TPL_RECTS.splice(S.selBox,1); S.selBox=null;
    renderTitleBoxes(); renderItemList(); renderScoreBoxes();
  }
});
el.btnItemSave.onclick=async ()=>{
  const items=[];
  S_TPL_RECTS.forEach((rt,i)=>{
    items.push({ item_index:i, item_name:rt.item_name||('第'+(i+1)+'项'),
      max_score:rt.max_score||0, score_page:rt.pageIndex||0, score_x:Math.round((rt.scoreX||0)/(S.tplScale||1)),
      title_rect:JSON.stringify({x:rt.x,y:rt.y,w:rt.w,h:rt.h}), total_region:'{}', title_img:rt.title_img||'' });
  });
  S_ITEMS.forEach((it,ix)=>{
    items.push({ item_index:S_TPL_RECTS.length+ix,
      item_name:it.item_name||('第'+(S_TPL_RECTS.length+ix+1)+'项'),
      max_score:it.max_score||0, score_page:0, score_x:0, title_rect:'{}', total_region:'{}' });
  });
  if(!items.length){ setErr('请至少框选或添加一项'); return; }
  const hasTotal = !!(S_TOTAL_RECT && S_TOTAL_RECT.w>0);
  if(hasTotal){
    items.push({ item_index:-1, item_name:'__total__', max_score:0, score_page:0, score_x:0,
      title_rect:'{}', total_region:JSON.stringify({x:S_TOTAL_RECT.x,y:S_TOTAL_RECT.y,w:S_TOTAL_RECT.w,h:S_TOTAL_RECT.h,count:S_TOTAL_RECT.count}) });
  }
  if(window.__bridge && window.__bridge.saveBatchItems){
    await window.__bridge.saveBatchItems(S.folder, items).catch(e=>{ setErr('⚠ '+e); return; });
  }
  if(S_BASIC_FIELDS.length && window.__bridge && window.__bridge.saveBasicFields){
    const fields = S_BASIC_FIELDS.map(rt=>[rt.type, rt.pageIndex||0, JSON.stringify({x:rt.x,y:rt.y,w:rt.w,h:rt.h})]);
    await window.__bridge.saveBasicFields(S.folder, fields).catch(e=>{ setErr('⚠ 基本信息保存失败: '+e); });
  }
  S.itemsTemplate=items.filter(x=>x.item_index>=0).map(it=>({item_name:it.item_name, max_score:it.max_score, score_x:it.score_x||0}));
  el.itemMask.style.display='none';
  setDetect('✅ 评分项已固化：'+S.itemsTemplate.length+' 项'+(hasTotal?'，含统分区':''));
  if(S.reports.length){ selectReport(0); }
};