// ============================================================
// 考勤分析页面逻辑（/attendance-analysis）
// 管理员：年级/班级筛选 + 统计卡片 + 趋势/排行榜/年级对比 + 班级明细
// 教师：所带班级 + 统计卡片 + 趋势 + 学生明细
// ============================================================
'use strict';

const $ = (id) => document.getElementById(id);
const el = {
  btnBack: $('btnBack'),
  btnUser: $('btnUser'),
  userInfo: $('userInfo'),
  userDropdown: $('userDropdown'),
  menuProfile: $('menuProfile'),
  menuLogout: $('menuLogout'),
  btnExport: $('btnExport'),
  fGradeWrap: $('fGradeWrap'),
  fClassWrap: $('fClassWrap'),
  fGrade: $('fGrade'),
  fClass: $('fClass'),
  cStart: $('cStart'),
  cEnd: $('cEnd'),
  cApply: $('cApply'),
  includeNonEnrolled: $('includeNonEnrolled'),
  customRange: $('customRange'),
  scRate: $('scRate'),
  scRateLabel: $('scRateLabel'),
  scRateSub: $('scRateSub'),
  scExpected: $('scExpected'),
  scExpectedSub: $('scExpectedSub'),
  scAttended: $('scAttended'),
  scAttendedSub: $('scAttendedSub'),
  scAbsent: $('scAbsent'),
  scAbsentSub: $('scAbsentSub'),
  scLeave: $('scLeave'),
  scLeaveSub: $('scLeaveSub'),
  cardRate: $('cardRate'),
  sessionNote: $('sessionNote'),
  termHint: $('termHint'),
  // 搜索学生
  stKeyword: $('stKeyword'),
  btnStSearch: $('btnStSearch'),
  btnStClear: $('btnStClear'),
  btnStClear2: $('btnStClear2'),
  studentPanel: $('studentPanel'),
  spKeyword: $('spKeyword'),
  spCount: $('spCount'),
  spMsg: $('spMsg'),
  spList: $('spList'),
  spDetail: $('spDetail'),
  spName: $('spName'),
  spNo: $('spNo'),
  spClass: $('spClass'),
  spRange: $('spRange'),
  spExpected: $('spExpected'),
  spAttended: $('spAttended'),
  spLeave: $('spLeave'),
  spAbsent: $('spAbsent'),
  spRate: $('spRate'),
  spRateCard: $('spRateCard'),
  spRecBody: $('spRecBody'),
  spChart: $('spChart'),
  spChartLegend: $('spChartLegend'),
  spRangeInfo: $('spRangeInfo'),
  spPageInfo: $('spPageInfo'),
  spPrev: $('spPrev'),
  spNext: $('spNext'),
  trendChart: $('trendChart'),
  rankChart: $('rankChart'),
  gradeChart: $('gradeChart'),
  rankCard: $('rankCard'),
  gradeCard: $('gradeCard'),
  tableTitle: $('tableTitle'),
  detailHead: $('detailHead'),
  detailBody: $('detailBody'),
  classRangeInfo: $('classRangeInfo'),
  classPageInfo: $('classPageInfo'),
  classPrev: $('classPrev'),
  classNext: $('classNext'),
  classPagination: $('classPagination'),
  detailModal: $('detailModal'),
  detailModalTitle: $('detailModalTitle'),
  detailModalBody: $('detailModalBody'),
  detailModalClose: $('detailModalClose'),
  exportModal: $('exportModal'),
  exStart: $('exStart'),
  exEnd: $('exEnd'),
  exClass: $('exClass'),
  exClassRow: $('exClassRow'),
  exError: $('exError'),
  exCancel: $('exCancel'),
  exSubmit: $('exSubmit'),
  fStudent: $('fStudent'),
  fStatus: $('fStatus'),
  fTime: $('fTime'),
  fMethod: $('fMethod'),
  fReason: $('fReason'),
  toast: $('toast'),
};

// 导航栏显示名：真实姓名（教师带角色后缀）
function displayNameForNav(u) {
  const nm = (u && (u.realName || u.displayName || u.username)) || '';
  return u && u.role === 'teacher' ? `${nm}（教师）` : nm;
}

let role = '';
let classes = [];
let timeMode = 'month';
// 学期设置（系统管理 → 学年管理 → 学期设置）：GET /api/term
//   已配置 → 用配置的当前学期起止日期；未配置 → 回退默认口径并在页面上提示
let termCfg = null;
let chartTrend = null;
let chartRank = null;
let chartGrade = null;

// ---------- 工具 ----------
let toastTimer = null;
function showToast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), ms);
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('未登录'); }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) ? data.error : `请求失败（${res.status}）`);
  return data;
}

function fmtDateInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function getRange() {
  const now = new Date();
  let start, end;
  if (timeMode === 'today') { start = end = now; }
  else if (timeMode === 'week') {
    const diff = now.getDay() === 0 ? 6 : now.getDay() - 1;
    start = new Date(now); start.setDate(now.getDate() - diff);
    end = new Date(start); end.setDate(start.getDate() + 6);
  } else if (timeMode === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = now;
  } else if (timeMode === 'semester') {
    const t = semesterRange(now);
    return t;
  } else { // custom
    start = el.cStart.value ? new Date(el.cStart.value + 'T00:00:00') : null;
    end = el.cEnd.value ? new Date(el.cEnd.value + 'T00:00:00') : null;
  }
  return { startDate: fmtDateInput(start), endDate: fmtDateInput(end) };
}

// 「本学期」区间：优先用学期设置里配置的起止日期，未配置时按默认口径（上学期 9/1~次年 1/31、下学期 2/1~7/15）
function semesterRange(now = new Date()) {
  if (termCfg && termCfg.startDate && termCfg.endDate) {
    return { startDate: termCfg.startDate, endDate: termCfg.endDate };
  }
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  let start;
  if (m >= 9) start = new Date(y, 8, 1);
  else if (m >= 3) start = new Date(y, 2, 1);
  else start = new Date(y - 1, 8, 1);
  return { startDate: fmtDateInput(start), endDate: fmtDateInput(now) };
}

// 选「本学期」时展示口径来源：已配置显示区间，未配置给出设置入口提示
function updateTermHint() {
  if (!el.termHint) return;
  if (timeMode !== 'semester') { el.termHint.classList.add('hidden'); return; }
  const r = semesterRange();
  const tail = (termCfg && termCfg.clipped && termCfg.rawEndDate)
    ? `（学期结束日 ${termCfg.rawEndDate}，未到则统计到今天）` : '';
  el.termHint.classList.remove('hidden');
  if (termCfg && termCfg.configured) {
    el.termHint.className = 'term-hint';
    el.termHint.innerHTML = `本学期（${termCfg.currentTermLabel || ''}）统计区间：<b>${r.startDate} ~ ${r.endDate}</b>${tail}（来自 系统管理 → 学年管理 → 学期设置）`;
  } else {
    el.termHint.className = 'term-hint warn';
    el.termHint.innerHTML = `⚠️ 请先设置当前学期（${termCfg && termCfg.currentTermLabel ? termCfg.currentTermLabel : '上学期/下学期'}）的起止日期：当前「本学期」按默认口径统计（<b>${r.startDate} ~ ${r.endDate}</b>）。管理员可在 系统管理 → 学年管理 → 学期设置 中配置。`;
  }
}

// ---------- 班级数据 ----------
async function loadClasses() {
  try {
    const data = await apiFetch('/api/classes');
    classes = data.classes || [];
    // 年级下拉（去重）
    const grades = [...new Set(classes.map((c) => c.grade).filter(Boolean))];
    el.fGrade.innerHTML = '<option value="">全部</option>' +
      grades.map((g) => `<option value="${g}">${g}</option>`).join('');
    // 班级下拉（随年级联动）
    renderClassOptions();
    // 导出弹窗班级下拉
    el.exClass.innerHTML = '<option value="">全部班级</option>' +
      classes.map((c) => `<option value="${c.id}">${c.className}</option>`).join('');
  } catch (err) {
    console.error('[班级加载失败]', err.message);
  }
}

function renderClassOptions() {
  const grade = el.fGrade.value;
  const list = grade ? classes.filter((c) => c.grade === grade) : classes;
  el.fClass.innerHTML = '<option value="">全部班级</option>' +
    list.map((c) => `<option value="${c.id}">${c.className}</option>`).join('');
}

// ---------- 数据加载 ----------
function buildQuery(extra = {}) {
  const r = getRange();
  const params = new URLSearchParams({ startDate: r.startDate, endDate: r.endDate });
  if (el.includeNonEnrolled && el.includeNonEnrolled.checked) {
    params.set('includeNonEnrolled', '1');
  }
  if (role === 'admin') {
    if (el.fGrade.value) params.set('grade', el.fGrade.value);
    if (el.fClass.value) params.set('classId', el.fClass.value);
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, v);
  }
  return params.toString();
}

async function refreshAll() {
  try {
    await Promise.all([loadOverview(), loadTrend()]);
    if (role === 'admin') {
      await Promise.all([loadRanking(), loadGradeCompare(), loadClassTable()]);
    } else {
      await loadStudentTable();
    }
  } catch (err) {
    showToast('加载失败：' + err.message);
  }
}

