// ============================================================
// 作业统计页（班主任 / 教师 / 管理员，只读）
// 路径：/homework
// 功能：筛选（日期/学科/班级）→ 作业列表（含未交名单）
//       汇总统计（总作业数/平均提交率/未交人次 + 按学科提交率）
//       按学生查看（日期/学科/标题/是否提交/提交时间，支持本周/本月/自定义）
//       导出 Excel
// ============================================================
const $ = (id) => document.getElementById(id);
const el = {
  userInfo: $('userInfo'),
  btnUser: $('btnUser'),
  userDropdown: $('userDropdown'),
  menuProfile: $('menuProfile'),
  menuLogout: $('menuLogout'),
  btnBack: $('btnBack'),
  btnExport: $('btnExport'),
  fDate: $('fDate'),
  fSubject: $('fSubject'),
  fTeacher: $('fTeacher'),
  fGradeWrap: $('fGradeWrap'),
  fGrade: $('fGrade'),
  fClassWrap: $('fClassWrap'),
  fClass: $('fClass'),
  btnClearDate: $('btnClearDate'),
  btnStudentView: $('btnStudentView'),
  dailyHwHead: $('dailyHwHead'),
  dailyHwBody: $('dailyHwBody'),
  dailyHwEmpty: $('dailyHwEmpty'),
  btnExportUnsub: $('btnExportUnsub'),
  unsubModal: $('unsubModal'),
  unsubSubject: $('unsubSubject'),
  unsubClass: $('unsubClass'),
  unsubFrom: $('unsubFrom'),
  unsubTo: $('unsubTo'),
  unsubOk: $('unsubOk'),
  unsubCancel: $('unsubCancel'),
  unsubMsg: $('unsubMsg'),
  scTasks: $('scTasks'),
  scRate: $('scRate'),
  scMissing: $('scMissing'),
  subjectBars: $('subjectBars'),
  taskHead: $('taskHead'),
  taskBody: $('taskBody'),
  taskEmpty: $('taskEmpty'),
  taskListTitle: $('taskListTitle'),
  studentModal: $('studentModal'),
  stStudent: $('stStudent'),
  stSummary: $('stSummary'),
  stSubjects: $('stSubjects'),
  stCustomRange: $('stCustomRange'),
  stFrom: $('stFrom'),
  stTo: $('stTo'),
  stApply: $('stApply'),
  stBody: $('stBody'),
  stClose: $('stClose'),
  toast: $('toast'),
};

async function apiFetch(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('未登录，请重新登录'); }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) ? data.error : `请求失败（${res.status}）`);
  return data;
}

let toastTimer = null;
function showToast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), ms);
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const pad = (n) => String(n).padStart(2, '0');
const fmtD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => fmtD(new Date());

let role = null;
let myClassId = null;
let headClassIds = [];
let classes = [];
let academicYear = null;         // /api/settings → 当前学年（用于取 /api/grades）
let gradeNames = new Map();      // 年级键 → 年级名称
let students = [];
let currentTasks = [];
let stRange = 'month';
let stStudentId = null;
let isHeadTeacher = false;
let refreshSeq = 0;              // 筛选请求序号（防旧结果覆盖新筛选）

// ---------- 初始化 ----------
(async function init() {
  try {
    const me = await apiFetch('/api/auth/me');
    role = me.user.role;
    myClassId = me.user.classId || null;
    headClassIds = me.user.headClassIds || [];
    isHeadTeacher = role === 'teacher' &&
      (((me.user.roles || []).includes('head_teacher')) || headClassIds.length > 0);
    el.userInfo.textContent = ((me.user.realName || me.user.displayName || me.user.username) || '') +
      (role === 'teacher' ? '（教师）' : '');
  } catch (_) { role = null; }

  const isAdmin = role === 'admin';
  // 班长（2026-09-30 起本页对班长开放）：只看本班，隐藏年级/班级筛选与导出（导出接口仅老师/管理员）
  const isMonitor = role === 'monitor';
  const showScope = isAdmin || headClassIds.length > 0;
  el.fGradeWrap.classList.toggle('hidden', !showScope);
  el.fClassWrap.classList.toggle('hidden', !showScope);
  if (isMonitor) {
    if (el.btnExport) el.btnExport.classList.add('hidden');
    if (el.btnExportUnsub) el.btnExportUnsub.classList.add('hidden');
    if (el.fTeacher && el.fTeacher.closest('label')) el.fTeacher.closest('label').classList.add('hidden');
  }

  try {
    const cd = await apiFetch('/api/classes');
    classes = cd.classes || [];
  } catch (_) { classes = []; }

  if (showScope) {
    await renderGradeOptions();     // 数据来源：GET /api/grades?academic_year=当前学年
    renderClassOptions();           // 班级下拉随年级联动
  }

  await loadPublishers();
  await ensureDailyHw();     // 进入页面即生成当天每日作业条目（幂等）
  await refresh();
})();

