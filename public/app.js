// ============================================================
// 武汉一中管理平台 - 前端逻辑
// 第三步：学生卡片展示、左键签到交互、实时统计
// ============================================================

'use strict';

// 版本号：页面加载时打印，用于确认浏览器拿到的是最新代码
const APP_VERSION = window.DSH_APP_VERSION || '3.16.0';   // 版本号统一由 navbar.js 提供

// 调试日志：浏览器控制台(F12)可看到每一步操作
const DEBUG = true;
function dbg(...args) {
  if (!DEBUG) return;
  console.log(`[签到调试 v${APP_VERSION}]`, ...args);
}
console.log(`[签到系统] 前端脚本版本 v${APP_VERSION} 已加载（若与实际不符请按 Ctrl+F5 强制刷新）`);

// 全局错误捕获：任何脚本错误都会在控制台打印并弹提示（便于定位"点击无反应"类问题）
window.addEventListener('error', (e) => {
  console.error('[页面脚本错误]', e.message, 'at', e.filename + ':' + e.lineno);
  const t = document.getElementById('toast');
  if (t) { t.textContent = '页面脚本错误：' + e.message; t.classList.remove('hidden'); }
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[未处理的异步异常]', e.reason);
});

const API = {
  students: '/api/students',
  status: '/api/attendance/status',
  start: '/api/attendance/start',
  checkin: '/api/attendance/checkin',
  sessionSave: '/api/attendance/session-save',   // 每天自动签到：整场保存（v35）
  plans: '/api/plans',
  sessionDelete: (id) => `/api/attendance/sessions/${id}`,
  me: '/api/auth/me',
  logout: '/api/auth/logout',
  hwTasks: '/api/homework/tasks',
  hwSub: '/api/homework/submissions',
  hwBatch: '/api/homework/submissions/batch',
  hwColumn: '/api/homework/submissions/column',
  hwDailyEnsure: '/api/homework/daily/ensure',
  hwDailySubjects: '/api/homework/daily-subjects',
  batchLeave: '/api/attendance/leave/batch',
};

const ROLE_CN = { admin: '管理员', teacher: '教师', student: '学生' };

const STATUS_LABEL = {
  present: '已签到',
  leave: '请假',
  late: '迟到',
  absent: '缺勤',
};

const REASON_LABEL = {
  sick: '病假',
  personal: '事假',
  official: '公假',
};

// 状态码 → CSS 颜色类名映射（关键！CSS 里定义的是颜色类名）
const STATUS_CLASS = {
  present: 'green',
  leave: 'orange',
  late: 'blue',
  absent: 'red',
};

// 导航栏显示名：真实姓名（教师/班长带角色后缀，便于一眼确认账号角色是否正确）
function displayNameForNav(u) {
  const nm = (u && (u.realName || u.displayName || u.username)) || '';
  if (u && u.role === 'teacher') return `${nm}（教师）`;
  if (u && u.role === 'monitor') return `${nm}（班长）`;
  if (u && u.role === 'student') return `${nm}（学生）`;
  return nm;
}

// ---------- 状态 ----------
let students = [];       // [{id, studentNo, name}]
let classes = [];        // [{id, className, grade, ...}]（计划适用范围用）
let current = null;      // { session, records, stats }（来自 /api/attendance/status）
let pinnedSessionId = null; // 本页正在登记的场次 id（轮询时带上，避免被新场次顶掉）
let countdownTimer = null;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  btnStart: $('btnStart'),
  deadlineSelect: $('deadlineSelect'),
  sessionInfo: $('sessionInfo'),
  sessionStarterWrap: $('sessionStarterWrap'),
  sessionStarter: $('sessionStarter'),
  startTime: $('startTime'),
  deadlineTime: $('deadlineTime'),
  countdown: $('countdown'),
  btnMakeupEnded: $('btnMakeupEnded'),
  // 每天自动签到（v35 · 路线 B）：早自习/晚自修两块 + 保存
  autoBar: $('autoBar'),
  autoSlots: $('autoSlots'),
  autoHint: $('autoHint'),
  autoDirty: $('autoDirty'),
  autoSave: $('autoSave'),
  grid: $('studentGrid'),
  emptyTip: $('emptyTip'),
  statTotal: $('statTotal'),
  statPresent: $('statPresent'),
  statLeave: $('statLeave'),
  statLate: $('statLate'),
  statAbsent: $('statAbsent'),
  toast: $('toast'),
  contextMenu: $('contextMenu'),
  contextTitle: $('contextTitle'),
  contextCancel: $('contextCancel'),
  btnStudents: $('btnStudents'),
  btnAnalysis: $('btnAnalysis'),
  // 🎲 随机点名 / 📋 课堂表现
  btnRollCall: $('btnRollCall'),
  btnPerformance: $('btnPerformance'),
  // 📢 叫号（班长端接收 / 教师端管理）
  btnAnnouncements: $('btnAnnouncements'),
  btnAnnManage: $('btnAnnManage'),
  annBadge: $('annBadge'),
  annModal: $('annModal'),
  annClassTag: $('annClassTag'),
  annHint: $('annHint'),
  annList: $('annList'),
  annClose: $('annClose'),
  annSpeakAll: $('annSpeakAll'),
  // 🧭 签到操作条（页面内）+ 分组导航
  dashActions: $('dashActions'),
  sessionTail: $('sessionTail'),
  navbarMenus: $('navbarMenus'),
  navToggle: $('navToggle'),
  navAttendance: $('navAttendance'),
  navGroupAttendance: $('navGroupAttendance'),
  navAttendanceMgmt: $('navAttendanceMgmt'),
  navGroupTeaching: $('navGroupTeaching'),
  navGroupStats: $('navGroupStats'),
  navGroupSystem: $('navGroupSystem'),
  navSystem: $('navSystem'),
  // 系统管理子项（管理员）：账号/年级/班级/学年管理，各自独立页面
  btnAdminUsers: $('btnAdminUsers'),
  btnAdminGrades: $('btnAdminGrades'),
  btnAdminClasses: $('btnAdminClasses'),
  btnAdminYears: $('btnAdminYears'),
  confirmModal: $('confirmModal'),
  confirmTitle: $('confirmTitle'),
  confirmMessage: $('confirmMessage'),
  confirmCancel: $('confirmCancel'),
  confirmOk: $('confirmOk'),
  btnAddPlan: $('btnAddPlan'),
  btnBatchPlan: $('btnBatchPlan'),
  btnPlansView: $('btnPlansView'),
  btnBackAttendance: $('btnBackAttendance'),
  viewAttendance: $('viewAttendance'),
  viewPlans: $('viewPlans'),
  planActiveBanner: $('planActiveBanner'),
  planList: $('planList'),
  planPageSize: $('planPageSize'),
  planStatusFilter: $('planStatusFilter'),
  planRangeInfo: $('planRangeInfo'),
  planPageInfo: $('planPageInfo'),
  planPrev: $('planPrev'),
  planNext: $('planNext'),
  navbarTime: $('navbarTime'),
  userInfo: $('userInfo'),
  btnUser: $('btnUser'),
  userDropdown: $('userDropdown'),
  menuProfile: $('menuProfile'),
  menuLogout: $('menuLogout'),
  planModal: $('planModal'),
  planDate: $('planDate'),
  planTime: $('planTime'),
  planDuration: $('planDuration'),
  planClass: $('planClass'),
  planError: $('planError'),
  planPreview: $('planPreview'),
  planCancel: $('planCancel'),
  planSubmit: $('planSubmit'),
  planModeSingle: $('planModeSingle'),
  planModeMulti: $('planModeMulti'),
  planModeWeekly: $('planModeWeekly'),
  multiDates: $('multiDates'),
  weekdayPick: $('weekdayPick'),
  weeklyFrom: $('weeklyFrom'),
  weeklyTo: $('weeklyTo'),
  // 座位表模式
  btnViewList: $('btnViewList'),
  btnViewSeat: $('btnViewSeat'),
  btnViewHomework: $('btnViewHomework'),
  btnHomework: $('btnHomework'),
  homeworkView: $('homeworkView'),
  hwListView: $('hwListView'),
  hwEntryView: $('hwEntryView'),
  hwSubject: $('hwSubject'),
  hwDate: $('hwDate'),
  hwQuick: $('hwQuick'),
  hwDateWrap: $('hwDateWrap'),
  hwRangeWrap: $('hwRangeWrap'),
  hwFrom: $('hwFrom'),
  hwTo: $('hwTo'),
  hwApplyRange: $('hwApplyRange'),
  hwScopeLabel: $('hwScopeLabel'),
  hwTaskCount: $('hwTaskCount'),
  hwSubmitted: $('hwSubmitted'),
  hwNotSubmitted: $('hwNotSubmitted'),
  hwTaskList: $('hwTaskList'),
  hwTaskEmpty: $('hwTaskEmpty'),
  hwReadonlyTip: $('hwReadonlyTip'),
  hwDirty: $('hwDirty'),
  hwColButtons: $('hwColButtons'),
  hwBackList: $('hwBackList'),
  hwEntryTitle: $('hwEntryTitle'),
  hwEntrySubmitted: $('hwEntrySubmitted'),
  hwEntryNotSubmitted: $('hwEntryNotSubmitted'),
  hwEntryAll: $('hwEntryAll'),
  hwEntrySave: $('hwEntrySave'),
  hwSeatGrid: $('hwSeatGrid'),
  hwUnseatedPanel: $('hwUnseatedPanel'),
  hwUnseatedList: $('hwUnseatedList'),
  hwEntryStats: $('hwEntryStats'),
  btnHomeworkManage: $('btnHomeworkManage'),
  seatView: $('seatView'),
  seatGrid: $('seatGrid'),
  seatStats: $('seatStats'),
  seatCols: $('seatCols'),
  seatRows: $('seatRows'),
  seatMode: $('seatMode'),
  unseatedPanel: $('unseatedPanel'),
  unseatedList: $('unseatedList'),
  btnSeatAuto: $('btnSeatAuto'),
  btnSeatReset: $('btnSeatReset'),
  btnSeatSave: $('btnSeatSave'),
  btnBatchAll: $('btnBatchAll'),
  btnBatchLeave: $('btnBatchLeave'),
  btnBatchColumn: $('btnBatchColumn'),
  btnFullscreen: $('btnFullscreen'),
  btnLikeRanking: $('btnLikeRanking'),
  seatReadonlyTip: $('seatReadonlyTip'),
  seatCapacityTip: $('seatCapacityTip'),
  noSessionTip: $('noSessionTip'),
  // 管理员专用：签到操作台的"查看班级"切换器（默认全校视角）
  adminClassWrap: $('adminClassWrap'),
  adminClassSelect: $('adminClassSelect'),
  columnModal: $('columnModal'),
  columnModalHint: $('columnModalHint'),
  columnModalSelect: $('columnModalSelect'),
  columnModalCancel: $('columnModalCancel'),
  columnModalOk: $('columnModalOk'),
  blModal: $('batchLeaveModal'),
  blDate: $('blDate'),
  blHint: $('blHint'),
  blSearch: $('blSearch'),
  blSelectAll: $('blSelectAll'),
  blList: $('blList'),
  blCount: $('blCount'),
  blCancel: $('blCancel'),
  blOk: $('blOk'),
  contextCancelCheckin: $('contextCancelCheckin'),
  contextRemark: $('contextRemark'),
  contextAbsentPresent: $('contextAbsentPresent'),
  contextAbsentLeave: $('contextAbsentLeave'),
  contextClear: $('contextClear'),
  pwdModal: $('pwdModal'),
  pwdOld: $('pwdOld'),
  pwdNew: $('pwdNew'),
  pwdNew2: $('pwdNew2'),
  pwdError: $('pwdError'),
  pwdLogout: $('pwdLogout'),
  pwdSubmit: $('pwdSubmit'),
};

// ---------- 通用请求 ----------
async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    // 禁用缓存（班级隔离）：签到/点名等接口按"当前场次 + 当前班级"返回，
    // 若被浏览器缓存，切换班级后仍会显示上一个班的数据 —— 表现为"隔离失效"。
    // 服务端也已对 /api 统一返回 Cache-Control: no-store，这里是双保险。
    cache: 'no-store',
    ...options,
  });
  // 会话过期 / 未登录：跳转登录页
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('未登录，请重新登录');
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* 无 JSON 响应 */ }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : `请求失败（${res.status}）`;
    throw new Error(msg);
  }
  return data;
}

// ---------- 当前用户 / 个人中心 ----------
let currentUser = null;

// 管理员在签到操作台选择的班级（null = 全校视角，与服务端默认一致）
let adminClassId = null;

// 本页"当前关注的班级"：管理员 = 选择器选中值；其他角色 = 账号绑定班级
//   所有签到相关请求（状态/学生/批量操作）都按它收敛，保证"切换班级 → 数据立即刷新"
function scopeClassId() {
  if (currentUser && currentUser.role === 'admin') return adminClassId;
  return (currentUser && currentUser.classId) ? Number(currentUser.classId) : null;
}

// 请求参数里的 classId 取值：
//   · 管理员选中班级 → 该班 id；管理员选"全部班级" → 'all'（服务端按全校视角处理）
//   · 教师/班长 → 自己绑定的班级（无绑定则不传，由服务端按所带班级解析）
function scopeParamValue() {
  if (currentUser && currentUser.role === 'admin') return adminClassId ? String(adminClassId) : 'all';
  const cid = scopeClassId();
  return cid ? String(cid) : '';
}

// 本地日期 YYYY-MM-DD（每天自动签到的 ?date= 用它；与后端 todayStr() 口径一致：本地时区）
function todayISODate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 签到/请假类请求体：统一带上"当前关注班级"的 classId
//   服务端据此在本班范围内解析"当前进行中的场次"并做班级权限校验
function withClassId(obj) {
  const body = { ...(obj || {}) };
  const v = scopeParamValue();
  if (v) body.classId = v;
  return body;
}

async function loadCurrentUser() {
  try {
    const data = await apiFetch(API.me);
    currentUser = data.user;
  } catch (err) {
    // 兜底：/api/auth/me 异常时用个人中心接口再取一次，避免"菜单/入口缺失"却无提示
    try {
      const p = await apiFetch('/api/user/profile');
      if (p && p.user) currentUser = p.user;
    } catch (_) { /* 仍失败则保持 null */ }
    if (!currentUser) {
      dbg('[获取用户失败]', err.message);
      showToast('用户信息加载失败，请刷新页面（Ctrl+F5）后重试', 4000);
      return;
    }
  }
  // 导航栏（标题/菜单/用户菜单）由统一组件 navbar.js 负责，这里只更新页面内元素
  if (window.DSHNavbar && window.DSHNavbar.ready) await window.DSHNavbar.ready;
  applyRoleUI(currentUser.role);
  dbg('[当前账号]', currentUser.username, 'role=', currentUser.role, 'roles=', JSON.stringify(currentUser.roles || []),
    'classId=', currentUser.classId);
}

// 按角色显示/隐藏"签到操作台页面内"的操作与按钮
//   导航栏菜单（考勤管理/教学工具/数据统计/系统管理…）的显隐由 navbar.js 统一处理，
//   这里只负责签到操作台自身的元素（截止时间、发起签到、座位表按钮、作业统计 Tab 等）
function applyRoleUI(role) {
  const roles = (currentUser && currentUser.roles) || [];
  const headClassIds = (currentUser && currentUser.headClassIds) || [];
  const isHeadTeacher = role === 'teacher' && (roles.includes('head_teacher') || headClassIds.length > 0);
  const isTeacher = role === 'teacher';
  const isAdmin = role === 'admin';
  const isMonitor = role === 'monitor';

  // 签到截止时间 / 发起签到：学生只读、班长无发起权限时隐藏
  if (el.deadlineSelect) el.deadlineSelect.classList.toggle('hidden', !(isTeacher || isAdmin));
  if (el.btnStart) el.btnStart.classList.toggle('hidden', !(isTeacher || isAdmin));
  // 管理员：显示"查看班级"切换器（默认全校视角，选中班级后只显示该班签到数据）
  if (el.adminClassWrap) el.adminClassWrap.classList.toggle('hidden', !isAdmin);
  // 👍 点赞排行（签到操作台上的备用入口）：**仅班长**可见
  //   老师/班主任/管理员不显示 —— 他们的点赞排名在「数据统计 → 课堂表现」
  if (el.btnLikeRanking) {
    el.btnLikeRanking.classList.toggle('hidden', !isMonitor);
  }
  // 签到操作台内的"作业统计"Tab：**仅班长可见**（本页是班长的作业录入台）
  //   · 班主任 / 任课老师 / 管理员 → **不显示**：他们查看作业走导航栏「教学工具 → 📚 作业管理」
  //     （那里自动作业 + 手动作业同一列表，有 学科/已交/未交/提交率/未交名单）
  //   · 2026-09-29 修正：上一版曾把该 Tab 对老师/管理员开放为"只读"入口，但同一件事在
  //     "签到操作台"和"作业管理"两处各有一套口径（列不同、刷新时机不同），反而让班主任困惑；
  //     现在统一为：**签到台只给班长**，老师端作业一律看「作业管理」。
  //   · 后端仍保留"非班长录入 → 403"的校验（前端隐藏只是第一道，防越权靠后端）
  const canUseHomeworkTab = isMonitor;
  if (el.btnViewHomework) el.btnViewHomework.classList.toggle('hidden', !canUseHomeworkTab);
  // 兜底：若当前正停在「作业统计」视图但已无该 Tab（例如角色变化后刷新、旧标签页复用），
  //   直接退回列表模式，避免出现"看不见 Tab 却停在作业视图"的空白页
  if (!canUseHomeworkTab && viewMode === 'homework') doSwitchCardView('list');
  // 班长端：叫号提醒面板与角标
  if (isMonitor) startAnnouncementPolling();
  // 签到操作条：三个操作（截止时间/发起签到/全屏）全部隐藏时，收起左侧操作组
  // （学生只读、班长无发起权限时，操作条只保留场次信息）
  if (el.dashActions) {
    const anyAction = [el.deadlineSelect, el.btnStart, el.btnLikeRanking, el.btnFullscreen].some((n) => n && !n.classList.contains('hidden'));
    el.dashActions.classList.toggle('hidden', !anyAction);
  }
  if (role === 'student') {
    document.body.classList.add('readonly-mode');
  }
  // 批量签到（「全员到齐」/「按列签到」）：教师、管理员、班长都可用
  //   （需求：先标记请假学生 → 再点「全员到齐」补齐剩余未标记的学生；教师也要能走这个流程）
  //   两者都只补齐【尚未标记】的学生，已请假/已迟到/已签到的一律不动
  if (isMonitor || isTeacher || isAdmin) {
    if (el.btnBatchAll) el.btnBatchAll.classList.remove('hidden');
    if (el.btnBatchLeave) el.btnBatchLeave.classList.remove('hidden');
    if (el.btnBatchColumn) el.btnBatchColumn.classList.remove('hidden');
  }
  if (isMonitor) {
    // 班长模式：大字体触屏优化 + 显示批量签到/全屏按钮
    // 座位布局只读：隐藏座位管理按钮、禁用列数/布局下拉、显示提示、禁止拖拽
    document.body.classList.add('monitor-mode');
    el.btnFullscreen.classList.remove('hidden');
    el.btnSeatAuto.classList.add('hidden');
    el.btnSeatReset.classList.add('hidden');
    el.btnSeatSave.classList.add('hidden');
    el.seatReadonlyTip.classList.remove('hidden');
    el.seatRows.disabled = true;
    el.seatCols.disabled = true;
    el.seatMode.disabled = true;
  }
}


