/* 实验报告批阅系统 — 前端逻辑
 * （0.1.36 重新触发编译：上一次编译因编译机器超时被取消，非代码错误）
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
  locateMask: $('locateMask'), locateBody: $('locateBody'), locateTitle: $('locateTitle'),
  locateSave: $('locateSave'), locateCancel: $('locateCancel'),
  attachBatchMask: $('attachBatchMask'), abPreview: $('abPreview'), abFileList: $('abFileList'),
  abCand: $('abCand'), abProgress: $('abProgress'), abPrevBtn: $('abPrevBtn'), abNextBtn: $('abNextBtn'),
  abCommitBtn: $('abCommitBtn'), abBackBtn: $('abBackBtn'), abErr: $('abErr'),
  pvMask: $('pvMask'), pvName: $('pvName'), pvInner: $('pvInner'), pvClose: $('pvClose'),
  attachSel: $('attachSel'), attachErr: $('attachErr'), btnAttachOk: $('btnAttachOk'), btnAttachCancel: $('btnAttachCancel'),
  btnLoadFolder: $('btnLoadFolder'),
  reportList: $('reportList'),
  statTotal: $('statTotal'), statDone: $('statDone'), statPending: $('statPending'),
  pdfHost: $('pdfHost'), pdfEmpty: $('pdfEmpty'),
  inpId: $('inpId'), inpName: $('inpName'), inpClass: $('inpClass'), inpExp: $('inpExp'),
  scoreRows: $('scoreRows'), totalVal: $('totalVal'),
  btnSubmitNext: $('btnSubmitNext'),
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
  btnSettings: $('btnSettings'), btnMarkBad: $('btnMarkBad'), btnDetail: $('btnDetail'),
  settingsMask: $('settingsMask'), stOk: $('stOk'), stClose: $('stClose'),
  detailMask: $('detailMask'), detailTableWrap: $('detailTableWrap'), dtExport: $('dtExport'), dtOk: $('dtOk'), dtClose: $('dtClose'),
  statAvg: $('statAvg'),
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
    const roster = await window.__bridge.getRoster(S.folder).catch(()=>[]);
    S.roster = roster;
    el.prepFolder.textContent = S.folder;
    renderPrepTable(ov, roster); renderPrepStats(ov); renderPrepRoster(); renderPrepSelbar();
  }catch(e){
    const msg = String(e);
    if(S.needsInit || /初始化|未找到批次/.test(msg)){
      // 数据库可能被删：尝试从 source_files/ 名单 CSV 自动恢复（有名单就自动摘录）
      let recovered=false;
      if(window.__bridge && window.__bridge.recoverRoster && S.folder){
        try{
          const list = await window.__bridge.recoverRoster(S.folder, S.teacher||'');
          if(list && list.length){ S.roster = list; recovered=true; }
        }catch(re){ setErr('自动恢复名单失败: ' + re); }
      }
      if(recovered){
        setDetect('✅ 已从 source_files 自动恢复名单 ' + (S.roster||[]).length + ' 人');
        return refreshPrepOverview();   // 重建批次后重新刷新
      }
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
async function renderPdfPreview(container, path){
  if(!path || !container) return;
  container.innerHTML='';
  if(!S.pdfjsOk){ container.innerHTML='<div style="color:#888;padding:12px">pdf.js 未就绪</div>'; return; }
  if(!window.__bridge || !window.__bridge.readPdf || !S.folder){ container.innerHTML='<div style="color:#888;padding:12px">无法读取报告</div>'; return; }
  try{
    const bytes=await window.__bridge.readPdf(S.folder, path);
    const pdf=await pdfjsLib.getDocument({data: bytes.slice(0)}).promise;
    for(let pi=1; pi<=pdf.numPages; pi++){
      const page=await pdf.getPage(pi);
      const vp=page.getViewport({scale:1});
      const availW=Math.max(220, container.clientWidth-12);
      const scale=availW/vp.width;
      const vp2=page.getViewport({scale});
      const canvas=document.createElement('canvas');
      canvas.width=Math.floor(vp2.width); canvas.height=Math.floor(vp2.height);
      canvas.style.width='100%'; canvas.style.marginBottom='6px'; canvas.style.boxShadow='0 1px 3px rgba(0,0,0,.2)';
      container.appendChild(canvas);
      await page.render({canvasContext: canvas.getContext('2d'), viewport: vp2}).promise;
    }
  }catch(e){ container.innerHTML='<div style="color:#c62828;padding:12px">预览失败: '+e+'</div>'; }
}
async function openReportPreview(path){
  if(!path) return;
  el.pvName.textContent = String(path).split('/').pop() || path;
  el.pvMask.style.display='flex';
  await renderPdfPreview(el.pvInner, path);
}
function openFile(path){ openReportPreview(path); }
el.pvClose.onclick=()=>{ el.pvMask.style.display='none'; };
el.pvMask.onclick=(e)=>{ if(e.target===el.pvMask){ el.pvMask.style.display='none'; } };
document.addEventListener('keydown',(e)=>{ if(e.key==='Escape'){ el.pvMask.style.display='none'; } });
function renderPrepTable(ov, roster){
  const tbody = el.prepTbody; tbody.innerHTML='';
  const rows = (ov.rows||[]);
  const rosterL = roster || S.roster || [];
  const mkSrc=(r)=>{ const a=document.createElement('a'); a.className='filelink'; a.textContent=r.fname||'原始'; a.title=r.fname||r.path; a.href='#'; a.onclick=(e)=>{ e.preventDefault(); openFile(r.path); }; return a; };
  const mkRnm=(r)=>{ if(!r.renamed_path) return null; const a=document.createElement('a'); a.className='filelink'; a.textContent='改名'; a.title=r.fname||r.path; a.href='#'; a.onclick=(e)=>{ e.preventDefault(); openFile(r.renamed_path); }; return a; };
  const addTd=(tr, txt)=>{ const td=document.createElement('td'); td.textContent=(txt==null?'':String(txt)); tr.appendChild(td); };
  const addNodes=(tr, arr)=>{ const td=document.createElement('td'); if(!arr || !arr.length){ td.textContent='—'; } else { arr.forEach((el,i)=>{ if(el instanceof Node){ td.appendChild(el); if(i<(arr.length-1)){ td.appendChild(document.createElement('br')); } } }); } tr.appendChild(td); };
  const tagSpan=(cls,txt)=>{ const s=document.createElement('span'); s.className='tag '+cls; s.textContent=txt; return s; };

  rosterL.forEach((s,i)=>{
    const mine = rows.filter(r=>r.matched && r.stu_no===s.no);
    // 每份匹配报告独立一行（各自一套状态）；该学生没有报告则一行表示缺交
    const lines = mine.length ? mine : [null];
    lines.forEach((r,li)=>{
      const tr = document.createElement('tr');
      const tdC = document.createElement('td'); tdC.className='col-check';
      const cb = document.createElement('input'); cb.type='checkbox'; cb.dataset.i = i;
      cb.checked = !!(S.prepChecked && S.prepChecked[i]);
      cb.addEventListener('change', ()=>{ S.prepChecked[i]=cb.checked; });
      tdC.appendChild(cb); tr.appendChild(tdC);
      // 学号/姓名/班级/报告名称：多份时只在首行显示学生信息
      addTd(tr, li===0?s.no:''); addTd(tr, li===0?s.name:''); addTd(tr, li===0?s.cls:''); addTd(tr, li===0?s.report_name:'');
      if(!r){
        addNodes(tr,[]); addNodes(tr,[]);
        const tdR=document.createElement('td'); tdR.appendChild(tagSpan('unrenamed','—')); tr.appendChild(tdR);
        const tdL=document.createElement('td'); tdL.appendChild(tagSpan('todo','—')); tr.appendChild(tdL);
        const tdM=document.createElement('td'); tdM.appendChild(tagSpan('new','未交')); tr.appendChild(tdM);
        const tdG=document.createElement('td'); tdG.appendChild(tagSpan('todo','待批')); tr.appendChild(tdG);
        const tdO=document.createElement('td'); tdO.textContent='—'; tr.appendChild(tdO);
        tbody.appendChild(tr); return;
      }
      addNodes(tr,[mkSrc(r)]);
      addNodes(tr,[mkRnm(r)].filter(Boolean));
      // 改名状态：按本份报告独立
      const tdR=document.createElement('td'); tdR.appendChild(tagSpan(r.renamed_path?'renamed':'unrenamed', r.renamed_path?'已改名':'未改名')); tr.appendChild(tdR);
      // 「已定位」列：按本份报告独立
      const st=r.locate_status||'pending';
      const lcls=st==='auto'?'done':(st==='manual'?'manual':'todo');
      const ltxt=st==='auto'?'已定位':(st==='manual'?'人工定位':'待定位');
      const tdL=document.createElement('td'); tdL.appendChild(tagSpan(lcls,ltxt));
      if(st==='pending' && r.renamed_path){
        const lb=document.createElement('button'); lb.className='opbtn locate'; lb.textContent='定位';
        lb.title='人工定位：拖动蓝框到每题标题行';
        lb.onclick=()=>{ manualLocate(r); };
        tdL.appendChild(lb);
      }
      tr.appendChild(tdL);
      // 匹配/批改：按本份报告独立
      const tdM=document.createElement('td'); tdM.appendChild(tagSpan('mat','已挂靠')); tr.appendChild(tdM);
      const tdG=document.createElement('td'); tdG.appendChild(tagSpan(r.done?'done':'todo', r.done?'已批':(r.graded?'部分':'待批'))); tr.appendChild(tdG);
      const tdO=document.createElement('td');
      const ab=document.createElement('button'); ab.className='opbtn attached'; ab.textContent='已挂靠'; tdO.appendChild(ab); tr.appendChild(tdO);
      tbody.appendChild(tr);
    });
  });

  const unmatch = rows.filter(r=>!r.matched);
  if(unmatch.length){
    const hr=document.createElement('tr'); const htd=document.createElement('td'); htd.colSpan=12;
    htd.style.cssText='padding:8px 10px;background:#fff6e5;color:#b45309;font-weight:600';
    htd.textContent='▼ 未匹配原始报告（OCR 后仍对不上名单，请手动挂靠或标记错误）';
    hr.appendChild(htd); tbody.appendChild(hr);
    unmatch.forEach((r)=>{
      const tr=document.createElement('tr');
      const tdC=document.createElement('td'); tdC.className='col-check'; tr.appendChild(tdC);
      addTd(tr, r.ocr_no); addTd(tr, r.ocr_name); addTd(tr, r.ocr_class); addTd(tr, r.ocr_exp||r.fname);
      addNodes(tr, [mkSrc(r)]);
      addNodes(tr, []);
      const tdR=document.createElement('td'); tdR.appendChild(tagSpan('unrenamed','未改名')); tr.appendChild(tdR);
      const tdL=document.createElement('td'); tdL.appendChild(tagSpan('todo','待定位')); tr.appendChild(tdL);
      const tdM=document.createElement('td'); tdM.appendChild(tagSpan('new','待挂靠')); tr.appendChild(tdM);
      const tdG=document.createElement('td'); tdG.appendChild(tagSpan('todo','待批')); tr.appendChild(tdG);
      const tdO=document.createElement('td');
      const ab=document.createElement('button'); ab.className='opbtn attach'; ab.textContent='挂靠';
      ab.onclick=()=>{ openAttachBatch(); }; tdO.appendChild(ab); tr.appendChild(tdO);
      tbody.appendChild(tr);
    });
  }
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
      '<button onclick="window.__app.openItemSetup()">设置模板（框选）</button>'+
      '<button onclick="window.__app.runSourceVerify()" style="margin-left:6px;background:#2563eb;color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:13px">核对原始报告</button>'+
      '<button onclick="window.__app.runLocatePositions()" style="margin-left:6px;background:#0d9488;color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:13px">定位批阅位置</button>';
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

// —— 批量挂靠弹窗
let S_ATTACH = { list: [], idx: 0 };
async function openAttachBatch(){
  const rows = ((S.prepOv && S.prepOv.rows) || []).filter(r=>!r.matched);
  if(!rows.length){ setErr('没有待挂靠的报告'); return; }
  S_ATTACH.list = rows; S_ATTACH.idx = 0;
  el.attachBatchMask.style.display='flex';
  el.abErr.textContent='';
  await refreshAttachBatch();
}
async function refreshAttachBatch(){
  const L=S_ATTACH.list, i=S_ATTACH.idx;
  if(!L.length){ el.attachBatchMask.style.display='none'; return; }
  const r = L[i];
  el.abProgress.textContent = (i+1)+' / '+L.length;
  // 左侧待挂靠文件清单
  el.abFileList.innerHTML='';
  L.forEach((x,k)=>{
    const row=document.createElement('div');
    row.className='ab-file'+(k===i?' active':'');
    const nm=document.createElement('span'); nm.textContent=(x.fname||x.path||''); nm.style.cursor='pointer';
    nm.onclick=()=>{ if(k!==S_ATTACH.idx){ S_ATTACH.idx=k; refreshAttachBatch(); } };
    const st=document.createElement('span'); st.className='tag '+(x.matched?'mat':'new'); st.textContent=x.matched?'已挂靠':'待挂靠';
    row.appendChild(nm); row.appendChild(st);
    el.abFileList.appendChild(row);
  });
  // 右侧名单候选（学号或姓名一致高亮）
  let roster=[];
  if(window.__bridge && window.__bridge.getRoster){ try{ roster=await window.__bridge.getRoster(S.folder); }catch(e){} }
  el.abCand.innerHTML='';
  roster.forEach(s=>{
    const hl = (s.no && s.no===r.ocr_no) || (s.name && s.name===r.ocr_name);
    const label=[s.no,s.name,s.cls,s.report_name].filter(Boolean).join('_');
    const lab=document.createElement('label'); if(hl) lab.className='hl';
    const inp=document.createElement('input'); inp.type='radio'; inp.name='abSel'; inp.value=s.no; if(hl) inp.checked=true;
    lab.appendChild(inp); lab.appendChild(document.createTextNode(label));
    el.abCand.appendChild(lab);
  });
  const errLab=document.createElement('label'); errLab.className='err';
  const errInp=document.createElement('input'); errInp.type='radio'; errInp.name='abSel'; errInp.value='__err';
  errLab.appendChild(errInp); errLab.appendChild(document.createTextNode('错误报告（交错了，不挂靠）'));
  el.abCand.appendChild(errLab);
  // 报告预览
  renderAttachPreview(r.path);
  el.abPrevBtn.disabled = (i===0);
  el.abNextBtn.disabled = (i>=L.length-1);
}
async function renderAttachPreview(path){
  const pre=el.abPreview;
  await renderPdfPreview(pre, path);
}
async function commitAttachBatch(){
  const sel=document.querySelector('input[name="abSel"]:checked');
  if(!sel){ el.abErr.textContent='请选择一个候选或「错误报告」'; return; }
  const v=sel.value;
  const r=S_ATTACH.list[S_ATTACH.idx];
  const action = v==='__err' ? '__skip' : v;
  el.abErr.textContent='';
  try{
    await window.__bridge.resolveUnmatched(S.folder, {path:r.path}, action);
    r.matched = (v!=='__err');
    refreshPrepOverview();
    const nxt = S_ATTACH.list.findIndex((x,k)=> k>S_ATTACH.idx && !x.matched);
    if(nxt>=0){ S_ATTACH.idx=nxt; refreshAttachBatch(); }
    else { el.attachBatchMask.style.display='none'; setDetect('✅ 所有待挂靠报告已处理'); }
  }catch(e){ el.abErr.textContent='挂靠失败: '+e; }
}
el.abCommitBtn.onclick = commitAttachBatch;
el.abPrevBtn.onclick = ()=>{ if(S_ATTACH.idx>0){ S_ATTACH.idx--; refreshAttachBatch(); } };
el.abNextBtn.onclick = ()=>{ if(S_ATTACH.idx<S_ATTACH.list.length-1){ S_ATTACH.idx++; refreshAttachBatch(); } };
el.abBackBtn.onclick = ()=>{ el.attachBatchMask.style.display='none'; refreshPrepOverview(); };
el.btnPrepFolder.onclick=()=>{ if(el.btnLoadFolder.onclick) el.btnLoadFolder.onclick(); };
el.btnPrepBack.onclick=()=>{ hidePrep(); S.teacher=''; localStorage.removeItem('loginUser'); el.loginMask.style.display='flex'; showLogin(); };
el.btnPrepStart.onclick=async()=>{
  const range=document.querySelector('input[name="prepRange"]:checked');
  const rv = range ? range.value : 'increment';
  S.prepRange = rv;
  const rows = (S.prepOv && S.prepOv.rows) || [];
  if(rv==='select'){
    const checked=Object.keys(S.prepChecked||{}).filter(i=>S.prepChecked[i]).map(Number);
    if(!checked.length){ setErr('请先在左侧表中勾选要批改的报告'); return; }
    const selRows = checked.flatMap(i=>{ const s=(S.roster||[])[i]; return s ? rows.filter(r=>r.matched&&r.stu_no===s.no) : []; });
    S.prepFilter=new Set(selRows.map(r=>r.key).filter(Boolean));
  } else if(rv==='increment'){
    S.prepFilter=new Set(rows.filter(r=>!r.done).map(r=>r.key).filter(Boolean));
  } else { S.prepFilter=null; }
  setErr('');
  hidePrep();
  await loadReportsFromScope();
  if(S.reports && S.reports.length){ selectReport(0); setDetect('已进入批改，共 '+S.reports.length+' 份'); }
  else setDetect('批改范围内没有可批改的报告');
};

// —— 批改报告列表 = 准备阶段选定的批改范围（不多不少）
async function loadReportsFromScope(){
  const rows=(S.prepOv && S.prepOv.rows) || [];
  let scoped = rows;
  if(S.prepRange && S.prepRange!=='all' && S.prepFilter){ scoped = rows.filter(r=>S.prepFilter.has(r.key)); }
  // 只保留有文件的（renamed 优先；无 renamed 用原始 source）；缺交的名单不进入批改
  scoped = scoped.filter(r=> (r.renamed_path || r.path));
  S.reports = scoped.map((row,i)=>{
    const path = row.renamed_path || row.path;
    const r={
      id: 'scope_'+i+'_'+Date.now(),
      name: path.split(/[\\/]/).pop() || (row.fname||('report'+i)),
      path: path,
      student: { no: row.stu_no||'', name: row.stu_name||'', cls: row.stu_cls||'', exp: row.report_name||'' },
      missing: false,
      done: !!(row.done),
      _row: row,
    };
    initReportState(r);
    if(!r.basic){ r.basic = { name:row.stu_name||'', id:row.stu_no||'', cls:row.stu_cls||'', exp:row.report_name||'' }; }
    return r;
  });
  renderReportList();
}
/* ==================== 批改面板新增功能 ==================== */
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// —— 设置面板：改分方式 + 快捷键说明
S.gradeMode = 'byPaper';
el.btnSettings.onclick=()=>{ el.settingsMask.style.display='flex'; };
const closeSettings=()=>{ el.settingsMask.style.display='none'; };
el.stClose.onclick=closeSettings;
el.stOk.onclick=()=>{
  const m=document.querySelector('input[name="gradeMode"]:checked');
  S.gradeMode = m ? m.value : 'byPaper';
  closeSettings();
  setDetect('改分方式：'+(S.gradeMode==='byItem'?'按题改':'按卷改'));
};

