// ============================================================
// 独立补签页（/attendance/makeup）
// 从"计划管理"补签按钮或签到台已结束场次补签入口进入
// 入口参数：
//   sessionId  可选：要补签的签到场次（无场次时也可只传 planId）
//   planId     可选：所属计划（用于展示计划日期/时间/班级，并反查场次）
//   from       plans | attendance：决定返回目标（默认 plans）
// 说明：已结束计划可能因服务器离线等原因从未生成签到场次（session_id 为空）。
//       此时页面仍列出学生供补签，点击"确认补签"时后端会按计划时间自动补录场次。
// ============================================================
const STATUS_LABEL = { present: '已签到', late: '迟到', leave: '请假', absent: '缺勤' };

const $ = (id) => document.getElementById(id);
const el = {
  userInfo: $('userInfo'),
  btnUser: $('btnUser'),
  userDropdown: $('userDropdown'),
  menuProfile: $('menuProfile'),
  menuLogout: $('menuLogout'),
  btnBack: $('btnBack'),
  planInfo: $('planInfo'),
  piDate: $('piDate'),
  piTime: $('piTime'),
  piClass: $('piClass'),
  piSession: $('piSession'),
  stTotal: $('stTotal'),
  stCan: $('stCan'),
  stPick: $('stPick'),
  selectAll: $('selectAll'),
  searchBox: $('searchBox'),
  mkScroll: $('mkScroll'),
  mkLoading: $('mkLoading'),
  btnSubmit: $('btnSubmit'),
  toast: $('toast'),
};

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('未登录，请重新登录');
  }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    throw new Error((data && data.error) ? data.error : `请求失败（${res.status}）`);
  }
  return data;
}

let toastTimer = null;
function showToast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), ms);
}

// ---------- 页面状态 ----------
const query = new URLSearchParams(location.search);
const sessionParam = Number(query.get('sessionId'));
let sessionId = Number.isInteger(sessionParam) && sessionParam > 0 ? sessionParam : null;
const planId = Number(query.get('planId')) || null;
const from = query.get('from') === 'attendance' ? 'attendance' : 'plans';

let me = null;                 // 当前用户 { role, classId, ... }
let plan = null;               // 计划信息（可能为 null = 手动场次）
let missingSession = false;    // 已结束计划但从未生成签到场次（提交时后端自动补录）
let sessionInfo = null;        // { id, startTime, deadline, status }
let classScopeId = null;       // 本次补签的学生班级范围（null = 全部班级）
let className = null;          // 范围班级名（null = 全部班级）
let students = [];             // 在读学生（按学号升序，后端排序）
let recordMap = {};            // studentId -> { status, ... }
let selectableIds = new Set(); // 可补签（未签/缺勤）的学生 id

function fmtDateCN(isoStr) {
  const d = isoStr ? new Date(isoStr) : null;
  if (!d || isNaN(d.getTime())) return '--';
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${wd[d.getDay()]}）`;
}
function fmtTimeHM(str) {
  if (!str) return '--';
  if (typeof str === 'string' && /^\d{2}:\d{2}/.test(str)) return str.slice(0, 5);
  const d = new Date(str);
  if (isNaN(d.getTime())) return '--';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 学生当前状态：'none' 未签 | 'signed' 已签(含迟到) | 'leave' 请假 | 'absent' 缺勤
function statusOf(stu) {
  const rec = recordMap[stu.id];
  if (!rec) return 'none';
  if (rec.status === 'present' || rec.status === 'late') return 'signed';
  return rec.status === 'absent' ? 'absent' : 'leave';
}

// ---------- 数据加载 ----------
async function loadPlans() {
  const data = await apiFetch('/api/plans');
  return data.plans || [];
}
async function loadClasses() {
  const data = await apiFetch('/api/classes');
  return data.classes || [];
}

async function loadAll() {
  const meRes = await apiFetch('/api/auth/me');
  me = meRes.user;
  const role = me && me.role;
  if (role === 'student' || role === 'monitor') {
    window.location.href = '/dashboard';
    return;
  }
  el.userInfo.textContent = ((me.realName || me.displayName || me.username) || '') +
    (role === 'teacher' ? '（教师）' : '');

  // 1) 定位计划（按 planId，或按 sessionId 反查）→ 决定班级范围
  const plans = await loadPlans();
  if (planId) {
    plan = plans.find((p) => p.id === planId) || (sessionId ? plans.find((p) => p.sessionId === sessionId) : null) || null;
  } else if (sessionId) {
    plan = plans.find((p) => p.sessionId === sessionId) || null;
  }
  if (!plan && !sessionId) {
    renderError('缺少有效的场次/计划参数，无法补签');
    return;
  }
  // 2) 若未带 sessionId，计划也未生成过场次 → missingSession（提交时自动补录）
  if (!sessionId) {
    if (plan && plan.sessionId) {
      sessionId = Number(plan.sessionId);
    } else {
      missingSession = true;
    }
  }

  // 3) 场次信息与记录（missingSession 时无场次，全部学生视为未签）
  if (sessionId) {
    const sr = await apiFetch('/api/attendance/session-records?sessionId=' + sessionId);
    sessionInfo = sr.session;
    for (const r of sr.records) recordMap[r.studentId] = r;
  }

  const myClassId = me.classId || null;
  classScopeId = plan ? (plan.classId || myClassId) : myClassId;

  // 4) 班级范围名称
  if (classScopeId) {
    const classes = await loadClasses();
    const c = classes.find((x) => x.id === classScopeId);
    className = c ? c.className : `班级 #${classScopeId}`;
  } else {
    className = null; // 全部班级
  }

  // 5) 学生名单：在读学生（范围班级 / 全部班级）
  const url = '/api/students?status=' + encodeURIComponent('在读') +
    (classScopeId ? '&classId=' + classScopeId : '');
  const stuData = await apiFetch(url);
  students = stuData.students || [];
  selectableIds = new Set(
    students.filter((s) => {
      const st = statusOf(s);
      return st === 'none' || st === 'absent';
    }).map((s) => s.id)
  );

  renderInfo();
  renderTable();
}