// ---------- Toast ----------
let toastTimer = null;
function showToast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), ms);
}

// ---------- 数据加载 ----------
async function loadClasses() {
  try {
    const data = await apiFetch('/api/classes');
    classes = data.classes || [];
  } catch (_) { classes = []; }
  fillAdminClassSelect();
}

// 管理员"查看班级"下拉：全部班级 + 各班级（保留当前选择；默认全校视角）
function fillAdminClassSelect() {
  const sel = el.adminClassSelect;
  if (!sel) return;
  // 默认「全部班级（全校视角）」——与服务端一致（管理员不传 classId 时按全校视角处理）
  const kept = adminClassId ? String(adminClassId) : '';
  sel.innerHTML = '<option value="">全校（不分班）</option>'
    + classes.map((c) => `<option value="${c.id}">${c.className || c.class_name || ('班级' + c.id)}</option>`).join('');
  sel.value = kept;
  if (sel.value !== kept) { sel.value = ''; adminClassId = null; }   // 班级被删除 → 回到全校视角
}

// 切换班级（管理员）：立即按新班级重新拉取学生与签到状态（班级隔离的关键交互）
async function onAdminClassChange() {
  const v = el.adminClassSelect ? el.adminClassSelect.value : '';
  adminClassId = v ? Number(v) : null;
  pinnedSessionId = null;            // 换班后不再钉住上一个班的场次
  blState = { date: '', initial: {}, rows: [] };   // 批量请假弹窗数据也按新班级重新加载
  if (el.blModal && !el.blModal.classList.contains('hidden')) closeBatchLeave();
  dbg('[切换班级] adminClassId=', adminClassId);
  await loadStudents();
  await refreshStatus(true);
  showToast(adminClassId ? '已切换到所选班级' : '已切换到全校视角');
}

async function loadStudents() {
  try {
    // 签到操作台只显示“在读”学生；按"当前关注班级"收敛（管理员选中班级后同样收敛）
    let url = API.students + '?status=' + encodeURIComponent('在读');
    const cid = scopeClassId();
    if (cid) {
      url += '&classId=' + cid;
    }
    const data = await apiFetch(url);
    students = data.students || [];
    el.emptyTip.classList.toggle('hidden', students.length > 0);
  } catch (err) {
    students = [];
    el.emptyTip.classList.remove('hidden');
    el.emptyTip.textContent = '学生列表加载失败：' + err.message;
  }
}

async function refreshStatus(showError = false) {
  try {
    // 钉住本页正在登记的场次：只要还显示着今天某一场，后续轮询就带上它的 id，
    // 避免被其它场次（计划自动触发等）顶掉后「已签到」记录看起来全部消失/变成缺勤
    // 同时带上本账号的 classId：服务端按 attendance_sessions.class_id 解析"当前场次"，
    // 前端也把自己的班级明确传上去（管理员可用 ?classId= 指定要看的班）
    const myClassId = scopeClassId();
    const params = [];
    // 每天自动签到（v35）：早/晚两块 → 按 (date + slot) 直查，不再靠"最新一场"
    const sentSlot = autoMode() ? AUTO.slot : null;
    if (sentSlot) {
      params.push('slot=' + encodeURIComponent(sentSlot));
      params.push('date=' + encodeURIComponent(AUTO.date || todayISODate()));
    } else if (pinnedSessionId) {
      params.push('sessionId=' + encodeURIComponent(pinnedSessionId));
    }
    // 管理员总是显式带上：数字 = 看该班，all = 全校视角；教师/班长带自己的班级
    const pv = scopeParamValue();
    if (pv) params.push('classId=' + encodeURIComponent(pv));
    const url = params.length ? `${API.status}?${params.join('&')}` : API.status;
    const data = await apiFetch(url);
    // 渲染前二次校验（防御性）：返回的场次若明确属于别的班 → 一律不显示，
    // 避免"服务端漏过滤 / 中间层缓存"把别班签到渲染到本班页面上
    if (data && data.session && myClassId && data.session.classId && Number(data.session.classId) !== myClassId) {
      dbg('[班级隔离] 返回场次属于其它班级，前端忽略：', data.session.id, 'classId=', data.session.classId);
      data.hiddenSession = data.hiddenSession || { id: data.session.id, classId: data.session.classId, reason: 'other-class' };
      data.session = null;
      data.records = {};
      data.stats = { total: (data.stats && data.stats.total) || 0, present: 0, leave: 0, late: 0, absent: 0 };
    }
    current = data;
    const s = current.session;
    // ---- 每天自动签到（v35）：进入/更新"自动签到模式" ----
    const autoList = (data && data.autoSessions) || [];
    const wasAuto = AUTO.on;
    AUTO.on = autoList.length > 0;
    AUTO.slots = autoList;
    if (AUTO.on) {
      AUTO.date = autoList[0].sessionDate || AUTO.date || todayISODate();
      // 默认选中哪一场（需求 2026-09-30）：**默认「早自习」**（不再按当前时间选）
      //   · 晚自修由顶部「🌙 晚自修」按钮手动切换；切过去后本次会话保持，刷新回到早自习
      //   · 早自习场次不存在时（极端情况）才退回第一场
      if (!AUTO.slot || !autoList.some((x) => x.slot === AUTO.slot)) {
        const morning = autoList.find((x) => x.slot === 'morning');
        AUTO.slot = (morning || autoList[0]).slot;
      }
      // 学生名册变化（或首次进入）时重建 draft；**有未保存修改时不覆盖本地**
      if (!AUTO.dirty || !wasAuto) buildAutoDraft(data);
      // 关键：进入自动签到模式的那一次请求**没带 slot**（当时还不知道是本班是自动模式），
      //   服务端可能返回了"最新一场"（晚自修）——若直接用它，用户看到"早自习"却把保存写到晚自修。
      //   因此这里立即按时段重取一次（只发生在首次进入，不会递归）。
      if (!sentSlot) return refreshStatus();
    } else if (wasAuto) {
      AUTO.dirty = false;
      AUTO.draft = {};
      AUTO.slot = null;
      pinnedSessionId = null;
    }
    if (s && s.id) {
      const isToday = new Date(s.startTime).toDateString() === new Date().toDateString();
      if (!pinnedSessionId && isToday && !AUTO.on) pinnedSessionId = s.id;
      // 钉住的场次已不在返回里（超出近两天/被清理）→ 解除钉住，回到默认取最新场次
      if (pinnedSessionId && s.id !== pinnedSessionId) pinnedSessionId = null;
    }
    dbg('[状态刷新] session=', s && s.id, 'pinned=', current.pinned, 'stats=', current.stats);
    renderAll();
  } catch (err) {
    dbg('[状态刷新失败]', err.message);
    if (showError) showToast('状态刷新失败：' + err.message);
  }
}

// ---------- 渲染 ----------
function renderAll() {
  renderSessionInfo();
  renderStats();
  renderCards();
  renderAutoBar();
  // 座位表模式：刷新时也要同步座位卡片与座位统计
  //   （此前只渲染列表卡片 → 在座位表下切换「早自习/晚自修」后，座位表还是上一场的状态，
  //     看起来就像"点早自习却记到晚自修"，2026-09-30 真实反馈的问题之一）
  if (viewMode === 'seat' && el.seatGrid) {
    renderSeats();
    renderSeatStats();
  }
}

function renderSessionInfo() {
  const s = current && current.session;
  // ---- 每天自动签到（v35）：不限时 → 不显示倒计时与截止时间，改用「早自习/晚自修 · 系统自动生成」 ----
  if (s && AUTO.on && s.autoGenerated) {
    el.sessionInfo.classList.remove('hidden');
    el.startTime.textContent = s.slotLabel || '自动签到';
    el.deadlineTime.textContent = '不限时';
    el.countdown.textContent = '—';
    stopCountdown();
    if (el.sessionStarter) {
      el.sessionStarter.textContent = '系统每天 0 点自动生成';
      el.sessionStarterWrap.classList.remove('hidden');
    }
    el.btnMakeupEnded.classList.add('hidden');   // 自动场次不限时，不需要"补签"
    el.btnStart.disabled = false;                // 仍可临时手动加一场（不会顶掉自动场次）
    el.noSessionTip.textContent = '';
    el.noSessionTip.classList.add('hidden');
    if (el.sessionTail) {
      const anyTail = [el.sessionStarterWrap, el.btnMakeupEnded].some((n) => n && !n.classList.contains('hidden'));
      el.sessionTail.classList.toggle('hidden', !anyTail);
    }
    return;
  }
  if (s) {
    el.sessionInfo.classList.remove('hidden');
    // 显示会话的真实起止时间（计划触发的场次 = 计划中设定的时间，如 08:00–08:10）
    el.startTime.textContent = fmtTimeHM(s.startTime);
    el.deadlineTime.textContent = fmtTimeHM(s.deadline);
    // 发起人追溯：手动发起 → 操作者；计划触发 → 计划创建人；历史数据无记录时不显示
    // 说明：班级隔离后，别的班的签到根本不会出现在本页；能看到的都是「全校场次 / 全部班级计划 /
    //       本班计划」，因此不再需要「其他老师发起」这类提示（2026-09-29 二次修复按需求移除）
    if (el.sessionStarter) {
      const by = s.createdByName;
      const label = s.startSource === 'plan' ? '计划发起' : '发起';
      el.sessionStarter.textContent = by ? `${label}：${by}` : (s.startSource === 'plan' ? '计划发起' : '');
      el.sessionStarterWrap.classList.toggle('hidden', !el.sessionStarter.textContent);
    }
    // 已结束场次（ended 展示视图）：允许发起新签到 + 显示补签入口
    el.btnStart.disabled = !s.ended;
    el.btnMakeupEnded.classList.toggle('hidden', !s.ended);
    startCountdown(s.deadline, s.id);
  } else {
    el.sessionInfo.classList.add('hidden');
    el.btnStart.disabled = false;
    el.btnMakeupEnded.classList.add('hidden');
    if (el.sessionStarterWrap) el.sessionStarterWrap.classList.add('hidden');
    stopCountdown();
    el.countdown.textContent = '--';
  }
  // 无进行中的签到时给出明确提示（需求："无进行中签到时显示'当前没有进行中的签到'"）
  if (el.noSessionTip) {
    const hasSession = !!(current && current.session);
    if (!hasSession) {
      const canStart = !!(currentUser && (currentUser.role === 'teacher' || currentUser.role === 'admin'));
      el.noSessionTip.textContent = 'ℹ️ 当前没有进行中的签到' + (canStart ? '（可点「发起签到」，或等计划到点自动发起）' : '（等老师发起签到后会在这里显示）');
      el.noSessionTip.classList.remove('hidden');
    } else {
      el.noSessionTip.textContent = '';
      el.noSessionTip.classList.add('hidden');
    }
  }
  // 右侧组（发起人 + 补签）：两项都无内容时整组收起，避免右侧留空
  if (el.sessionTail) {
    const anyTail = [el.sessionStarterWrap, el.btnMakeupEnded].some((n) => n && !n.classList.contains('hidden'));
    el.sessionTail.classList.toggle('hidden', !anyTail);
  }
}

// 已结束场次补签入口（覆盖手动发起的历史场次）→ 跳转独立补签页
el.btnMakeupEnded.addEventListener('click', () => {
  const s = current && current.session;
  if (s) goMakeupPage(null, s.id, 'attendance');
});

function renderStats() {
  // 每天自动签到（v35）：统计与本地 draft 严格一致（默认全绿 → 已签到 = 总人数）
  const st = autoMode() ? autoStats()
    : ((current && current.stats) || { total: students.length, present: 0, leave: 0, late: 0, absent: 0 });
  el.statTotal.textContent = st.total;
  el.statPresent.textContent = st.present;
  el.statLeave.textContent = st.leave;
  el.statLate.textContent = st.late;
  el.statAbsent.textContent = st.absent;
}

// 签到窗口状态：'open'（进行中）| 'expired'（已截止）| 'not-started'（未开始/未发起）
function windowState() {
  if (!current || !current.session) return 'not-started';
  if (Date.now() > new Date(current.session.deadline).getTime()) return 'expired';
  return 'open';
}

// 未签卡片的徽章文案（按窗口状态）
function pendingBadgeText() {
  const st = windowState();
  if (st === 'expired') return '已截止';
  if (st === 'not-started') return '签到未开始';
  return '未签到';
}

// ============================================================
// 每天自动签到（v35 · 路线 B）
//   后台每天 0 点为每个班生成 2 场：早自习(morning) / 晚自修(evening)，**不限时**。
//   前端行为（与老师确认的口径一致）：
//     · 进页面**默认全员已签到**（绿色）—— 未落库的默认状态只存在本地 draft 里，不发请求
//     · 点卡片 = 取消未到（红）；再点 = 恢复已签到（绿）；右键 = 请假（橙）
//     · 点「保存本场」→ 一次写整场（present/absent/leave）：**保存即录入**，缺勤是显式行
//     · auto 场次不显示倒计时/截止时间（不限时）
//   · 老场次（手动发起/计划触发、auto_generated=false）完全按原逻辑走，本模块不介入
// ============================================================
const AUTO = {
  on: false,        // 当前页面是否处于"自动签到"模式（本班今天有自动场次）
  date: null,       // YYYY-MM-DD
  slot: null,       // 'morning' | 'evening'
  slots: [],        // 服务端返回的 autoSessions 概览
  draft: {},        // studentId -> { status, leaveReason }（本地未保存的整场状态）
  dirty: false,     // 有未保存修改
  saving: false,
  loadedAt: 0,
};
const SLOT_LABEL = { morning: '早自习', evening: '晚自修' };
// 调试/自动化测试只读钩子：无头浏览器驱动据此断言草稿状态（不参与任何业务逻辑）
if (typeof window !== 'undefined') window.__DSH_AUTO = AUTO;

// 是否处于自动签到模式
function autoMode() { return AUTO.on && !!AUTO.slot; }

// 自动场次会话（用于区分"默认已签到"与"已保存"）
function autoSlotMeta(slot) {
  return (AUTO.slots || []).find((x) => x.slot === (slot || AUTO.slot)) || null;
}
// 该场次是否已有落库记录（未保存过 = 页面显示的是"默认全绿"）
function autoSlotSaved(slot) {
  const m = autoSlotMeta(slot);
  return !!(m && Number(m.marked) > 0);
}

// 用服务端数据建立/刷新 draft（有未保存修改时不覆盖本地）
function buildAutoDraft(data) {
  const records = (data && data.records) || {};
  AUTO.draft = {};
  for (const stu of students) {
    const rec = records[stu.id];
    if (rec) AUTO.draft[stu.id] = { status: rec.status, leaveReason: rec.leaveReason || null, dayLeave: !!rec.dayLeave };
    else AUTO.draft[stu.id] = { status: 'present', leaveReason: null, default: true };   // 默认全员已签到
  }
  AUTO.dirty = false;
}

// 卡片/座位表统一取"当前应显示的状态"：自动签到模式下优先用本地 draft
function recordFor(stu) {
  if (!autoMode()) return (current && current.records && current.records[stu.id]) || null;
  const d = AUTO.draft[stu.id];
  if (!d) return null;
  return {
    status: d.status,
    leaveReason: d.leaveReason || null,
    dayLeave: !!d.dayLeave,
    autoDraft: true,
    unsaved: d.default === true && AUTO.dirty === false ? false : true,
  };
}

// 自动签到模式下的统计（与 draft 完全一致）
function autoStats() {
  const st = { total: students.length, present: 0, leave: 0, late: 0, absent: 0 };
  for (const stu of students) {
    const d = AUTO.draft[stu.id];
    if (!d) { st.present += 1; continue; }              // 无 draft = 默认已签到
    if (Object.prototype.hasOwnProperty.call(st, d.status)) st[d.status] += 1;
  }
  return st;
}

// draft 是否能写（学生只读 / 场次已收口）
function autoEditable() {
  if (!autoMode()) return false;
  if (currentUser && currentUser.role === 'student') return false;
  const meta = autoSlotMeta();
  return !meta || meta.status === 'active';
}
function autoBlockReason() {
  if (currentUser && currentUser.role === 'student') return '当前账号仅可查看，无操作权限';
  const meta = autoSlotMeta();
  if (meta && meta.status !== 'active') return '该场次已结束，只能查看（可在考勤分析里查历史）';
  return '';
}

// 修改 draft 中的某个学生（本地，不落库）
function setAutoDraft(studentId, status, leaveReason) {
  const prev = AUTO.draft[studentId] || {};
  AUTO.draft[studentId] = { status, leaveReason: leaveReason || null, dayLeave: prev.dayLeave && status === 'leave' };
  AUTO.dirty = true;
  renderStats();
  renderCards();
  renderSeats();
  renderAutoBar();
}