async function loadOverview() {
  const d = await apiFetch('/api/attendance/analysis/overview?' + buildQuery());
  const range = getRange();
  const short = (s) => (s || '').slice(5); // MM-DD
  el.scRate.textContent = d.rate === null ? '—' : d.rate + '%';
  // 出勤率卡片按数值变色：≥90% 绿 / 70-90% 橙 / <70% 红
  el.cardRate.classList.toggle('lv-mid', d.rate !== null && d.rate < 90 && d.rate >= 70);
  el.cardRate.classList.toggle('lv-low', d.rate !== null && d.rate < 70);
  el.scRateSub.textContent = `共 ${d.totalSessions} 场签到 · ${d.totalDays} 个签到日 · ${d.totalStudents} 名在读学生`;
  el.scExpected.textContent = d.expected;
  el.scExpectedSub.textContent = `${d.totalSessions} 场 × ${d.totalStudents} 人（每场每人 1 次）`;
  el.scAttended.textContent = d.attended;
  el.scAttendedSub.textContent = `统计范围 ${short(range.startDate)} ~ ${short(range.endDate)}（截至今日）`;
  if (el.scLeave) el.scLeave.textContent = d.leave;
  // 请假卡片副文案：显示请假构成（病假/事假/公假）——需求"考勤统计显示请假人数和类型"
  if (el.scLeaveSub) {
    const lr = d.leaveByReason || {};
    const parts = [];
    if (lr.sick) parts.push(`病假 ${lr.sick}`);
    if (lr.personal) parts.push(`事假 ${lr.personal}`);
    if (lr.official) parts.push(`公假 ${lr.official}`);
    if (lr.unknown) parts.push(`未标事由 ${lr.unknown}`);
    el.scLeaveSub.textContent = parts.length
      ? `已批准请假（${parts.join(' · ')}）`
      : '已批准请假（含批量请假，未标事由）';
  }
  if (el.scAbsent) el.scAbsent.textContent = d.absent;
  if (el.scAbsentSub) el.scAbsentSub.textContent = `缺勤 = 应到 − 实到 − 请假（请假 ${d.leave} 人次）`;
  // 场次口径提示：本班无任何签到记录的场次（仍按"每场每人 1 次"计入应到）
  const miss = d.sessionsWithoutRecords || 0;
  const autoN = d.autoSessionCount || 0;
  // 每天自动签到（v35）：每天早/晚两场各计一次 → 应到人次约为"人数 × 2 × 天数"，这里明确写出来
  const autoNote = autoN > 0
    ? `<div class="sn-sub">其中 <b>${autoN}</b> 场为「每天自动签到」（早自习/晚自修）：<b>一天两场各计 1 次</b>，` +
      `所以近 n 天的应到人次约为「人数 × 2 × 天数」；趋势图已按天合并展示。</div>`
    : '';
  if (miss > 0) {
    const list = (d.missingSessions || []).map((x) => x.slotLabel || x.at).join('、');
    const more = miss > (d.missingSessions || []).length ? ' …' : '';
    el.sessionNote.innerHTML =
      `⚠️ 统计的 ${d.totalSessions} 场中，有 <b>${miss}</b> 场本班没有任何签到记录（该场未录入/未参与）：${list}${more}` +
      `<div class="sn-sub">这些场次仍按「每场每人 1 次」计入应到人次；如是漏录，请到对应日期的场次补签后再查看。</div>` + autoNote;
    el.sessionNote.classList.remove('hidden');
  } else if (autoNote) {
    el.sessionNote.innerHTML = autoNote;
    el.sessionNote.classList.remove('hidden');
  } else {
    el.sessionNote.classList.add('hidden');
    el.sessionNote.innerHTML = '';
  }
  if (d.warning) showToast('⚠ 数据异常：统计超过应到上限，已自动修正', 4000);
}