// ---------- 年级 → 班级 联动 ----------
//   年级数据来源：GET /api/grades?academic_year=当前学年
//   可见年级 = 该列表 ∩ 当前账号可查看班级所属年级（不会越权显示）
async function currentAcademicYear() {
  if (academicYear !== null) return academicYear;
  try {
    const s = await apiFetch('/api/settings');
    academicYear = s.currentAcademicYear || '';
  } catch (_) { academicYear = ''; }
  return academicYear;
}

function gradeKeyOf(c) {
  if (c.gradeId !== undefined && c.gradeId !== null && c.gradeId !== '') return String(c.gradeId);
  return c.grade ? 'name:' + c.grade : '';
}

// 当前账号可筛选的班级（管理员=全部班级；班主任=自己的班主任班级）
function selectableClasses() {
  if (role === 'admin') return classes;
  return classes.filter((c) => headClassIds.includes(c.id));
}

// 当前年级筛选下可选的班级
function filteredClasses() {
  const g = el.fGrade.value;
  if (!g) return selectableClasses();
  return selectableClasses().filter((c) => gradeKeyOf(c) === g);
}

async function renderGradeOptions() {
  const scope = selectableClasses();
  const have = new Map();          // 由可见班级推导（兜底）
  scope.forEach((c) => {
    const k = gradeKeyOf(c);
    if (k && !have.has(k)) have.set(k, c.grade || '未分年级');
  });
  const seen = new Map();
  try {
    const y = await currentAcademicYear();
    const d = await apiFetch('/api/grades' + (y ? '?academic_year=' + encodeURIComponent(y) : ''));
    (d.grades || []).forEach((g) => {
      const k = String(g.id);
      if (have.has(k)) seen.set(k, g.grade_name || have.get(k));    // 只保留在查看范围内的年级
    });
  } catch (_) { /* 无权限或接口异常 → 用班级列表推导 */ }
  have.forEach((name, k) => { if (!seen.has(k)) seen.set(k, name); });
  gradeNames = seen;

  const cur = el.fGrade.value;
  el.fGrade.innerHTML = '<option value="">全部年级</option>' +
    [...seen.entries()].map(([k, name]) => `<option value="${escHtml(k)}">${escHtml(name)}</option>`).join('');
  el.fGrade.value = (cur && seen.has(cur)) ? cur : '';    // 默认「全部年级」
  el.fGrade.disabled = seen.size === 0;
}

function renderClassOptions() {
  const list = filteredClasses();
  const isAdmin = role === 'admin';
  const cur = el.fClass.value;
  if (!list.length) {
    el.fClass.innerHTML = '<option value="">（无可选班级）</option>';
    el.fClass.disabled = true;
    return;
  }
  el.fClass.disabled = false;
  if (isAdmin) {
    el.fClass.innerHTML = '<option value="">全部班级</option>' +
      list.map((c) => `<option value="${c.id}">${escHtml(c.className)}</option>`).join('');
    el.fClass.value = list.some((c) => String(c.id) === cur) ? cur : '';   // 默认「全部班级」
  } else {
    // 班主任：仅显示自己的班主任班级
    el.fClass.innerHTML = (list.length > 1 ? '<option value="">全部班主任班级</option>' : '') +
      list.map((c) => `<option value="${c.id}">${escHtml(c.className)}</option>`).join('');
    if (list.length === 1) el.fClass.value = String(list[0].id);
    else el.fClass.value = list.some((c) => String(c.id) === cur) ? cur : '';
  }
}

// 班级筛选参数：单选班级 → classId；选了年级且班级=全部班级 → classIds
//   （必须把该年级的班级整体传给后端，否则后端仍按"全部可见班级"取数，年级筛选对结果不生效）
function applyClassFilter(params) {
  if (el.fClass.value) { params.set('classId', el.fClass.value); return; }
  if (el.fGrade.value) {
    const ids = filteredClasses().map((c) => c.id);
    if (ids.length) params.set('classIds', ids.join(','));
  }
}