// 顶部"早自习 / 晚自修"两块 + 保存按钮
function renderAutoBar() {
  if (!el.autoBar) return;
  const show = autoMode() && (AUTO.slots || []).length > 0;
  el.autoBar.classList.toggle('hidden', !show);
  if (!show) return;
  if (el.autoSlots) {
    el.autoSlots.innerHTML = (AUTO.slots || []).map((s) => {
      const total = students.length || 0;
      const marked = Number(s.marked) || 0;
      const label = s.label || SLOT_LABEL[s.slot] || s.slot;
      // 未保存过时不要写"已签 0/N"（那是服务端记录数；页面此刻显示的是"默认全员已签"的草稿，会自相矛盾）
      const rate = marked
        ? `已登记 ${marked} 人 · 已签 ${s.present || 0}/${total || '—'}`
        : '未保存（默认全员已签）';
      const done = s.status && s.status !== 'active';
      return `<button type="button" class="auto-slot-btn${s.slot === AUTO.slot ? ' active' : ''}${done ? ' done' : ''}"
                data-slot="${s.slot}" title="${label}：${marked ? '已保存 ' + marked + ' 条记录' : '尚未保存（页面显示默认全员已签）'}${done ? '（已结束）' : ''}">
                ${s.slot === 'morning' ? '🌅' : '🌙'} ${label}
                <span class="auto-slot-rate">${rate}</span>
              </button>`;
    }).join('');
    el.autoSlots.querySelectorAll('.auto-slot-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchAutoSlot(btn.dataset.slot));
    });
  }
  if (el.autoHint) {
    const meta = autoSlotMeta();
    const saved = autoSlotSaved();
    const editable = autoEditable();
    el.autoHint.textContent = !editable
      ? (autoBlockReason() || '只读')
      : (saved
        ? '不限时：随时可录入；修改后点「保存本场」生效'
        : '不限时：默认全员已签到，点掉没来的人后点「保存本场」');
    void meta;
  }
  if (el.autoDirty) el.autoDirty.classList.toggle('hidden', !AUTO.dirty);
  if (el.autoSave) {
    el.autoSave.classList.toggle('hidden', !autoEditable());
    el.autoSave.disabled = AUTO.saving;
    el.autoSave.textContent = AUTO.saving ? '保存中…' : '💾 保存本场';
  }
}

// 切换早/晚（有未保存修改先确认）
function switchAutoSlot(slot) {
  if (!slot || slot === AUTO.slot) return;
  const go = () => {
    AUTO.slot = slot;
    pinnedSessionId = null;      // 按时段直查，不再钉别场
    AUTO.dirty = false;
    refreshStatus();
  };
  if (AUTO.dirty) {
    openConfirm('放弃未保存的修改？', `${SLOT_LABEL[AUTO.slot] || ''}还有未保存的修改（未点"保存本场"）。切换到${SLOT_LABEL[slot] || '另一场'}将丢弃这些修改。`, go);
    return;
  }
  go();
}

// 保存整场（一次写全班：present/absent/leave）
async function saveAutoSession() {
  if (!autoMode() || AUTO.saving) return;
  if (!autoEditable()) { showToast(autoBlockReason() || '当前不可保存'); return; }
  const sid = current && current.session && current.session.id;
  if (!sid) { showToast('当前没有可保存的场次'); return; }
  // 防御：页面显示的时段必须与服务端返回的场次一致（否则会"看着早自习、存到晚自修"）
  const curSlot = current.session.slot || null;
  if (curSlot && curSlot !== AUTO.slot) {
    showToast(`正在切换到${SLOT_LABEL[AUTO.slot] || '该场'}，请稍后再保存`);
    await refreshStatus();
    return;
  }
  const records = students.map((stu) => {
    const d = AUTO.draft[stu.id] || { status: 'present' };
    const item = { studentId: stu.id, status: d.status };
    if (d.status === 'leave' && d.leaveReason) item.leaveReason = d.leaveReason;
    return item;
  });
  if (!records.length) { showToast('本班没有学生'); return; }
  AUTO.saving = true;
  renderAutoBar();
  try {
    const data = await apiFetch(API.sessionSave, { method: 'POST', body: JSON.stringify(withClassId({ sessionId: sid, records })) });
    dbg('[整场保存]', data);
    AUTO.dirty = false;
    AUTO.saving = false;
    showToast(`已保存 ${SLOT_LABEL[AUTO.slot] || ''}：已签到 ${(data.counts && data.counts.present) || 0} / 缺勤 ${(data.counts && data.counts.absent) || 0} / 请假 ${(data.counts && data.counts.leave) || 0}`);
    await refreshStatus();
  } catch (err) {
    AUTO.saving = false;
    showToast('保存失败：' + err.message);
    renderAutoBar();
  }
}

function renderCards() {
  const records = (current && current.records) || {};
  if (students.length === 0) return;

  // 事件委托：网格上统一监听点击
  if (!el.grid.dataset.bound) {
    el.grid.dataset.bound = '1';
    el.grid.addEventListener('click', (e) => {
      if (longPressTriggered) { longPressTriggered = false; return; }
      const card = e.target.closest('.student-card');
      if (card) onCardClick(card);
    });
    // 右键：弹出请假菜单
    el.grid.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.student-card');
      if (card) onCardContextMenu(e, card);
    });
    // 移动端：长按 500ms 打开请假菜单（第六步）
    el.grid.addEventListener('touchstart', (e) => {
      const card = e.target.closest('.student-card');
      if (!card) return;
      const touch = e.touches[0];
      longPressTriggered = false;
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        longPressTriggered = true;
        suppressNextClick = true;
        onCardContextMenu(
          { preventDefault() {}, clientX: touch.clientX, clientY: touch.clientY },
          card
        );
        if (navigator.vibrate) navigator.vibrate(30);
      }, 500);
    }, { passive: true });
    el.grid.addEventListener('touchend', () => clearTimeout(longPressTimer));
    el.grid.addEventListener('touchmove', () => clearTimeout(longPressTimer));
    el.grid.addEventListener('touchcancel', () => clearTimeout(longPressTimer));
  }

  el.grid.innerHTML = '';
  for (const stu of students) {
    const rec = autoMode() ? recordFor(stu) : records[stu.id];
    const status = rec ? rec.status : null;
    const card = document.createElement('div');
    // 类名用颜色类：present→green、leave→orange、late→blue、absent→red、无记录→gray
    card.className = 'student-card ' + (status ? (STATUS_CLASS[status] || 'gray') : 'gray');
    card.dataset.studentId = stu.id;
    card.dataset.status = status || 'none';

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = status ? STATUS_LABEL[status] : pendingBadgeText();
    // 每天自动签到（v35）：默认"全员已签到"，未保存前在角标上标明是本地草稿，避免与"已落库"混淆
    if (autoMode() && rec && rec.autoDraft && AUTO.dirty) {
      badge.textContent = (STATUS_LABEL[status] || '') + '·待保存';
      card.title = '本次修改尚未保存，点右上角「保存本场」生效';
    }
    // 当天「全天请假」（批量请假登记）：即使当前没有进行中的场次也显示为橙色请假，
    // 并在卡片上标明事由，避免老师/班长误判为"未签到"
    if (rec && rec.dayLeave) {
      card.title = `当天全天请假：${REASON_LABEL[rec.leaveReason] || '已批准'}（当天各场次都不需要签到）`;
      badge.textContent = `请假·${REASON_LABEL[rec.leaveReason] || '全天'}`;
    }

    const name = document.createElement('span');
    name.className = 'name ' + nameSizeClass(stu.name);
    name.textContent = stu.name;

    const no = document.createElement('span');
    no.className = 'no';
    no.textContent = stu.studentNo;

    const cls = document.createElement('span');
    cls.className = 'cls';
    cls.textContent = stu.className || '未分班';

    card.appendChild(badge);
    card.appendChild(name);
    card.appendChild(no);
    card.appendChild(cls);

    // 状态标签（休学/转学/退学等，签到台只显示在读，防御性展示）
    if (stu.status && stu.status !== '在读') {
      const stTag = document.createElement('span');
      stTag.className = 'stu-status-tag';
      stTag.textContent = stu.status;
      card.appendChild(stTag);
    }

    el.grid.appendChild(card);
  }
  const colored = el.grid.querySelectorAll('.student-card:not(.gray)').length;
  dbg('[卡片渲染] 共', el.grid.children.length, '张，已着色', colored, '张（未着色=', el.grid.children.length - colored, '）');
}

// ---------- 座位表模式（v2.7.0：空位 + 自定义布局） ----------
let viewMode = 'list';     // 'list' | 'seat'
let seatPrepared = false;  // 是否已准备过初始布局
let dragStudentId = null;  // 拖拽中的学生
let seatCfg = { rows: 4, cols: 4, mode: '标准' }; // 布局配置（来自 classes.seat_config）
let hasSeatConfig = false; // 当前班级是否已保存过座位配置（seat_config 非空）

const SEAT_MODES = ['标准', '左对齐', '右对齐', '居中', '左右分列', '自定义'];

// 当前布局配置（来自下拉框）
function getSeatCfg() {
  return {
    rows: Number(el.seatRows.value) || 4,
    cols: Number(el.seatCols.value) || 4,
    mode: el.seatMode.value || '标准',
  };
}

// 布局模式 → 物理列数（居中/左右分列多出空列）
function physicalColCount(cfg) {
  const cols = cfg.cols || 4;
  if (cfg.mode === '居中' || cfg.mode === '左右分列') return cols + 2;
  return cols;
}

// 逻辑列 → 物理列（渲染定位）
function logicalToPhysical(logicalCol, cfg) {
  const cols = cfg.cols || 4;
  const L = Math.ceil(cols / 2);
  switch (cfg.mode) {
    case '居中': return logicalCol + 1;                    // 两侧各空 1 列
    case '左右分列': return logicalCol <= L ? logicalCol : logicalCol + 2; // 中间空 2 列
    default: return logicalCol;                            // 标准/左对齐/右对齐/自定义
  }
}

// 物理列 → 逻辑列（拖入空位入座时换算；空列/走廊返回 null）
function physicalToLogical(physicalCol, cfg) {
  const cols = cfg.cols || 4;
  const L = Math.ceil(cols / 2);
  switch (cfg.mode) {
    case '居中': {
      const lc = physicalCol - 1;
      return (lc >= 1 && lc <= cols) ? lc : null;
    }
    case '左右分列': {
      if (physicalCol <= L) return physicalCol;        // 左半 1..L
      if (physicalCol > L + 2) return physicalCol - 2; // 右半
      return null;                                     // 中间空列（走廊）
    }
    default: return physicalCol;
  }
}

// 视图切换：列表模式 / 座位表模式 / 作业统计模式
let pendingCardMode = null; // 有未保存作业修改时的暂存目标模式

function doSwitchCardView(mode) {
  viewMode = mode;
  if (mode !== 'homework') {
    try { localStorage.setItem('attendanceViewMode', mode); } catch (_) {}
  }
  // 需求 2026-09-30：签到台只保留座位表模式，切换按钮已移除 → 这里对 null 做保护（兼容旧缓存页面）
  if (el.btnViewList) el.btnViewList.classList.toggle('active', mode === 'list');
  if (el.btnViewSeat) el.btnViewSeat.classList.toggle('active', mode === 'seat');
  if (el.btnViewHomework) el.btnViewHomework.classList.toggle('active', mode === 'homework');
  const listWrap = el.grid.closest('main');
  if (listWrap) listWrap.classList.toggle('hidden', mode !== 'list');
  el.seatView.classList.toggle('hidden', mode !== 'seat');
  el.homeworkView.classList.toggle('hidden', mode !== 'homework');
  if (mode === 'seat') {
    prepareSeats();
    renderSeats();
    renderSeatStats();
  }
  if (mode === 'homework') {
    enterHomeworkView();
  }
}

function switchCardView(mode) {
  // 离开作业统计且有未保存修改 → 二次确认（放弃修改后再切换）
  if (viewMode === 'homework' && mode !== 'homework' && hwDirty()) {
    pendingCardMode = mode;
    openConfirm('放弃未保存的作业修改？', '作业统计中有未保存的修改（点击了卡片/按列/全部已交但未点"保存"）。切换模式将丢弃这些修改。', () => {
      const target = pendingCardMode;
      pendingCardMode = null;
      doSwitchCardView(target);
    });
    return;
  }
  pendingCardMode = null;
  doSwitchCardView(mode);
}

// 首次进入座位表：
//  - 班级无已保存配置（seat_config 为空）→ 按班级人数自动计算行数（CEIL(人数/列数)，限 4-10）
//  - 无已保存座位 → 按学号+布局模式自动排列
function prepareSeats() {
  if (seatPrepared) return;
  seatPrepared = true;
  if (!hasSeatConfig) autoFitRows();
  const hasSaved = students.some((s) => (s.seatRow > 0 || s.seatCol > 0));
  if (!hasSaved) autoArrange();
}

// 默认行数自适应：列数默认 4，行数 = CEIL(班级人数 / 列数)，限制在 4-10
function autoFitRows() {
  const cols = Number(el.seatCols.value) || 4;
  const n = students.length;
  const rows = Math.min(10, Math.max(4, Math.ceil(n / cols)));
  el.seatRows.value = String(rows);
}

// 按学号从小到大填充矩阵（内存排列，不落库）
// 右对齐模式每行从右往左分配列；其余从左往右
// 按学号从小到大填充矩阵（内存排列，不落库）
// 容量 = 行数 × 列数；学生超出容量时置为未排座（0,0），返回是否溢出
function autoArrange() {
  const cfg = getSeatCfg();
  const rows = cfg.rows;
  const cols = cfg.cols;
  const capacity = rows * cols;
  const sorted = [...students].sort((a, b) => a.studentNo.localeCompare(b.studentNo, { numeric: true }));
  let idx = 0;
  let overflow = 0;
  for (const s of sorted) {
    if (idx >= capacity) { s.seatRow = 0; s.seatCol = 0; overflow += 1; continue; }
    const inRow = idx % cols;
    s.seatRow = Math.floor(idx / cols) + 1;
    s.seatCol = cfg.mode === '右对齐' ? cols - inRow : inRow + 1;
    idx += 1;
  }
  return overflow > 0;
}

// 列数 → 座位卡片字号档位（列越多字号越小，保证 8-10 列也能在容器内完整显示、不溢出）
const SEAT_NAME_SIZES = { 4: 15, 5: 15, 6: 13, 7: 13, 8: 12, 9: 11, 10: 11 };
const SEAT_META_SIZES = { 4: 11, 5: 11, 6: 10, 7: 10, 8: 9, 9: 8, 10: 8 };

// 应用座位表尺寸：列数均分宽度（CSS 负责），字号按列数分档
function applySeatSizing(grid, cols) {
  if (!grid) return;
  grid.style.setProperty('--seat-cols', String(cols));
  grid.style.setProperty('--seat-name-size', (SEAT_NAME_SIZES[cols] || 12) + 'px');
  grid.style.setProperty('--seat-meta-size', (SEAT_META_SIZES[cols] || 9) + 'px');
  grid.classList.remove('cols-8', 'cols-9', 'cols-10');
  if (cols >= 8 && cols <= 10) grid.classList.add('cols-' + cols);
}

// 姓名长度 → 字号档位（≤8 字用列数档位字号；>8 字再缩 1px，如"阿卜杜力艾则孜·克热木"）
function nameSizeClass(name) {
  const len = [...String(name == null ? '' : name)].length;
  if (len <= 4) return 'n1';
  if (len <= 8) return 'n2';
  return 'n3';
}

function buildSeatCard(stu, rec, displayCol) {
  const status = rec ? rec.status : null;
  const color = status ? (STATUS_CLASS[status] || 'gray') : 'gray';
  const card = document.createElement('div');
  card.className = 'student-card seat-card ' + color;
  card.dataset.studentId = stu.id;
  card.dataset.status = status || 'none';
  // 学生/班长：座位表只读，不可拖拽
  const canEdit = !(currentUser && (currentUser.role === 'student' || currentUser.role === 'monitor'));
  if (canEdit) card.draggable = true;
  else card.title = currentUser && currentUser.role === 'monitor' ? '座位布局由班主任统一管理，班长不可调整' : '只读模式，不可拖拽';

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = status ? STATUS_LABEL[status] : pendingBadgeText();

  const name = document.createElement('span');
  name.className = 'name ' + nameSizeClass(stu.name);
  name.textContent = stu.name;

  const no = document.createElement('span');
  no.className = 'no';
  no.textContent = stu.studentNo;

  const pos = document.createElement('span');
  pos.className = 'seat-pos';
  pos.textContent = `${stu.seatRow}排${displayCol || stu.seatCol}座`;

  card.append(badge, name, no, pos);
  return card;
}

function renderSeats() {
  const records = (current && current.records) || {};
  const cfg = getSeatCfg();
  const pCols = physicalColCount(cfg);
  applySeatSizing(el.seatGrid, pCols); // 列数均分宽度 + 按列数字号分档
  el.seatGrid.innerHTML = '';

  // 有座学生 → 物理位置 map
  const placed = new Map(); // "row|pcol" -> student
  let maxRow = 0;
  for (const s of students) {
    if (s.seatRow > 0 && s.seatCol > 0) {
      const pcol = logicalToPhysical(s.seatCol, cfg);
      if (pcol < 1 || pcol > pCols) continue; // 越界防御
      placed.set(s.seatRow + '|' + pcol, s);
      if (s.seatRow > maxRow) maxRow = s.seatRow;
    }
  }

  // 容量提示：学生数 > 行×列 最大座位数
  const capacity = cfg.rows * cfg.cols;
  const enrolled = students.length;
  const overflow = enrolled > capacity;
  el.seatCapacityTip.classList.toggle('hidden', !overflow);
  if (overflow) {
    el.seatCapacityTip.textContent = `⚠️ 当前座位数（${cfg.rows}×${cfg.cols}=${capacity}）不足以容纳全部学生（${enrolled}人），请增加行数或列数。`;
  }

  // 渲染全部 cell（学生卡片或空位块）；行数固定为配置行数（或已排座最大行）
  const renderRows = Math.max(cfg.rows, maxRow);
  if (renderRows === 0 && students.length === 0) {
    el.seatGrid.innerHTML = '<div class="empty-tip">暂无学生</div>';
    renderUnseated();
    return;
  }
  for (let r = 1; r <= renderRows; r++) {
    for (let pc = 1; pc <= pCols; pc++) {
      const cell = document.createElement('div');
      cell.dataset.row = r;
      cell.dataset.col = pc; // 物理列
      cell.style.gridRowStart = r;
      cell.style.gridColumnStart = pc;
      const stu = placed.get(r + '|' + pc);
      if (stu) {
        cell.className = 'seat-cell';
        cell.appendChild(buildSeatCard(stu, autoMode() ? recordFor(stu) : records[stu.id], pc));
      } else {
        cell.className = 'seat-cell seat-empty';
        cell.dataset.empty = '1';
        cell.title = '空位（走廊）· 拖入学生入座';
      }
      el.seatGrid.appendChild(cell);
    }
  }
  renderUnseated();
}

// 未排座学生（seat 为 0,0）：显示在底部，可拖入空位
function renderUnseated() {
  const unseated = students.filter((s) => !(s.seatRow > 0 && s.seatCol > 0));
  el.unseatedPanel.classList.toggle('hidden', unseated.length === 0);
  el.unseatedList.innerHTML = '';
  for (const s of unseated) {
    const chip = document.createElement('span');
    chip.className = 'unseated-chip';
    chip.dataset.studentId = s.id;
    chip.textContent = `${s.studentNo} ${s.name}`;
    // 学生/班长不可拖拽（座位只读）
    const canEdit = !(currentUser && (currentUser.role === 'student' || currentUser.role === 'monitor'));
    chip.draggable = canEdit;
    chip.title = canEdit ? '拖到座位表空位入座' : '座位布局由班主任统一管理';
    el.unseatedList.appendChild(chip);
  }
}