async function loadTrend() {
  const d = await apiFetch('/api/attendance/analysis/trend?' + buildQuery());
  const labels = d.points.map((p) => p.date.slice(5)); // MM-DD
  const data = d.points.map((p) => p.rate === null ? null : p.rate);
  if (chartTrend) chartTrend.destroy();
  chartTrend = new Chart(el.trendChart, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '出勤率 (%)',
        data,
        borderColor: '#4A90D9',
        backgroundColor: 'rgba(74,144,217,0.12)',
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        spanGaps: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, max: 100, ticks: { callback: (v) => v + '%' } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

async function loadRanking() {
  const d = await apiFetch('/api/attendance/analysis/ranking?' + buildQuery());
  if (chartRank) chartRank.destroy();
  chartRank = new Chart(el.rankChart, {
    type: 'bar',
    data: {
      labels: d.rows.map((r) => r.className),
      datasets: [{
        label: '出勤率 (%)',
        data: d.rows.map((r) => r.rate === null ? 0 : r.rate),
        backgroundColor: '#52C41A',
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { beginAtZero: true, max: 100, ticks: { callback: (v) => v + '%' } } },
      plugins: { legend: { display: false } },
    },
  });
}

async function loadGradeCompare() {
  const d = await apiFetch('/api/attendance/analysis/grade-compare?' + buildQuery());
  if (chartGrade) chartGrade.destroy();
  chartGrade = new Chart(el.gradeChart, {
    type: 'bar',
    data: {
      labels: d.rows.map((r) => r.grade),
      datasets: [{
        label: '出勤率 (%)',
        data: d.rows.map((r) => r.rate === null ? 0 : r.rate),
        backgroundColor: '#FAAD14',
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, max: 100, ticks: { callback: (v) => v + '%' } } },
      plugins: { legend: { display: false } },
    },
  });
}

// 管理员：班级明细表（排序/分页/高亮/查看详情）
const CLASS_PAGE_SIZE = 10;
let classRows = [];
let classPage = 1;
let classSortKey = 'rate';    // 默认按出勤率
let classSortDir = 'desc';    // 默认降序

function sortClassRows() {
  const key = classSortKey;
  const dir = classSortDir === 'asc' ? 1 : -1;
  classRows.sort((a, b) => {
    const va = a[key] === null || a[key] === undefined ? -1 : a[key];
    const vb = b[key] === null || b[key] === undefined ? -1 : b[key];
    return (va - vb) * dir;
  });
}

async function loadClassTable() {
  el.tableTitle.textContent = '班级明细';
  const d = await apiFetch('/api/attendance/analysis/ranking?' + buildQuery());
  classRows = d.rows || [];
  sortClassRows();
  renderClassTable();
}

function renderClassTable() {
  el.detailHead.innerHTML = `
    <tr>
      <th class="col-num">序号</th>
      <th>班级名称</th>
      <th class="col-num">应到人次</th>
      <th class="col-num">实到人次</th>
      <th class="col-num">请假人次</th>
      <th class="col-num">缺勤人次</th>
      <th class="col-num sortable" data-key="rate">出勤率 ${classSortKey === 'rate' ? (classSortDir === 'asc' ? '▲' : '▼') : ''}</th>
      <th>操作</th>
    </tr>`;

  const total = classRows.length;
  const totalPages = Math.max(1, Math.ceil(total / CLASS_PAGE_SIZE));
  if (classPage > totalPages) classPage = totalPages;
  const start = (classPage - 1) * CLASS_PAGE_SIZE;
  const pageRows = classRows.slice(start, start + CLASS_PAGE_SIZE);

  el.classRangeInfo.textContent = total === 0
    ? '显示 0-0 条，共 0 条'
    : `显示 ${start + 1}-${Math.min(start + CLASS_PAGE_SIZE, total)} 条，共 ${total} 条`;
  el.classPageInfo.textContent = `第 ${classPage} / ${totalPages} 页`;
  el.classPrev.disabled = classPage <= 1;
  el.classNext.disabled = classPage >= totalPages;

  if (pageRows.length === 0) {
    el.detailBody.innerHTML = '<tr><td colspan="8" class="plan-empty">暂无数据</td></tr>';
    return;
  }
  el.detailBody.innerHTML = pageRows.map((r, i) => {
    const low = r.rate !== null && r.rate < 60;
    const warnMark = r.warning
      ? ' <span class="warn-mark" title="数据异常：实到+请假超过应到，已按应到上限修正">⚠</span>'
      : '';
    return `
      <tr class="${low ? 'low-rate' : ''}${r.warning ? ' warn-rate' : ''}">
        <td class="col-num" data-label="序号">${start + i + 1}</td>
        <td data-label="班级名称"><b class="class-name">📚 ${r.className}</b>${r.grade ? `<span class="class-grade">${r.grade}</span>` : ''}${warnMark}</td>
        <td class="col-num" data-label="应到人次">${r.expected}</td>
        <td class="col-num" data-label="实到人次">${r.attended}</td>
        <td class="col-num" data-label="请假人次">${r.leave}</td>
        <td class="col-num" data-label="缺勤人次">${r.absent}</td>
        <td class="col-num" data-label="出勤率">${rateTag(r.rate)}</td>
        <td data-label="操作">${r.classId === null ? '' : `<button type="button" class="btn-link" data-act="detail" data-id="${r.classId}" data-name="${r.className}">查看详情</button>`}</td>
      </tr>`;
  }).join('');
}

// 出勤率彩色标签：>85 绿 / 60-85 橙 / <60 红
function rateTag(rate) {
  if (rate === null) return '<span class="rate-tag gray">—</span>';
  let cls = 'red';
  if (rate > 85) cls = 'green';
  else if (rate >= 60) cls = 'orange';
  return `<span class="rate-tag ${cls}">${rate}%</span>`;
}

// 点击列头排序（出勤率）
el.detailHead.addEventListener('click', (e) => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const key = th.dataset.key;
  if (classSortKey === key) {
    classSortDir = classSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    classSortKey = key;
    classSortDir = 'desc';
  }
  sortClassRows();
  renderClassTable();
});

// 班级明细分页
el.classPrev.addEventListener('click', () => { if (classPage > 1) { classPage -= 1; renderClassTable(); } });
el.classNext.addEventListener('click', () => {
  if (classPage < Math.max(1, Math.ceil(classRows.length / CLASS_PAGE_SIZE))) {
    classPage += 1;
    renderClassTable();
  }
});

// 查看详情：打开该班学生明细
el.detailBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act="detail"]');
  if (!btn) return;
  const classId = Number(btn.dataset.id);
  el.detailModalTitle.textContent = `${btn.dataset.name} · 学生出勤明细`;
  el.detailModalBody.innerHTML = '<tr><td colspan="7" class="plan-empty">加载中...</td></tr>';
  el.detailModal.classList.remove('hidden');
  try {
    const d = await apiFetch('/api/attendance/analysis/student-detail?' + buildQuery({ classId }));
    if (!d.rows.length) {
      el.detailModalBody.innerHTML = '<tr><td colspan="7" class="plan-empty">该班级暂无学生</td></tr>';
      return;
    }
    el.detailModalBody.innerHTML = d.rows.map((r) => `
      <tr>
        <td>${r.studentNo}</td>
        <td><b>${r.name}</b></td>
        <td>${r.expected}</td>
        <td>${r.attended}</td>
        <td>${r.leave}</td>
        <td>${r.absent}</td>
        <td>${r.rate === null ? '—' : r.rate + '%'}</td>
      </tr>`).join('');
  } catch (err) {
    el.detailModalBody.innerHTML = `<tr><td colspan="7" class="plan-empty">${err.message}</td></tr>`;
  }
});

