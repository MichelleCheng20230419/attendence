// ============================================================
// 课堂表现页（/performance）：点名记录 + 点赞数据
//   角色范围（服务端强制）：
//     班长  本班全部学科（不可导出）
//     学科老师 本学科（可导出本学科）
//     班主任 本班全部学科（可导出本班）
//     管理员 全校全部学科（可导出全校）
// ============================================================
'use strict';

const $ = (id) => document.getElementById(id);
const el = {
  btnBack: $('btnBack'), btnRefresh: $('btnRefresh'),
  pfGrade: $('pfGrade'), pfClass: $('pfClass'), pfSubject: $('pfSubject'), pfQuick: $('pfQuick'),
  pfFrom: $('pfFrom'), pfTo: $('pfTo'), pfApply: $('pfApply'), pfScope: $('pfScope'), pfTermHint: $('pfTermHint'),
  pfRecCount: $('pfRecCount'), pfRecBody: $('pfRecBody'),
  pfLikeCount: $('pfLikeCount'), pfLikeBody: $('pfLikeBody'),
  pfExportRec: $('pfExportRec'), pfExportLike: $('pfExportLike'),
  pfToast: $('pfToast'),
};

const state = {
  options: null,
  period: 'all',
  from: '',
  to: '',
  academicYear: null,     // /api/settings → 当前学年（用于取 /api/grades）
};
let loadSeq = 0;          // 筛选请求序号（防旧结果覆盖新筛选）

let toastTimer = null;
function showToast(msg, ms = 2600) {
  el.pfToast.textContent = msg;
  el.pfToast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.pfToast.classList.add('hidden'), ms);
}
async function apiFetch(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('未登录，请重新登录'); }
  let data = null; try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) ? data.error : `请求失败（${res.status}）`);
  return data;
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const pad2 = (n) => String(n).padStart(2, '0');
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 当前筛选 → 查询串
function buildQuery(extra = {}) {
  const q = new URLSearchParams();
  if (el.pfClass.value) q.set('classId', el.pfClass.value);
  else {
    // 年级联动：班级=全部班级 时把该年级的可见班级整体传给后端，
    // 否则后端按"全部可见班级"取数，年级筛选对结果不生效
    const ids = gradeScopedClasses().map((c) => c.classId);
    if (el.pfGrade && el.pfGrade.value && ids.length) q.set('classIds', ids.join(','));
  }
  if (el.pfSubject.value) q.set('subject', el.pfSubject.value);
  if (state.from && state.to) { q.set('from', state.from); q.set('to', state.to); }
  else if (state.period && state.period !== 'all') q.set('period', state.period);
  Object.entries(extra).forEach(([k, v]) => { if (v) q.set(k, v); });
  return q.toString();
}

// ---------- 年级 → 班级 联动 ----------
//   年级数据来源：GET /api/grades?academic_year=当前学年（取年级名称与顺序）
//   可见年级 = 上述年级 ∩ 当前账号可查看班级所属年级（不会越权显示）
function gradeKeyOf(c) {
  if (c.gradeId !== undefined && c.gradeId !== null && c.gradeId !== '') return String(c.gradeId);
  return c.grade ? 'name:' + c.grade : '';
}

// 当前年级筛选下可见的班级（未选年级=全部可见班级）
function gradeScopedClasses() {
  const list = (state.options && state.options.classes) || [];
  const g = el.pfGrade ? el.pfGrade.value : '';
  if (!g) return list;
  return list.filter((c) => gradeKeyOf(c) === g);
}

async function currentAcademicYear() {
  if (state.academicYear !== null) return state.academicYear;
  try {
    const s = await apiFetch('/api/settings');
    state.academicYear = s.currentAcademicYear || '';
  } catch (_) { state.academicYear = ''; }
  return state.academicYear;
}