function renderSeatStats() {
  const st = autoMode() ? autoStats()
    : ((current && current.stats) || { total: students.length, present: 0, leave: 0, late: 0, absent: 0 });
  el.seatStats.innerHTML =
    `<span class="ss-total">总人数 <b>${st.total}</b></span>` +
    `<span class="ss-present">已签到 <b>${st.present}</b></span>` +
    `<span class="ss-late">迟到 <b>${st.late}</b></span>` +
    `<span class="ss-leave">请假 <b>${st.leave}</b></span>` +
    `<span class="ss-absent">缺勤 <b>${st.absent}</b></span>`;
}

// 清空某学生座位（右键菜单"清空座位"）
function clearStudentSeat(studentId) {
  const stu = students.find((s) => s.id === studentId);
  if (!stu) return;
  stu.seatRow = 0;
  stu.seatCol = 0;
  closeContextMenu();
  renderSeats();
  showToast(`${stu.name} 已清空座位（位置变为空位）`);
}

// 座位表事件绑定（一次性）
function bindSeatEvents() {
  // 点击签到 / 右键 / 长按（与列表卡片相同交互）
  el.seatGrid.addEventListener('click', (e) => {
    if (longPressTriggered) { longPressTriggered = false; return; }
    const card = e.target.closest('.seat-card');
    if (card) onCardClick(card);
  });
  el.seatGrid.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.seat-card');
    if (card) { onCardContextMenu(e, card); return; }
    const empty = e.target.closest('.seat-empty');
    if (empty) {
      e.preventDefault();
      showToast('此处为空位（走廊）：从底部"未排座"区拖入学生，或从其他座位拖入即可');
    }
  });
  el.seatGrid.addEventListener('touchstart', (e) => {
    const card = e.target.closest('.seat-card');
    if (!card) return;
    const touch = e.touches[0];
    longPressTriggered = false;
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      longPressTriggered = true;
      suppressNextClick = true;
      onCardContextMenu(
        { preventDefault() {}, clientX: touch.clientX, clientY: touch.clientY },
        card
      );
      if (navigator.vibrate) navigator.vibrate(30);
    }, 500);
  }, { passive: true });
  el.seatGrid.addEventListener('touchend', () => clearTimeout(longPressTimer));
  el.seatGrid.addEventListener('touchmove', () => clearTimeout(longPressTimer));
  el.seatGrid.addEventListener('touchcancel', () => clearTimeout(longPressTimer));

  // 拖拽：源卡片 / 未排座 chip
  el.seatGrid.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.seat-card');
    if (!card) return;
    dragStudentId = Number(card.dataset.studentId);
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragStudentId));
  });
  el.unseatedList.addEventListener('dragstart', (e) => {
    const chip = e.target.closest('.unseated-chip');
    if (!chip) return;
    dragStudentId = Number(chip.dataset.studentId);
    chip.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragStudentId));
  });
  el.unseatedList.addEventListener('dragend', () => {
    dragStudentId = null;
    el.unseatedList.querySelectorAll('.unseated-chip.dragging').forEach((c) => c.classList.remove('dragging'));
  });

  // 拖拽经过：高亮目标（其他学生卡片 或 空位块）
  el.seatGrid.addEventListener('dragover', (e) => {
    if (dragStudentId === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.seatGrid.querySelectorAll('.drop-target').forEach((c) => c.classList.remove('drop-target'));
    const card = e.target.closest('.seat-card');
    const empty = e.target.closest('.seat-empty');
    if (card && Number(card.dataset.studentId) !== dragStudentId) card.classList.add('drop-target');
    else if (empty) empty.classList.add('drop-target');
  });
  el.seatGrid.addEventListener('dragleave', (e) => {
    const t = e.target.closest('.drop-target');
    if (t) t.classList.remove('drop-target');
  });

  // 松开：拖到学生 = 交换；拖到空位 = 移动入座（原位置变空位）
  el.seatGrid.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragStudentId === null) return;
    const a = students.find((s) => s.id === dragStudentId);
    if (!a) return;
    const cfg = getSeatCfg();
    const card = e.target.closest('.seat-card');
    const empty = e.target.closest('.seat-empty');
    if (card) {
      const targetId = Number(card.dataset.studentId);
      if (targetId !== dragStudentId) {
        const b = students.find((s) => s.id === targetId);
        if (b) {
          const tr = a.seatRow; a.seatRow = b.seatRow; b.seatRow = tr;
          const tc = a.seatCol; a.seatCol = b.seatCol; b.seatCol = tc;
          showToast(`已交换：${a.name} ↔ ${b.name}（点"保存座位"落库）`);
        }
      }
    } else if (empty) {
      const r = Number(empty.dataset.row);
      const pc = Number(empty.dataset.col);
      const lc = physicalToLogical(pc, cfg);
      if (lc === null) {
        showToast('此处为走廊（空列），不能入座');
      } else {
        a.seatRow = r;
        a.seatCol = lc;
        showToast(`${a.name} 已移到 ${r}排${pc}座（点"保存座位"落库）`);
      }
    }
    renderSeats();
  });
  el.seatGrid.addEventListener('dragend', () => {
    dragStudentId = null;
    el.seatGrid.querySelectorAll('.seat-card').forEach((c) => c.classList.remove('dragging', 'drop-target'));
  });
}

// 保存座位（落库，含布局配置）
async function saveSeats() {
  const classId = scopeClassId();
  if (!classId) {
    showToast('当前账号未绑定班级（管理员请先在操作条选择班级），无法保存座位');
    return;
  }
  try {
    const seats = students.map((s) => ({ studentId: s.id, row: s.seatRow, col: s.seatCol }));
    const seatConfig = getSeatCfg();
    const data = await apiFetch('/api/students/seats', {
      method: 'POST',
      body: JSON.stringify({ classId, seats, seatConfig }),
    });
    dbg('[保存座位]', data);
    showToast(`座位布局已保存（${data.updated} 人 · ${seatConfig.mode} ${seatConfig.cols}列）`);
  } catch (err) {
    showToast('保存失败：' + err.message);
  }
}

// 重置座位：清空全部座位 → 按学号+当前布局模式排列 → 落库
function resetSeats() {
  openConfirm('重置座位', '将清空所有学生的座位（seat_row/seat_col 归零），并按学号顺序 + 当前布局模式重新填充后保存。确定吗？', async () => {
    for (const s of students) { s.seatRow = 0; s.seatCol = 0; }
    autoArrange();
    renderSeats();
    await saveSeats();
    showToast('座位已重置并重新排列');
  });
}

// 加载当前班级的布局配置（classes.seat_config）
async function loadSeatConfig() {
  const cid = scopeClassId();
  if (!cid) return;
  hasSeatConfig = false;
  try {
    const d = await apiFetch('/api/classes');
    const cls = (d.classes || []).find((c) => c.id === cid);
    const cfg = cls && cls.seatConfig;
    if (cfg && SEAT_MODES.includes(cfg.mode)) {
      const rows = Number(cfg.rows);
      const cols = Number(cfg.cols);
      if (rows >= 4 && rows <= 10) {
        seatCfg.rows = rows;
        el.seatRows.value = String(rows);
      }
      if (cols >= 4 && cols <= 10) {
        seatCfg.cols = cols;
        el.seatCols.value = String(cols);
      }
      seatCfg.mode = cfg.mode;
      el.seatMode.value = cfg.mode;
      hasSeatConfig = true; // 班级已保存过座位配置
    }
  } catch (_) {}
}

// 视图切换 / 控制栏事件
// 需求 2026-09-30：去掉「列表模式 / 座位表模式」两个切换按钮 —— 签到操作台**只保留座位表模式**
//   · 列表视图的 DOM 仍会渲染（隐藏），供"卡片状态/统计"相关的既有用例与兜底逻辑使用
//   · 将来若要恢复切换：把两个按钮加回 #viewToggleMini 并恢复下面两行监听即可
if (el.btnViewList) el.btnViewList.addEventListener('click', () => switchCardView('list'));
if (el.btnViewSeat) el.btnViewSeat.addEventListener('click', () => switchCardView('seat'));
// 需求 2026-09-30：签到操作台右上角的「作业」按钮已移除（班长导航栏已有「作业统计」菜单）→
//   作业录入台（#homeworkView）仍可通过 URL 直达：/dashboard?view=homework（班长端；见启动逻辑），
//   将来若要在作业统计页给班长加「录入」入口，复用 enterHomeworkView() 即可。
if (el.btnViewHomework) el.btnViewHomework.addEventListener('click', () => switchCardView('homework'));
el.btnSeatAuto.addEventListener('click', () => {
  autoArrange();
  renderSeats();
  showToast('已按学号自动排列（未保存）');
});
el.btnSeatReset.addEventListener('click', resetSeats);
el.btnSeatSave.addEventListener('click', saveSeats);
el.seatCols.addEventListener('change', () => {
  autoArrange();
  renderSeats();
});
el.seatRows.addEventListener('change', () => {
  autoArrange();
  renderSeats();
});
el.seatMode.addEventListener('change', () => {
  autoArrange();
  renderSeats();
});

// ---------- 批量签到（班长模式） ----------
async function batchCheckin(mode, columnIndex) {
  if (!current || !current.session) {
    showToast('当前没有进行中的签到，请先让教师发起签到');
    return;
  }
  try {
    const body = { mode, checkInMethod: mode === 'all' ? 'batch_all' : 'batch_column' };
    if (mode === 'column') body.columnIndex = columnIndex;
    // **必须带上"当前页面上正在操作的那一场"**（v35 一天两场）：
    //   不带 sessionId 时服务端只能自己挑"当前场次"（以往取最新一场=晚自修），
    //   于是座位表里选着「早自习」点「全员到齐/按列签到」会写进晚自修（2026-09-30 真实反馈的 BUG）
    if (current && current.session && current.session.id) body.sessionId = current.session.id;
    // 明确带上本班 classId：服务端按"该班进行中的场次"写入（管理员选中班级后同样收敛）
    const batchBody = withClassId(body);
    const data = await apiFetch('/api/attendance/batch-checkin', {
      method: 'POST',
      body: JSON.stringify(batchBody),
    });
    dbg('[批量签到]', data);
    const skip = Number(data.skipped || 0);
    const tail = skip > 0 ? `，跳过已标记 ${skip} 人` : '';
    showToast(mode === 'all'
      ? `全员签到完成（补齐 ${data.updated} 人${tail}）`
      : `第 ${columnIndex} 列签到完成（补齐 ${data.updated} 人${tail}）`);
    await refreshStatus();
  } catch (err) {
    showToast(err.message);
  }
}

// 全员到齐：二次确认（只补齐未标记的学生，已请假/迟到/已签到的不动）
// 管理员切换"查看班级"：立即刷新学生卡片与签到数据（班级隔离的关键交互）
if (el.adminClassSelect) {
  el.adminClassSelect.addEventListener('change', () => { onAdminClassChange(); });
}

el.btnBatchAll.addEventListener('click', () => {
  openConfirm('全员到齐', '将把本班【尚未标记】的学生标记为已签到；已请假、已迟到、已签到的不受影响。确定继续吗？', () => {
    batchCheckin('all');
  });
});

// 按列签到：弹出列选择
el.btnBatchColumn.addEventListener('click', () => {
  const cfg = getSeatCfg();
  const pCols = physicalColCount(cfg);
  el.columnModalHint.textContent = `选择要签到的列（当前布局共 ${pCols} 列，含空列）`;
  const opts = [];
  for (let pc = 1; pc <= pCols; pc++) {
    const lc = physicalToLogical(pc, cfg);
    opts.push(`<option value="${pc}"${lc === null ? ' data-empty="1"' : ''}>第 ${pc} 列${lc === null ? '（空列·走廊）' : ''}</option>`);
  }
  el.columnModalSelect.innerHTML = opts.join('');
  el.columnModal.classList.remove('hidden');
});
el.columnModalCancel.addEventListener('click', () => el.columnModal.classList.add('hidden'));
el.columnModal.addEventListener('click', (e) => { if (e.target === el.columnModal) el.columnModal.classList.add('hidden'); });
el.columnModalOk.addEventListener('click', () => {
  const pc = Number(el.columnModalSelect.value);
  el.columnModal.classList.add('hidden');
  const cfg = getSeatCfg();
  const lc = physicalToLogical(pc, cfg);
  if (lc === null) {
    showToast('该列为空列（走廊），无学生可签到');
    return;
  }
  batchCheckin('column', lc);
});

// ---------- 📋 批量请假（当天全天请假：多选学生 + 逐个选择病假/事假） ----------
//   数据来源：GET /api/attendance/leave/batch（学生列表 + 当天已登记事由）
//   提交：POST 同路径 { date, items:[{studentId,reason}], cancels:[studentId] }
//   交互：勾选后该行请假类型可选（未勾选置灰）；「全选」勾选当前筛选出的学生
let blState = { date: '', initial: {}, rows: [] };   // initial: studentId -> 打开弹窗时已登记的事由

function blKeyword() { return (el.blSearch.value || '').trim().toLowerCase(); }
function blVisibleRows() {
  const kw = blKeyword();
  return blState.rows.filter((r) => !kw
    || String(r.name || '').toLowerCase().includes(kw)
    || String(r.studentNo || '').toLowerCase().includes(kw));
}

// 重建列表（打开弹窗 / 搜索 / 全选时用；行内勾选与事由变更走 blUpdateDerived，不重建 DOM）
function blRender() {
  const visible = blVisibleRows();
  if (visible.length === 0) {
    el.blList.innerHTML = '<div class="bl-empty">' + (blState.rows.length ? '没有匹配的学生' : '本班暂无在读学生') + '</div>';
  } else {
    el.blList.innerHTML = visible.map((r) => `
      <label class="bl-row${r.checked ? ' checked' : ''}" data-id="${r.id}">
        <input type="checkbox" data-role="check" ${r.checked ? 'checked' : ''}>
        <span class="bl-name">${escHtml(r.name)}<small>（${escHtml(r.studentNo)}）</small></span>
        ${blState.initial[r.id] ? '<span class="bl-tag">当天已请假</span>' : ''}
        <select data-role="reason" ${r.checked ? '' : 'disabled'} title="${r.checked ? '选择请假类型' : '先勾选学生'}">
          ${['sick', 'personal'].map((c) => `<option value="${c}"${r.reason === c ? ' selected' : ''}>${REASON_LABEL[c]}</option>`).join('')}
        </select>
      </label>`).join('');
  }
  blUpdateDerived();
}

// 只更新派生显示（已选人数 / 全选状态 / 行内勾选与下拉可用性）
function blUpdateDerived() {
  const visible = blVisibleRows();
  const checked = blState.rows.filter((r) => r.checked);
  el.blCount.textContent = `已选 ${checked.length} 人`;
  el.blSelectAll.checked = visible.length > 0 && visible.every((r) => r.checked);
  el.blSelectAll.indeterminate = !el.blSelectAll.checked && checked.length > 0;
  el.blList.querySelectorAll('.bl-row').forEach((rowEl) => {
    const row = blState.rows.find((r) => r.id === Number(rowEl.dataset.id));
    if (!row) return;
    const cb = rowEl.querySelector('[data-role="check"]');
    const sel = rowEl.querySelector('[data-role="reason"]');
    if (cb) cb.checked = row.checked;
    if (sel) { sel.value = row.reason; sel.disabled = !row.checked; sel.title = row.checked ? '选择请假类型' : '先勾选学生'; }
    rowEl.classList.toggle('checked', row.checked);
  });
}

async function openBatchLeave() {
  el.blModal.classList.remove('hidden');
  el.blSearch.value = '';
  el.blList.innerHTML = '<div class="bl-empty">加载中…</div>';
  el.blCount.textContent = '已选 0 人';
  el.blSelectAll.checked = false;
  el.blSelectAll.indeterminate = false;
  try {
    // 带上当前关注班级：服务端按班级范围返回学生列表与"本班进行中的场次"
    const scopeCid = scopeClassId();
    const blUrl = scopeCid ? `${API.batchLeave}?classId=${encodeURIComponent(scopeCid)}` : API.batchLeave;
    const d = await apiFetch(blUrl);
    const list = d.students || [];
    blState = { date: d.date, initial: {}, rows: [] };
    for (const s of list) {
      const reason = s.reason || null;
      if (reason) blState.initial[s.id] = reason;      // 已登记 → 默认勾选，便于修改/取消
      blState.rows.push({ id: s.id, name: s.name, studentNo: s.studentNo, checked: !!reason, reason: reason || 'sick' });
    }
    el.blDate.textContent = `日期：${d.date}${d.isToday ? '（今天）' : ''}`;
    el.blHint.textContent = (d.sessionId
      ? '勾选学生并为每人选择请假类型；确认后这些学生当天全天记为请假，当前进行中的签到也会一并标记。'
      : '勾选学生并为每人选择请假类型；确认后这些学生当天全天记为请假（当前没有进行中的签到，之后发起的签到会自动带上）。')
      + `已签到/迟到的学生不会被改动。共 ${list.length} 名学生。`;
    blRender();
  } catch (err) {
    el.blList.innerHTML = `<div class="bl-empty">加载失败：${escHtml(err.message)}</div>`;
  }
}

function closeBatchLeave() { el.blModal.classList.add('hidden'); }

async function submitBatchLeave() {
  const items = [];
  const cancels = [];
  for (const r of blState.rows) {
    if (r.checked) {
      // 只有"新增请假"或"改了事由"才提交（避免无变化也重复写日志）
      if (blState.initial[r.id] !== r.reason) items.push({ studentId: r.id, reason: r.reason });
    } else if (blState.initial[r.id]) {
      cancels.push(r.id);                              // 原来已请假 → 取消请假
    }
  }
  if (items.length === 0 && cancels.length === 0) {
    showToast('没有变化：勾选学生并选择请假类型后再点确认');
    return;
  }
  el.blOk.disabled = true;
  try {
    const blBody = withClassId({ date: blState.date, items, cancels });
    const d = await apiFetch(API.batchLeave, {
      method: 'POST',
      body: JSON.stringify(blBody),
    });
    const nameOf = (id) => ((blState.rows.find((r) => r.id === id) || {}).name) || ('#' + id);
    const skipped = (d.skippedSignedIn || []).map(nameOf);
    const parts = [];
    if (d.marked) parts.push(`已登记 ${d.marked} 人当天请假`);
    if (d.cancelled) parts.push(`已取消 ${d.cancelled} 人请假`);
    closeBatchLeave();
    showToast(parts.join('，')
      + (d.sessionCount ? `（同步当天 ${d.sessionCount} 个场次）` : '（当天暂无场次，之后发起的签到会自动带上）')
      + (skipped.length ? `；${skipped.join('、')} 已签到，未改动` : ''));
    await refreshStatus();
  } catch (err) {
    showToast('批量请假失败：' + err.message);
  } finally {
    el.blOk.disabled = false;
  }
}