el.detailModalClose.addEventListener('click', () => el.detailModal.classList.add('hidden'));
el.detailModal.addEventListener('click', (e) => { if (e.target === el.detailModal) el.detailModal.classList.add('hidden'); });

// 教师：学生明细表
async function loadStudentTable() {
  el.tableTitle.textContent = '学生出勤明细';
  const d = await apiFetch('/api/attendance/analysis/student-detail?' + buildQuery());
  el.detailHead.innerHTML =
    '<tr><th>学号</th><th>姓名</th><th>应到人次</th><th>实到人次</th><th>请假人次</th><th>缺勤人次</th><th>出勤率</th></tr>';
  if (!d.rows.length) {
    el.detailBody.innerHTML = '<tr><td colspan="7" class="plan-empty">暂无数据</td></tr>';
    return;
  }
  el.detailBody.innerHTML = d.rows.map((r) => `
    <tr>
      <td>${r.studentNo}</td>
      <td><b>${r.name}</b></td>
      <td>${r.expected}</td>
      <td>${r.attended}</td>
      <td>${r.leave}</td>
      <td>${r.absent}</td>
      <td>${r.rate === null ? '—' : r.rate + '%'}</td>
    </tr>`).join('');
}

// ---------- 筛选事件 ----------
function setTimeMode(mode) {
  timeMode = mode;
  document.querySelectorAll('.time-quick .btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.t === mode);
  });
  el.customRange.classList.toggle('hidden', mode !== 'custom');
  updateTermHint();
  refreshAll();
  // 正在查看某位学生 → 明细随时间范围一起刷新
  if (SEARCH.selectedId) showStudentDetail(SEARCH.selectedId);
}

document.querySelectorAll('.time-quick .btn').forEach((b) => {
  b.addEventListener('click', () => setTimeMode(b.dataset.t));
});
el.fGrade.addEventListener('change', () => { renderClassOptions(); refreshAll(); });
el.fClass.addEventListener('change', refreshAll);
el.cApply.addEventListener('click', () => refreshAll());
el.includeNonEnrolled.addEventListener('change', () => refreshAll());

// ---------- 导出 ----------
function openExportModal() {
  const r = getRange();
  el.exStart.value = r.startDate;
  el.exEnd.value = r.endDate;
  el.exError.classList.add('hidden');
  // 教师不显示班级筛选（导出本班）
  el.exClassRow.classList.toggle('hidden', role !== 'admin');
  el.exportModal.classList.remove('hidden');
}

function closeExportModal() { el.exportModal.classList.add('hidden'); }

el.btnExport.addEventListener('click', openExportModal);
el.exCancel.addEventListener('click', closeExportModal);
el.exportModal.addEventListener('click', (e) => { if (e.target === el.exportModal) closeExportModal(); });

document.querySelectorAll('#exportModal [data-quick]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const now = new Date();
    let start, end;
    const t = btn.dataset.quick;
    if (t === 'today') { start = end = now; }
    else if (t === 'week') {
      const diff = now.getDay() === 0 ? 6 : now.getDay() - 1;
      start = new Date(now); start.setDate(now.getDate() - diff);
      end = new Date(start); end.setDate(start.getDate() + 6);
    } else if (t === 'month') { start = new Date(now.getFullYear(), now.getMonth(), 1); end = now; }
    else {
      // 本学期：用学期设置里的配置区间（未配置时回退默认口径）
      const r = semesterRange(now);
      el.exStart.value = r.startDate;
      el.exEnd.value = r.endDate;
      return;
    }
    el.exStart.value = fmtDateInput(start);
    el.exEnd.value = fmtDateInput(end);
  });
});