// —— 标记错误报告（交错）：两次点击确认，回退 excluded 并从列表移除
el.btnMarkBad.onclick=async()=>{
  const r=S.current; if(!r){ setErr('请先选择一份报告'); return; }
  if(S.__confirmBad === r){ S.__confirmBad=null; }
  else { S.__confirmBad=r; setErr('再点一次确认：将《'+r.name+'》标记为错误报告（交错）'); return; }
  try{
    if(window.__bridge && window.__bridge.markExcluded){ await window.__bridge.markExcluded(S.folder, r.name); }
    const idx=S.reports.indexOf(r);
    S.reports.splice(idx,1);
    renderReportList();
    if(S.reports.length){ selectReport(Math.min(idx, S.reports.length-1)); }
    else { S.current=null; el.scoreRows.innerHTML=''; el.totalVal.textContent='0 / 0'; el.pdfHost.innerHTML='<div id="pdfEmpty"><div class="big">📭</div>批改范围内没有更多报告</div>'; }
    setErr('');
    setDetect('已标记《'+r.name+'》为错误报告（交错）');
  }catch(e){ setErr('标记失败: '+(e&&e.message||e)); }
};

// —— 成绩明细弹窗（只读查看，导出统一到导出阶段）
function openDetail(){
  const done = S.reports.filter(r=>r.done && Array.isArray(r.scores));
  const n = done.length ? done[0].scores.length : 0;
  let h='<table class="dt-table"><thead><tr><th>姓名</th><th>学号</th><th>班级</th><th>报告名称</th>';
  for(let i=0;i<n;i++) h+='<th>题'+(i+1)+'</th>';
  h+='<th>总分</th></tr></thead><tbody>';
  done.forEach(r=>{
    const st=r.student||{};
    h+='<tr><td>'+esc(st.name||'')+'</td><td>'+esc(st.no||'')+'</td><td>'+esc(st.cls||'')+'</td><td>'+esc((r._row&&r._row.report_name)||'')+'</td>';
    const total=r.scores.reduce((a,b)=>a+b,0);
    for(let i=0;i<n;i++) h+='<td>'+(r.scores[i]||0)+'</td>';
    h+='<td><b>'+total+'</b></td></tr>';
  });
  h+='</tbody></table>';
  el.detailTableWrap.innerHTML = done.length ? h : '<div style="padding:20px;color:#888">还没有已批卷的成绩明细</div>';
  el.detailMask.style.display='flex';
}
/* 成绩明细已合并到顶部「批阅概览」，右下角不再独立绑定 */
el.dtClose.onclick=()=>{ el.detailMask.style.display='none'; };
el.dtOk.onclick=()=>{ el.detailMask.style.display='none'; };
if(el.dtExport){ el.dtExport.style.display='none'; }   // 导出统一到导出阶段，明细弹窗只读

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

/* ==================== 文件选择（报告由准备范围带出，此处仅保留隐藏的选文件夹入口） ==================== */
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
    if(r===S.current) li.classList.add('active');
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
  renderAvg();
}
// 只更新当前高亮，不重建列表（selectReport 切换时调用）
function updateListHighlight(){
  const lis = el.reportList ? el.reportList.children : null;
  if(!lis) return;
  S.reports.forEach((r,i)=>{ if(lis[i]) lis[i].classList.toggle('active', r===S.current); });
}
// 每次提交后刷新：每题平均分 + 总评平均分（仅已批卷）
function renderAvg(){
  if(!el.statAvg) return;
  const done = S.reports.filter(r=>r.done && Array.isArray(r.scores));
  if(!done.length){ el.statAvg.textContent='提交后显示每题平均分与总评平均分'; return; }
  const n = done[0].scores.length || 1;
  const sums = new Array(n).fill(0);
  done.forEach(r=>{ if(!r.scores) return; r.scores.forEach((v,i)=>{ if(i<n) sums[i]+= (v||0); }); });
  const itemAvg = sums.map(s=> (s/done.length).toFixed(1));
  const totalAvg = sums.reduce((a,b)=>a+b,0)/done.length;
  el.statAvg.textContent = '每题均分 ' + itemAvg.join(' / ') + ' ｜ 总评均分 ' + totalAvg.toFixed(1);
}