if (el.btnBatchLeave) el.btnBatchLeave.addEventListener('click', openBatchLeave);
if (el.blCancel) el.blCancel.addEventListener('click', closeBatchLeave);
if (el.blOk) el.blOk.addEventListener('click', submitBatchLeave);
if (el.blModal) el.blModal.addEventListener('click', (e) => { if (e.target === el.blModal) closeBatchLeave(); });
if (el.blSearch) el.blSearch.addEventListener('input', blRender);
if (el.blSelectAll) el.blSelectAll.addEventListener('change', () => {
  const on = el.blSelectAll.checked;
  blVisibleRows().forEach((r) => { r.checked = on; });   // 全选 = 勾选当前筛选出的学生
  blUpdateDerived();
});
if (el.blList) {
  el.blList.addEventListener('change', (e) => {
    const rowEl = e.target.closest('.bl-row');
    if (!rowEl) return;
    const row = blState.rows.find((r) => r.id === Number(rowEl.dataset.id));
    if (!row) return;
    if (e.target.matches('[data-role="reason"]')) row.reason = e.target.value;
    else row.checked = e.target.checked;
    blUpdateDerived();
  });
}

// ---------- 全屏（希沃白板） ----------
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => showToast('浏览器未允许自动全屏，请按 F11'));
  }
}
el.btnFullscreen.addEventListener('click', toggleFullscreen);
// 👍 点赞排行：跳转到独立页面（班长端只读排行榜）
if (el.btnLikeRanking) el.btnLikeRanking.addEventListener('click', () => { window.location.href = '/likes-ranking'; });

// ---------- 首次登录强制修改密码 ----------
function showPwdModal() {
  el.pwdOld.value = '';
  el.pwdNew.value = '';
  el.pwdNew2.value = '';
  el.pwdError.classList.add('hidden');
  el.pwdModal.classList.remove('hidden');
}
el.pwdLogout.addEventListener('click', async () => {
  try { await apiFetch(API.logout, { method: 'POST' }); } catch (_) {}
  window.location.href = '/login';
});
el.pwdSubmit.addEventListener('click', async () => {
  const oldP = el.pwdOld.value;
  const newP = el.pwdNew.value;
  const newP2 = el.pwdNew2.value;
  el.pwdError.classList.add('hidden');
  if (!oldP) return showPwdErr('请输入原密码');
  if (!newP || newP.length < 6) return showPwdErr('新密码至少 6 位');
  if (newP !== newP2) return showPwdErr('两次输入的新密码不一致');
  try {
    await apiFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword: oldP, newPassword: newP }),
    });
    el.pwdModal.classList.add('hidden');
    if (currentUser) currentUser.mustChangePassword = false;
    showToast('密码修改成功');
  } catch (err) {
    showPwdErr(err.message);
  }
});
function showPwdErr(msg) { el.pwdError.textContent = msg; el.pwdError.classList.remove('hidden'); }

// ---------- 通用确认弹窗 + 删除学生 ----------
let confirmAction = null;

function openConfirm(title, message, onOk) {
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  confirmAction = onOk;
  el.confirmModal.classList.remove('hidden');
}

function closeConfirm() {
  el.confirmModal.classList.add('hidden');
  confirmAction = null;
}

el.confirmOk.addEventListener('click', () => {
  const fn = confirmAction;
  closeConfirm();
  if (fn) fn();
});
el.confirmCancel.addEventListener('click', closeConfirm);
el.confirmModal.addEventListener('click', (e) => {
  if (e.target === el.confirmModal) closeConfirm();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeConfirm();
});

// ---------- 视图切换（签到主页面 / 计划管理页） ----------
// URL 路由驱动（与后台管理页一致）：**URL 是当前视图的唯一真源**
//   /dashboard                    → 签到操作台（首页）
//   /dashboard?view=plans 或 /plans → 签到计划（计划管理）
// 为什么必须同步 URL（本 BUG 的根因）：
//   此前只在内存里切换视图、URL 不动 —— 例如从别的页面点「计划管理」进来时 URL 是
//   /dashboard?view=plans，之后用「← 返回签到」回到操作台，URL 里仍留着 view=plans，
//   于是**一刷新就被 URL 带回计划管理页**（用户反馈的"刷新后偶尔跳转"）。
//   现在：切换视图 = 同步改写 URL；刷新时按 URL 加载对应视图 → 刷新不再改变所在页面。
const VIEW_PATH = { attendance: '/dashboard', plans: '/dashboard?view=plans' };

// 当前 URL 对应的视图（兼容 /plans 这个"计划管理"直达路径）
function viewFromUrl() {
  try {
    if (window.location.pathname === '/plans') return 'plans';
    const qp = new URLSearchParams(window.location.search);
    return qp.get('view') === 'plans' ? 'plans' : 'attendance';
  } catch (_) { return 'attendance'; }
}

// 把视图写回 URL（只在本页 /dashboard、/plans 上生效，绝不影响其它页面）
//   push=true  → 用户主动切换（浏览器"后退"可回到上一个视图）
//   push=false → 载入时校正 URL（不留历史记录）
function syncViewUrl(view, push) {
  const here = window.location.pathname;
  if (here !== '/dashboard' && here !== '/plans' && here !== '/') return;
  const url = VIEW_PATH[view] || VIEW_PATH.attendance;
  if (here + window.location.search === url) return;              // 已就是目标地址
  const staleAnn = /(^|[?&])ann=1(&|$)/.test(window.location.search);
  // 等价地址（/plans 与 /dashboard?view=plans 同义）且无残留参数 → 不动地址栏，避免"载入即改写 URL"
  if (viewFromUrl() === view && !staleAnn) return;
  try {
    if (push) history.pushState({ view }, '', url);
    else history.replaceState({ view }, '', url);
  } catch (_) { /* 老浏览器/沙箱：URL 同步失败不影响视图切换 */ }
}

function doSwitchView(view, opts = {}) {
  const isPlans = view === 'plans';
  el.viewAttendance.classList.toggle('hidden', isPlans);
  el.viewPlans.classList.toggle('hidden', !isPlans);
  if (!opts.skipUrl) syncViewUrl(isPlans ? 'plans' : 'attendance', !!opts.push);
  if (isPlans) {
    loadPlans(); // 进入计划页时立即刷新
    updatePlanBanner();
  }
}

function switchView(view, opts = {}) {
  // 作业统计模式有未保存修改时切到计划管理 → 二次确认
  if (view === 'plans' && viewMode === 'homework' && hwDirty()) {
    pendingCardMode = null;
    openConfirm('放弃未保存的作业修改？', '作业统计中有未保存的修改（未点"保存"）。进入计划管理将丢弃这些修改。', () => {
      doSwitchView('plans', opts);
    });
    return;
  }
  doSwitchView(view, opts);
}

// 浏览器前进/后退：按 URL 恢复视图（不弹二次确认，避免与历史记录互相卡住）
window.addEventListener('popstate', () => {
  doSwitchView(viewFromUrl(), { skipUrl: true });
});

// 导航菜单项的跳转统一由 navbar.js 处理；签到操作台内"就地响应"的两项（计划管理 / 叫号提醒）
// 由 navbar.js 派发 navbar:item 事件，这里只负责页面内动作（不刷新页面）
window.addEventListener('navbar:item', (e) => {
  const id = e.detail && e.detail.id;
  if (id === 'btnPlansView') switchView('plans', { push: true });
  else if (id === 'btnAnnouncements') {
    if (el.annModal && !el.annModal.classList.contains('hidden')) closeAnnModal();
    else openAnnModal();
  } else if (id === 'navAttendance') {
    // 从"计划管理"点导航栏「签到操作」→ 回到签到操作台（同步 URL，刷新也留在操作台）
    if (viewFromUrl() === 'attendance' && !el.viewPlans.classList.contains('hidden')) {
      // URL 已是操作台但视图还在计划页（异常态）→ 一并纠正
      switchView('attendance', { push: true });
      return;
    }
    if (viewFromUrl() === 'plans') switchView('attendance', { push: true });
    else showToast('当前已在签到操作台');
  }
});

el.btnBackAttendance.addEventListener('click', () => switchView('attendance', { push: true }));