// ---------- 渲染 ----------
function renderInfo() {
  // 日期/时间：优先计划，否则取场次开始时间
  let dateIso = null, timeStr = null;
  if (plan) {
    dateIso = plan.planDate ? plan.planDate + 'T00:00:00' : null;
    timeStr = plan.startTime;
  } else if (sessionInfo && sessionInfo.startTime) {
    dateIso = sessionInfo.startTime;
    timeStr = sessionInfo.startTime;
  }
  el.piDate.textContent = fmtDateCN(dateIso);
  el.piTime.textContent = fmtTimeHM(timeStr);
  el.piClass.textContent = className ? className : '全部班级';
  if (missingSession) {
    el.piSession.textContent =
      `场次未生成（计划 ${plan.planDate || ''} ${timeStr || ''} 未触发）· 提交补签时将自动补录`;
  } else if (plan) {
    el.piSession.textContent = `场次 #${sessionId} · ${plan.planDate || ''} 计划 ${timeStr || ''}`.trim();
  } else {
    el.piSession.textContent = `场次 #${sessionId} · 手动场次（非计划生成）`;
  }

  const total = students.length;
  const can = selectableIds.size;
  el.stTotal.textContent = total;
  el.stCan.textContent = can;
  updateStats(0);
}

function mkTag(status) {
  if (status === 'none') return '<span class="mk-tag none">未签</span>';
  if (status === 'signed') return '<span class="mk-tag signed">已签</span>';
  if (status === 'leave') return '<span class="mk-tag leave">请假</span>';
  return '<span class="mk-tag absent">缺勤</span>';
}

function filteredStudents() {
  const kw = el.searchBox.value.trim().toLowerCase();
  if (!kw) return students;
  return students.filter((s) =>
    s.studentNo.toLowerCase().includes(kw) || s.name.toLowerCase().includes(kw)
  );
}