el.exSubmit.addEventListener('click', () => {
  const start = el.exStart.value;
  const end = el.exEnd.value;
  const classId = role === 'admin' ? el.exClass.value : '';
  const fields = [];
  if (el.fStudent.checked) fields.push('student');
  if (el.fStatus.checked) fields.push('status');
  if (el.fTime.checked) fields.push('time');
  if (el.fMethod.checked) fields.push('method');
  if (el.fReason.checked) fields.push('reason');
  if (!start || !end) return showExErr('请选择开始和结束日期');
  if (start > end) return showExErr('开始日期不能晚于结束日期');
  if (fields.length === 0) return showExErr('请至少勾选一项导出内容');
  const params = new URLSearchParams({ startDate: start, endDate: end, fields: fields.join(',') });
  if (classId) params.set('classId', classId);
  closeExportModal();
  window.location.href = '/api/attendance/analysis/export?' + params.toString();
});

function showExErr(msg) { el.exError.textContent = msg; el.exError.classList.remove('hidden'); }

// ============================================================
// 搜索学生（姓名/学号模糊搜索 → 该生考勤统计 + 签到记录明细）
//   搜索时隐藏默认统计视图，点「清除」恢复默认视图
// ============================================================
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const SEARCH = { keyword: '', students: [], selectedId: null, chart: null };
const DEFAULT_VIEW_IDS = ['statCards', 'termHint', 'sessionNote', 'chartsArea', 'detailPanel'];
let defaultViewHidden = null;   // 进入搜索模式前各区块的显示状态（清除时精确还原）

function setDefaultViewVisible(visible) {
  if (!visible) {
    // 只在"首次进入搜索模式"时记录原状态；连续搜索时不要覆盖，否则会把"已隐藏"当成原状态
    if (!defaultViewHidden) {
      defaultViewHidden = {};
      for (const id of DEFAULT_VIEW_IDS) {
        const n = $(id);
        if (!n) continue;
        defaultViewHidden[id] = n.classList.contains('hidden');
      }
    }
    for (const id of DEFAULT_VIEW_IDS) {
      const n = $(id);
      if (n) n.classList.add('hidden');
    }
  } else if (defaultViewHidden) {
    for (const id of DEFAULT_VIEW_IDS) {
      const n = $(id);
      if (!n) continue;
      n.classList.toggle('hidden', !!defaultViewHidden[id]);
    }
    defaultViewHidden = null;
  }
}

function showSpMsg(msg) {
  if (!el.spMsg) return;
  el.spMsg.textContent = msg;
  el.spMsg.classList.remove('hidden');
}

const SP_STATUS_CLASS = { present: 'present', late: 'late', leave: 'leave', absent: 'absent' };
// 签到方式中文映射（manual → 手动签到、makeup → 补签；其它值保持原样）
const SP_METHOD_LABEL = {
  manual: '手动签到',
  makeup: '补签',
  batch: '批量签到',
  auto: '自动签到',
  seat: '座位表签到',
  column: '按列签到',
  import: '导入',
  // 每天自动签到（v35）：整场保存 + 既有的批量/请假方式（此前未映射 → 明细里显示英文原值）
  save_all: '整场保存',
  batch_all: '全员签到',
  batch_column: '按列签到',
  batch_leave: '批量请假',
};
function methodLabel(m) {
  const k = String(m == null ? '' : m).trim();
  if (!k) return '—';
  return SP_METHOD_LABEL[k] || k;
}
// 签到记录明细分页（每页 20 条）
const SP_PAGE_SIZE = 20;
const SP = { records: [], page: 1 };