// 页脚实时时钟（原导航栏时钟；元素不存在时静默跳过）
function updateClock() {
  if (!el.navbarTime) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  el.navbarTime.textContent =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 计划页顶部横幅：有签到中的计划时提示快速返回
// 若当前列表被状态筛选隐藏了签到中计划，仍显示通用提示（用 current 会话兜底）
function updatePlanBanner() {
  const active = plans.find((p) => p.status === 'active');
  let html;
  if (active) {
    html =
      `🔵 正在签到中：${fmtDateCN(active.planDate)} ${active.startTime}，` +
      `剩余 ${active.sessionDeadline ? Math.max(0, Math.ceil((new Date(active.sessionDeadline) - Date.now()) / 60000)) : 0} 分钟 · ` +
      `<button type="button" class="btn btn-primary btn-sm" id="bannerBack">返回签到</button>`;
  } else if (current && current.session) {
    html =
      `🔵 正在签到中（场次 #${current.session.id}）· ` +
      `<button type="button" class="btn btn-primary btn-sm" id="bannerBack">返回签到</button>`;
  } else {
    el.planActiveBanner.classList.add('hidden');
    return;
  }
  el.planActiveBanner.innerHTML = html;
  el.planActiveBanner.classList.remove('hidden');
  const btn = el.planActiveBanner.querySelector('#bannerBack');
  if (btn) btn.addEventListener('click', () => switchView('attendance'));
}

// ---------- 签到计划 ----------
let plans = [];
let planPage = 1;         // 当前页码
let planPageSize = 20;    // 每页条数（默认 20）
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const PLAN_STATUS_CN = { pending: '待签到', active: '签到中', ended: '已结束' };

function fmtDateCN(dateStr) {
  // '2026-09-01' -> '2026年9月1日（周二）'
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAY_CN[d.getDay()]}）`;
}

async function loadPlans() {
  try {
    // 状态筛选（传给后端）
    const status = el.planStatusFilter.value;
    const url = API.plans + (status ? '?status=' + encodeURIComponent(status) : '');
    const data = await apiFetch(url);
    plans = data.plans || [];
    renderPlanList();
    updatePlanBanner();
  } catch (err) {
    dbg('[计划加载失败]', err.message);
  }
}

// 分页渲染计划列表（纯前端，不刷新页面）
function renderPlanList() {
  const total = plans.length;
  const totalPages = Math.max(1, Math.ceil(total / planPageSize));
  if (planPage > totalPages) planPage = totalPages;
  if (planPage < 1) planPage = 1;

  const start = (planPage - 1) * planPageSize;
  const pagePlans = plans.slice(start, start + planPageSize);

  // 信息提示：显示范围 + 页码
  el.planRangeInfo.textContent = total === 0
    ? '显示 0-0 条，共 0 条'
    : `显示 ${start + 1}-${Math.min(start + planPageSize, total)} 条，共 ${total} 条`;
  el.planPageInfo.textContent = `第 ${planPage} / ${totalPages} 页`;
  el.planPrev.disabled = planPage <= 1;
  el.planNext.disabled = planPage >= totalPages;

  if (pagePlans.length === 0) {
    // 默认筛选（签到中+待签到）为空时，提示如何查看历史（已结束）计划
    const f = el.planStatusFilter.value;
    el.planList.innerHTML = f === 'open'
      ? '<tr><td colspan="6" class="plan-empty">暂无"签到中 / 待签到"计划；如需查看历史计划，请把上方「状态」切换为"全部"或"已结束"</td></tr>'
      : '<tr><td colspan="6" class="plan-empty">暂无签到计划，点击"添加计划"或"批量生成"设置自动签到</td></tr>';
    return;
  }
  el.planList.innerHTML = pagePlans.map((p) => {
    let statusTag, actions = '';
    if (p.status === 'pending') {
      statusTag = '<span class="tag pending">待签到</span>';
      actions = `<button type="button" class="btn btn-danger-ghost btn-sm plan-del" data-id="${p.id}" data-label="${fmtDateCN(p.planDate)} ${p.startTime}">删除</button>`;
    } else if (p.status === 'active') {
      const remain = p.sessionDeadline ? Math.max(0, Math.ceil((new Date(p.sessionDeadline) - Date.now()) / 60000)) : 0;
      statusTag = `<span class="tag active">签到中 · 剩 ${remain} 分钟</span>`;
    } else {
      statusTag = '<span class="tag ended">已结束</span>';
      // 已结束的计划一律显示补签按钮（无论日期/班级/是否生成过场次）；
      // 未生成场次的计划在补签页提交时会自动补录签到场次
      actions = `<button type="button" class="btn btn-secondary btn-sm plan-makeup" data-id="${p.id}" data-session="${p.sessionId || ''}">补签</button>`;
      // 管理员：删除"这场已经结束的签到"（场次 + 其签到记录，不可恢复；计划本身保留）
      if (isAdminUser() && p.sessionId) {
        actions += `<button type="button" class="btn btn-danger-ghost btn-sm plan-session-del"
          data-session="${p.sessionId}"
          data-date="${escHtml(fmtDateCN(p.planDate))}"
          data-range="${escHtml(fmtTimeHM(p.sessionStart || '') + '–' + fmtTimeHM(p.sessionDeadline || ''))}"
          data-class="${escHtml(p.className || '全部班级')}">删除</button>`;
      }
    }
    const classCell = p.className ? p.className : '<span style="color:var(--text-light)">全部班级</span>';
    return `
      <tr>
        <td>${fmtDateCN(p.planDate)}</td>
        <td>${p.startTime}</td>
        <td>${p.durationMinutes} 分钟</td>
        <td>${classCell}</td>
        <td>${statusTag}</td>
        <td class="td-actions">${actions}</td>
      </tr>`;
  }).join('');
}

// 每页条数 / 状态筛选 / 翻页（不刷新页面）
el.planPageSize.addEventListener('change', () => {
  planPageSize = Number(el.planPageSize.value) || 20;
  planPage = 1;
  renderPlanList();
});

// 状态筛选：重新请求后端并回到第 1 页
el.planStatusFilter.addEventListener('change', () => {
  planPage = 1;
  loadPlans();
});

el.planPrev.addEventListener('click', () => {
  if (planPage > 1) { planPage -= 1; renderPlanList(); }
});

el.planNext.addEventListener('click', () => {
  if (planPage < Math.max(1, Math.ceil(plans.length / planPageSize))) {
    planPage += 1;
    renderPlanList();
  }
});

// 计划列表操作（事件委托）
el.planList.addEventListener('click', (e) => {
  // 删除已结束的"签到"（场次 + 其签到记录）—— 仅管理员可见此按钮
  const sdel = e.target.closest('.plan-session-del');
  if (sdel) {
    const sid = Number(sdel.dataset.session);
    const date = sdel.dataset.date || '';
    const range = sdel.dataset.range || '';
    const cls = sdel.dataset.class || '';
    openConfirm('删除签到',
      `确定要删除这场签到吗？\n日期：${date}\n时间：${range}\n班级：${cls}\n` +
      '删除后，该场次的签到记录将一并删除，不可恢复。',
      async () => {
        try {
          const r = await apiFetch(API.sessionDelete(sid), { method: 'DELETE' });
          showToast(`删除成功（同时删除 ${r.recordsDeleted || 0} 条签到记录）` +
            (r.planEnded > 0 ? `，对应的 ${r.planEnded} 条进行中计划已置为已结束（不会自动重建场次）` : ''));
          await loadPlans();
          await refreshStatus();
        } catch (err) {
          showToast('删除失败：' + err.message);
        }
      });
    return;
  }
  const del = e.target.closest('.plan-del');
  if (del) {
    const id = Number(del.dataset.id);
    openConfirm('删除计划', `确定删除 ${del.dataset.label} 的签到计划吗？`, async () => {
      try {
        await apiFetch(API.plans + '/' + id, { method: 'DELETE' });
        showToast('计划已删除');
        await loadPlans();
      } catch (err) {
        showToast('删除失败：' + err.message);
      }
    });
    return;
  }
  // 补签按钮由文档级委托统一处理（见下方 goMakeupPage / document 委托）
});

// 跳转独立补签页（统一入口；已结束计划若未生成过场次则只带 planId，
// 补签页会提示并在提交补签时自动补录场次）
function goMakeupPage(planId, sessionId, from) {
  const q = [];
  if (Number.isInteger(planId) && planId > 0) q.push('planId=' + planId);
  if (Number.isInteger(sessionId) && sessionId > 0) q.push('sessionId=' + sessionId);
  if (q.length === 0) {
    showToast('无法补签：缺少场次/计划参数');
    return false;
  }
  q.push('from=' + (from || 'plans'));
  dbg('[补签] 跳转', q.join('&'));
  window.location.href = '/attendance/makeup?' + q.join('&');
  return true;
}

// 兜底：文档级事件委托（即使计划列表被重新渲染/绑定失效，点击"补签"依然生效）
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.plan-makeup');
  if (!btn) return;
  dbg('[补签] 文档级委托触发');
  goMakeupPage(Number(btn.dataset.id), Number(btn.dataset.session), 'plans');
});

// 兜底：旧版内嵌补签弹窗按钮若残留，直接跳转补签页（避免旧元素报错导致无反应）
document.addEventListener('click', (e) => {
  const legacy = e.target.closest && e.target.closest('#makeupSubmit, .makeup-legacy');
  if (!legacy) return;
  const s = current && current.session;
  if (s) goMakeupPage(null, s.id, 'attendance');
});

// ---------- 添加计划弹窗 ----------
let planMode = 'single';
let planWeekdays = [];

function buildMultiDates() {
  const grid = [];
  const today = new Date();
  for (let i = 1; i <= 31; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    grid.push(`<label class="date-check"><input type="checkbox" value="${key}"><span>${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY_CN[d.getDay()]}</span></label>`);
  }
  el.multiDates.innerHTML = grid.join('');
}

function buildWeekdayPick() {
  el.weekdayPick.innerHTML = WEEKDAY_CN.map((w, i) =>
    `<label class="wd-check"><input type="checkbox" value="${i}"><span>${w}</span></label>`
  ).join('');
}

function switchPlanMode(mode) {
  planMode = mode;
  document.querySelectorAll('.plan-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  el.planModeSingle.classList.toggle('hidden', mode !== 'single');
  el.planModeMulti.classList.toggle('hidden', mode !== 'multi');
  el.planModeWeekly.classList.toggle('hidden', mode !== 'weekly');
  updatePlanPreview();
}

function openPlanModal() {
  // 默认日期：明天
  const t = new Date();
  t.setDate(t.getDate() + 1);
  el.planDate.value = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  // 周循环默认范围：本月剩余 ~ 下月
  const from = new Date();
  from.setDate(from.getDate() + 1);
  const to = new Date(from);
  to.setMonth(to.getMonth() + 1);
  const f = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  el.weeklyFrom.value = f(from);
  el.weeklyTo.value = f(to);

  // 适用范围：教师只显示本班（锁定）；管理员全部班级或指定班级
  const isTeacher = currentUser && currentUser.role === 'teacher';
  if (isTeacher) {
    const myClass = classes.find((c) => c.id === currentUser.classId);
    el.planClass.innerHTML = `<option value="${currentUser.classId || ''}" selected>${myClass ? myClass.className : '本班'}</option>`;
    el.planClass.disabled = true;
  } else {
    el.planClass.disabled = false;
    el.planClass.innerHTML = '<option value="">全部班级</option>' +
      classes.map((c) => `<option value="${c.id}">${c.className}</option>`).join('');
  }

  el.planError.classList.add('hidden');
  el.planPreview.className = 'import-preview';
  el.planPreview.textContent = '';
  buildMultiDates();
  buildWeekdayPick();
  planWeekdays = [];
  switchPlanMode('single');
  el.planModal.classList.remove('hidden');
}

function closePlanModal() {
  el.planModal.classList.add('hidden');
}

function updatePlanPreview() {
  const time = el.planTime.value || '08:00';
  const dur = el.planDuration.value || 10;
  let count = 0;
  if (planMode === 'single') {
    count = el.planDate.value ? 1 : 0;
  } else if (planMode === 'multi') {
    count = el.multiDates.querySelectorAll('input:checked').length;
  } else {
    planWeekdays = [...el.weekdayPick.querySelectorAll('input:checked')].map((c) => Number(c.value));
    if (planWeekdays.length > 0 && el.weeklyFrom.value && el.weeklyTo.value) {
      count = estimateWeeklyCount(planWeekdays, el.weeklyFrom.value, el.weeklyTo.value);
    }
  }
  el.planPreview.textContent = count > 0
    ? `将添加 ${count} 个签到日，每天 ${time} 自动发起，时长 ${dur} 分钟`
    : '请选择日期';
  el.planPreview.className = 'import-preview' + (count > 0 ? ' ok' : ' err');
}

function estimateWeeklyCount(weekdays, from, to) {
  let n = 0;
  const d = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  const wd = new Set(weekdays);
  while (d <= end) {
    if (wd.has(d.getDay())) n += 1;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

async function onPlanSubmit() {
  const startTime = el.planTime.value || '08:00';
  const durationMinutes = Number(el.planDuration.value) || 10;
  const planClassId = el.planClass.value ? Number(el.planClass.value) : null;
  let body;
  if (planMode === 'single') {
    if (!el.planDate.value) return showPlanError('请选择签到日期');
    body = { planDate: el.planDate.value, startTime, durationMinutes };
  } else if (planMode === 'multi') {
    const dates = [...el.multiDates.querySelectorAll('input:checked')].map((c) => c.value);
    if (dates.length === 0) return showPlanError('请至少勾选一个日期');
    body = { dates, startTime, durationMinutes };
  } else {
    const weekdays = [...el.weekdayPick.querySelectorAll('input:checked')].map((c) => Number(c.value));
    if (weekdays.length === 0) return showPlanError('请至少选择一个星期几');
    if (!el.weeklyFrom.value) return showPlanError('请选择开始日期');
    body = { weekdays, dateFrom: el.weeklyFrom.value, dateTo: el.weeklyTo.value || undefined, startTime, durationMinutes };
  }
  if (planClassId) body.classId = planClassId;
  dbg('[添加计划]', body);
  try {
    const data = await apiFetch(API.plans, { method: 'POST', body: JSON.stringify(body) });
    dbg('[添加计划成功]', data);
    closePlanModal();
    showToast(`已添加 ${data.inserted} 个签到日${data.skipped > 0 ? `（${data.skipped} 个已存在跳过）` : ''}`);
    await loadPlans();
  } catch (err) {
    showPlanError(err.message);
  }
}

function showPlanError(msg) {
  el.planError.textContent = msg;
  el.planError.classList.remove('hidden');
}

// 模式切换
document.querySelectorAll('.plan-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchPlanMode(tab.dataset.mode));
});
el.multiDates.addEventListener('change', updatePlanPreview);
el.weekdayPick.addEventListener('change', updatePlanPreview);
el.planTime.addEventListener('change', updatePlanPreview);
el.planDuration.addEventListener('input', updatePlanPreview);
el.planDate.addEventListener('change', updatePlanPreview);
el.btnAddPlan.addEventListener('click', openPlanModal);
el.btnBatchPlan.addEventListener('click', () => { openPlanModal(); switchPlanMode('multi'); });
el.planCancel.addEventListener('click', closePlanModal);
el.planModal.addEventListener('click', (e) => { if (e.target === el.planModal) closePlanModal(); });
el.planSubmit.addEventListener('click', onPlanSubmit);

// ---------- 倒计时 ----------
// 倒计时：
//  - 进行中场次：每秒刷新剩余时间，到点时补刷一次状态（服务端在响应前会懒执行补缺勤）
//  - 已结束场次（回看视图，deadline 已过）：只显示"已截止"，【绝不】再回调 refreshStatus
//    否则链路 refreshStatus → renderAll → renderSessionInfo → startCountdown → tick → refreshStatus
//    会形成无限刷新死循环（页面狂刷 /api/attendance/status）
let countdownExpiredHandled = null; // 已对哪个场次做过"到点补刷"（防重复）
function startCountdown(deadlineISO, sessionId) {
  stopCountdown();
  const deadline = new Date(deadlineISO).getTime();
  const remainInit = deadline - Date.now();
  if (remainInit <= 0) {
    el.countdown.textContent = '已截止';
    return; // 已结束场次：不再触发补刷，避免死循环
  }
  el.countdown.textContent = fmtCountdown(remainInit);
  const sid = sessionId;
  countdownTimer = setInterval(() => {
    const remain = deadline - Date.now();
    if (remain <= 0) {
      el.countdown.textContent = '已截止';
      stopCountdown();
      if (countdownExpiredHandled !== sid) {
        countdownExpiredHandled = sid;
        refreshStatus();
      }
      return;
    }
    el.countdown.textContent = fmtCountdown(remain);
  }, 1000);
}

function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

// ---------- 交互：发起签到 ----------
async function onStartClick() {
  const minutes = Number(el.deadlineSelect.value) || 30;
  dbg('[发起签到] 截止分钟数=', minutes);
  try {
    const data = await apiFetch(API.start, {
      method: 'POST',
      // 带上"当前关注班级"：管理员选中某班 → 只为该班发起；选"全部班级" → 按班拆场（每班一条）；
      // 教师 → 只对本班发起（服务端仍会按其所带班级再校验一次）
      body: JSON.stringify(withClassId({ deadlineMinutes: minutes })),
    });
    dbg('[发起签到成功] session=', data.session, 'sessions=', (data.sessions || []).length);
    // 新场次立刻成为本页钉住的场次（否则下一次轮询会把旧场次又拉回来）
    pinnedSessionId = data.session && data.session.id ? data.session.id : null;
    const n = (data.sessions || []).filter((x) => !x.shared).length;
    showToast(n > 1
      ? `已为 ${n} 个班级各发起一场签到，截止 ${fmtTimeHM(data.session.deadline)}`
      : `签到已发起，截止 ${fmtTimeHM(data.session.deadline)}`);
    await refreshStatus();
  } catch (err) {
    dbg('[发起签到失败]', err.message);
    showToast('发起签到失败：' + err.message);
  }
}

// 判断卡片当前能否操作；返回 null 表示可以，否则返回提示文案
function getInteractBlock(card) {
  if (currentUser && currentUser.role === 'student') return '当前账号仅可查看，无签到操作权限';
  if (!current || !current.session) return '当前没有进行中的签到，请先发起签到';
  // 每天自动签到（v35）：**不限时** —— 不做窗口判断；点卡片 = 切换"已签/未到"（本地草稿）
  if (autoMode()) {
    if (!autoEditable()) return autoBlockReason() || '当前不可修改';
    return null;
  }
  // 签到窗口已关闭：截止后不可再签到（补签请用"手动补签"）
  if (Date.now() > new Date(current.session.deadline).getTime()) return '签到窗口已关闭';
  const st = card.dataset.status;
  if (st === 'none') return null;
  return st === 'absent' ? '该学生已被标记为缺勤' :
         st === 'late'   ? '该学生已迟到' :
         st === 'leave'  ? '该学生已请假' :
                           '该学生本场次已签到，不能重复操作';
}

// 乐观更新：用接口返回的记录立即更新单张卡片与统计（不依赖轮询/刷新）
// 同时更新列表模式与座位表模式的卡片
function applyRecordLocal(studentId, rec) {
  if (!current) return;
  const old = current.records[studentId];
  if (old && old.status in current.stats) {
    current.stats[old.status] = Math.max(0, current.stats[old.status] - 1);
  }
  current.records[studentId] = rec; // rec 可为 null（取消签到）
  if (rec && rec.status in current.stats) {
    current.stats[rec.status] += 1;
  }
  renderStats();
  const color = rec ? (STATUS_CLASS[rec.status] || 'gray') : 'gray';
  const label = rec ? (STATUS_LABEL[rec.status] || rec.status) : '未签到';
  const status = rec ? rec.status : 'none';
  const listCard = el.grid.querySelector(`.student-card[data-student-id="${studentId}"]`);
  if (listCard) {
    listCard.className = 'student-card ' + color;
    listCard.dataset.status = status;
    const badge = listCard.querySelector('.badge');
    if (badge) badge.textContent = label;
  }
  const seatCard = el.seatGrid.querySelector(`.seat-card[data-student-id="${studentId}"]`);
  if (seatCard) {
    seatCard.className = 'student-card seat-card ' + color;
    seatCard.dataset.status = status;
    const badge = seatCard.querySelector('.badge');
    if (badge) badge.textContent = label;
  }
  renderSeatStats();
}

// ---------- 交互：点击卡片签到（左键） ----------
async function onCardClick(card) {
  const studentId = Number(card.dataset.studentId);
  dbg('[点击卡片] studentId=', studentId, '当前状态=', card.dataset.status);
  const block = getInteractBlock(card);
  if (block) {
    dbg('[点击被拦截]', block);
    showToast(block);
    return;
  }
  // 每天自动签到（v35）：点一下 = 取消未到；再点 = 恢复已签到（本地草稿，点「保存本场」才落库）
  if (autoMode()) {
    const stu = students.find((s) => s.id === studentId);
    const cur = (AUTO.draft[studentId] || {}).status || 'present';
    if (cur === 'leave') {
      showToast(`${stu ? stu.name : '该学生'} 已请假（右键可改成已签到或缺勤）`);
      return;
    }
    const next = cur === 'present' ? 'absent' : 'present';
    setAutoDraft(studentId, next, null);
    showToast(next === 'absent'
      ? `${stu ? stu.name : '该学生'} 已标记为缺勤（点「保存本场」生效）`
      : `${stu ? stu.name : '该学生'} 已恢复为已签到（点「保存本场」生效）`);
    return;
  }
  try {
    const data = await apiFetch(API.checkin, {
      method: 'POST',
      body: JSON.stringify(withClassId({ studentId, action: 'present', sessionId: current && current.session ? current.session.id : undefined })),
    });
    dbg('[签到成功] 返回=', data);
    const stu = students.find((s) => s.id === studentId);
    const who = stu ? stu.name : '该学生';
    // 第一步：立即更新卡片颜色（乐观更新）
    applyRecordLocal(studentId, data.record);
    // 第二步：全量同步（即使失败，卡片也已经是新颜色）
    await refreshStatus();
    if (data.record.status === 'late') {
      showToast(`${who} 已迟到（截止后签到）`);
    } else {
      showToast(`${who} 已签到`);
    }
  } catch (err) {
    dbg('[签到失败]', err.message);
    showToast(err.message);
    await refreshStatus();
  }
}

// ---------- 交互：右键菜单（按学生状态显示对应操作） ----------
let menuStudentId = null;
let longPressTimer = null;
let longPressTriggered = false;
let suppressNextClick = false;
let contextMode = 'main'; // 'main' | 'leave-reason'（修改为请假的二级事由选择）

function onCardContextMenu(e, card) {
  e.preventDefault();
  const studentId = Number(card.dataset.studentId);

  // 仅拦截无权限 / 无会话（状态不再拦截：按状态显示对应菜单项）
  if (currentUser && currentUser.role === 'student') {
    showToast('当前账号仅可查看，无操作权限');
    return;
  }
  if (!current || !current.session) {
    showToast('当前没有进行中的签到，请先发起签到');
    return;
  }

  const stu = students.find((s) => s.id === studentId);
  menuStudentId = studentId;
  contextMode = 'main';
  const st = card.dataset.status; // none / present / late / leave / absent
  const absent = st === 'absent';
  const isSeat = viewMode === 'seat';

  el.contextTitle.textContent = (stu ? stu.name : '学生') + ' · 选择操作';

  // ---- 每天自动签到（v35）：菜单语义改为"默认已签到 → 标缺勤 / 标请假 / 恢复" ----
  if (autoMode()) {
    // 病假/事假/公假：只要不是请假状态就显示（含默认已签到）
    document.querySelectorAll('#contextMenu [data-reason]').forEach((item) => {
      item.classList.toggle('hidden', st === 'leave');
    });
    // "修改为已签到"：缺勤/请假时显示（恢复绿色）
    el.contextAbsentPresent.classList.toggle('hidden', !(absent || st === 'leave'));
    el.contextAbsentPresent.textContent = '✅ 恢复为已签到';
    // "修改为请假"：非请假时显示（进入二级事由）
    el.contextAbsentLeave.classList.toggle('hidden', st === 'leave');
    el.contextAbsentLeave.textContent = '🟠 标记为请假';
    // 取消签到：自动签到模式下不用（点卡片即可切换）—— 隐藏，避免与"标缺勤"重复
    el.contextCancelCheckin.classList.add('hidden');
    el.contextRemark.classList.remove('hidden');
    el.contextClear.classList.toggle('hidden', !isSeat);
    el.contextMenu.classList.remove('hidden');
    const rect = el.contextMenu.getBoundingClientRect();
    const x = Math.min(e.clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(e.clientY, window.innerHeight - rect.height - 8);
    el.contextMenu.style.left = Math.max(8, x) + 'px';
    el.contextMenu.style.top = Math.max(8, y) + 'px';
    return;
  }
  // 恢复默认文案（老模式）
  if (el.contextAbsentPresent) el.contextAbsentPresent.textContent = '✅ 修改为已签到';
  if (el.contextAbsentLeave) el.contextAbsentLeave.textContent = '🟠 修改为请假';

  // 病假/事假/公假：未签到/已签到/迟到 显示；请假/缺勤 隐藏（缺勤用"修改为请假"）
  document.querySelectorAll('#contextMenu [data-reason]').forEach((item) => {
    item.classList.toggle('hidden', absent || st === 'leave');
  });
  // 修改为已签到 / 修改为请假：仅缺勤
  el.contextAbsentPresent.classList.toggle('hidden', !absent);
  el.contextAbsentLeave.classList.toggle('hidden', !absent);
  // 取消签到：已签到/迟到/请假 显示
  el.contextCancelCheckin.classList.toggle('hidden', !(st === 'present' || st === 'late' || st === 'leave'));
  // 备注：所有状态
  el.contextRemark.classList.remove('hidden');
  // 清空座位：仅座位表模式
  el.contextClear.classList.toggle('hidden', !isSeat);

  // 显示后再定位，确保菜单位置不超出视口
  el.contextMenu.classList.remove('hidden');
  const rect = el.contextMenu.getBoundingClientRect();
  const x = Math.min(e.clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(e.clientY, window.innerHeight - rect.height - 8);
  el.contextMenu.style.left = Math.max(8, x) + 'px';
  el.contextMenu.style.top = Math.max(8, y) + 'px';
}

function closeContextMenu() {
  el.contextMenu.classList.add('hidden');
  menuStudentId = null;
  contextMode = 'main';
}

async function selectLeaveReason(reason) {
  const studentId = menuStudentId;
  closeContextMenu();
  if (!studentId) return;
  dbg('[选择请假] studentId=', studentId, '事由=', reason);
  // 每天自动签到（v35）：请假只改本地草稿，点「保存本场」才落库
  if (autoMode()) {
    const stu = students.find((s) => s.id === studentId);
    setAutoDraft(studentId, 'leave', reason);
    showToast(`${stu ? stu.name : '该学生'} 已标记请假（${REASON_LABEL[reason] || reason}）· 点「保存本场」生效`);
    return;
  }
  try {
    const data = await apiFetch(API.checkin, {
      method: 'POST',
      body: JSON.stringify(withClassId({ studentId, action: 'leave', leaveReason: reason, sessionId: current && current.session ? current.session.id : undefined })),
    });
    dbg('[请假成功] 返回=', data);
    const stu = students.find((s) => s.id === studentId);
    applyRecordLocal(studentId, data.record);
    await refreshStatus();
    showToast(`${stu ? stu.name : '该学生'} 已请假（${REASON_LABEL[reason] || reason}）`);
  } catch (err) {
    dbg('[请假失败]', err.message);
    showToast(err.message);
    await refreshStatus();
  }
}

// 缺勤 → 修改为已签到（绿色 present）
async function absentToPresent(studentId) {
  closeContextMenu();
  if (!studentId) return;
  // 每天自动签到（v35）：恢复为已签到 = 本地草稿（点卡片也行）
  if (autoMode()) {
    const stu = students.find((s) => s.id === studentId);
    setAutoDraft(studentId, 'present', null);
    showToast(`✅ ${stu ? stu.name : '该学生'} 已恢复为已签到（点「保存本场」生效）`);
    return;
  }
  try {
    const data = await apiFetch(API.checkin, {
      method: 'POST',
      body: JSON.stringify(withClassId({ studentId, action: 'present', forcePresent: true, checkInMethod: 'manual', sessionId: current && current.session ? current.session.id : undefined })),
    });
    dbg('[缺勤改已签到]', data);
    applyRecordLocal(studentId, data.record);
    await refreshStatus();
    const stu = students.find((s) => s.id === studentId);
    showToast(`✅ ${stu ? stu.name : '该学生'} 已标记为已签到`);
  } catch (err) {
    showToast(err.message);
    await refreshStatus();
  }
}

// 缺勤 → 修改为请假：切换到二级"选择事由"菜单
function absentToLeave(studentId) {
  const stu = students.find((s) => s.id === studentId);
  menuStudentId = studentId;
  contextMode = 'reason';
  el.contextTitle.textContent = (stu ? stu.name : '学生') + ' · 选择请假事由';
  el.contextAbsentPresent.classList.add('hidden');
  el.contextAbsentLeave.classList.add('hidden');
  el.contextCancelCheckin.classList.add('hidden');
  el.contextRemark.classList.add('hidden');
  el.contextClear.classList.add('hidden');
  document.querySelectorAll('#contextMenu [data-reason]').forEach((item) => item.classList.remove('hidden'));
}

// 取消签到（恢复待签）
async function cancelCheckin(studentId) {
  closeContextMenu();
  if (!studentId) return;
  // 每天自动签到（v35）：语义是"标缺勤"（本地草稿），点卡片也能切换
  if (autoMode()) {
    const stu = students.find((s) => s.id === studentId);
    setAutoDraft(studentId, 'absent', null);
    showToast(`${stu ? stu.name : '该学生'} 已标记为缺勤（点「保存本场」生效）`);
    return;
  }
  try {
    const data = await apiFetch(API.checkin, {
      method: 'POST',
      body: JSON.stringify(withClassId({ studentId, action: 'cancel', sessionId: current && current.session ? current.session.id : undefined })),
    });
    dbg('[取消签到]', data);
    applyRecordLocal(studentId, null);
    await refreshStatus();
    const stu = students.find((s) => s.id === studentId);
    showToast(`${stu ? stu.name : '该学生'} 已取消签到`);
  } catch (err) {
    showToast(err.message);
    await refreshStatus();
  }
}

// 备注（记录到操作日志）
async function remarkStudent(studentId) {
  closeContextMenu();
  if (!studentId) return;
  const stu = students.find((s) => s.id === studentId);
  const remark = window.prompt(`为 ${stu ? stu.name : '该学生'} 添加备注：`, '');
  if (remark === null) return; // 取消
  if (!remark.trim()) { showToast('备注不能为空'); return; }
  try {
    await apiFetch('/api/attendance/remark', {
      method: 'POST',
      body: JSON.stringify({ studentId, remark: remark.trim() }),
    });
    showToast('备注已记录');
  } catch (err) {
    showToast(err.message);
  }
}

// 菜单项点击（事件委托到菜单本身）
el.contextMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.context-item');
  if (!item) return;
  const sid = menuStudentId;
  if (item.id === 'contextClear') {
    closeContextMenu();
    if (sid) clearStudentSeat(sid);
    return;
  }
  if (item.id === 'contextCancelCheckin') {
    cancelCheckin(sid);
    return;
  }
  if (item.id === 'contextRemark') {
    remarkStudent(sid);
    return;
  }
  if (item.id === 'contextAbsentPresent') {
    absentToPresent(sid);
    return;
  }
  if (item.id === 'contextAbsentLeave') {
    absentToLeave(sid);
    return;
  }
  if (item.dataset.reason) {
    selectLeaveReason(item.dataset.reason);
  } else {
    closeContextMenu(); // “取消”项
  }
});

// 点击其他区域 / 右键其他区域 / 滚动 / 缩放 / Esc → 关闭菜单
document.addEventListener('click', () => {
  if (suppressNextClick) { suppressNextClick = false; return; }
  closeContextMenu();
});
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.student-card')) closeContextMenu();
});
document.addEventListener('scroll', () => closeContextMenu(), true);
window.addEventListener('resize', () => closeContextMenu());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeContextMenu();
});

// ---------- 时间格式化 ----------
function fmtTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 时:分（签到操作台场次时间显示用，与计划管理口径一致）
function fmtTimeHM(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtCountdown(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}时${m}分${sec}秒`;
  if (m > 0) return `${m}分${sec}秒`;
  return `${sec}秒`;
}