function renderTable() {
  const list = filteredStudents();
  if (students.length === 0) {
    el.mkScroll.innerHTML = '<div class="mk-empty">该范围暂无在读学生，无法补签</div>';
    return;
  }
  const checkedSet = checkedIds();
  if (list.length === 0) {
    el.mkScroll.innerHTML = '<div class="mk-empty">没有匹配的学生</div>';
    updateSelectAllState();
    return;
  }
  const rows = list.map((s) => {
    const st = statusOf(s);
    const canPick = st === 'none' || st === 'absent';
    const on = canPick && checkedSet.has(s.id);
    return `
      <tr class="${canPick ? (on ? 'selected' : '') : 'disabled-row'}">
        <td class="col-check">
          <input type="checkbox" class="mk-row-check" data-id="${s.id}"
            ${canPick ? '' : 'disabled'} ${on ? 'checked' : ''}>
        </td>
        <td class="col-no">${s.studentNo}</td>
        <td><b>${s.name}</b></td>
        <td>${mkTag(st)}${canPick ? ' <span style="color:#2f6fb0;font-size:12px">可补签</span>' : ''}</td>
      </tr>`;
  }).join('');
  el.mkScroll.innerHTML = `
    <table>
      <thead>
        <tr><th class="col-check"></th><th class="col-no">学号</th><th>姓名</th><th>当前状态</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  updateSelectAllState();
}

function checkedIds() {
  const out = new Set();
  el.mkScroll.querySelectorAll('.mk-row-check:checked').forEach((cb) => {
    out.add(Number(cb.dataset.id));
  });
  return out;
}

function updateStats(pickOverride) {
  const pick = pickOverride !== undefined ? pickOverride : checkedIds().size;
  el.stPick.textContent = pick;
  el.btnSubmit.disabled = pick === 0;
  el.btnSubmit.textContent = `确认补签（${pick} 人）`;
}

function updateSelectAllState() {
  const list = filteredStudents();
  const boxes = [...el.mkScroll.querySelectorAll('.mk-row-check')];
  const pickableBoxes = boxes.filter((cb) => !cb.disabled);
  const checked = pickableBoxes.filter((cb) => cb.checked);
  const allChecked = pickableBoxes.length > 0 && checked.length === pickableBoxes.length;
  el.selectAll.checked = allChecked;
  el.selectAll.indeterminate = checked.length > 0 && !allChecked;
  // 只统计全部勾选（含被搜索隐藏的行）？这里统计全局勾选数：
  updateStats();
  // 同步表格"已选"高亮
  const ids = checkedIds();
  el.mkScroll.querySelectorAll('tbody tr').forEach((tr) => {
    const cb = tr.querySelector('.mk-row-check');
    if (cb && !cb.disabled) tr.classList.toggle('selected', ids.has(Number(cb.dataset.id)));
  });
}

// 全选：只勾选【当前列表（含搜索过滤）中可补签】的学生
el.selectAll.addEventListener('change', () => {
  const want = el.selectAll.checked;
  const ids = checkedIds();
  el.mkScroll.querySelectorAll('.mk-row-check:not(:disabled)').forEach((cb) => {
    if (want) {
      if (!cb.checked) cb.checked = true;
    } else {
      cb.checked = false;
    }
  });
  updateSelectAllState();
});

// 行勾选事件（事件委托）
el.mkScroll.addEventListener('change', (e) => {
  if (e.target && e.target.classList.contains('mk-row-check')) {
    updateSelectAllState();
  }
});

// 搜索即时过滤
el.searchBox.addEventListener('input', renderTable);

// ---------- 提交补签 ----------
el.btnSubmit.addEventListener('click', async () => {
  const ids = [...checkedIds()];
  if (ids.length === 0) return;
  el.btnSubmit.disabled = true;
  try {
    const body = { studentIds: ids };
    if (missingSession && plan) {
      // 计划未生成场次 → 交给后端按计划时间自动补录场次（只传 planId）
      body.planId = plan.id;
    } else {
      body.sessionId = sessionId;
    }
    const data = await apiFetch('/api/attendance/records/batch', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    showToast(`成功补签 ${data.count} 人` + (data.skipped ? `（跳过已签 ${data.skipped} 人）` : ''));
    // 自动返回计划管理页面
    setTimeout(() => {
      window.location.href = from === 'attendance' ? '/dashboard' : '/dashboard?view=plans';
    }, 1100);
  } catch (err) {
    showToast('补签失败：' + err.message, 3800);
    updateStats();
    el.btnSubmit.disabled = false;
  }
});

// ---------- 返回 ----------
function backTarget() {
  return from === 'attendance' ? '/dashboard' : '/dashboard?view=plans';
}
el.btnBack.addEventListener('click', () => { window.location.href = backTarget(); });
// 统一页头返回按钮：文案与箭头结构保持一致（← 返回X）
el.btnBack.innerHTML = '<span class="back-arrow">←</span> ' + (from === 'attendance' ? '返回签到' : '返回计划管理');

// ---------- 用户菜单（个人中心 / 帮助文档 / 退出登录）----------
// 顶部导航栏（含右上角用户菜单）由统一组件 navbar.js 渲染与接管，页面脚本不再重复绑定。

// ---------- 错误展示 ----------
function renderError(msg) {
  el.mkScroll.innerHTML = `<div class="mk-error">${msg}</div>`;
}

// ---------- 初始化 ----------
(async function init() {
  try {
    await loadAll();
  } catch (err) {
    renderError('加载失败：' + err.message);
  }
})();