async function loadPublishers() {
  try {
    const d = await apiFetch('/api/homework/publishers');
    const list = d.publishers || [];
    el.fTeacher.innerHTML = '<option value="">全部</option>' +
      list.map((p) => `<option value="${p.id}">${escHtml(p.name)}</option>`).join('');
  } catch (_) {
    el.fTeacher.innerHTML = '<option value="">全部</option>';
  }
}

// ---------- 数据加载 ----------
async function loadStudentsForScope() {
  try {
    let classIds = [];
    if (el.fClass.value) {
      classIds = [Number(el.fClass.value)];
    } else if (role === 'admin' && !el.fGrade.value) {
      classIds = [];     // 管理员「全部年级 + 全部班级」：拉取全部学生
    } else {
      // 选了年级（班级=全部班级）→ 只拉该年级的班级；班主任未选班级 → 自己的班主任班级
      classIds = filteredClasses().map((c) => c.id);
    }
    if (role === 'admin' && classIds.length === 0) {
      // 管理员"全部班级"：拉取全部学生
      const data = await apiFetch('/api/students?status=' + encodeURIComponent('在读'));
      students = data.students || [];
    } else if (classIds.length === 0) {
      students = [];
    } else {
      const all = [];
      for (const cid of classIds) {
        const data = await apiFetch('/api/students?status=' + encodeURIComponent('在读') + '&classId=' + cid);
        all.push(...(data.students || []));
      }
      students = all;
    }
  } catch (_) { students = []; }
  const opts = ['<option value="">选择学生…</option>'].concat(
    students.map((s) => `<option value="${s.id}">${escHtml(s.studentNo)} ${escHtml(s.name)}</option>`)
  );
  el.stStudent.innerHTML = opts.join('');
  if (stStudentId) el.stStudent.value = String(stStudentId);
}

function scopeClassId() {
  if (role === 'admin') return el.fClass.value ? Number(el.fClass.value) : null;
  return el.fClass.value ? Number(el.fClass.value) : null; // 班主任：选中/全部班主任班级
}