// ============================================================
// 作业统计（班长端：作业列表 + 录入提交情况）
//  - 默认显示【今天】的作业；可按 今天 / 昨天 / 本周 / 自定义 快速切换日期
//  - 学科筛选 + 长列表：学科 / 标题 / 发布老师 / 截止时间 / 已交-未交 / 收作业状态
//  - 收作业状态：已录入提交情况 = 已收，未录入 = 待收
//  - 录入：座位表模式（点击卡片切换、按列全选、保存）
// 教师/班主任/管理员 视图在独立页面（/homework-manage 发布、/homework 统计）
// ============================================================
const HW = {
  inited: false,
  subject: '',
  date: '',
  from: '',
  to: '',
  rangeMode: 'today',   // 'today' | 'yesterday' | 'week' | 'custom'
  tasks: [],
  daily: null,          // 最近一次"每日作业生成"的返回（subjects/createdCount，便于排查）
  stats: { taskCount: 0, submittedCount: 0, notSubmittedCount: 0 },
  entry: {
    task: null,
    students: [],
    base: {},           // 已保存状态 studentId -> bool
    pending: {},        // 未保存修改
    cols: 4,            // 按列批量的列数（来自班级座位布局）
  },
};

function hwPad(n) { return String(n).padStart(2, '0'); }
function hwTodayStr() { const d = new Date(); return `${d.getFullYear()}-${hwPad(d.getMonth() + 1)}-${hwPad(d.getDate())}`; }
function hwDirty() { return Object.keys(HW.entry.pending).length > 0; }
function escHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// 当前账号是否管理员（计划管理里的"删除已结束签到"仅管理员可见）
function isAdminUser() {
  if (!currentUser) return false;
  if (currentUser.role === 'admin') return true;
  return Array.isArray(currentUser.roles) && currentUser.roles.includes('admin');
}

// 录入界面：当前生效状态（未保存修改优先）
//   每日作业（isDaily）默认"全部已交"——需求：已交学生默认勾选，取消勾选即为未交；
//   老师发布的具体作业保持原口径（默认未交，逐一点选已交）
function hwEntryState(studentId) {
  if (Object.prototype.hasOwnProperty.call(HW.entry.pending, studentId)) return HW.entry.pending[studentId];
  if (Object.prototype.hasOwnProperty.call(HW.entry.base, studentId)) return !!HW.entry.base[studentId];
  return HW.entry.defaultSubmitted === true;
}

// ---------- 进入作业统计（班长端） ----------
function enterHomeworkView() {
  if (!currentUser) return;
  if (!HW.inited) {
    HW.inited = true;
    // 默认显示【今天】的作业；可用学科/日期（今天/昨天/本周/自定义）进一步筛选
    HW.subject = el.hwSubject.value || '';
    setHwRange('today', { reload: false });
  }
  showHwListView();
  loadHomeworkTasks();
}

// 日期快速切换：today | yesterday | week | custom
function setHwRange(mode, { reload = true } = {}) {
  HW.rangeMode = mode;
  const today = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const isCustom = mode === 'custom';
  // 按钮高亮
  el.hwQuick.querySelectorAll('.hw-quick-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.range === mode);
  });
  // 单日 / 范围 控件显隐
  el.hwDateWrap.classList.toggle('hidden', mode === 'week' || isCustom);
  el.hwRangeWrap.classList.toggle('hidden', !(mode === 'week' || isCustom));
  el.hwApplyRange.classList.toggle('hidden', !isCustom);

  if (mode === 'today' || mode === 'yesterday') {
    const d = new Date(today);
    if (mode === 'yesterday') d.setDate(d.getDate() - 1);
    HW.date = fmt(d);
    HW.from = '';
    HW.to = '';
    el.hwDate.value = HW.date;
  } else if (mode === 'week') {
    const d = new Date(today);
    const dow = (d.getDay() + 6) % 7; // 周一为一周开始
    const mon = new Date(d); mon.setDate(d.getDate() - dow);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    HW.date = '';
    HW.from = fmt(mon);
    HW.to = fmt(sun);
    el.hwFrom.value = HW.from;
    el.hwTo.value = HW.to;
  } else {
    // 自定义：保留已填内容；未填则默认本月
    HW.date = '';
    if (!el.hwFrom.value || !el.hwTo.value) {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      el.hwFrom.value = fmt(first);
      el.hwTo.value = fmt(today);
    }
    HW.from = el.hwFrom.value;
    HW.to = el.hwTo.value;
  }
  renderHwScopeLabel();
  if (reload) loadHomeworkTasks();
}

function renderHwScopeLabel() {
  const mode = HW.rangeMode;
  if (mode === 'today') el.hwScopeLabel.textContent = `[今天 ${HW.date}] `;
  else if (mode === 'yesterday') el.hwScopeLabel.textContent = `[昨天 ${HW.date}] `;
  else if (mode === 'week') el.hwScopeLabel.textContent = `[本周 ${HW.from} ~ ${HW.to}] `;
  else el.hwScopeLabel.textContent = `[自定义 ${HW.from || '…'} ~ ${HW.to || '…'}] `;
}

function showHwListView() {
  el.hwListView.classList.remove('hidden');
  el.hwEntryView.classList.add('hidden');
}

function showHwEntryView() {
  el.hwListView.classList.add('hidden');
  el.hwEntryView.classList.remove('hidden');
}

// ---------- 作业列表（默认今天；按截止时间排序） ----------
async function loadHomeworkTasks() {
  HW.subject = el.hwSubject.value || '';
  const cols = 8;
  el.hwTaskList.innerHTML = `<tr><td colspan="${cols}" class="plan-empty">加载中…</td></tr>`;
  el.hwTaskEmpty.classList.add('hidden');
  const writable = isHwWritable();
  el.hwReadonlyTip.classList.toggle('hidden', writable);
  try {
    // 每日固定科目作业：进入"今天"视图时自动生成当天各科条目（班长无需老师先发布；
    // 幂等，后端只在缺条目时新增）——失败不阻塞列表展示
    if (HW.rangeMode === 'today') {
      try {
        HW.daily = await apiFetch(API.hwDailyEnsure, { method: 'POST', body: JSON.stringify({}) });
      } catch (_) { HW.daily = null; }
    }
    const params = new URLSearchParams();
    if (HW.date) params.set('date', HW.date);
    else {
      if (HW.from) params.set('from', HW.from);
      if (HW.to) params.set('to', HW.to);
    }
    if (HW.subject) params.set('subject', HW.subject);
    const q = params.toString() ? '?' + params.toString() : '';
    const data = await apiFetch(API.hwTasks + q);
    HW.tasks = data.tasks || [];
    HW.stats = data.stats || { taskCount: 0, submittedCount: 0, notSubmittedCount: 0 };
    el.hwTaskCount.textContent = HW.stats.taskCount;
    el.hwSubmitted.textContent = HW.stats.submittedCount;
    el.hwNotSubmitted.textContent = HW.stats.notSubmittedCount;
    renderHwScopeLabel();
    renderHwTaskList();
  } catch (err) {
    el.hwTaskList.innerHTML = `<tr><td colspan="${cols}" class="plan-empty">作业加载失败：${escHtml(err.message)}</td></tr>`;
  }
}

function isHwWritable() {
  return !!(currentUser && currentUser.role === 'monitor');
}

// 状态：按截止时间
function hwTaskStatus(deadlineIso) {
  if (!deadlineIso) return { cls: 'future', text: '—' };
  const d = new Date(deadlineIso).getTime();
  return d > Date.now() ? { cls: 'doing', text: '进行中' } : { cls: 'done', text: '已截止' };
}

function renderHwTaskList() {
  if (HW.tasks.length === 0) {
    el.hwTaskList.innerHTML = '';
    el.hwTaskEmpty.classList.remove('hidden');
    el.hwTaskEmpty.textContent = HW.rangeMode === 'today'
      ? '今天暂无作业（可切换日期查看历史作业；作业由任课老师在「作业管理」中发布）'
      : '所选日期范围内暂无作业（作业由任课老师在「作业管理」中发布）';
    return;
  }
  el.hwTaskEmpty.classList.add('hidden');
  const writable = isHwWritable();     // 只有班长可录入；老师/管理员看只读列表
  el.hwTaskList.innerHTML = HW.tasks.map((t) => {
    const st = hwTaskStatus(t.deadline);
    // 收作业状态：已录入提交情况 = 已收，否则待收
    const collect = t.recorded
      ? '<span class="hw-status-tag done">已收</span>'
      : '<span class="hw-status-tag doing">待收</span>';
    return `
      <tr>
        <td>${escHtml(t.subject)}${t.isDaily ? '<span class="hw-admin-tag hw-daily-tag">每日作业</span>' : ''}</td>
        <td><b>${escHtml(t.title)}</b></td>
        <td>${escHtml(t.teacherName || (t.isDaily ? '系统' : '—'))}</td>
        <td style="white-space:nowrap">${escHtml(t.deadlineText || '')} <span class="hw-status-tag ${st.cls}" style="font-size:11px;padding:1px 6px">${st.text}</span></td>
        <td><b>${t.submitted}</b> / ${t.total - t.submitted}</td>
        <td>${collect}</td>
        <td class="td-actions">
          ${writable
            ? `<button type="button" class="btn btn-primary btn-sm hw-entry" data-id="${t.id}">${t.recorded ? '修改' : '录入'}</button>`
            : `<span class="hw-status-tag" style="font-size:11px;padding:1px 6px">👀 只读</span>`}
        </td>
      </tr>`;
  }).join('');
}

// 列表操作（事件委托）：仅"录入"（非班长点不到按钮；这里再兜一层，避免误触后才发现没权限）
el.hwTaskList.addEventListener('click', (e) => {
  const entryBtn = e.target.closest('.hw-entry');
  if (entryBtn) {
    if (!isHwWritable()) { showToast('只读：作业提交情况由班长录入'); return; }
    openHwEntry(Number(entryBtn.dataset.id));
  }
});

// ---------- 录入提交情况（座位表模式） ----------
async function openHwEntry(taskId) {
  try {
    const data = await apiFetch(API.hwTasks + '/' + taskId);
    const t = data.task;
    HW.entry.task = t;
    HW.entry.students = data.students || [];
    HW.entry.base = data.submissions || {};
    HW.entry.pending = {};
    // 每日作业：默认全部已交（班长只取消"未交"的那几个人）
    HW.entry.defaultSubmitted = t.isDaily === true;
    // 座位布局：与签到座位表一致（班级 seat_config）；无配置则按人数自适应
    const cfg = data.seatConfig || {};
    const cols = Number(cfg.cols) >= 4 && Number(cfg.cols) <= 10 ? Number(cfg.cols) : 4;
    let rows = Number(cfg.rows) >= 4 && Number(cfg.rows) <= 10 ? Number(cfg.rows) : 0;
    if (!rows) rows = Math.min(10, Math.max(4, Math.ceil(HW.entry.students.length / cols)));
    const mode = SEAT_MODES.includes(cfg.mode) ? cfg.mode : '标准';
    HW.entry.cfg = { rows, cols, mode };
    hwArrangeEntryStudents(); // 无已排座数据时按学号内存排布（仅本界面）
    // 顶部显示：学科 + 作业标题 + 截止时间（发布老师）
    el.hwEntryTitle.textContent =
      `${t.subject} · ${t.title} · 截止 ${t.deadlineText || '—'}` +
      (t.teacherName ? ` · 发布老师 ${t.teacherName}` : '') +
      (t.isDaily ? ' · 已交默认勾选，取消勾选即为未交' : '');
    showHwEntryView();
    renderHwEntry();
  } catch (err) {
    showToast('打开录入失败：' + err.message);
  }
}

// 未排座学生按学号自动排布（仅录入界面内存，不影响签到座位表）
function hwArrangeEntryStudents() {
  const students = HW.entry.students;
  const anySeated = students.some((s) => s.seatRow > 0 && s.seatCol > 0);
  if (anySeated) return;
  const cfg = HW.entry.cfg;
  const sorted = [...students].sort((a, b) => String(a.studentNo).localeCompare(String(b.studentNo), { numeric: true }));
  cfg.rows = Math.min(10, Math.max(4, Math.ceil(sorted.length / cfg.cols)));
  let idx = 0;
  for (const s of sorted) {
    const inRow = idx % cfg.cols;
    s.seatRow = Math.floor(idx / cfg.cols) + 1;
    s.seatCol = cfg.mode === '右对齐' ? cfg.cols - inRow : inRow + 1;
    idx += 1;
  }
}

function hwBuildSeatCard(stu, displayCol) {
  const done = hwEntryState(stu.id);
  const card = document.createElement('div');
  card.className = 'student-card seat-card hw-card ' + (done ? 'done' : 'undone');
  card.dataset.studentId = stu.id;
  card.title = done ? `${stu.name}：已交（点击改为未交）` : `${stu.name}：未交（点击标记已交）`;

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = done ? '已交' : '未交';

  const name = document.createElement('span');
  name.className = 'name ' + nameSizeClass(stu.name);
  name.textContent = stu.name;

  const no = document.createElement('span');
  no.className = 'no';
  no.textContent = stu.studentNo;

  const pos = document.createElement('span');
  pos.className = 'seat-pos';
  pos.textContent = `${stu.seatRow}排${displayCol || stu.seatCol}座`;

  card.append(badge, name, no, pos);
  return card;
}

// 渲染座位矩阵（与签到座位表同款布局算法）
function renderHwSeatGrid() {
  const grid = el.hwSeatGrid;
  const cfg = HW.entry.cfg;
  const pCols = physicalColCount(cfg);
  applySeatSizing(grid, pCols);
  grid.innerHTML = '';

  const placed = new Map();
  let maxRow = 0;
  for (const s of HW.entry.students) {
    if (s.seatRow > 0 && s.seatCol > 0) {
      const pc = logicalToPhysical(s.seatCol, cfg);
      if (pc < 1 || pc > pCols) continue;
      placed.set(s.seatRow + '|' + pc, s);
      if (s.seatRow > maxRow) maxRow = s.seatRow;
    }
  }
  const renderRows = Math.max(cfg.rows, maxRow);
  for (let r = 1; r <= renderRows; r++) {
    for (let pc = 1; pc <= pCols; pc++) {
      const cell = document.createElement('div');
      cell.style.gridRowStart = r;
      cell.style.gridColumnStart = pc;
      const stu = placed.get(r + '|' + pc);
      if (stu) {
        cell.className = 'seat-cell';
        cell.appendChild(hwBuildSeatCard(stu, pc));
      } else {
        cell.className = 'seat-cell seat-empty';
      }
      grid.appendChild(cell);
    }
  }
}