async function loadGradeOptions() {
  const have = new Map();     // 可见班级推导出的年级（兜底）
  ((state.options && state.options.classes) || []).forEach((c) => {
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
  } catch (_) { /* 无权限（如班长）或接口异常 → 用班级列表推导 */ }
  have.forEach((name, k) => { if (!seen.has(k)) seen.set(k, name); });
  return seen;
}

async function renderGradeOptions() {
  if (!el.pfGrade) return;
  const grades = await loadGradeOptions();
  const cur = el.pfGrade.value;
  el.pfGrade.innerHTML = '<option value="">全部年级</option>' +
    [...grades.entries()].map(([k, name]) => `<option value="${escHtml(k)}">${escHtml(name)}</option>`).join('');
  el.pfGrade.value = (cur && grades.has(cur)) ? cur : '';           // 默认「全部年级」
  el.pfGrade.disabled = grades.size === 0;
}

function renderClassOptions() {
  const list = gradeScopedClasses();
  const hasAllOption = list.length > 1 || !!(state.options && state.options.isAdmin);
  const cur = el.pfClass.value;
  el.pfClass.innerHTML = list.length
    ? (hasAllOption ? '<option value="">全部班级</option>' : '') +
      list.map((c) => `<option value="${c.classId}">${escHtml(c.className)}${c.grade ? '（' + escHtml(c.grade) + '）' : ''}${c.role === 'head_teacher' ? ' · 班主任' : (c.role === 'subject_teacher' ? ' · 任课' : '')}</option>`).join('')
    : '<option value="">（无可查看班级）</option>';
  if (list.length === 0) { el.pfClass.disabled = true; return; }
  if (hasAllOption) {
    el.pfClass.disabled = false;
    // 保留仍然有效的选择（含空值=全部班级），否则回到「全部班级」
    el.pfClass.value = (cur && list.some((c) => String(c.classId) === cur)) ? cur : '';
  } else {
    el.pfClass.disabled = true;      // 只有唯一班级：锁定
    el.pfClass.value = String(list[0].classId);
  }
}

function renderSubjectOptions() {
  const list = (state.options && state.options.classes) || [];
  const cid = Number(el.pfClass.value);
  const cur = el.pfSubject.value;
  const cls = list.find((c) => Number(c.classId) === cid);
  let subjects;
  if (cls) {
    subjects = cls.subjects || [];
  } else {
    // 全部班级：取当前年级/范围内各班级学科并集（任课老师仍只看到自己所教学科）
    const union = [];
    gradeScopedClasses().forEach((c) => (c.subjects || []).forEach((s) => { if (!union.includes(s)) union.push(s); }));
    subjects = union.length ? union : ((state.options && state.options.subjects) || []);
  }
  el.pfSubject.innerHTML = '<option value="">全部学科</option>' + subjects.map((s) => `<option>${escHtml(s)}</option>`).join('');
  if (cur && subjects.includes(cur)) el.pfSubject.value = cur;
  // 学科老师只能看本学科：只有一个可选学科时直接锁定
  const onlyOne = subjects.length === 1;
  if (onlyOne) el.pfSubject.value = subjects[0];
  el.pfSubject.disabled = onlyOne;
}

async function loadOptions() {
  const d = await apiFetch('/api/performance/options');
  state.options = d;
  el.pfScope.textContent = d.scopeLabel + (d.isMonitor ? '（班长只读）' : '');
  await renderGradeOptions();
  renderClassOptions();
  renderSubjectOptions();
  el.pfExportRec.classList.toggle('hidden', !d.canExport);
  el.pfExportLike.classList.toggle('hidden', !d.canExport);
}

// 「本学期」提示：口径来自 系统管理 → 学年管理 → 学期设置（后端 termConfigured/termStart/termEnd）
function renderTermHint(d) {
  const hint = el.pfTermHint;
  if (!hint) return;
  if (state.period !== 'term') { hint.classList.add('hidden'); hint.textContent = ''; return; }
  hint.classList.remove('hidden');
  if (d && d.termConfigured === false) {
    hint.className = 'pf-term-hint warn';
    hint.textContent = `⚠️ 请先设置当前学期的起止日期：当前「本学期」按默认口径统计（${d.termStart || '—'} ~ ${d.termEnd || '—'}）。管理员可在 系统管理 → 学年管理 → 学期设置 中配置。`;
  } else if (d && d.termStart) {
    hint.className = 'pf-term-hint';
    hint.textContent = `本学期统计区间：${d.termStart} ~ ${d.termEnd}（${d.termLabel || '来自学期设置'}｜来自 系统管理 → 学年管理 → 学期设置）`;
  } else {
    hint.classList.add('hidden');
    hint.textContent = '';
  }
}

async function loadRecords(seq) {
  el.pfRecBody.innerHTML = '<tr><td colspan="8" class="pf-empty">加载中…</td></tr>';
  try {
    const d = await apiFetch('/api/performance/records?' + buildQuery({ limit: 200 }));
    if (seq !== undefined && seq !== loadSeq) return;    // 已有更新的筛选请求 → 丢弃过期结果
    renderTermHint(d);
    const list = d.records || [];
    el.pfRecCount.textContent = `共 ${d.total} 条` + (state.period !== 'all' || state.from ? `（${state.from && state.to ? state.from + ' ~ ' + state.to : state.period === 'week' ? '本周' : state.period === 'month' ? '本月' : '本学期'}）` : '');
    el.pfRecBody.innerHTML = list.length
      ? list.map((r) => `<tr>
          <td>${fmtTime(r.createdAt)}</td>
          <td><b>${escHtml(r.name || '—')}</b></td>
          <td>${escHtml(r.studentNo || '—')}</td>
          <td>${escHtml(r.seatLabel || '未排座')}</td>
          <td><span class="pf-tag">${escHtml(r.subject || '未标学科')}</span></td>
          <td>${escHtml(r.className || '—')}</td>
          <td><span class="pf-tag ${r.scopeLabel === '仅未签到' ? 'absent' : ''}">${escHtml(r.scopeLabel || '')}</span></td>
          <td>${escHtml(r.operatorName || '—')}</td>
        </tr>`).join('')
      : '<tr><td colspan="8" class="pf-empty">该条件下没有点名记录</td></tr>';
  } catch (err) {
    if (seq !== undefined && seq !== loadSeq) return;
    el.pfRecBody.innerHTML = `<tr><td colspan="8" class="pf-empty">加载失败：${escHtml(err.message)}</td></tr>`;
  }
}

async function loadLikes(seq) {
  el.pfLikeBody.innerHTML = '<tr><td colspan="6" class="pf-empty">加载中…</td></tr>';
  try {
    const d = await apiFetch('/api/performance/likes?' + buildQuery());
    if (seq !== undefined && seq !== loadSeq) return;
    const list = d.ranking || [];
    el.pfLikeCount.textContent = list.length ? `共 ${list.length} 名同学获得点赞` : '';
    el.pfLikeBody.innerHTML = list.length
      ? list.map((r) => `<tr>
          <td><span class="pf-rank">${r.rank <= 3 ? '🏅 ' + r.rank : r.rank}</span></td>
          <td><b>${escHtml(r.name || '—')}</b></td>
          <td>${escHtml(r.studentNo || '—')}</td>
          <td>${escHtml(r.seatLabel || '未排座')}</td>
          <td><span class="pf-likes">${r.likes}</span></td>
          <td>${fmtTime(r.lastAt)}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="pf-empty">该条件下还没有点赞数据</td></tr>';
  } catch (err) {
    if (seq !== undefined && seq !== loadSeq) return;
    el.pfLikeBody.innerHTML = `<tr><td colspan="6" class="pf-empty">加载失败：${escHtml(err.message)}</td></tr>`;
  }
}

async function reloadAll() {
  // 序号防串：年级/班级连续切换时旧请求可能后到 → 丢弃过期结果，避免覆盖新筛选
  const seq = ++loadSeq;
  await Promise.all([loadRecords(seq), loadLikes(seq)]);
}

// ---------- 事件 ----------
el.btnBack.addEventListener('click', () => { window.location.href = '/dashboard'; });
el.btnRefresh.addEventListener('click', () => { reloadAll(); showToast('已刷新'); });
el.pfGrade.addEventListener('change', async () => { renderClassOptions(); renderSubjectOptions(); await reloadAll(); });
el.pfClass.addEventListener('change', async () => { renderSubjectOptions(); await reloadAll(); });
el.pfSubject.addEventListener('change', () => { reloadAll(); });
el.pfApply.addEventListener('click', () => {
  state.from = el.pfFrom.value || '';
  state.to = el.pfTo.value || '';
  if ((state.from && !state.to) || (!state.from && state.to)) { showToast('请同时选择开始与结束日期'); return; }
  state.period = state.from ? 'custom' : 'all';
  el.pfQuick.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.period === 'all' && !state.from));
  reloadAll();
});
el.pfQuick.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-period]');
  if (!btn) return;
  state.period = btn.dataset.period;
  state.from = ''; state.to = '';
  el.pfFrom.value = ''; el.pfTo.value = '';
  el.pfQuick.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  reloadAll();
});
[el.pfExportRec, el.pfExportLike].forEach((btn) => {
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (state.options && !state.options.canExport) { showToast('班长不可导出，请老师导出'); return; }
    const type = btn.dataset.type;
    window.open('/api/performance/export?' + buildQuery({ type }), '_blank');
  });
});

// ---------- 初始化 ----------
(async function init() {
  try {
    await loadOptions();
    await reloadAll();
  } catch (err) {
    showToast('加载失败：' + err.message);
  }
})();