function renderSpRecords() {
  const body = el.spRecBody;
  if (!body) return;
  const all = SP.records || [];
  const pages = Math.max(1, Math.ceil(all.length / SP_PAGE_SIZE));
  if (SP.page > pages) SP.page = pages;
  const from = all.length === 0 ? 0 : (SP.page - 1) * SP_PAGE_SIZE + 1;
  const to = Math.min(all.length, SP.page * SP_PAGE_SIZE);
  const slice = all.slice(from === 0 ? 0 : from - 1, to);
  body.innerHTML = all.length
    ? slice.map((x) => `<tr>
        <td class="sp-mono">${escHtml(x.date)}</td>
        <td><span class="sp-st ${SP_STATUS_CLASS[x.status] || ''}">${escHtml(x.statusLabel)}</span></td>
        <td class="sp-mono">${escHtml(x.checkinTime || '—')}</td>
        <td class="sp-method">${escHtml(methodLabel(x.method))}</td>
        <td>${escHtml(x.leaveReason || '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="sp-empty">该时间段没有已结束的签到场次</td></tr>';
  if (el.spRangeInfo) el.spRangeInfo.textContent = `显示 ${from}-${to} 条，共 ${all.length} 条（每页 ${SP_PAGE_SIZE} 条）`;
  if (el.spPageInfo) el.spPageInfo.textContent = `第 ${SP.page} / ${pages} 页`;
  if (el.spPrev) el.spPrev.disabled = SP.page <= 1;
  if (el.spNext) el.spNext.disabled = SP.page >= pages;
}

function renderSpList(list) {
  if (!el.spList) return;
  el.spList.innerHTML = (list || []).map((s) => `
    <button type="button" class="sp-item${String(s.id) === String(SEARCH.selectedId) ? ' active' : ''}" data-sid="${s.id}">
      <span class="sp-item-name">${escHtml(s.name || '—')}</span>
      <span class="sp-item-no">${escHtml(s.studentNo || '—')}</span>
      <span class="sp-item-cls">${escHtml(s.className || '未分班')}</span>
    </button>`).join('');
  el.spList.classList.toggle('hidden', !(list || []).length);
}

// 出勤构成饼图：居中 200px，自定义图例（颜色块 + 状态名 + 数量 + 百分比）
const SP_CHART_COLORS = { present: '#10b981', late: '#3b82f6', leave: '#f59e0b', absent: '#ef4444' };
const SP_CHART_LABELS = { present: '已签到', late: '迟到', leave: '请假', absent: '缺勤' };

function renderSpChart(stats) {
  if (!el.spChart || typeof Chart === 'undefined') return;
  const keys = ['present', 'late', 'leave', 'absent'];
  const values = keys.map((k) => Number(stats[k]) || 0);
  const total = values.reduce((s, v) => s + v, 0);
  if (SEARCH.chart) { SEARCH.chart.destroy(); SEARCH.chart = null; }
  SEARCH.chart = new Chart(el.spChart, {
    type: 'doughnut',
    data: {
      labels: keys.map((k) => SP_CHART_LABELS[k]),
      datasets: [{
        data: values,
        backgroundColor: keys.map((k) => SP_CHART_COLORS[k]),
        borderWidth: 2,
        borderColor: '#fff',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '55%',
      plugins: {
        legend: { display: false },   // 图例用页面内的 HTML 渲染（带数量与百分比）
        tooltip: { callbacks: { label: (c) => `${c.label}：${c.parsed} 次（${total ? Math.round((c.parsed / total) * 1000) / 10 : 0}%）` } },
      },
    },
  });
  if (el.spChartLegend) {
    el.spChartLegend.innerHTML = keys.map((k) => {
      const n = Number(stats[k]) || 0;
      const pct = total ? Math.round((n / total) * 1000) / 10 : 0;
      return `<div class="sp-legend-item" data-key="${k}">
        <i style="background:${SP_CHART_COLORS[k]}"></i>
        <span class="lg-name">${SP_CHART_LABELS[k]}</span>
        <span class="lg-num">${n} 次</span>
        <span class="lg-pct">${pct}%</span>
      </div>`;
    }).join('');
  }
}

async function showStudentDetail(id) {
  SEARCH.selectedId = id;
  renderSpList(SEARCH.students);
  if (el.spMsg) el.spMsg.classList.add('hidden');
  if (el.spDetail) el.spDetail.classList.remove('hidden');
  const r = getRange();
  const params = new URLSearchParams({ startDate: r.startDate, endDate: r.endDate });
  try {
    const d = await apiFetch('/api/attendance/student/' + id + '/detail?' + params.toString());
    if (el.spName) el.spName.textContent = d.student.name || '—';
    if (el.spNo) el.spNo.textContent = d.student.studentNo || '—';
    if (el.spClass) el.spClass.textContent = d.student.className || '未分班';
    if (el.spRange) el.spRange.textContent = `统计区间 ${d.range.startDate} ~ ${d.range.endDate}（${d.range.sessions} 场）`;
    if (el.spExpected) el.spExpected.textContent = d.stats.expected;
    if (el.spAttended) el.spAttended.textContent = d.stats.attended;
    if (el.spLeave) el.spLeave.textContent = d.stats.leave;
    if (el.spAbsent) el.spAbsent.textContent = d.stats.absent;
    if (el.spRate) el.spRate.textContent = d.stats.rate === null ? '—' : d.stats.rate + '%';
    // 出勤率卡片按数值变色：≥90% 绿 / 70-90% 橙 / <70% 红
    if (el.spRateCard) {
      const rt = d.stats.rate;
      el.spRateCard.classList.toggle('lv-mid', rt !== null && rt < 90 && rt >= 70);
      el.spRateCard.classList.toggle('lv-low', rt !== null && rt < 70);
    }
    SP.records = d.records || [];
    SP.page = 1;
    renderSpRecords();
    renderSpChart(d.stats);
  } catch (e) {
    if (el.spDetail) el.spDetail.classList.add('hidden');
    showSpMsg('加载学生考勤失败：' + e.message);
  }
}

async function doStudentSearch() {
  const kw = (el.stKeyword && el.stKeyword.value ? el.stKeyword.value : '').trim();
  if (!kw) { showToast('请输入学生姓名或学号'); if (el.stKeyword) el.stKeyword.focus(); return; }
  SEARCH.keyword = kw;
  SEARCH.selectedId = null;
  SEARCH.students = [];
  if (el.studentPanel) el.studentPanel.classList.remove('hidden');
  setDefaultViewVisible(false);
  if (el.spKeyword) el.spKeyword.textContent = kw;
  if (el.spMsg) el.spMsg.classList.add('hidden');
  if (el.spDetail) el.spDetail.classList.add('hidden');
  if (el.spCount) el.spCount.textContent = '搜索中…';
  renderSpList([]);
  const params = new URLSearchParams({ keyword: kw });
  // 搜索范围跟随当前筛选：选了具体班级按班级；否则按年级（管理员）；教师后端自动限本班
  if (role === 'admin') {
    if (el.fClass && el.fClass.value) params.set('classId', el.fClass.value);
    else if (el.fGrade && el.fGrade.value) params.set('grade', el.fGrade.value);
  }
  if (el.includeNonEnrolled && el.includeNonEnrolled.checked) params.set('includeNonEnrolled', '1');
  try {
    const d = await apiFetch('/api/attendance/student/search?' + params.toString());
    SEARCH.students = d.students || [];
    if (!d.total) {
      if (el.spCount) el.spCount.textContent = '';
      showSpMsg('未找到该学生' + (/^\d/.test(kw) ? '（学号）' : '（姓名）') + '：' + kw);
      return;
    }
    if (el.spCount) el.spCount.textContent = `找到 ${d.total} 名学生` + (d.total > 1 ? '，点击查看某位学生的考勤' : '');
    renderSpList(SEARCH.students);
    if (d.total === 1) await showStudentDetail(SEARCH.students[0].id);
  } catch (e) {
    if (el.spCount) el.spCount.textContent = '';
    showSpMsg('搜索失败：' + e.message);
  }
}

function clearStudentSearch() {
  SEARCH.keyword = '';
  SEARCH.students = [];
  SEARCH.selectedId = null;
  if (el.stKeyword) el.stKeyword.value = '';
  if (el.studentPanel) el.studentPanel.classList.add('hidden');
  if (SEARCH.chart) { SEARCH.chart.destroy(); SEARCH.chart = null; }
  setDefaultViewVisible(true);
}

if (el.btnStSearch) el.btnStSearch.addEventListener('click', doStudentSearch);
if (el.stKeyword) el.stKeyword.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doStudentSearch(); } });
if (el.btnStClear) el.btnStClear.addEventListener('click', clearStudentSearch);
if (el.btnStClear2) el.btnStClear2.addEventListener('click', clearStudentSearch);
if (el.spList) el.spList.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-sid]');
  if (btn) showStudentDetail(btn.dataset.sid);
});
// 签到记录明细分页
if (el.spPrev) el.spPrev.addEventListener('click', () => { if (SP.page > 1) { SP.page--; renderSpRecords(); } });
if (el.spNext) el.spNext.addEventListener('click', () => {
  const pages = Math.max(1, Math.ceil((SP.records || []).length / SP_PAGE_SIZE));
  if (SP.page < pages) { SP.page++; renderSpRecords(); }
});

// ---------- 用户菜单（个人中心 / 帮助文档 / 退出登录）----------
// 顶部导航栏（含右上角用户菜单）由统一组件 navbar.js 渲染与接管，页面脚本不再重复绑定。
el.btnBack.addEventListener('click', () => { window.location.href = '/dashboard'; });

// ---------- 初始化 ----------
(async function init() {
  try {
    const me = await apiFetch('/api/auth/me');
    role = me.user.role;
    el.userInfo.textContent = displayNameForNav(me.user);
  } catch (_) {}
  if (role !== 'admin') {
    // 教师/学生：隐藏年级与班级筛选（教师固定看自己班），隐藏排行榜/年级对比图表、班级分页
    el.fGradeWrap.classList.add('hidden');
    el.fClassWrap.classList.add('hidden');
    el.rankCard.classList.add('hidden');
    el.gradeCard.classList.add('hidden');
    el.classPagination.classList.add('hidden');
    el.scRateLabel.textContent = role === 'teacher' ? '本班出勤率' : '个人出勤率';
  }
  // 学期设置（「本学期」口径）先取，再首次刷新，避免首屏用了默认口径
  try { termCfg = await apiFetch('/api/term'); } catch (_) { termCfg = null; }
  updateTermHint();
  await loadClasses();
  await refreshAll();
})();