// 未排座学生：底部可点击标签（同样能切换状态）
function renderHwUnseated() {
  const unseated = HW.entry.students.filter((s) => !(s.seatRow > 0 && s.seatCol > 0));
  el.hwUnseatedPanel.classList.toggle('hidden', unseated.length === 0);
  el.hwUnseatedList.innerHTML = '';
  for (const s of unseated) {
    const chip = document.createElement('span');
    const done = hwEntryState(s.id);
    chip.className = 'unseated-chip hw-unseated-chip ' + (done ? 'done' : 'undone');
    chip.dataset.studentId = s.id;
    chip.textContent = `${done ? '✅' : '⬜'} ${s.studentNo} ${s.name}`;
    chip.title = '点击切换已交/未交';
    el.hwUnseatedList.appendChild(chip);
  }
}

function renderHwEntry() {
  const students = HW.entry.students;
  let submitted = 0;
  for (const s of students) if (hwEntryState(s.id)) submitted += 1;
  el.hwEntrySubmitted.textContent = submitted;
  el.hwEntryNotSubmitted.textContent = students.length - submitted;
  el.hwDirty.classList.toggle('hidden', !hwDirty());
  el.hwEntryStats.innerHTML =
    `<span class="ss-total">总人数 <b>${students.length}</b></span>` +
    `<span class="ss-present">已交 <b>${submitted}</b></span>` +
    `<span class="ss-absent">未交 <b>${students.length - submitted}</b></span>`;

  renderHwSeatGrid();
  renderHwUnseated();
  renderHwColButtons();
}

// 按列批量按钮（列数与座位表一致；点"第X列全选"→ 该列学生标记已交）
function renderHwColButtons() {
  el.hwColButtons.innerHTML = '';
  for (let c = 1; c <= HW.entry.cfg.cols; c++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hw-col-btn';
    btn.textContent = `第 ${c} 列全选`;
    btn.title = `将第 ${c} 列（座位表列）学生标记为已交`;
    btn.addEventListener('click', () => {
      let n = 0;
      for (const s of HW.entry.students) {
        if (s.seatCol === c && s.seatRow > 0) { HW.entry.pending[s.id] = true; n += 1; }
      }
      if (n === 0) { showToast(`第 ${c} 列暂无已排座学生`); return; }
      showToast(`第 ${c} 列 ${n} 人已标记为已交（点"保存"落库）`);
      renderHwEntry();
    });
    el.hwColButtons.appendChild(btn);
  }
}

// 点击卡片 / 未排座标签 → 切换 已交 ↔ 未交
function hwToggleStudent(studentId) {
  const stu = HW.entry.students.find((s) => s.id === studentId);
  if (!stu) return;
  const next = !hwEntryState(studentId);
  HW.entry.pending[studentId] = next;
  showToast(`${stu.name}：${next ? '已交' : '未交'}（点"保存"落库）`);
  renderHwEntry();
}

el.hwSeatGrid.addEventListener('click', (e) => {
  const card = e.target.closest('.hw-card');
  if (!card) return;
  hwToggleStudent(Number(card.dataset.studentId));
});
el.hwUnseatedList.addEventListener('click', (e) => {
  const chip = e.target.closest('.hw-unseated-chip');
  if (!chip) return;
  hwToggleStudent(Number(chip.dataset.studentId));
});

// 全选已交
el.hwEntryAll.addEventListener('click', () => {
  for (const s of HW.entry.students) HW.entry.pending[s.id] = true;
  showToast(`已标记全部 ${HW.entry.students.length} 人为已交（点"保存"落库）`);
  renderHwEntry();
});

// 返回列表（有未保存修改先确认）
el.hwBackList.addEventListener('click', () => {
  if (hwDirty()) {
    openConfirm('放弃未保存的修改？', '提交情况有未保存的修改（未点"保存"）。返回列表将丢弃这些修改。', () => {
      HW.entry.pending = {};
      showHwListView();
      loadHomeworkTasks();
    });
    return;
  }
  showHwListView();
  loadHomeworkTasks();
});

// 保存提交情况
el.hwEntrySave.addEventListener('click', async () => {
  const task = HW.entry.task;
  if (!task) return;
  const updates = [];
  if (HW.entry.defaultSubmitted) {
    // 每日作业：默认"全部已交" → 必须把**全班每个人的最终状态**都存下来，
    //   否则未改动的人没有记录，列表里的"已交/总数"会算错（需求：取消勾选=未交）
    for (const s of HW.entry.students) {
      const val = hwEntryState(s.id);
      if (val !== HW.entry.base[s.id]) updates.push({ studentId: s.id, isSubmitted: val });
    }
  } else {
    for (const idStr of Object.keys(HW.entry.pending)) {
      const id = Number(idStr);
      const val = HW.entry.pending[id];
      if (val !== !!HW.entry.base[id]) updates.push({ studentId: id, isSubmitted: val });
    }
  }
  if (updates.length === 0) {
    HW.entry.pending = {};
    renderHwEntry();
    showToast('没有需要保存的修改');
    return;
  }
  el.hwEntrySave.disabled = true;
  try {
    const data = await apiFetch(API.hwBatch, {
      method: 'POST',
      body: JSON.stringify({ taskId: task.id, updates }),
    });
    showToast(`已保存 ${data.updated} 条提交记录`);
    HW.entry.pending = {};
    // 重新拉取详情，保持与数据库一致
    await openHwEntry(task.id);
  } catch (err) {
    showToast('保存失败：' + err.message, 3200);
  } finally {
    el.hwEntrySave.disabled = false;
  }
});

// 学科切换
el.hwSubject.addEventListener('change', () => { loadHomeworkTasks(); });

// 日期快速切换：今天 / 昨天 / 本周 / 自定义
el.hwQuick.addEventListener('click', (e) => {
  const btn = e.target.closest('.hw-quick-btn');
  if (!btn) return;
  setHwRange(btn.dataset.range);
});

// 单日选择（今天/昨天模式下也可手选其他日期 → 视为单日筛选）
el.hwDate.addEventListener('change', () => {
  HW.date = el.hwDate.value || '';
  HW.from = '';
  HW.to = '';
  if (HW.date) {
    const pad2 = (n) => String(n).padStart(2, '0');
    const t = new Date();
    const today = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
    const y = new Date(t); y.setDate(y.getDate() - 1);
    const yesterday = `${y.getFullYear()}-${pad2(y.getMonth() + 1)}-${pad2(y.getDate())}`;
    HW.rangeMode = HW.date === today ? 'today' : (HW.date === yesterday ? 'yesterday' : 'custom');
    el.hwQuick.querySelectorAll('.hw-quick-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.range === HW.rangeMode);
    });
  }
  loadHomeworkTasks();
});

// 自定义范围查询
el.hwApplyRange.addEventListener('click', () => {
  if (!el.hwFrom.value || !el.hwTo.value) { showToast('请选择开始与结束日期'); return; }
  if (el.hwFrom.value > el.hwTo.value) { showToast('开始日期不能晚于结束日期'); return; }
  HW.from = el.hwFrom.value;
  HW.to = el.hwTo.value;
  HW.date = '';
  loadHomeworkTasks();
});


// ============================================================
// 📢 叫号系统（班长端：接收 / 语音播报 / 标记已处理）
//   教师发布 → 班长端顶部"叫号"按钮出现未读角标，每 30 秒自动刷新
//   未播报的叫号自动语音播报：请[班级][学生姓名]到[地点]
//   权限由后端强制校验（班长只能看/处理本班叫号）
// ============================================================
const ANN_POLL_MS = 30000;   // 自动刷新间隔
let annTimer = null;         // 轮询定时器
let annData = null;          // 最近一次收件箱数据
let annLoading = false;
let annPollCount = 0;        // 轮询次数（测试钩子：验证 30 秒自动刷新在运行）
let annPageVisible = true;   // 弹窗是否打开（打开时不重复播报，只刷新列表）

function annEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function annFmtTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 语音播报文本：请[班级][学生姓名]到[地点]
function annSpeechText(a) {
  const cls = a.className || '本班';
  const name = a.studentName || '同学';
  const loc = a.location || '';
  return `请${cls}${name}到${loc}`;
}

function annSpeak(a) {
  const text = annSpeechText(a);
  window.__lastSpoken = text;   // 测试钩子：无声音环境也能断言播报内容
  try {
    if (typeof window.speechSynthesis === 'undefined') return false;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 1;      // 正常语速
    u.volume = 1;    // 最大音量
    u.pitch = 1;
    window.__lastSpokenOpts = { lang: u.lang, rate: u.rate, volume: u.volume };  // 测试钩子
    window.speechSynthesis.speak(u);
    return true;
  } catch (_) { return false; }
}

// 播报未播报过的叫号，并在后端标记 is_played（避免刷新后重复播报）
async function annSpeakUnplayed(list) {
  const pending = (list || []).filter((a) => !a.isPlayed);
  if (pending.length === 0) return 0;
  // 紧急优先，其余按发布时间正序（先发的先播）
  pending.sort((x, y) => {
    const ux = x.priority === 'urgent' ? 0 : 1;
    const uy = y.priority === 'urgent' ? 0 : 1;
    if (ux !== uy) return ux - uy;
    return new Date(x.createdAt) - new Date(y.createdAt);
  });
  for (const a of pending) {
    annSpeak(a);
    try { await apiFetch(`/api/announcements/${a.id}/played`, { method: 'POST' }); } catch (_) {}
    a.isPlayed = true;
  }
  return pending.length;
}

function annUpdateBadge(count) {
  // 角标由 navbar.js 统一渲染（全站一致），这里只把数据传过去
  if (window.DSHNavbar && window.DSHNavbar.setAnnBadge) { window.DSHNavbar.setAnnBadge(count); return; }
  if (!el.annBadge) return;
  const n = Number(count) || 0;
  el.annBadge.textContent = n > 99 ? '99+' : String(n);
  el.annBadge.classList.toggle('hidden', n === 0);
}

// 拉取本班叫号（班长端）
//   2026-09-30 架构修复：**播报已改为全局**（navbar.js 在每个页面轮询并播报）→
//   本页只负责"手动查看"（弹窗列表），不再自己起轮询、也不重复播报。
//   数据来源：优先复用 navbar.js 的全局结果（window.DSHNavbar.announcements），拿不到才自己拉一次（且 speak:false）
async function annFetch({ speak = true, fresh = false } = {}) {
  if (annLoading) return;
  annLoading = true;
  try {
    const globalAnn = window.DSHNavbar && window.DSHNavbar.announcements;
    // 优先复用全局（navbar.js）的快照；fresh=true 时（手动改过数据）强制重新拉取
    let data = (!fresh && globalAnn && globalAnn.data) ? globalAnn.data : null;
    if (!data) data = await apiFetch('/api/announcements/inbox');
    annData = data;
    annPollCount += 1;
    annUpdateBadge(data.pendingCount);
    // 兜底：若全局组件不可用（极老缓存页面），这里仍会播报一次；正常情况下全局已标记 is_played → 不会重复
    if (speak && !globalAnn) {
      const n = await annSpeakUnplayed(data.unplayed);
      if (n > 0) dbg('[叫号] 已播报', n, '条');
    }
    if (annPageVisible) annRenderList();
  } catch (e) {
    dbg('[叫号] 拉取失败：', e.message);
  } finally {
    annLoading = false;
  }
}

function startAnnouncementPolling() {
  // 播报由 navbar.js 全局负责；本页只在打开弹窗时刷新列表（并复用全局数据）
  if (annTimer) return;
  annFetch({ speak: false });
  annTimer = setInterval(() => { annFetch({ speak: false }); }, ANN_POLL_MS);
}

function annRenderList() {
  if (!el.annList) return;
  const list = (annData && annData.announcements) || [];
  if (el.annClassTag) el.annClassTag.textContent = (annData && annData.className) || '';
  if (list.length === 0) {
    el.annList.innerHTML = '<div class="ann-empty">暂无叫号通知</div>';
    return;
  }
  el.annList.innerHTML = list.map((a) => {
    const urgent = a.priority === 'urgent';
    const done = a.status === 'processed';
    return `<div class="ann-item${urgent ? ' urgent' : ''}${done ? ' done' : ''}" data-id="${a.id}">
      <div class="ann-item-main">
        <div class="ann-item-title">
          ${urgent ? '<span class="ann-chip urgent">⚡ 紧急</span>' : ''}
          <b>${annEsc(a.studentName || '')}</b>
          <span class="ann-arrow">→</span>
          <span class="ann-loc">${annEsc(a.location || '')}</span>
        </div>
        <div class="ann-item-meta">
          何时：${annEsc(a.scheduledText || '—')}　|　发布：${annEsc(a.teacherName || '老师')} ${annFmtTime(a.createdAt)}
          ${a.note ? `<br>备注：${annEsc(a.note)}` : ''}
        </div>
      </div>
      <div class="ann-item-ops">
        <button class="btn btn-secondary btn-sm" data-act="speak" data-id="${a.id}" title="语音播报这条叫号">🔊 播报</button>
        ${done
          ? '<span class="ann-chip processed">✅ 已处理</span>'
          : `<button class="btn btn-primary btn-sm" data-act="process" data-id="${a.id}">已处理</button>`}
      </div>
    </div>`;
  }).join('');
}

function openAnnModal() {
  if (!el.annModal) return;
  el.annModal.classList.remove('hidden');
  annPageVisible = true;
  annRenderList();
  annFetch({ speak: false });
}
function closeAnnModal() {
  if (el.annModal) el.annModal.classList.add('hidden');
  annPageVisible = false;
}

// 「叫号提醒」菜单项由 navbar.js 派发 navbar:item 事件（见上），这里不再重复绑定
if (el.annClose) el.annClose.addEventListener('click', closeAnnModal);
if (el.annModal) el.annModal.addEventListener('click', (e) => { if (e.target === el.annModal) closeAnnModal(); });
if (el.annSpeakAll) {
  el.annSpeakAll.addEventListener('click', async () => {
    const list = ((annData && annData.announcements) || []).filter((a) => a.status === 'pending');
    if (list.length === 0) { showToast('暂无待处理叫号'); return; }
    // 手动重播：不管 is_played，直接重播
    for (const a of list) annSpeak(a);
    showToast(`已重新播报 ${list.length} 条叫号`);
  });
}
if (el.annList) {
  el.annList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const item = ((annData && annData.announcements) || []).find((a) => a.id === id);
    if (btn.dataset.act === 'speak') {
      if (item) { annSpeak(item); showToast('正在播报…'); }
      return;
    }
    // 标记已处理
    btn.disabled = true;
    try {
      await apiFetch(`/api/announcements/${id}/process`, { method: 'POST' });
      showToast('已标记为已处理');
      // 手动操作后必须**强制拉新**：全局快照（navbar 每 30 秒更新）此刻还是旧的
      if (window.DSHNavbar && window.DSHNavbar.announcements) await window.DSHNavbar.announcements.refresh();
      await annFetch({ speak: false, fresh: true });
    } catch (err) {
      btn.disabled = false;
      showToast(err.message, 3200);
    }
  });
}
window.addEventListener('beforeunload', () => { if (annTimer) clearInterval(annTimer); });
// 测试钩子（无头驱动使用）
window.__ann = {
  fetch: () => annFetch({ speak: false }),
  speakAll: () => annSpeakUnplayed((annData && annData.unplayed) || []),
  speakText: annSpeechText,
  state: () => annData,
  pollCount: () => annPollCount,
  intervalMs: ANN_POLL_MS,
  refreshMs: () => (annTimer ? ANN_POLL_MS : 0),
};

// ---------- 初始化 ----------
el.btnStart.addEventListener('click', onStartClick);
// 每天自动签到（v35）：保存本场 / 离开页面提醒
if (el.autoSave) el.autoSave.addEventListener('click', saveAutoSession);
window.addEventListener('beforeunload', (e) => {
  if (AUTO.dirty) { e.preventDefault(); e.returnValue = ''; }
});

(async function init() {
  dbg('页面初始化开始，版本', APP_VERSION);
  // 版本号由 navbar.js 渲染在导航栏（全站同一份），这里只打印日志
  await loadCurrentUser();
  // 教师未确认教学设置（profile_locked = false）→ 强制跳转个人中心「教学设置」
  if (currentUser && currentUser.role === 'teacher' && currentUser.profileLocked === false) {
    dbg('[教学设置未确认] 跳转个人中心教学设置');
    window.location.href = '/profile?setup=1';
    return;
  }
  updateClock();
  setInterval(updateClock, 1000);
  bindSeatEvents();
  await loadSeatConfig();
  await loadClasses();
  await loadStudents();
  dbg('学生加载完成，共', students.length, '人');
  await loadPlans();
  await refreshStatus();
  // 视图（需求 2026-09-30）：签到操作台**只有座位表模式**（所有角色一致）
  //   列表模式的切换按钮已移除；列表视图 DOM 仍渲染但隐藏（兼容既有断言/兜底）
  switchCardView('seat');
  // 支持导航栏直达/刷新保持：?view=plans 或 /plans（计划管理）、?ann=1（叫号提醒，班长端）、
  //   ?view=homework（班长端作业录入台 —— 按钮已移除，保留 URL 直达，避免功能丢失）
  //   刷新时按 URL 加载对应视图 —— 只有 URL 是唯一真源，刷新才不会改变所在页面
  try {
    const qp = new URLSearchParams(window.location.search);
    if (viewFromUrl() === 'plans') switchView('plans');
    if (qp.get('view') === 'homework' && currentUser && currentUser.role === 'monitor') {
      switchCardView('homework');
    }
    if (qp.get('ann') === '1' && currentUser && currentUser.role === 'monitor') {
      openAnnModal();
      // 弹窗已打开：把 ann=1 从地址栏去掉（否则每次刷新都会再弹一次）
      syncViewUrl(viewFromUrl(), false);
    }
  } catch (_) {}
  // 首次登录强制修改密码（班长默认密码 123456）
  if (currentUser && currentUser.mustChangePassword) {
    showPwdModal();
    showToast('首次登录，请先修改密码', 4000);
  }
  // 每 3 秒轮询状态，每 10 秒轮询计划（自动触发会改变计划状态）
  setInterval(() => refreshStatus(false), 3000);
  setInterval(() => loadPlans(), 10000);
  dbg('初始化完成，轮询已启动');
})();