// ---------- 今日各科提交情况（每日固定科目作业）----------
//   需求：班主任不需要知道具体作业内容，只要知道学生今天各科交没交
//   数据来源：GET /api/homework/tasks?date=今天（isDaily=true 的条目，含未交名单）
async function loadDailyHw() {
  const body = el.dailyHwBody;
  const head = el.dailyHwHead;
  if (!body || !head) return;
  try {
    const d = await apiFetch('/api/homework/tasks?date=' + todayStr());
    const list = (d.tasks || []).filter((t) => t.isDaily);
    // 多班（管理员/多班教师）时补充「班级」列
    const multiClass = new Set(list.map((t) => t.classId)).size > 1;
    head.innerHTML = '<tr><th>科目</th>' + (multiClass ? '<th>班级</th>' : '') +
      '<th>已交 / 总数</th><th>提交率</th><th>未交名单</th></tr>';
    if (!list.length) {
      body.innerHTML = '';
      if (el.dailyHwEmpty) {
        // 空态给出"下一步怎么办"：条目由系统每天 0 点自动生成（启动时也会补发当天一次），
        //   正常情况下不会为空 —— 为空通常是"当天班级名册刚建好/服务跨天没重启"，故给出兜底操作
        el.dailyHwEmpty.textContent = '今天还没有「每日作业」条目 —— 系统每天 0 点自动为每个班生成（服务启动时也会补发当天一次）；'
          + '若当天确实缺失，可重启一次服务，或让本班班长打开一次「签到操作台 → 📝 作业统计」（打开即补生成当天各科条目）';
        el.dailyHwEmpty.classList.remove('hidden');
      }
      return;
    }
    if (el.dailyHwEmpty) el.dailyHwEmpty.classList.add('hidden');
    const level = (rate) => (rate >= 90 ? 'ok' : (rate >= 70 ? 'warn' : 'bad'));
    body.innerHTML = list.map((t) => {
      const rate = t.total > 0 ? Math.round((t.submitted / t.total) * 1000) / 10 : 0;
      const missing = (t.notSubmitted || []).map((s) => s.name);
      const missingHtml = !t.recorded
        ? '<span class="daily-hw-unrecorded">未录入</span>'
        : (missing.length
          ? `<span class="daily-hw-missing">${missing.slice(0, 20).map((n) => escHtml(n)).join('、')}${missing.length > 20 ? ' …' : ''}</span>`
          : '—');
      return `<tr>
        <td><b>${escHtml(t.subject)}</b></td>
        ${multiClass ? `<td>${escHtml(t.className || '—')}</td>` : ''}
        <td>${t.submitted} / ${t.total}</td>
        <td class="daily-hw-rate ${t.recorded ? level(rate) : ''}">${t.recorded ? rate + '%' : '—'}</td>
        <td>${missingHtml}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    body.innerHTML = `<tr><td class="empty-tip-small">加载失败：${escHtml(err.message)}</td></tr>`;
  }
}

// 进入页面时自动生成当天各科条目（幂等；班主任/任课老师端同样能看到当天条目）
async function ensureDailyHw() {
  try {
    const body = {};
    // 管理员/多班教师未锁定班级时不自动生成（避免一次给所有班生成）；
    // 班级下拉有明确选中值时按该班生成
    if (el.fClass && el.fClass.value) body.classId = Number(el.fClass.value);
    else if (role === 'teacher') { /* 不传 → 后端按账号绑定班级生成 */ }
    else if (role === 'admin') return;
    await apiFetch('/api/homework/daily/ensure', { method: 'POST', body: JSON.stringify(body) });
  } catch (_) { /* 生成失败不影响页面其它内容 */ }
}

// ---------- 📊 导出未交统计（学科 × 日期范围 × 班级 → Excel）----------
//   后端：GET /api/homework/export-unsubmitted?classId=&subject=&from=&to=
//   表格：第一列 学生姓名 → 中间列 每天（MM-DD）→ 最后一列 未提交总次数（降序）
async function openUnsubModal() {
  if (!el.unsubModal) return;
  el.unsubModal.classList.remove('hidden');
  el.unsubMsg.textContent = '';
  el.unsubMsg.className = 'unsub-msg';
  // 日期范围默认：近 7 天（含今天）
  const end = todayStr();
  const start = fmtD(new Date(Date.now() - 6 * 86400000));
  el.unsubFrom.value = el.unsubFrom.value || start;
  el.unsubTo.value = el.unsubTo.value || end;
  // 班级：班主任/任课老师=所带班级；管理员=全部班级（可任选）
  const list = role === 'admin' ? classes : selectableClasses();
  el.unsubClass.innerHTML = list.length
    ? list.map((c) => `<option value="${c.id}">${escHtml(c.className)}</option>`).join('')
    : '<option value="">（无可选班级）</option>';
  const preferred = el.fClass.value ? Number(el.fClass.value) : (myClassId || (list[0] && list[0].id));
  if (preferred && list.some((c) => Number(c.id) === Number(preferred))) el.unsubClass.value = String(preferred);
  // 学科：优先用页面当前学科筛选，其次该班"每日作业"配置的科目
  let subjects = [];
  try {
    const cfg = await apiFetch('/api/homework/daily-subjects' + (el.unsubClass.value ? '?classId=' + el.unsubClass.value : ''));
    subjects = cfg.effective || [];
  } catch (_) { subjects = []; }
  const cur = el.fSubject.value || '';
  if (cur && !subjects.includes(cur)) subjects = [cur, ...subjects];
  el.unsubSubject.innerHTML = subjects.map((s) => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('')
    || '<option value="">（无科目）</option>';
  if (cur) el.unsubSubject.value = cur;
}

function closeUnsubModal() { if (el.unsubModal) el.unsubModal.classList.add('hidden'); }

function submitUnsubExport() {
  const subject = el.unsubSubject.value;
  const classId = el.unsubClass.value;
  const from = el.unsubFrom.value;
  const to = el.unsubTo.value;
  const fail = (m) => { el.unsubMsg.textContent = m; el.unsubMsg.className = 'unsub-msg err'; };
  if (!subject) return fail('请选择学科');
  if (!classId) return fail('请选择班级');
  if (!from || !to) return fail('请选择日期范围');
  if (from > to) return fail('开始日期不能晚于结束日期');
  const q = new URLSearchParams({ classId, subject, from, to }).toString();
  window.open('/api/homework/export-unsubmitted?' + q, '_blank');
  closeUnsubModal();
  showToast('正在导出未交统计（已提交/未提交/当天无作业）');
}

el.btnExportUnsub.addEventListener('click', () => { openUnsubModal().catch(() => {}); });
if (el.unsubCancel) el.unsubCancel.addEventListener('click', closeUnsubModal);
if (el.unsubOk) el.unsubOk.addEventListener('click', submitUnsubExport);
if (el.unsubModal) el.unsubModal.addEventListener('click', (e) => { if (e.target === el.unsubModal) closeUnsubModal(); });
if (el.unsubModal) {
  el.unsubModal.querySelectorAll('[data-days]').forEach((btn) => btn.addEventListener('click', () => {
    const d = Number(btn.dataset.days) || 7;
    el.unsubTo.value = todayStr();
    el.unsubFrom.value = fmtD(new Date(Date.now() - (d - 1) * 86400000));
  }));
}

async function refresh() {
  // 序号防串：年级/班级连续切换时，旧请求的结果可能后到 → 丢弃过期结果，避免覆盖新筛选
  const seq = ++refreshSeq;
  const subject = el.fSubject.value || '';
  const params = new URLSearchParams();
  if (el.fDate.value) params.set('date', el.fDate.value);
  if (subject) params.set('subject', subject);
  applyClassFilter(params);
  if (el.fTeacher.value) params.set('teacherId', el.fTeacher.value);
  el.btnClearDate.classList.toggle('hidden', !el.fDate.value);
  el.taskBody.innerHTML = '<tr><td colspan="8" class="empty-tip-small">加载中…</td></tr>';
  try {
    const data = await apiFetch('/api/homework/tasks?' + params.toString());
    if (seq !== refreshSeq) return;          // 已有更新的请求在跑 → 忽略本次
    currentTasks = data.tasks || [];
    renderSummary(data.stats || {}, data.bySubject || []);
    renderTaskList(currentTasks);
    await loadStudentsForScope();
    await loadDailyHw();
  } catch (err) {
    if (seq !== refreshSeq) return;
    el.taskBody.innerHTML = `<tr><td colspan="8" class="empty-tip-small">加载失败：${escHtml(err.message)}</td></tr>`;
  }
}

// ---------- 渲染：汇总 + 按学科提交率 ----------
//   进度条：宽度 = 提交率，颜色按提交率变化（≥90% 绿 / 70%-89% 橙 / <70% 红）
function barLevel(rate) {
  if (rate >= 90) return 'ok';
  if (rate >= 70) return 'warn';
  return 'bad';
}

function renderSummary(stats, bySubject) {
  el.scTasks.textContent = stats.taskCount || 0;
  const rate = stats.avgRate || 0;
  el.scRate.textContent = stats.studentSlots > 0 ? rate + '%' : '—';
  el.scRate.style.color = rate >= 90 ? 'var(--success)' : (rate >= 60 ? 'var(--warning)' : 'var(--danger)');
  el.scMissing.textContent = stats.notSubmittedCount || 0;

  if (!bySubject.length) {
    el.subjectBars.innerHTML = '<div class="empty-tip-small">暂无数据</div>';
    return;
  }
  el.subjectBars.innerHTML = bySubject.map((b) => {
    // 接口已给 rate；若缺失则按 已交/应交 现算，保证进度条宽度永远有值
    const r = (typeof b.rate === 'number') ? b.rate
      : (b.total > 0 ? Math.round((b.submitted / b.total) * 1000) / 10 : 0);
    const lv = barLevel(r);
    return `<div class="hw-bar-row" data-subject="${escHtml(b.subject)}" data-rate="${r}" data-level="${lv}">
      <span class="hw-bar-label">${escHtml(b.subject)}</span>
      <span class="hw-bar-track"><span class="hw-bar-fill ${lv}" style="width:${Math.max(0, Math.min(100, r))}%"></span></span>
      <span class="hw-bar-value">${b.submitted}/${b.total}（${r}%）</span>
    </div>`;
  }).join('');
}

// ---------- 渲染：作业列表 ----------
function taskStatus(deadlineIso) {
  if (!deadlineIso) return { cls: 'future', text: '—' };
  const d = new Date(deadlineIso).getTime();
  return d > Date.now() ? { cls: 'doing', text: '进行中' } : { cls: 'done', text: '已截止' };
}

function renderTaskList(tasks) {
  const showClass = role === 'admin' || isHeadTeacher;
  el.taskHead.innerHTML = `<tr>
    ${showClass ? '<th>班级</th>' : ''}
    <th>学科</th><th>作业标题</th><th>发布老师</th><th>截止时间</th>
    <th>已交 / 总人数</th><th>提交率</th><th>未交名单</th><th>状态</th>
  </tr>`;
  const scopeTxt = el.fDate.value ? el.fDate.value : '全部日期';
  el.taskListTitle.textContent = `作业列表（${scopeTxt}${el.fSubject.value ? ' · ' + el.fSubject.value : ''}${el.fTeacher.value ? ' · 指定发布老师' : ''}）`;
  el.taskEmpty.classList.toggle('hidden', tasks.length > 0);
  el.taskBody.innerHTML = tasks.map((t) => {
    const rate = t.total > 0 ? Math.round((t.submitted / t.total) * 1000) / 10 : 0;
    const tag = rate >= 90 ? 'green' : (rate >= 60 ? 'orange' : 'red');
    const names = t.notSubmitted || [];
    const shown = names.slice(0, 10).map((s) =>
      `<span class="hw-stu-link" data-id="${s.id}" data-name="${escHtml(s.name)}">${escHtml(s.name)}</span>`).join('');
    const more = names.length > 10 ? `<span style="font-size:12px;color:var(--text-light)">等 ${names.length} 人</span>` : '';
    const listHtml = names.length === 0 ? '<span class="hw-notsub-none">全部已交 ✅</span>' : shown + more;
    const st = taskStatus(t.deadline);
    return `<tr>
      ${showClass ? `<td>${escHtml(t.className || '')}</td>` : ''}
      <td>${escHtml(t.subject)}</td>
      <td><b>${escHtml(t.title)}</b></td>
      <td>${escHtml(t.teacherName || '—')}</td>
      <td style="white-space:nowrap">${escHtml(t.deadlineText || '')}</td>
      <td><b>${t.submitted}</b> / ${t.total}</td>
      <td><span class="hw-rate-tag ${tag}">${rate}%</span></td>
      <td>${listHtml}</td>
      <td><span class="hw-status-tag ${st.cls}">${st.text}</span></td>
    </tr>`;
  }).join('');
}

// 点击未交名单中的学生姓名 → 打开该学生记录
el.taskBody.addEventListener('click', (e) => {
  const link = e.target.closest('.hw-stu-link');
  if (!link) return;
  openStudentModal(Number(link.dataset.id));
});

// ---------- 按学生查看 ----------
el.btnStudentView.addEventListener('click', () => {
  if (students.length === 0) { showToast('当前范围内没有学生'); return; }
  openStudentModal(stStudentId || students[0].id);
});

function openStudentModal(studentId) {
  stStudentId = studentId;
  if (students.length === 0) { showToast('当前范围内没有学生'); return; }
  el.stStudent.value = String(studentId);
  el.studentModal.classList.remove('hidden');
  loadStudentRecords();
}

el.stStudent.addEventListener('change', () => {
  stStudentId = Number(el.stStudent.value) || null;
  if (stStudentId) loadStudentRecords();
});

function rangeDates() {
  const today = new Date();
  if (stRange === 'week') {
    const d = new Date(today);
    const dow = (d.getDay() + 6) % 7; // 周一为一周开始
    d.setDate(d.getDate() - dow);
    return { from: fmtD(d), to: fmtD(today) };
  }
  if (stRange === 'month') {
    const d = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: fmtD(d), to: fmtD(today) };
  }
  return { from: el.stFrom.value || '', to: el.stTo.value || '' };
}

document.querySelectorAll('.range-quick .btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-quick .btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    stRange = btn.dataset.range;
    const isCustom = stRange === 'custom';
    el.stCustomRange.classList.toggle('hidden', !isCustom);
    if (isCustom) {
      if (!el.stFrom.value) {
        const d = new Date();
        el.stFrom.value = fmtD(new Date(d.getFullYear(), d.getMonth(), 1));
        el.stTo.value = todayStr();
      }
      return; // 自定义需点"查询"
    }
    loadStudentRecords();
  });
});
el.stApply.addEventListener('click', loadStudentRecords);

// ---------- 各科作业提交情况（应交/实交/提交率 + 颜色标记） ----------
//   提交率 100% → ✅ 优秀（绿）；80%-99% → ⚠️ 需关注（橙）；<80% → ❌ 需改进（红）
function rateLevel(rate) {
  if (rate >= 100) return { key: 'ok', label: '✅ 优秀' };
  if (rate >= 80) return { key: 'warn', label: '⚠️ 需关注' };
  return { key: 'bad', label: '❌ 需改进' };
}

function renderSubjectChart(bySubject) {
  const box = el.stSubjects;
  if (!box) return;
  const list = bySubject || [];
  if (list.length === 0) {
    box.innerHTML = '<div class="hsc-empty">该时间范围内暂无作业</div>';
    return;
  }
  box.innerHTML = list.map((x) => {
    const lv = rateLevel(Number(x.rate) || 0);
    const width = Math.max(0, Math.min(100, Number(x.rate) || 0));
    return `<div class="hsc-row" data-subject="${escHtml(x.subject)}" data-rate="${x.rate}">
      <span class="hsc-subj" title="${escHtml(x.subject)}">${escHtml(x.subject)}</span>
      <span class="hsc-bar"><i class="fill-${lv.key}" style="width:${width}%"></i></span>
      <span class="hsc-count">${x.submitted}/${x.expected} 次</span>
      <span class="hsc-rate ${lv.key}">${x.rate}%</span>
      <span class="hsc-badge ${lv.key}">${lv.label}</span>
    </div>`;
  }).join('');
}

async function loadStudentRecords() {
  if (!stStudentId) return;
  const { from, to } = rangeDates();
  const params = new URLSearchParams();
  const classId = scopeClassId();
  if (classId) params.set('classId', classId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  el.stBody.innerHTML = '<tr><td colspan="5" class="empty-tip-small">加载中…</td></tr>';
  if (el.stSubjects) el.stSubjects.innerHTML = '<div class="hsc-empty">加载中…</div>';
  try {
    const data = await apiFetch(`/api/homework/student/${stStudentId}?` + params.toString());
    const st = data.student;
    const stats = data.stats || {};
    el.stSummary.innerHTML = `${escHtml(st.name)}（${escHtml(st.studentNo)}） · 共 <b>${stats.total}</b> 次作业 · 已交 <b>${stats.submitted}</b> · 未交 <b>${stats.notSubmitted}</b> · 提交率 <b>${stats.rate}%</b>`;
    renderSubjectChart(data.bySubject);
    const records = data.records || [];
    if (records.length === 0) {
      el.stBody.innerHTML = '<tr><td colspan="5" class="empty-tip-small">该时间范围内没有作业记录</td></tr>';
      return;
    }
    el.stBody.innerHTML = records.map((r) => {
      const when = r.updatedAt ? new Date(r.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '';
      return `<tr>
        <td>${escHtml(r.date)}</td>
        <td>${escHtml(r.subject)}</td>
        <td>${escHtml(r.title)}</td>
        <td>${r.isSubmitted ? '<span class="hw-rate-tag green">已交</span>' : '<span class="hw-rate-tag red">未交</span>'}</td>
        <td style="color:var(--text-light);font-size:12px">${r.isSubmitted ? escHtml(when) : '—'}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    el.stBody.innerHTML = `<tr><td colspan="5" class="empty-tip-small">加载失败：${escHtml(err.message)}</td></tr>`;
  }
}

el.stClose.addEventListener('click', () => el.studentModal.classList.add('hidden'));
el.studentModal.addEventListener('click', (e) => { if (e.target === el.studentModal) el.studentModal.classList.add('hidden'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') el.studentModal.classList.add('hidden'); });

// ---------- 筛选 / 导出 ----------
el.fDate.addEventListener('change', refresh);
el.fSubject.addEventListener('change', refresh);
el.fTeacher.addEventListener('change', refresh);
el.fClass.addEventListener('change', refresh);
el.fGrade.addEventListener('change', () => { renderClassOptions(); refresh(); });
el.btnClearDate.addEventListener('click', () => { el.fDate.value = ''; refresh(); });

el.btnExport.addEventListener('click', () => {
  const params = new URLSearchParams();
  if (el.fDate.value) params.set('date', el.fDate.value);
  if (el.fSubject.value) params.set('subject', el.fSubject.value);
  if (el.fTeacher.value) params.set('teacherId', el.fTeacher.value);
  applyClassFilter(params);
  window.location.href = '/api/homework/export?' + params.toString();
});

// ---------- 用户菜单（个人中心 / 帮助文档 / 退出登录）----------
// 顶部导航栏（含右上角用户菜单）由统一组件 navbar.js 渲染与接管，页面脚本不再重复绑定。
el.btnBack.addEventListener('click', () => { window.location.href = '/dashboard'; });