/* ==================== 选中报告 & 检测 ==================== */
async function selectReport(idx){
  const r = S.reports[idx];
  S.current = r;
  updateListHighlight();
  el.pdfHost.innerHTML = '<div id="pdfEmpty"><div class="big">⏳</div>正在解析报告...</div>';
  el.scoreRows.innerHTML = '';
  setFile('解析中: ' + r.name);

  // 待提交：名单里有名字但尚未收到报告文件
  if(r.missing){
    el.pdfHost.innerHTML = '<div id="pdfEmpty"><div class="big">📭</div>该学生尚未提交报告</div>';
    setFile(reportLabel(r) + '（未提交）');
    setDetect('状态: 待提交');
    el.inpId.textContent   = (r.student && r.student.no)  || '';
    el.inpName.textContent = (r.student && r.student.name)|| '';
    el.inpClass.textContent= (r.student && r.student.cls) || '';
    el.inpExp.textContent  = '';
    return;
  }
  // 有报告但 pdf 未就绪：加载失败（真实原因见红字），不要误报"未提交"
  if(!r.pdf){
    el.pdfHost.innerHTML = '<div id="pdfEmpty"><div class="big">⚠</div>报告加载失败：' + (r.pdfError || '请重试') + '</div>';
    setFile(reportLabel(r) + '（加载失败）');
    setDetect('状态: 加载失败');
    el.inpId.textContent   = (r.student && r.student.no)  || '';
    el.inpName.textContent = (r.student && r.student.name)|| '';
    el.inpClass.textContent= (r.student && r.student.cls) || '';
    el.inpExp.textContent  = '';
    return;
  }

  try{
    const analysis = await analyze(r.pdf);
    r.analysis = analysis;
    // —— 评分项以准备阶段模板(batch_items)为准：题名/满分直接挖模板 ——
    if(!S.itemsFull){
      try{ S.itemsFull = await window.__bridge.getBatchItems(S.folder); }
      catch(e){ S.itemsFull=[]; }
    }
    const tpl=(S.itemsFull||[]).filter(x=>x.item_index>=0).sort((a,b)=>a.item_index-b.item_index);
    if(tpl.length){
      // 补齐 scores/activated 到模板项数（扫描版 analyze 可能检测不到项，但模板一定有）
      if(!Array.isArray(r.scores)) r.scores=[];
      if(!Array.isArray(r.activated)) r.activated=[];
      while(r.scores.length < tpl.length) r.scores.push(0);
      while(r.activated.length < tpl.length) r.activated.push(false);
      if(!r.maxs || !r.maxs.length) r.maxs = tpl.map(t=>t.max_score!=null?t.max_score:0);
    } else {
      if(!r.maxs) r.maxs = analysis.items.map(it=>it.max);
    }
    if(!r.basic) r.basic = analysis.basic;

    // 基本信息回填（来自准备阶段核心数据表，纯文本展示）
    const st = r.student || {};
    el.inpName.textContent = st.name || '';
    el.inpId.textContent   = st.no   || '';
    el.inpClass.textContent= st.cls  || '';
    el.inpExp.textContent  = st.exp  || '';

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

// 加载已存定位（准备阶段写入，格式 {titleY_pct,pageIndex,titleX_pct}）到 r._locate，供渲染/导出直接用
async function loadLocate(r){
  if(!r._locate) r._locate = {};
  if(!window.__bridge.getReportLocate) return;
  try{
    const j=await window.__bridge.getReportLocate(S.folder, r.name);
    if(j){ const loc=JSON.parse(j); (loc.items||[]).forEach(li=>{ if(li.item_index!=null) r._locate[li.item_index]={ titleY_pct:li.titleY_pct!=null?li.titleY_pct:null, pageIndex:li.pageIndex, titleX_pct:li.titleX_pct!=null?li.titleX_pct:null }; }); }
  }catch(e){}
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
// 旧版模板坐标检测提示：标题/总分框选若为旧像素数据(w>1)，渲染无法精确定位，提示重新框选
function ensureTplWarn(){
  let old=false;
  (S.itemsFull||[]).forEach(t=>{
    try{ const tr=JSON.parse(t.title_rect||'{}'); if(tr.w>1) old=true; }catch(e){}
    try{ const tt=JSON.parse(t.total_region||'{}'); if(tt.w>1) old=true; }catch(e){}
  });
  let w=document.getElementById('tplWarn');
  if(old){
    if(!w){
      w=document.createElement('div'); w.id='tplWarn';
      w.style.cssText='background:#fff3cd;color:#7a5c00;padding:7px 12px;font-size:12px;line-height:1.5;border:1px solid #ffe29a;border-radius:4px;margin:6px 2px;';
      el.pdfHost.parentNode.insertBefore(w, el.pdfHost);
    }
    w.textContent='⚠ 检测到旧版模板框选坐标，预览区得分位置可能不准。请到准备面板【设置模板】重新框选各项并保存，即可精确定位。';
  } else if(w){ w.remove(); }
}
async function renderPages(r){
  ensureTplWarn();
  await loadLocate(r);
  el.pdfHost.innerHTML = '';
  const centerEl = document.getElementById('center');
  const availW = Math.max(240, centerEl.clientWidth - 32); // 中间栏可用宽度(去掉padding)
  r._rendered = { titleOv: [], totalOv: null };   // 缓存叠加层节点，供打分时局部刷新

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
  // 叠加层已改用模板定位，不再依赖 autoLocateTitles 找图
  // await autoLocateTitles(r);
}

function px2(x,y,vp){ return vp.convertToViewportPoint(x,y); }

// —— 叠加层：每题得分显示在"文字区右边缘(score_x/蓝框) + 标题行y"，统分区内等距排多分数（各题分+总分）。
//    只显示数字，不再写"得分:N / 总分:N"。坐标沿用模板百分比(0-1)；旧像素数据(w>1)按报告页归一化，重框后精确。
function addOverlays(r, wrap, pageIndex, vp, page){
  const vp1 = page.getViewport({scale:1});
  const pw1 = vp1.width||1, ph1 = vp1.height||1;
  const items=(S.itemsFull||[]).filter(x=>x.item_index>=0);

  // 每题：分数显示在标题行右端（文字区右边缘），只显示数字
  items.forEach((t,i)=>{
    let tr={}; try{ tr=JSON.parse(t.title_rect||'{}'); }catch(e){}
    if(tr.w && tr.h && (t.score_page||0)===pageIndex){
      const isPct = tr.w<=1 && tr.h<=1;
      // 纵向：优先读已存定位(titleY_pct 距顶比例)，没有则回退模板框选位置
      const lc = (r._locate && r._locate[i]) || null;
      let top;
      if(lc && lc.titleY_pct!=null && lc.pageIndex===pageIndex){ top = lc.titleY_pct*vp.height; }
      else { const py = isPct? (tr.y||0) : (tr.y||0)/ph1; top = py*vp.height; }
      // 横向：优先已存定位的整页文字区右缘(titleX_pct)；其次 score_x（文字区右边缘/蓝框）；最后红框右边缘
      let xPct=null;
      if(lc && lc.titleX_pct!=null && lc.titleX_pct>0){ xPct = lc.titleX_pct; }
      else {
        const sx = t.score_x;
        if(sx && sx>0 && sx<=1){ xPct = sx; }
        else if(sx && sx>1){ xPct = sx/pw1; }
        if(xPct==null){ xPct = isPct ? (tr.x+tr.w) : (tr.x+tr.w)/pw1; }
      }
      const left = xPct*vp.width;
      const ov=document.createElement('div');
      ov.className = 'ov-score ov-title-score';
      ov.style.left = (left - 100) + 'px';
      ov.style.top  = (top - 14) + 'px';
      ov.style.width = '100px'; ov.style.textAlign='right';
      ov.textContent = String(r.scores[i]!=null ? r.scores[i] : 0);
      ov.dataset.itemIndex = i;
      wrap.appendChild(ov);
      r._rendered.titleOv.push({ node: ov, itemIndex: i });
    }
  });

  // 统分区：框内横向等距排 (题目数+1) 个分数 = 各题分 + 总分（第1页）
  const total=(S.itemsFull||[]).find(x=>x.item_index<0);
  if(total && pageIndex===0){
    let ttr={}; try{ ttr=JSON.parse(total.total_region||'{}'); }catch(e){}
    if(ttr.w && ttr.h){
      const isPct = ttr.w<=1 && ttr.h<=1;
      const px = isPct? (ttr.x||0) : (ttr.x||0)/pw1;
      const py = isPct? (ttr.y||0) : (ttr.y||0)/ph1;
      const pw = isPct? ttr.w : ttr.w/pw1;
      const ph = isPct? ttr.h : ttr.h/ph1;
      const left=px*vp.width, top=py*vp.height, w=pw*vp.width, h=ph*vp.height;
      const N = items.length;
      const nSlots = Math.max(2, N + 1);   // 各题分 + 总分
      const slotW = w / nSlots;
      r._rendered.totalOv = [];
      for(let k=0;k<nSlots;k++){
        const ov=document.createElement('div');
        ov.className='ov-score ov-total-score';
        ov.style.left = (left + slotW*(k+0.5) - 16) + 'px';
        ov.style.top  = (top + h/2 - 10) + 'px';
        ov.style.width = '32px'; ov.style.textAlign='center';
        ov.textContent = '';
        ov.dataset.slot = k;
        wrap.appendChild(ov);
        r._rendered.totalOv.push(ov);
      }
    }
  }
}

// 只更新叠加层文本，不重渲 canvas（P1-5）
function fillOverlays(r){
  if(!r._rendered) return;
  const total = r.scores.reduce((x,y)=>x+y,0);
  for(const t of r._rendered.titleOv){
    t.node.textContent = String(r.scores[t.itemIndex]!=null ? r.scores[t.itemIndex] : 0);
  }
  const tslots = r._rendered.totalOv;
  if(tslots && tslots.length){
    const N = tslots.length - 1;
    tslots.forEach((node,k)=>{
      node.textContent = (k<N) ? String(r.scores[k]!=null?r.scores[k]:0) : String(total||0);
    });
  }
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
  const tpl=(S.itemsFull||[]).filter(x=>x.item_index>=0).sort((a,b)=>a.item_index-b.item_index);
  const inputs = [];
  const byItem = (S.gradeMode==='byItem');
  const target = byItem ? (S.itemCursor!=null?S.itemCursor:0) : -1;
  // 若无模板则回退 analysis.items
  const list = tpl.length ? tpl.map(t=>({name:t.item_name||('题'+(t.item_index+1)), max:(t.max_score!=null?t.max_score:0)})) : (r.analysis && r.analysis.items||[]).map((it,i)=>({name:it.name||('题'+(i+1)), max:(r.maxs&&r.maxs[i]!=null)?r.maxs[i]:it.max}));
  const activeIdx = byItem ? (target>=0?target:0) : (S.selectedItem!=null?S.selectedItem:0);
  list.forEach((it,i)=>{
    if(byItem && i!==target) return;   // 按题模式：只渲染当前题的打分框
    const max = it.max;
    const row = document.createElement('div');
    row.className = 'score-row' + (i===activeIdx ? ' active' : '');   // 当前题高亮（同报告列表）
    const nm = document.createElement('span'); nm.className='name'; nm.textContent = it.name;   // 只显示题名，不带序号
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
    // 聚焦 → 记录当前项、立即全选已有分数以便直接输入（P0-2），不视为已批；同时高亮当前题
    inp.addEventListener('focus', ()=>{
      S.selectedItem = i;
      document.querySelectorAll('#scoreRows .score-row').forEach(rd=>rd.classList.remove('active'));
      row.classList.add('active');
      inp.select();
      jumpToItem(i);
    });
    const cur = document.createElement('span'); cur.className='cur'; cur.textContent = '';
    row.appendChild(nm); row.appendChild(mx); row.appendChild(cur); row.appendChild(inp);
    el.scoreRows.appendChild(row);
    inputs.push(inp);
  });
  updateTotal(r);
  S.scoreInputs = inputs;   // 供全局 ← → 键切换焦点（按题模式仅当前题）
}
function updateTotal(r){
  const total = r.scores.reduce((x,y)=>x+y,0);
  const maxAll = (r.maxs && r.maxs.length) ? r.maxs.reduce((x,y)=>x+(y||0),0) : 0;
  el.totalVal.textContent = total + ' / ' + maxAll;
  // P0-3：已批只由"提交"决定，满不满分都不自动标记已批
}

// 学生信息为纯文本（来自准备阶段核心表），不做编辑监听

/* ==================== 定位：跳转到指定标题所在位置 ==================== */
function jumpToItem(i){
  const el2 = document.querySelector(`.ov-title-score[data-item-index="${i}"]`);
  if(el2){ setErr(''); el2.scrollIntoView({behavior:'smooth', block:'center'}); return; }
  // 该题模板定位未渲染（可能不在当前页）→ 尝试直接滚动到对应叠加层页
  setErr('第'+(i+1)+'项标题未能定位（可手动翻页查看）');
}

/* ==================== 提交并切换到下一份报告 ==================== */
// 提交前检查：所有评分项都必须已批阅（activated 全为 true），否则拦截
function allItemsGraded(r){
  return !!(r.activated && r.activated.length) && r.activated.every(a=>a===true);
}
function submitAndNext(){
  if(S.gradeMode==='byItem'){ submitItemAndNext(); return; }
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
// —— 按题改：确认当前卷当前题 → 跳到当前题未完成的下一份卷；当前题全部完成 → 下一题
function submitItemAndNext(){
  const i = S.itemCursor!=null ? S.itemCursor : 0;
  const r = S.current;
  if(!r || !r.activated || r.activated[i]===true){ gotoNextByItem(i); return; }
  r.activated[i] = true;
  const inp = S.scoreInputs && S.scoreInputs[0];
  if(inp){ inp.classList.remove('ungraded'); inp.classList.add('graded'); }
  if(allItemsGraded(r)){ r.done=true; r.submitted=true; r.submittedAt=Date.now(); }   // 整卷全部题完成才算已批
  saveState(r);
  renderReportList();
  gotoNextByItem(i);
}
function gotoNextByItem(i){
  // 跳到当前题 i 未完成的第一份卷
  for(let k=0;k<S.reports.length;k++){
    const t=S.reports[k];
    if(t.activated && !t.activated[i]){ selectReport(k); focusItem(i); setDetect('题'+(i+1)+'：已进入下一份'); return; }
  }
  // 当前题全部完成 → 下一题
  const totalItems = (S.reports[0] && S.reports[0].activated) ? S.reports[0].activated.length : 0;
  if(i+1 < totalItems){ S.itemCursor=i+1; selectReport(0); focusItem(i+1); setDetect('进入第 '+(i+2)+' 题'); }
  else { setDetect('🎉 当前范围所有题目已批改完成'); }
}
function focusItem(i){ setTimeout(()=>{ const arr=S.scoreInputs||[]; const idx=(S.gradeMode==='byItem')?0:i; if(arr[idx]) arr[idx].focus(); }, 80); }

el.btnSubmitNext.onclick = submitAndNext;

/* ==================== 报告预览滚动（单手快捷键） ==================== */
function pagePreview(dir){
  const cs = Array.from(document.querySelectorAll('#pdfHost canvas, #pdfHost .page'));
  if(!cs.length){ nudgePreview(dir>0?innerHeight*0.8:-(innerHeight*0.8)); return; }
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  let target=null;
  for(const c of cs){
    const abs = c.getBoundingClientRect().top + y;
    if(dir>0 && abs > y+10 && (target===null || abs<target)) target=abs;
    if(dir<0 && abs < y-10) target=abs;   // 取最后一个在当前之上的
  }
  if(dir>0 && target===null) target = y + innerHeight*0.8;
  if(dir<0 && target===null) target = Math.max(0, y - innerHeight*0.8);
  window.scrollTo({ top: Math.max(0,target), behavior:'smooth' });
}
function nudgePreview(dy){ window.scrollBy(0, dy); }

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

  // 上下方向键：焦点不在输入框时微调滚动五行
  if(e.key === 'ArrowUp' || e.key === 'ArrowDown'){
    if(!isInput){ e.preventDefault(); nudgePreview(e.key==='ArrowDown'?75:-75); }
  }
  // PgUp / PgDn：焦点不在输入框时翻整页
  if((e.key==='PageUp'||e.key==='PageDown') && !isInput){
    e.preventDefault(); pagePreview(e.key==='PageDown'?1:-1);
  }
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
    const lc = (r._locate && r._locate[i]) || null;
    const lcPage = (lc && lc.pageIndex!=null) ? lc.pageIndex : it.pageIndex;
    if(it.titleY==null && !(lc && lc.titleY_pct!=null)) continue;
    const page = pdfDoc.getPage(lcPage);
    const W = page.getWidth();
    const baseX = (it.score_x!=null) ? it.score_x : (W - 70);
    // 纵向：优先已存定位 titleY_pct(距顶) → 距底=页高*(1-pct)；否则用旧距底 titleY
    const y = (lc && lc.titleY_pct!=null) ? (page.getHeight()*(1-lc.titleY_pct)) : it.titleY;
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
/* 导出已移至导出阶段（批改面板不再涉及导出） */

function buildRecord(){
  const r = S.current;
  const a = r.analysis;
  const total = r.scores.reduce((x,y)=>x+y,0);
  const maxAll = a.items.reduce((x,y)=>x+y.max,0);
  return {
    teacher: S.teacher,
    studentId: (r.basic && r.basic.id)||'', name: (r.basic && r.basic.name)||'', cls: (r.basic && r.basic.cls)||'', exp: (r.basic && r.basic.exp)||'',
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
/* 导出已移至导出阶段（批改面板不再涉及导出） */

/* —— 批阅概览（表格弹窗）与 帮助 —— */
async function showOverview(){
  if(!S.reports.length){ setErr('还没有报告'); return; }
  // 顶部：当前批阅报告的逐项明细（题名/满分/得分/总分）——原「成绩明细」合并至此
  let prefix='';
  const r=S.current;
  if(r){
    const tpl=(S.itemsFull||[]).filter(x=>x.item_index>=0).sort((a,b)=>a.item_index-b.item_index);
    prefix += '<h3 style="margin:4px 0 8px">当前批阅：'+esc(r.name)+'</h3>';
    prefix += '<table class="ov-table ov-detail"><thead><tr><th>题项</th><th>满分</th><th>得分</th></tr></thead><tbody>';
    (tpl.length?tpl:[]).forEach((t,i)=>{
      prefix += '<tr><td>'+(i+1)+'. '+esc(t.item_name||('题'+(i+1)))+'</td><td>'+(t.max_score!=null?t.max_score:0)+'</td><td>'+(r.scores&&r.scores[i]!=null?r.scores[i]:0)+'</td></tr>';
    });
    const total=r.scores?r.scores.reduce((a,b)=>a+(b||0),0):0;
    const maxTotal=(r.maxs&&r.maxs.length)?r.maxs.reduce((a,b)=>a+(b||0),0):0;
    prefix += '<tr class="ov-total-row"><td>总分</td><td>'+maxTotal+'</td><td>'+total+'</td></tr>';
    prefix += '</tbody></table><hr style="margin:10px 0">';
  }
  let rows;
  try { rows = await fetchAllGrades(); } catch(e){ setErr('读取成绩失败: '+e); return; }
  const items = gradesToTable(rows);
  const n = Math.max(0, ...items.map(it=>it.scores.length));
  let h = prefix + '<table class="ov-table"><thead><tr><th>学号</th><th>姓名</th><th>班级</th>';
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
/* 导出已移至导出阶段（批改面板不再涉及导出） */

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
    { header: '报告名称', key: 'report_name', width: 26 },
  ];
  ws.addRow({ no: '2024010101', name: '张三', cls: '2024级临床1班', report_name: '实验报告' });
  ws.addRow({ no: '2024010102', name: '李四', cls: '2024级临床1班', report_name: '实验报告' });
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
      return { no: c[0]||'', name: c[1]||'', cls: c[2]||'', report_name: c[3]||'' };
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
    const report_name = String(row.getCell(4).value || '').trim();
    if(no || name) out.push({ no, name, cls, report_name });
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
    // 导入名单完成后回到「核对原始报告」刷新批次
    if(window.__bridge && window.__bridge.syncFolder && S.folder){ await runSourceVerify(); }
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
  showPrep, hidePrep, refreshPrepOverview, openPrepImport, prepBasicField,
  runSourceVerify, runLocatePositions, manualLocate };

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
    loadSavedBoxes();
  }).catch(e=>setErr('渲染模板失败: '+e));
}
async function loadSavedBoxes(){
  if(!window.__bridge || !S.folder || !S.tplPages) return;
  try{
    const [bf, items] = await Promise.all([
      window.__bridge.getBasicFields(S.folder).catch(()=>[]),
      window.__bridge.getBatchItems(S.folder).catch(()=>[])
    ]);
    const BASIC_LABELS={no:'学号',name:'姓名',class:'班级',exp:'报告名称'};
    S_BASIC_FIELDS = (bf||[]).filter(f=>f&&f[0]).map(f=>{
      let r={}; try{ r=JSON.parse(f[2]||'{}'); }catch(e){}
      const pvp = S.tplPages[(f[1]||0)] ? S.tplPages[(f[1]||0)].vp : null;
      const pw = (pvp && pvp.width) ? pvp.width : 1;
      const ph = (pvp && pvp.height) ? pvp.height : 1;
      if(r.left!=null && r.top!=null && r.right!=null && r.bottom!=null){
        return { type:f[0], label:(BASIC_LABELS[f[0]]||f[0]), pageIndex:f[1]||0,
          x:r.left*pw, y:r.top*ph, w:(r.right-r.left)*pw, h:(r.bottom-r.top)*ph, text:'' };
      }
      return { type:f[0], label:(BASIC_LABELS[f[0]]||f[0]), pageIndex:f[1]||0, x:r.x||0, y:r.y||0, w:r.w||0, h:r.h||0, text:'' };
    });
    S_TPL_RECTS=[]; S_ITEMS=[]; S_TOTAL_RECT=null;
    (items||[]).forEach(it=>{
      if(it.item_index<0){
        try{ S_TOTAL_RECT=JSON.parse(it.total_region||'{}'); }catch(e){}
        if(S_TOTAL_RECT && !S_TOTAL_RECT.w) S_TOTAL_RECT=null;
        return;
      }
      let tr={}; try{ tr=JSON.parse(it.title_rect||'{}'); }catch(e){}
      if(tr.w && tr.h){
        const spvp = S.tplPages[(it.score_page||0)] ? S.tplPages[(it.score_page||0)].vp : null;
        const spw = (spvp && spvp.width) ? spvp.width : 1;
        // score_x 新格式为百分比(<=1) → 还原为模板预览像素；旧格式为模板scale像素(>1) → 直接乘 scale
        const sx = it.score_x||0;
        const scoreX = (sx>0 && sx<=1) ? sx*(S.tplScale||1)*spw : sx*(S.tplScale||1);
        S_TPL_RECTS.push({ pageIndex:it.score_page||0, x:tr.x||0, y:tr.y||0, w:tr.w||0, h:tr.h||0,
          item_name:it.item_name||('题目'+(it.item_index+1)), max_score:it.max_score||0,
          scoreX, title_img:it.title_img||'' });
      } else {
        S_ITEMS.push({ item_name:it.item_name||('题目'+(it.item_index+1)), max_score:it.max_score||0 });
      }
    });
    if(S_BASIC_FIELDS.length){ renderBasicBoxes(); }
    if(S_TPL_RECTS.length){ renderTitleBoxes(); renderScoreBoxes(); }
    if(S_TOTAL_RECT){ renderTotalBox(); }
    if(S_BASIC_FIELDS.length || S_TPL_RECTS.length || S_TOTAL_RECT || S_ITEMS.length){ renderItemList(); }
    if(window.__bridge&&window.__bridge.log) window.__bridge.log('[加载框选] basic='+S_BASIC_FIELDS.length+' items='+S_TPL_RECTS.length+(S_TOTAL_RECT?' 统分区':'')+' 已从数据库恢复');
  }catch(e){ if(window.__bridge&&window.__bridge.log) window.__bridge.log('[加载框选] 失败 '+e); }
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
      if(t.classList.contains('tpl-resize-lt')){  // 左上角缩放手柄
        drag={mode:'resize-lt', idx:parseInt(t.dataset.idx,10), x0:e.clientX, y0:e.clientY};
        return;
      }
      if(t.classList.contains('tpl-total-del')){  // 统分区删除
        S_TOTAL_RECT=null; renderTotalBox(); renderItemList();
        e.preventDefault(); e.stopPropagation(); return;
      }
      if(t.classList.contains('tpl-total-resize') || t.classList.contains('tpl-total-resize-lt')){  // 统分区缩放
        drag={mode:t.classList.contains('tpl-total-resize-lt')?'tresize-lt':'tresize', x0:e.clientX, y0:e.clientY};
        return;
      }
      if(t.classList.contains('tpl-total')){  // 统分区移动
        drag={mode:'tmove', x0:e.clientX, y0:e.clientY};
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
      const dx=e.clientX-drag.x0, dy=e.clientY-drag.y0;
      drag.x0=e.clientX; drag.y0=e.clientY;
      if(drag.mode==='tmove'||drag.mode==='tresize'||drag.mode==='tresize-lt'){
        const tt=S_TOTAL_RECT;
        if(!tt) return;
        if(drag.mode==='tmove'){ tt.x=Math.max(0,Math.round(tt.x+dx)); tt.y=Math.max(0,Math.round(tt.y+dy)); renderTotalBox(); }
        else if(drag.mode==='tresize'){ tt.w=Math.max(30,Math.round(tt.w+dx)); tt.h=Math.max(16,Math.round(tt.h+dy)); renderTotalBox(); }
        else { const nx=Math.max(0,Math.min(tt.x+dx,tt.x+tt.w-30)); const ny=Math.max(0,Math.min(tt.y+dy,tt.y+tt.h-16)); tt.w=Math.max(30,Math.round(tt.w+(tt.x-nx))); tt.h=Math.max(16,Math.round(tt.h+(tt.y-ny))); tt.x=Math.round(nx); tt.y=Math.round(ny); renderTotalBox(); }
        return;
      }
      const rt=S_TPL_RECTS[drag.idx];
      if(!rt) return;
      if(drag.mode==='score'){
        const ndx = Math.max(0, Math.round(rt.scoreX + dx));
        S_TPL_RECTS.forEach(rt2=>{ rt2.scoreX = ndx; });   // 打分区统一对齐同一竖列，调一个全联动
        renderScoreBoxes();
      } else if(drag.mode==='resize'){
        rt.w=Math.max(14, Math.round(rt.w+dx));
        rt.h=Math.max(12, Math.round(rt.h+dy));
        renderTitleBoxes(); renderScoreBoxes();
      } else if(drag.mode==='resize-lt'){
        const nx=Math.max(0, Math.min(rt.x+dx, rt.x+rt.w-14));
        const ny=Math.max(0, Math.min(rt.y+dy, rt.y+rt.h-12));
        rt.w=Math.max(14, Math.round(rt.w+(rt.x-nx)));
        rt.h=Math.max(12, Math.round(rt.h+(rt.y-ny)));
        rt.x=Math.round(nx); rt.y=Math.round(ny);
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
  let m=title.match(/[（(]\s*(\d+(?:\.\d+)?)\s*分?\s*[）)]/);
  if(m){ score=m[1]; title=title.replace(m[0],'').trim(); }
  else{
    m=title.match(/(?:^|[，,;；。:\s])(\d+(?:\.\d+)?)\s*分\s*$/);
    if(m){ score=m[1]; title=title.replace(m[0],'').trim(); }
  }
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
    lab.textContent = rt.item_name || ('题目'+(i+1));
    d.appendChild(lab);
    const rzlt=document.createElement('div'); rzlt.className='tpl-resize-lt'; rzlt.dataset.idx=i; d.appendChild(rzlt);
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
  const log=(m)=>{ if(window.__bridge && window.__bridge.log) window.__bridge.log('OCR '+m); };
  const tout=(ms)=> new Promise((_,rej)=>setTimeout(()=>rej(new Error('OCR 超时('+ms+'ms)')), ms));
  let worker;
  try{
    worker = await Promise.race([
      Tesseract.createWorker({
        workerPath, corePath, langPath,
        workerBlobURL: false,
        logger: m=>{ if(m && m.status) log(m.status); },
        errorHandler: e=>{ log('worker 错误: '+String(e&&e.message||e)); }
      }),
      tout(25000)
    ]);
  }catch(e){ log('createWorker 失败/超时: '+String(e&&e.message||e)); throw e; }
  S_ocrWorker = worker;
  if(window.__bridge && window.__bridge.log) window.__bridge.log('OCR createWorker OK');
  try{ await Promise.race([ S_ocrWorker.loadLanguage('chi_sim'), tout(30000) ]); }catch(e){ log('loadLanguage 失败/超时: '+String(e&&e.message||e)); throw e; }
  if(window.__bridge && window.__bridge.log) window.__bridge.log('OCR chi_sim 语言已加载');
  try{ await Promise.race([ S_ocrWorker.initialize('chi_sim'), tout(15000) ]); }catch(e){ log('initialize 失败/超时: '+String(e&&e.message||e)); throw e; }
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
  pre.querySelectorAll('.tpl-total,.tpl-total-dot,.tpl-total-label,.tpl-total-del,.tpl-total-resize,.tpl-total-resize-lt').forEach(n=>n.remove());
  if(!S_TOTAL_RECT) return;
  const t=S_TOTAL_RECT;
  const d=document.createElement('div'); d.className='tpl-total';
  d.style.left=t.x+'px'; d.style.top=t.y+'px'; d.style.width=t.w+'px'; d.style.height=t.h+'px';
  host.appendChild(d);
  const n=Math.max(1,t.count);
  const lab=document.createElement('div'); lab.className='tpl-total-label'; lab.textContent='统分区：'+n+' 个分数位'; d.appendChild(lab);
  const rzlt=document.createElement('div'); rzlt.className='tpl-total-resize-lt'; d.appendChild(rzlt);
  const rz=document.createElement('div'); rz.className='tpl-total-resize'; d.appendChild(rz);
  const dl=document.createElement('div'); dl.className='tpl-total-del'; dl.textContent='×'; d.appendChild(dl);
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
// —— 保存评分项后自动扫描原始报告并 OCR 基本信息，对比名单生成核心表
async function runPrepScan(){
  window.__bridge.log('[runPrepScan] start folder=', S.folder, 'syncBridge=', !!(window.__bridge&&window.__bridge.syncFolder));
  if(!window.__bridge || !window.__bridge.syncFolder || !S.folder){ window.__bridge.log('[runPrepScan] abort(缺sync或folder)'); return; }
  setDetect('正在扫描并识别报告基本信息...');
  try{
    const sync = await window.__bridge.syncFolder(S.folder);
    window.__bridge.log('[runPrepScan] sync ok added=', sync && sync.added, 'unmatched=', sync && sync.unmatched && sync.unmatched.length);
  }catch(e){ window.__bridge.log('[runPrepScan] sync FAIL:', e); setErr('扫描同步失败: '+e); }
  refreshPrepOverview();
  const ov = S.prepOv;
  const rows = (ov && ov.rows) || [];
  window.__bridge.log('[runPrepScan] prepOverview rows=', rows.length);
  if(!rows.length) return;
  const roster = await window.__bridge.getRoster(S.folder).catch(()=>[]);
  const basicFields = await window.__bridge.getBasicFields(S.folder).catch(()=>[]);
  window.__bridge.log('[runPrepScan] roster=', roster && roster.length, ' basicFields=', basicFields && basicFields.length);
  const need = rows.filter(r=>!r.matched);
  let ok=0;
  for(const r of need){
    try{
      const ocr = await ocrReportBasic(r.path, basicFields);
      if(!ocr){ window.__bridge.log('[runPrepScan] ocr none:', r.path); continue; }
      window.__bridge.log('[runPrepScan] ocr:', JSON.stringify(ocr));
      await window.__bridge.saveReportOcr(S.folder, r.key, (ocr.no||'').trim(), (ocr.name||'').trim(), (ocr.cls||'').trim(), (ocr.exp||'').trim());
      const hit = roster.find(s=> (ocr.no && s.no===ocr.no.trim()) || (ocr.name && s.name===ocr.name.trim()));
      if(hit){ await window.__bridge.resolveUnmatched(S.folder, {path:r.path}, hit.no); ok++; window.__bridge.log('[runPrepScan] 自动挂靠', hit.no, r.path); }
    }catch(e){ window.__bridge.log('[runPrepScan] 单份失败:', e); }
  }
  setDetect('✅ 扫描识别完成'+(ok?('，自动挂靠 '+ok+' 份'):''));
  refreshPrepOverview();
}
async function textLayerMatchReport(pobj, vp, px, py, pw, ph){
  try{
    const tc = await pobj.getTextContent();
    const parts=[];
    for(const it of (tc.items||[])){
      if(!it || !it.str || !it.transform || it.transform.length<6) continue;
      const p = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      if(p[0]>=px-6 && p[0]<=px+pw+6 && p[1]>=py-6 && p[1]<=py+ph+6) parts.push(it.str);
    }
    return parts.join(' ').trim();
  }catch(e){ return ''; }
}
async function ocrReportBasic(path, basicFields){
  const fields=(basicFields||[]).filter(f=>f[0] && f[0]!=='__total__');
  if(!fields.length || !path) return null;
  if(!S.pdfjsOk) return null;
  try{
    const bytes=await window.__bridge.readPdf(S.folder, path);
    const pdf=await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
    const res={}; const tplScale = S.tplScale || 1;
    for(const f of fields){
      const type=f[0]; let page=f[1]||0; let rect={};
      try{ rect=JSON.parse(f[2]||'{}'); }catch(e){}
      if(!rect.w && !rect.h && !(rect.left!=null && rect.top!=null && rect.right!=null && rect.bottom!=null)) continue;
      try{
        const pobj=await pdf.getPage(Math.max(1,page));
        const vp=await pobj.getViewport({scale:2});
        let px,py,pw,ph;
        if(rect.left!=null && rect.top!=null && rect.right!=null && rect.bottom!=null){
          px=Math.max(0, Math.floor(rect.left*vp.width));
          py=Math.max(0, Math.floor(rect.top*vp.height));
          pw=Math.max(4, Math.min(Math.floor(vp.width)-px, Math.ceil((rect.right-rect.left)*vp.width)));
          ph=Math.max(4, Math.min(Math.floor(vp.height)-py, Math.ceil((rect.bottom-rect.top)*vp.height)));
        } else {
          px=Math.max(0, Math.floor(rect.x/tplScale*2));
          py=Math.max(0, Math.floor(rect.y/tplScale*2));
          pw=Math.max(4, Math.min(Math.floor(vp.width)-px, Math.ceil(rect.w/tplScale*2)));
          ph=Math.max(4, Math.min(Math.floor(vp.height)-py, Math.ceil(rect.h/tplScale*2)));
        }
        // 优先文本层识别（文本型报告最准，不依赖图像OCR引擎）
        let txt = await textLayerMatchReport(pobj, vp, px, py, pw, ph);
        let source = txt ? 'text' : 'image';
        // 图像OCR备用（扫描版无文本层）
        if(!txt){
          const canvas=document.createElement('canvas'); canvas.width=Math.floor(vp.width); canvas.height=Math.floor(vp.height);
          await pobj.render({canvasContext:canvas.getContext('2d'), viewport:vp}).promise;
          const ctx=canvas.getContext('2d');
          const img=ctx.getImageData(px,py,pw,ph);
          const c2=document.createElement('canvas'); c2.width=pw; c2.height=ph;
          c2.getContext('2d').putImageData(img,0,0);
          const b64=c2.toDataURL('image/png').split(',')[1];
          try{ txt=await window.__bridge.ocrImageB64(b64); }catch(e){ if(window.__bridge&&window.__bridge.log) window.__bridge.log('[ocrERR] type='+type+' err='+e); }
          txt=(txt||'').trim();
          if(!txt && window.Tesseract){
            try{ const t=await recognizeOcr(c2); txt=(t||'').trim(); if(txt) source='tesseract'; }catch(e){ if(window.__bridge&&window.__bridge.log) window.__bridge.log('[tessERR] type='+type+' '+String(e&&e.message||e)); }
          }
          try{ if(window.__bridge && window.__bridge.saveToOutput){
            const raw=atob(b64); const arr=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++) arr[i]=raw.charCodeAt(i);
            await window.__bridge.saveToOutput('ocr_debug/'+type+'_'+Date.now()+'.png', arr).catch(()=>{});
          }}catch(e){}
        }
        if(window.__bridge && window.__bridge.log) window.__bridge.log('[ocrtpl] type='+type+' page='+page+' rect='+JSON.stringify(rect)+' px='+px+' py='+py+' w='+pw+' h='+ph+' ocr="'+txt+'" src='+source);
        if(type==='no') res.no=txt; else if(type==='name') res.name=txt; else if(type==='class') res.cls=txt; else if(type==='exp') res.exp=txt;
      }catch(e){}
    }
    return Object.keys(res).length ? res : null;
  }catch(e){ return null; }
}
// —— 核对原始报告进度条（前端逐份 OCR，可控进度）
function showVerifyProgress(total, label){
  let bar=document.getElementById('verifyProgress');
  if(!bar){
    bar=document.createElement('div'); bar.id='verifyProgress';
    bar.style.cssText='position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:999;background:#fff;border:1px solid #dde1e6;border-radius:8px;padding:12px 18px;box-shadow:0 2px 12px rgba(0,0,0,.12);min-width:420px;text-align:left;';
    bar.innerHTML='<div id="vpLabel" style="font-size:13px;color:#2b3a55;margin-bottom:6px;font-weight:600">正在核对原始报告…</div>'+
      '<div style="height:10px;background:#eef1f5;border-radius:5px;overflow:hidden"><div id="vpFill" style="height:100%;width:0;background:#e07b39;transition:width .2s"></div></div>'+
      '<div id="vpTxt" style="font-size:12px;color:#666;margin-top:6px"></div>';
    document.body.appendChild(bar);
  }
  bar.style.display='block';
  const lb=document.getElementById('vpLabel'); if(lb) lb.textContent=label||'正在核对原始报告…';
  const fill=document.getElementById('vpFill'); if(fill) fill.style.width='0%';
  const txt=document.getElementById('vpTxt'); if(txt) txt.textContent='0% ｜ 已处理 0 份 ｜ 剩余 '+(total||0)+' 份';
  S._vpTotal=total||0; S._vpDone=0;
  updateVerifyProgress();
}
function updateVerifyProgress(){
  const t=S._vpTotal||0, d=S._vpDone||0;
  const pct = t? Math.round(d/t*100) : 100;
  const fill=document.getElementById('vpFill'); if(fill) fill.style.width=pct+'%';
  const txt=document.getElementById('vpTxt'); if(txt) txt.textContent=pct+'% ｜ 已处理 '+d+' 份 ｜ 剩余 '+(t-d)+' 份';
}
function hideVerifyProgress(){ const bar=document.getElementById('verifyProgress'); if(bar) bar.style.display='none'; }

/* ==================== 打分位置定位（准备阶段批量，写库供批改复用） ==================== */
// 构造完整标题串（题目+括号分数）：框选内容含完整标题时直接命中；统分区题目/分数分两行不会整串命中
function locateTarget(it){
  let t=(it.item_name||'').trim();
  if(!/分\)/.test(t) && it.max_score>0) t += '（'+it.max_score+'分）';
  return t.replace(/\s+/g,'');
}
// 在文字层找包含完整标题串的"标题行"（距顶比例存库；横向统一为整页文字区右缘）
async function findTitleInTextLayer(pdf, target, pageIdx){
  try{
    const page=await pdf.getPage(pageIdx+1);
    const items=await getPageText(page);
    const lines=groupLines(items);
    const vp=page.getViewport({scale:1});
    const ph=vp.height||1, pw=vp.width||1;
    // 整页文字区右缘：所有字(块) x+width 的最大值
    let maxRight=0;
    for(const l of lines){ for(const it of l.items){ const r=it.x+it.w; if(r>maxRight) maxRight=r; } }
    const rightPct = pw>0 ? Math.round(maxRight/pw*10000)/10000 : null;
    for(const l of lines){
      const t=l.text.replace(/\s+/g,'');
      if(t.includes(target) && /^[一二三四五六七]、/.test(l.text.trim())){
        return { pageIndex:pageIdx, titleY_pct: Math.round(l.y/ph*10000)/10000, titleX_pct: rightPct, ocr_text:'' };
      }
    }
  }catch(e){}
  return null;
}
// 文字版定位整份报告
async function locateReportTitlesText(path, tpl){
  try{
    const bytes=await window.__bridge.readPdf(S.folder, path);
    const pdf=await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
    const locItems=[]; let fully=true;
    for(const it of tpl){
      const target=locateTarget(it);
      const f=await findTitleInTextLayer(pdf, target, it.score_page||0);
      if(f){ locItems.push({item_index:it.item_index, pageIndex:f.pageIndex, titleY_pct:f.titleY_pct, titleX_pct:f.titleX_pct, ocr_text:''}); }
      else fully=false;
    }
    return {items:locItems, fully};
  }catch(e){ return {items:[], fully:false}; }
}
// 渲染整页为 b64（供全文 OCR）
async function renderPageB64(pdf, pageIdx, scale){
  const page=await pdf.getPage(pageIdx+1);
  const vp=page.getViewport({scale});
  const canvas=document.createElement('canvas'); canvas.width=Math.floor(vp.width); canvas.height=Math.floor(vp.height);
  await page.render({canvasContext:canvas.getContext('2d'), viewport:vp}).promise;
  return canvas.toDataURL('image/png').split(',')[1];
}
// 渲染页面上一个比例区域（左/上/宽/高均为0-1比例），返回该区域b64 —— 供逐段聚焦OCR
async function renderAreaB64(pdf, pageIdx, leftPct, topPct, wPct, hPct, scale){
  const page=await pdf.getPage(pageIdx+1);
  const vp=page.getViewport({scale});
  const canvas=document.createElement('canvas'); canvas.width=Math.floor(vp.width); canvas.height=Math.floor(vp.height);
  await page.render({canvasContext:canvas.getContext('2d'), viewport:vp}).promise;
  const ctx=canvas.getContext('2d');
  const px=Math.max(0,Math.floor(leftPct*vp.width));
  const py=Math.max(0,Math.floor(topPct*vp.height));
  const pw=Math.max(8,Math.min(Math.floor(vp.width)-px,Math.ceil(wPct*vp.width)));
  const ph=Math.max(8,Math.min(Math.floor(vp.height)-py,Math.ceil(hPct*vp.height)));
  const img=ctx.getImageData(px,py,pw,ph);
  const c2=document.createElement('canvas'); c2.width=pw; c2.height=ph;
  c2.getContext('2d').putImageData(img,0,0);
  return c2.toDataURL('image/png').split(',')[1];
}
// 把整页OCR的行按纵向距离自动聚合成"段落框"（自动框选文字段落）：每段含位置(top/left/right/bottom)+文本
function clusterLines(lines, gap=0.016){
  const arr=(lines||[]).slice().sort((a,b)=>(a.top||0)-(b.top||0));
  const blocks=[];
  for(const l of arr){
    const top=l.top||0, bottom=top+0.016, left=l.left!=null?l.left:0, right=l.right!=null?l.right:1;
    const last=blocks[blocks.length-1];
    if(last && (top-last.bottom) < gap && Math.abs(left-last.left)<0.5){
      last.bottom=Math.max(last.bottom,bottom);
      last.left=Math.min(last.left,left);
      last.right=Math.max(last.right,right);
      last.text+=l.text;
    } else {
      blocks.push({top, bottom, left, right, text:l.text});
    }
  }
  return blocks;
}
// 逐像素行扫描检测"文字行带"：文字行是连续多条像素行且行内黑白交替(非背景像素占比适中)，空白行没有。
// 返回段落块(top/bottom 比例)——字体大小不影响，按真实文字区域切分。
// 页面结构分析（逐像素行扫描）：区分 文字行带 / 表格横线 / 空白；检测表格竖线→重建网格；并反推字号(A4)
// 返回 { textBands:[{top,bottom,pt}], hlines:[{top,bottom}], vlines:[{x,top,bottom}], grid:{rows,cols}|null }
async function analyzePage(pdf, pageIdx, scale=2){
  const page=await pdf.getPage(pageIdx+1);
  const vp=page.getViewport({scale});
  const canvas=document.createElement('canvas'); canvas.width=Math.floor(vp.width); canvas.height=Math.floor(vp.height);
  await page.render({canvasContext:canvas.getContext('2d'), viewport:vp}).promise;
  const W=canvas.width, H=canvas.height;
  const empty={textBands:[], hlines:[], vlines:[], grid:null};
  if(!W||!H) return empty;
  const data=canvas.getContext('2d').getImageData(0,0,W,H).data;
  const isBg=(i)=>{ const r=data[i],g=data[i+1],b=data[i+2]; return r>242&&g>242&&b>242; };
  // 逐像素行：统计非背景占比 + 最大连续黑段（判断表格横线）
  const rowType=new Array(H).fill('blank');
  for(let y=0;y<H;y++){
    let cnt=0, maxSeg=0, seg=0, segStart=-1, segLeft=W, segRight=-1;
    const off=y*W;
    for(let x=0;x<W;x++){
      if(!isBg((off+x)*4)){
        cnt++; if(seg===0) segStart=x; seg++; if(seg>maxSeg) maxSeg=seg; segRight=x;
      } else { if(seg>0){ if(segStart<segLeft) segLeft=segStart; seg=0; } }
    }
    if(seg>0 && segStart<segLeft) segLeft=segStart;
    const ratio=cnt/W;
    // 表格横线：黑像素聚成一个覆盖中间的大连续段(段长>行宽一半)，且段左右都有空白
    if(maxSeg> W*0.5 && segLeft> W*0.04 && segRight< W*0.96 && ratio>0.3){
      rowType[y]='hline';
    } else if(ratio>0.0012 && ratio<0.55){   // 文字行（黑白交替）
      rowType[y]='text';
    }
  }
  // 连续同类行 → 文字行带 / 表格横杠（连续横线行合并为同一根横杠）
  const textBands=[], hlines=[];
  let tStart=-1, hStart=-1;
  for(let y=0;y<H;y++){
    const ty=rowType[y];
    if(ty==='text' && tStart<0) tStart=y;
    if(ty!=='text' && tStart>=0){ textBands.push({top:tStart,bottom:y-1}); tStart=-1; }
    if(ty==='hline' && hStart<0) hStart=y;
    if(ty!=='hline' && hStart>=0){ hlines.push({top:hStart,bottom:y-1}); hStart=-1; }
  }
  if(tStart>=0) textBands.push({top:tStart,bottom:H-1});
  if(hStart>=0) hlines.push({top:hStart,bottom:H-1});
  // 文字行带（单行，不做段落合并——定位时逐行送OCR）
  const blocks=textBands.slice();
  // 字号换算：行带高 → A4(297mm) → pt（行距系数1.4）
  const mmPerPx=297/H;
  blocks.forEach(b=>{ b.pt=Math.round((b.bottom-b.top+1)*mmPerPx/0.3528/1.4*10)/10; });
  // 竖线检测：相邻两根横杠之间的区域里找"垂直连续黑"列，并与上/下横杠同x(±容差)确认
  // 区域从横杠下方过约3像素开始、到下一横杠上方3像素为止，避开横杠上下阴影
  const vlines=[];
  if(hlines.length>=2){
    const skip=Math.max(2, Math.round(H*0.0015));   // 约3px阴影带
    for(let hi=0; hi<hlines.length-1; hi++){
      const top=Math.min(hlines[hi].bottom+skip, H-1), bot=Math.max(hlines[hi+1].top-skip, top+1);
      if(bot-top<1) continue;
      for(let x=1;x<W-1;x++){
        let c=0;
        for(let y=top;y<=bot;y++){ if(!isBg((y*W+x)*4)) c++; }
        if(c/(bot-top+1)>0.85){   // 该列垂直连续黑 → 竖线候选
          const n=Math.max(1, Math.round(W*0.0015));   // 容差：与横杠像素 x 差在 n 内
          let up=false, down=false;
          for(let dx=-n;dx<=n;dx++){
            const xx=x+dx; if(xx<0||xx>=W) continue;
            if(!isBg((hlines[hi].top*W+xx)*4)) up=true;
            if(!isBg((hlines[hi+1].bottom*W+xx)*4)) down=true;
          }
          if(up && down){ vlines.push({x, top:hlines[hi].top, bottom:hlines[hi+1].bottom}); x++; }
        }
      }
    }
  }
  // 去重竖线（合并相邻 x）
  const vx=[];
  for(const v of vlines){ if(!vx.length || v.x-vx[vx.length-1].x>2) vx.push(v.x); }
  // 网格：横杠 y 为行边界，竖线 x 为列边界
  const grid = (hlines.length>=2 && vx.length>=2)
    ? { rows: hlines.map(h=>({top:h.top/H, bottom:(h.bottom+1)/H})), cols: vx.map(x=>x/W) }
    : null;
  return {
    textLines: blocks.map(b=>({top:Math.round(b.top/H*10000)/10000, bottom:Math.round((b.bottom+1)/H*10000)/10000, pt:b.pt})),
    hlines: hlines.map(h=>({top:Math.round(h.top/H*10000)/10000, bottom:Math.round((h.bottom+1)/H*10000)/10000})),
    vlines: vlines.map(v=>({x:Math.round(v.x/W*10000)/10000, top:Math.round(v.top/H*10000)/10000, bottom:Math.round((v.bottom+1)/H*10000)/10000})),
    grid
  };
}
// 最长连续公共子串长度（标题与识别文本），用于匹配容错
function longestContMatch(a,b){
  const m=a.length,n=b.length; if(!m||!n) return 0;
  const dp=new Array(m+1); for(let i=0;i<=m;i++) dp[i]=new Array(n+1).fill(0);
  let mx=0;
  for(let i=1;i<=m;i++) for(let j=1;j<=n;j++){
    if(a[i-1]===b[j-1]){ dp[i][j]=dp[i-1][j-1]+1; if(dp[i][j]>mx) mx=dp[i][j]; }
  }
  return mx;
}
// 扫描版定位：①像素结构分析(文字行+表格网格) → ②逐行OCR(一行一行送,含表格行带) → ③表格格内OCR补充 → ④跨行拼接匹配 → ⑤框选模板区域兜底
async function findTitleInScan(pdf, target, pageIdx, titleRectJson){
  const p=pageIdx||0;
  const norm=(s)=>(s||'').replace(/\s+/g,'').replace(/[，。、；：（）()【】《》"'“”]/g,'');
  const tn=norm(target);
  let rows=[], pageRight=null, ana=null;
  // ① 像素结构分析
  try{ ana=await analyzePage(pdf,p,2); }catch(e){}
  // ② 逐行 OCR（一行一行送，scale4，含表格内的文字行带；上下各扩充3像素防裁字）
  try{
    const lines=(ana&&ana.textLines)||[];
    let exp=0.004;   // 默认扩充(约3px@scale4)，下面按实际页高折算
    try{ const vp0=await (await pdf.getPage(p+1)).getViewport({scale:4}); exp=Math.max(0.0005, 3/vp0.height); }catch(e){}
    for(const ln of lines){
      const top=Math.max(0, ln.top-exp);
      const h=Math.min(1-top, (ln.bottom-ln.top)+2*exp);
      const ab64=await renderAreaB64(pdf, p, 0.02, top, 0.96, Math.max(h, 0.01), 4);
      const l=(await window.__bridge.ocrImageB64Words(ab64).catch(()=>[]))||[];
      const t=(l||[]).map(x=>x.text).join('');
      let r=0; for(const w of l){ const rr=0.02+((w.right!=null?w.right:w.left)||0)*0.96; if(rr>r) r=rr; }
      if(r>0 && (pageRight==null || r>pageRight)) pageRight=r;
      rows.push({top:ln.top, bottom:ln.bottom, text:t, pt:ln.pt});
    }
  }catch(e){}
  // ③ 表格格内 OCR 补充（标题若整格、行带漏了也能补上）
  try{
    if(ana && ana.grid && ana.grid.rows.length>=2 && ana.grid.cols.length>=2){
      const gR=ana.grid.rows, cols=ana.grid.cols;
      for(let ri=0; ri<gR.length-1; ri++){
        const top=gR[ri].top, h=(gR[ri+1].top-top)||0.02;
        for(let ci=0; ci<cols.length-1; ci++){
          const left=cols[ci], w=(cols[ci+1]-left)||0.02;
          const ab64=await renderAreaB64(pdf, p, left, top, w, h, 4);
          const l=(await window.__bridge.ocrImageB64Words(ab64).catch(()=>[]))||[];
          const t=(l||[]).map(x=>x.text).join('');
          if(t.trim()){
            let r=0; for(const ww of l){ const rr=left+((ww.right!=null?ww.right:ww.left)||0)*w; if(rr>r) r=rr; }
            if(r>0 && (pageRight==null || r>pageRight)) pageRight=r;
            rows.push({top, bottom:top+h, text:t, isCell:true});
          }
        }
      }
    }
  }catch(e){}
  // ④ 匹配标题：逐行 + 跨行拼接（标题若拆两行）
  rows.sort((a,b)=>a.top-b.top);
  for(let i=0;i<rows.length;i++){
    const nt1=norm(rows[i].text);
    if(nt1 && (nt1.includes(tn) || (tn.length>0 && longestContMatch(tn,nt1)/tn.length>=0.8))){
      return { pageIndex:p, titleY_pct: Math.round(rows[i].top*10000)/10000, titleX_pct: (pageRight!=null?Math.round(pageRight*10000)/10000:null), ocr_text:rows[i].text, pt:rows[i].pt };
    }
    if(i+1<rows.length){
      const nt2=norm(rows[i].text+rows[i+1].text);
      if(nt2 && (nt2.includes(tn) || (tn.length>0 && longestContMatch(tn,nt2)/tn.length>=0.8))){
        return { pageIndex:p, titleY_pct: Math.round(rows[i].top*10000)/10000, titleX_pct: (pageRight!=null?Math.round(pageRight*10000)/10000:null), ocr_text:rows[i].text+rows[i+1].text, pt:rows[i].pt };
      }
    }
  }
  // ⑤ 框选模板区域兜底（原 title_rect）
  try{
    let rect={}; try{ rect=JSON.parse(titleRectJson||'{}'); }catch(e){}
    if(rect.x!=null && rect.y!=null && rect.w && rect.h){
      const ab64=await renderAreaB64(pdf, p, rect.x, rect.y, rect.w, rect.h, 4);
      const rlines=(await window.__bridge.ocrImageB64Words(ab64).catch(()=>[]))||[];
      const atext=(rlines||[]).map(x=>x.text).join('');
      const hit=(rlines||[]).find(x=>norm(x.text).includes(tn));
      if(hit) return { pageIndex:p, titleY_pct: Math.round(hit.top*10000)/10000, titleX_pct: (pageRight!=null?Math.round(pageRight*10000)/10000:null), ocr_text:hit.text };
      if((rlines||[]).length){
        return { pageIndex:p, titleY_pct: Math.round((rect.y+rect.h/2)*10000)/10000, titleX_pct: (pageRight!=null?Math.round(pageRight*10000)/10000:null), ocr_text:atext };
      }
    }
  }catch(e){}
  // ⑥ 全部未命中 → 返回还原文本（逐行拼接，位置空）
  const rt=rows.map(x=>x.text).join('\n');
  return { pageIndex:p, titleY_pct: null, titleX_pct: null, ocr_text: rt };
}
// 扫描版定位整份报告
async function locateReportTitlesScan(path, tpl){
  try{
    const bytes=await window.__bridge.readPdf(S.folder, path);
    const pdf=await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
    const norm=(s)=>(s||'').replace(/\s+/g,'').replace(/[，。、；：（）()【】《》"'“”]/g,'');
    const locItems=[]; let fully=true;
    const allRows=[]; let pageRight=null;
    // 全页逐行 OCR（从第一页起，完整还原文本 + 跨页定位）
    for(let p=0;p<pdf.numPages;p++){
      let ana=null; try{ ana=await analyzePage(pdf,p,2); }catch(e){}
      const lines=(ana&&ana.textLines)||[];
      let exp=0.004; try{ const vp0=await (await pdf.getPage(p+1)).getViewport({scale:4}); exp=Math.max(0.0005,3/vp0.height); }catch(e){}
      for(const ln of lines){
        const top=Math.max(0,ln.top-exp);
        const h=Math.min(1-top,(ln.bottom-ln.top)+2*exp);
        const ab64=await renderAreaB64(pdf,p,0.02,top,0.96,Math.max(h,0.01),4);
        const l=(await window.__bridge.ocrImageB64Words(ab64).catch(()=>[]))||[];
        const t=(l||[]).map(x=>x.text).join('');
        let r=0; for(const w of l){ const rr=0.02+((w.right!=null?w.right:w.left)||0)*0.96; if(rr>r) r=rr; }
        if(r>0 && (pageRight==null || r>pageRight)) pageRight=r;
        allRows.push({pageIndex:p, top:ln.top, bottom:ln.bottom, text:t});
      }
    }
    // 每题标题匹配（跨页，含跨行拼接与80%容错）
    for(const it of tpl){
      const tn=norm(locateTarget(it));
      let hit=null;
      for(let i=0;i<allRows.length;i++){
        const nt1=norm(allRows[i].text);
        if(nt1 && (nt1.includes(tn)||(tn.length>0&&longestContMatch(tn,nt1)/tn.length>=0.8))){ hit=allRows[i]; break; }
        if(i+1<allRows.length){
          const nt2=norm(allRows[i].text+allRows[i+1].text);
          if(nt2 && (nt2.includes(tn)||(tn.length>0&&longestContMatch(tn,nt2)/tn.length>=0.8))){ hit=allRows[i]; break; }
        }
      }
      if(hit){
        locItems.push({item_index:it.item_index, pageIndex:hit.pageIndex, titleY_pct:Math.round(hit.top*10000)/10000, titleX_pct:(pageRight!=null?Math.round(pageRight*10000)/10000:null), ocr_text:hit.text});
      } else { locItems.push({item_index:it.item_index, pageIndex:null, titleY_pct:null, titleX_pct:null, ocr_text:''}); fully=false; }
    }
    const fullText=allRows.map(r=>r.text).join('\n');
    return {items:locItems, fully, fullText};
  }catch(e){ return {items:[], fully:false, fullText:''}; }
}
// 探测 PDF 是否有文字层（首页文本量）
async function hasTextLayer(path){
  try{
    const bytes=await window.__bridge.readPdf(S.folder, path);
    const pdf=await pdfjsLib.getDocument({data:bytes.slice(0)}).promise;
    for(let p=0;p<Math.min(2,pdf.numPages);p++){
      const items=await getPageText(await pdf.getPage(p+1));
      if(items.length>10) return true;
    }
    return false;
  }catch(e){ return false; }
}

async function runSourceVerify(){
  const L=(m)=>{ if(window.__bridge&&window.__bridge.log) window.__bridge.log('[核对] '+m); };
  L('入口 folder='+(S.folder||'<空>'));
  if(!S.folder){ setErr('请先选报告文件夹'); return; }
  if(!window.__bridge || !window.__bridge.syncFolder){ L('缺少同步接口'); setErr('环境异常：缺少同步接口'); return; }
  let bf=[]; try{ bf = await window.__bridge.getBasicFields(S.folder); }catch(e){ L('getBasicFields err '+e); }
  if(!(bf&&bf.length)){ L('基本信息为空，中止'); setErr('请先点「设置模板（框选）」框选基本信息并保存，再核对原始报告'); return; }
  setDetect('正在核对原始报告：扫描并 OCR 匹配...');
  L('开始，基本信息字段='+bf.length);
  try{ const sync=await window.__bridge.syncFolder(S.folder); L('sync added='+(sync&&sync.added)+' unmatched='+(sync&&sync.unmatched&&sync.unmatched.length)); }
  catch(e){ L('sync FAIL '+e); setErr('同步失败: '+e); }
  refreshPrepOverview();
  const rows=(S.prepOv&&S.prepOv.rows)||[];
  if(!rows.length){ L('无原始报告'); setDetect('没有扫描到原始报告，请确认报告 PDF 在所选文件夹内'); return; }
  const roster = await window.__bridge.getRoster(S.folder).catch(()=>[]);
  const basicFields = await window.__bridge.getBasicFields(S.folder).catch(()=>[]);
  const need = rows.filter(r=>!r.matched);
  need.sort((a,b)=>{ const ka=a.path.includes('扫描')||a.path.includes('scan')?1:0; const kb=b.path.includes('扫描')||b.path.includes('scan')?1:0; return ka-kb; });
  L('需OCR '+need.length+' 份');
  let ok=0;
  showVerifyProgress(need.length, '第0步：基本信息 OCR + 挂靠');
  for(const r of need){
    S._vpDone++; updateVerifyProgress();
    try{
      const ocr = await ocrReportBasic(r.path, basicFields);
      if(!ocr){ L('ocr none '+r.path); continue; }
      L('ocr '+JSON.stringify(ocr));
      await window.__bridge.saveReportOcr(S.folder, r.key, (ocr.no||'').replace(/\s+/g,''), (ocr.name||'').trim(), (ocr.cls||'').trim(), (ocr.exp||'').trim());
      const noClean=(ocr.no||'').replace(/\s+/g,'');
      const nameClean=(ocr.name||'').replace(/\s+/g,'');
      const hit = roster.find(s=> (noClean && s.no && s.no.replace(/\s+/g,'')===noClean) || (nameClean && s.name && s.name.replace(/\s+/g,'')===nameClean));
      if(hit){ await window.__bridge.resolveUnmatched(S.folder, {path:r.path}, hit.no); ok++; L('挂靠 '+hit.no); }
    }catch(e){ L('单份失败 '+e); }
  }
  hideVerifyProgress();
  refreshPrepOverview();

  // 第0步后：对已挂靠报告生成改名版（学号_姓名_班级_报告名称.pdf 复制到 renamed/），供定位与批改直接使用
  let renamedN=0;
  try{ renamedN = await window.__bridge.applyRenames(S.folder); L('改名 '+renamedN+' 份'); }catch(e){ L('改名失败 '+e); }
  refreshPrepOverview();
  setDetect('✅ 核对完成'+(ok?('，自动挂靠 '+ok+' 份'):'')+(renamedN?('，改名 '+renamedN+' 份'):''));
}

/* ---- 「定位批阅位置」按钮：只负责给已挂靠改名的报告定位打分框位置（纵向 titleY_pct），位置写库供批改直接复用 ----
   第1步：文字版定位（完整标题串，只对有文字层的）；第2步：文字版定位不全的 + 无文字层(扫描版) */
async function runLocatePositions(){
  const L2=(m)=>{ if(window.__bridge&&window.__bridge.log) window.__bridge.log('[定位] '+m); };
  if(!S.folder){ setErr('请先选报告文件夹'); return; }
  const rows2=(S.prepOv&&S.prepOv.rows)||[];
  const targets=rows2.filter(r=>r.matched && r.renamed_path);
  const tpl=(await window.__bridge.getBatchItems(S.folder).catch(()=>[]))||[];
  const itemTpl=tpl.filter(x=>x.item_index>=0).sort((a,b)=>a.item_index-b.item_index);
  L2('定位目标 '+targets.length+' 份, 模板题 '+itemTpl.length);
  if(!targets.length){ setDetect('没有待定位的报告，请先「核对原始报告」完成挂靠与改名'); return; }
  if(!itemTpl.length){ setDetect('请先「设置模板（框选）」框选题目与分值并保存'); return; }
  const saveLoc=async(key,items,source)=>{
    const json=JSON.stringify({items, source:source||'auto'});
    try{ await window.__bridge.saveReportLocate(S.folder, key, json); L2('已保存 '+key+' len='+json.length+' src='+(source||'auto')); }
    catch(e){ L2('保存定位失败 '+key+': '+e); }
  };
  const textNeed=[], scanNeed=[];
  for(const t of targets){
    if(await hasTextLayer(t.renamed_path)) textNeed.push(t); else scanNeed.push(t);
  }
  L2('文字层 '+textNeed.length+' 份, 扫描版 '+scanNeed.length+' 份');
  const toScan=[];
  let doneText=0, doneScan=0;
  if(textNeed.length){
    showVerifyProgress(textNeed.length, '第1步：文字版定位');
    for(const t of textNeed){
      S._vpDone++; updateVerifyProgress();
      const res=await locateReportTitlesText(t.renamed_path, itemTpl);
      if(res.fully && res.items.length){ await saveLoc(t.key, res.items, 'auto'); doneText++; }
      else toScan.push(t);
    }
    hideVerifyProgress();
  }
  const scanList=[...scanNeed, ...toScan];
  if(scanList.length){
    showVerifyProgress(scanList.length, '第2步：扫描版定位');
    for(const t of scanList){
      S._vpDone++; updateVerifyProgress();
      const res=await locateReportTitlesScan(t.renamed_path, itemTpl);
      const locKey=t.key;                    // 数据库 report_key（原始文件名）
      const assetKey=t.renamed_path.split(/[\\/]/).pop();   // 改名文件名（还原文本资产名）
      if(res.items.length){ await saveLoc(locKey, res.items, 'auto'); doneScan++; }
      if(res.fullText && window.__bridge.saveScanText){
        try{ await window.__bridge.saveScanText(S.folder, assetKey, res.fullText); }catch(e){ L2('保存还原文本失败 '+assetKey+': '+e); }
      }
    }
    hideVerifyProgress();
  }
  refreshPrepOverview();
  setDetect('✅ 定位完成：自动定位 '+(doneText+doneScan)+' 份，未定位 '+(targets.length-doneText-doneScan)+' 份（可在核心表人工定位）');
}

/* ---- 人工定位兜底：对「待定位」的报告，拖动蓝框到每题标题行，只改纵向，横向沿用模板文字区右边缘(score_x) ---- */
async function manualLocate(r){
  if(!r || !r.renamed_path){ alert('该报告尚无改名版，无法人工定位'); return; }
  if(!window.__bridge.readPdf){ alert('缺少渲染接口'); return; }
  const L=(m)=>{ if(window.__bridge&&window.__bridge.log) window.__bridge.log('[人工定位] '+m); };
  try{
    const arr = await window.__bridge.readPdf(S.folder, r.renamed_path);
    const pdf = await pdfjsLib.getDocument({ data: arr }).promise;
    const tpl = (await window.__bridge.getBatchItems(S.folder).catch(()=>[]))||[];
    const itemTpl = tpl.filter(x=>x.item_index>=0).sort((a,b)=>a.item_index-b.item_index);
    const body=el.locateBody; body.innerHTML='';
    el.locateTitle.textContent='人工定位：'+(r.stu_no||'')+' '+(r.stu_name||'')+' '+(r.report_name||r.fname||'');
    el.locateMask.style.display='flex';
    const blocks=[];
    for(let p=0;p<pdf.numPages;p++){
      const page=await pdf.getPage(p+1);
      const vp1=page.getViewport({scale:1});
      const availW = Math.max(240, el.locateBody.clientWidth||600);
      const scale=availW/vp1.width;
      const vp=page.getViewport({scale});
      const pg=document.createElement('div'); pg.className='loc-page'; pg.style.width=vp.width+'px';
      const cv=document.createElement('canvas'); cv.width=vp.width; cv.height=vp.height; pg.appendChild(cv);
      const ctx=cv.getContext('2d'); await page.render({canvasContext:ctx, viewport:vp}).promise;
      itemTpl.forEach((t,i)=>{
        let tr={}; try{ tr=JSON.parse(t.title_rect||'{}'); }catch(e){}
        if(!tr.w || !tr.h || (t.score_page||0)!==p) return;
        const isPct = tr.w<=1 && tr.h<=1;
        const py = isPct? (tr.y||0) : (tr.y||0)/vp1.height;
        // 横向固定：文字区右边缘 score_x（蓝框）；缺失回退红框右边缘
        let xPct=null; const sx=t.score_x;
        if(sx && sx>0 && sx<=1) xPct=sx; else if(sx && sx>1) xPct=sx/vp1.width;
        if(xPct==null) xPct = isPct? (tr.x+tr.w) : (tr.x+tr.w)/vp1.width;
        const blk=document.createElement('div'); blk.className='loc-block';
        blk.style.left = (xPct*vp.width - 120) + 'px';
        blk.style.width = '120px';
        blk.style.top = (py*vp.height - 2) + 'px';
        const tag=document.createElement('span'); tag.className='loc-tag'; tag.textContent='题'+(i+1);
        blk.appendChild(tag); pg.appendChild(blk);
        blocks.push({ blk, page, vp, item_index:i });
      });
      body.appendChild(pg);
    }
    // 拖动：只改纵向(top)，左右固定；用单一全局监听避免泄漏
    let dragging=null, offY=0;
    const onMove=(e)=>{
      if(!dragging) return;
      const pg=dragging.blk.parentElement;
      const rect=pg.getBoundingClientRect();
      const y=e.clientY-rect.top-offY;
      const vp=dragging.vp;
      dragging.blk.style.top=Math.max(0, Math.min(vp.height-4, y))+'px';
    };
    const onUp=()=>{ dragging=null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    blocks.forEach(b=>{
      b.blk.addEventListener('mousedown',(e)=>{ dragging=b; offY=e.clientY-b.blk.getBoundingClientRect().top; e.preventDefault(); });
    });
    // 保存
    el.locateSave.onclick=async ()=>{
      const items=blocks.map(b=>{
        const topPx=parseFloat(b.blk.style.top);
        return { item_index:b.item_index, titleY_pct: Math.round((topPx/b.vp.height)*10000)/10000, pageIndex:b.page.pageIndex-0, titleX_pct:null, ocr_text:'' };
      });
      if(!items.length){ alert('没有可保存的题目位置'); return; }
      const key=r.key;                     // 数据库 report_key（原始文件名）
      const json=JSON.stringify({ items, source:'manual', fully:true });
      try{
        await window.__bridge.saveReportLocate(S.folder, key, json);
        L('已保存人工定位 '+key+' items='+items.length);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        el.locateMask.style.display='none';
        refreshPrepOverview();
      }catch(e){ alert('保存失败: '+e); }
    };
  }catch(e){ alert('渲染失败: '+e); }
}
el.locateCancel.onclick=()=>{ el.locateMask.style.display='none'; };
el.btnItemSave.onclick=async ()=>{
  const items=[];
  const ts=(S.tplScale||1);
  // 归一化为相对模板页的百分比(0-1)：title_rect/total_region 不再存显示像素，批改渲染不依赖 S.tplScale
  const rectPct=(pageIndex,x,y,w,h)=>{ const pvp=(S.tplPages[pageIndex]||{}).vp; const pw=(pvp&&pvp.width)?pvp.width:1, ph=(pvp&&pvp.height)?pvp.height:1; return {x:x/ts/pw, y:y/ts/ph, w:w/ts/pw, h:h/ts/ph}; };
  S_TPL_RECTS.forEach((rt,i)=>{
    const rp=rectPct(rt.pageIndex, rt.x, rt.y, rt.w, rt.h);
    // score_x 存"相对模板页宽的百分比"(0-1)：得分显示在文字区右边缘(蓝框)，批改渲染直接用百分比
    const spvp=(S.tplPages[rt.pageIndex]||{}).vp;
    const spw=(spvp&&spvp.width)?spvp.width:1;
    const scorePct = ((rt.scoreX||0)/(S.tplScale||1))/spw;
    items.push({ item_index:i, item_name:rt.item_name||('第'+(i+1)+'项'),
      max_score:rt.max_score||0, score_page:rt.pageIndex||0,
      score_x: (rt.scoreX? Math.round(scorePct*10000)/10000 : 0),
      title_rect:JSON.stringify(rp), total_region:'{}', title_img:rt.title_img||'' });
  });
  S_ITEMS.forEach((it,ix)=>{
    items.push({ item_index:S_TPL_RECTS.length+ix,
      item_name:it.item_name||('第'+(S_TPL_RECTS.length+ix+1)+'项'),
      max_score:it.max_score||0, score_page:0, score_x:0, title_rect:'{}', total_region:'{}' });
  });
  if(!items.length && !S_BASIC_FIELDS.length){ setErr('请先框选基本信息或至少一个评分项'); return; }
  const hasTotal = !!(S_TOTAL_RECT && S_TOTAL_RECT.w>0);
  if(hasTotal){
    const ts=(S.tplScale||1);
    const pvp=(S.tplPages[0]||{}).vp;
    const pw=(pvp&&pvp.width)?pvp.width:1, ph=(pvp&&pvp.height)?pvp.height:1;
    items.push({ item_index:-1, item_name:'__total__', max_score:0, score_page:0, score_x:0,
      title_rect:'{}', total_region:JSON.stringify({x:S_TOTAL_RECT.x/ts/pw, y:S_TOTAL_RECT.y/ts/ph, w:S_TOTAL_RECT.w/ts/pw, h:S_TOTAL_RECT.h/ts/ph, count:S_TOTAL_RECT.count}) });
  }
  if(items.length && window.__bridge && window.__bridge.saveBatchItems){
    await window.__bridge.saveBatchItems(S.folder, items).catch(e=>{ setErr('⚠ '+e); return; });
  }
  if(S_BASIC_FIELDS.length && window.__bridge && window.__bridge.saveBasicFields){
    const fields = S_BASIC_FIELDS.map(rt=>{
      const pvp = (S.tplPages[rt.pageIndex]||{}).vp;
      const pw = (pvp && pvp.width) ? pvp.width : 1;
      const ph = (pvp && pvp.height) ? pvp.height : 1;
      return [rt.type, rt.pageIndex||0, JSON.stringify({left:(rt.x/pw), top:(rt.y/ph), right:((rt.x+rt.w)/pw), bottom:((rt.y+rt.h)/ph)})];
    });
    await window.__bridge.saveBasicFields(S.folder, fields).catch(e=>{ setErr('⚠ 基本信息保存失败: '+e); });
  }
  S.itemsTemplate=items.filter(x=>x.item_index>=0).map(it=>({item_name:it.item_name, max_score:it.max_score, score_x:it.score_x||0}));
  el.itemMask.style.display='none';
  window.__bridge.log('[btnItemSave] 保存 items=', items.length, ' basicFields=', S_BASIC_FIELDS.length);
  setDetect('✅ 评分项已固化：'+S.itemsTemplate.length+' 项'+(hasTotal?'，含统分区':''));
  refreshPrepOverview();
  if(S.reports.length){ selectReport(0); }
  runSourceVerify();
};
