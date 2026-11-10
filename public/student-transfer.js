// ============================================================
// 学生异动页面逻辑（/admin/student-transfer，仅管理员/教师）
// 布局：左栏执行异动（年级/班级/学生搜索 + 类型按钮组 + 动态表单）
//       右栏学生信息预览；下方异动历史（筛选 + 分页 + 导出）
// ============================================================
'use strict';

const PAGE_SIZE = 10;
const TYPE_CLASS = { 转班: 'zb', 休学: 'xx', 复学: 'fx', 转学: 'zx', 退学: 'tx' };

const $ = (id) => document.getElementById(id);
const el = {
  btnBack: $('btnBack'),
  btnUser: $('btnUser'),
  userInfoNav: $('userInfoNav'),
  userDropdown: $('userDropdown'),
  menuProfile: $('menuProfile'),
  menuLogout: $('menuLogout'),
  opAvatar: $('opAvatar'),
  userInfo: $('userInfo'),
  currentClassInfo: $('currentClassInfo'),
  currentClassName: $('currentClassName'),

  // 执行异动
  tfGrade: $('tfGrade'),
  tfClass: $('tfClass'),
  tfSearch: $('tfSearch'),
  tfSearchList: $('tfSearchList'),
  tfTypeBtns: $('tfTypeBtns'),
  tfTypeForm: $('tfTypeForm'),
  tfError: $('tfError'),
  tfSubmit: $('tfSubmit'),
  previewArea: $('previewArea'),

  // 历史记录
  tfHistoryClass: $('tfHistoryClass'),
  tfFrom: $('tfFrom'),
  tfTo: $('tfTo'),
  tfQuery: $('tfQuery'),
  btnExportHistory: $('btnExportHistory'),
  historyBody: $('historyBody'),
  pagePrev: $('pagePrev'),
  pageNext: $('pageNext'),
  pageInfo: $('pageInfo'),
  confirmModal: $('confirmModal'),
  confirmTitle: $('confirmTitle'),
  confirmMessage: $('confirmMessage'),
  confirmCancel: $('confirmCancel'),
  confirmOk: $('confirmOk'),

  // 统计
  statTotal: $('statTotal'),
  statZhuanban: $('statZhuanban'),
  statXiuxue: $('statXiuxue'),
  statFuxue: $('statFuxue'),

  toast: $('toast'),
};

// 导航栏显示名：真实姓名（教师带角色后缀）
function displayNameForNav(u) {
  const nm = (u && (u.realName || u.displayName || u.username)) || '';
  return u && u.role === 'teacher' ? `${nm}（教师）` : nm;
}

let classes = [];
let students = [];        // 当前班级学生
let selectedStudent = null;
let transferType = '转班';
let currentYear = null;
let historyRows = [];
let historyPage = 1;
let currentRole = 'admin';   // 当前角色
let myClassId = null;        // 教师所带班级（管理员为 null）

// ---------- 工具 ----------
let toastTimer = null;
function showToast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), ms);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 通用确认弹窗 ----------
let confirmAction = null;
function openConfirm(title, message, onOk) {
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  confirmAction = onOk;
  el.confirmModal.classList.remove('hidden');
}
function closeConfirm() { el.confirmModal.classList.add('hidden'); confirmAction = null; }
el.confirmOk.addEventListener('click', () => { const fn = confirmAction; closeConfirm(); if (fn) fn(); });
el.confirmCancel.addEventListener('click', closeConfirm);
el.confirmModal.addEventListener('click', (e) => { if (e.target === el.confirmModal) closeConfirm(); });

function fmtDateInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function currentYearClasses() {
  return currentYear
    ? classes.filter((c) => !c.academicYear || c.academicYear === currentYear)
    : classes;
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('未登录'); }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) ? data.error : `请求失败（${res.status}）`);
  return data;
}

// ---------- 年级 / 班级联动 ----------
// 年级下拉数据源：grades 表（GET /api/grades?academicYear=当前学年），与年级管理页共享
async function loadClasses() {
  const d = await apiFetch('/api/classes');
  classes = d.classes || [];
  currentYear = d.currentAcademicYear || null;
  if (currentRole === 'teacher' && myClassId) {
    // 教师：只显示本班（下拉锁定）
    const myClass = classes.find((c) => c.id === myClassId);
    el.tfGrade.innerHTML = `<option value="">${myClass ? myClass.grade : '未绑定班级'}</option>`;
    el.tfGrade.disabled = true;
    el.tfClass.innerHTML = `<option value="${myClassId}" selected>${myClass ? myClass.className : ''}</option>`;
    el.tfClass.disabled = true;
    el.tfClass.dispatchEvent(new Event('change'));
    return;
  }
  // 管理员：年级从 grades 表读取（当前学年）
  let gradeList = [];
  try {
    const gd = await apiFetch('/api/grades?academicYear=' + encodeURIComponent(currentYear || ''));
    gradeList = gd.grades || [];
  } catch (_) { gradeList = []; }
  el.tfGrade.disabled = false;
  el.tfClass.disabled = false;
  if (!gradeList.length) {
    el.tfGrade.innerHTML = '<option value="">暂无年级</option>';
    el.tfClass.innerHTML = '<option value="">请选择班级</option>';
    return;
  }
  // 渲染年级（无"请选择"占位 → 默认选中第一个）；value 用 grade_id 保证与班级可靠关联
  el.tfGrade.innerHTML = gradeList.map((g) => `<option value="${g.id}">${g.grade_name}</option>`).join('');
  // 联动班级 + 默认加载第一个年级的学生
  renderClassOptions();
  el.tfClass.dispatchEvent(new Event('change'));
}

function renderClassOptions() {
  // 教师：固定本班（loadClasses 已设置，此处防御）
  if (currentRole === 'teacher' && myClassId) {
    const my = classes.filter((c) => c.id === myClassId);
    el.tfClass.innerHTML = `<option value="${myClassId}" selected>${my[0] ? my[0].className : ''}</option>`;
    return;
  }
  const gradeId = Number(el.tfGrade.value);
  const list = currentYearClasses().filter((c) => !gradeId || c.gradeId === gradeId);
  el.tfClass.innerHTML = '<option value="">请选择班级</option>' +
    list.map((c) => `<option value="${c.id}">${c.className}</option>`).join('');
}

el.tfGrade.addEventListener('change', () => {
  renderClassOptions();
  resetSelection();
  loadStudents();
});

el.tfClass.addEventListener('change', () => {
  resetSelection();
  loadStudents();
  refreshTargetOptions(); // 换班级后刷新目标班级（年级可能变化）
});

// ---------- 学生选择（搜索组合框） ----------
function resetSelection() {
  selectedStudent = null;
  el.tfSearch.value = '';
  el.tfSearchList.classList.add('hidden');
  renderPreview();
}

async function loadStudents() {
  const classId = el.tfClass.value;
  if (!classId) {
    students = [];
    el.tfSearchList.innerHTML = '<div class="combobox-empty">请先选择年级和班级</div>';
    return;
  }
  try {
    const d = await apiFetch('/api/students?classId=' + classId);
    students = d.students || [];
    if (!students.length) {
      el.tfSearchList.innerHTML = '<div class="combobox-empty">该班级暂无学生</div>';
    } else {
      renderSearchList();
    }
  } catch (err) {
    el.tfSearchList.innerHTML = `<div class="combobox-empty">${escapeHtml(err.message)}</div>`;
  }
}

function renderSearchList() {
  const kw = el.tfSearch.value.trim().toLowerCase();
  let matched = students;
  if (kw) {
    matched = students.filter((s) =>
      s.name.toLowerCase().includes(kw) || s.studentNo.toLowerCase().includes(kw)
    );
  }
  if (!matched.length) {
    el.tfSearchList.innerHTML = '<div class="combobox-empty">无匹配学生</div>';
    return;
  }
  el.tfSearchList.innerHTML = matched.slice(0, 60).map((s) => `
    <div class="combobox-item" data-id="${s.id}">
      <span class="no">${escapeHtml(s.studentNo)} - ${escapeHtml(s.name)}</span>
      <span class="st tag ${s.status === '在读' ? 'tag-enroll' : 'tag-other'}">${escapeHtml(s.status || '在读')}</span>
    </div>`).join('');
}

function selectStudent(s) {
  selectedStudent = s;
  el.tfSearch.value = `${s.studentNo} - ${s.name}`;
  el.tfSearchList.classList.add('hidden');
  renderPreview();
  refreshTargetOptions(); // 转班目标班级依赖学生所在班级的年级
}

// 刷新目标班级下拉（转班/复学时）
function refreshTargetOptions() {
  const node = $('tfTargetClass');
  if (node && ['转班', '复学'].includes(transferType)) {
    node.innerHTML = targetClassOptions();
  }
}

el.tfSearch.addEventListener('focus', () => {
  if (!el.tfClass.value) {
    el.tfSearchList.innerHTML = '<div class="combobox-empty">请先选择年级和班级</div>';
    el.tfSearchList.classList.remove('hidden');
    return;
  }
  renderSearchList();
  el.tfSearchList.classList.remove('hidden');
});

el.tfSearch.addEventListener('input', () => {
  if (selectedStudent && el.tfSearch.value !== `${selectedStudent.studentNo} - ${selectedStudent.name}`) {
    selectedStudent = null;
    renderPreview();
  }
  renderSearchList();
  el.tfSearchList.classList.remove('hidden');
});

el.tfSearch.addEventListener('blur', () => {
  setTimeout(() => el.tfSearchList.classList.add('hidden'), 160);
});

el.tfSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') el.tfSearchList.classList.add('hidden');
});

el.tfSearchList.addEventListener('click', (e) => {
  const item = e.target.closest('.combobox-item');
  if (!item) return;
  const s = students.find((x) => x.id === Number(item.dataset.id));
  if (s) selectStudent(s);
});

// ---------- 学生信息预览（右栏卡片） ----------
function renderPreview() {
  if (!selectedStudent) {
    el.previewArea.innerHTML = `
      <div class="preview-empty">
        <div class="big">👤</div>
        请先在左侧选择学生<br>选中后这里将显示学生信息卡片
      </div>`;
    return;
  }
  const s = selectedStudent;
  const initial = escapeHtml((s.name || '?').charAt(0));
  const stTag = s.status === '在读' ? 'tag-enroll' : 'tag-other';
  el.previewArea.innerHTML = `
    <div class="stu-card">
      <div class="avatar">${initial}</div>
      <div class="meta">
        <div class="name">${escapeHtml(s.name)} <span class="tag ${stTag}">${escapeHtml(s.status || '在读')}</span></div>
        <div class="sub">学号：<span class="val">${escapeHtml(s.studentNo)}</span></div>
      </div>
    </div>
    <div class="info-list">
      <div class="item"><label>班级</label><b>${escapeHtml(s.className || '未分班')}</b></div>
      <div class="item"><label>当前状态</label><b>${escapeHtml(s.status || '在读')}</b></div>
      <div class="item"><label>家长电话</label><b>${escapeHtml(s.phone || '—')}</b></div>
      <div class="item"><label>性别</label><b>${escapeHtml(s.gender || '—')}</b></div>
    </div>`;
}

// ---------- 异动类型按钮组 + 动态表单 ----------
el.tfTypeBtns.addEventListener('click', (e) => {
  const btn = e.target.closest('.type-btn');
  if (!btn) return;
  transferType = btn.dataset.type;
  el.tfTypeBtns.querySelectorAll('.type-btn').forEach((b) => b.classList.toggle('active', b === btn));
  buildTypeForm();
});

// 重建动态表单时保留已填内容
function captureTypeForm() {
  const v = {};
  ['tfTargetClass', 'tfResumeDate', 'tfReason', 'tfDestination', 'tfDate'].forEach((id) => {
    const node = $(id);
    if (node) v[id] = node.value;
  });
  return v;
}

function restoreTypeForm(saved) {
  Object.entries(saved).forEach(([id, val]) => {
    const node = $(id);
    if (node && val) node.value = val;
  });
}

// 目标班级下拉选项：
//  - 转班：当前学生所在年级的其他班级（排除原班）
//  - 复学：当前学年所有班级（不限制年级，排除原班）
function targetClassOptions() {
  const base = currentYearClasses().filter((c) => c.status !== 'archived');
  const myClassId = Number(el.tfClass.value);
  let list;
  if (transferType === '转班') {
    const myClass = classes.find((c) => c.id === myClassId);
    const gradeId = myClass ? myClass.gradeId : null;
    list = base.filter((c) => c.gradeId === gradeId && c.id !== myClassId);
  } else { // 复学
    list = base.filter((c) => c.id !== myClassId);
  }
  if (list.length === 0) {
    return `<option value="">${transferType === '转班' ? '该年级暂无其他班级' : '暂无班级可选'}</option>`;
  }
  return '<option value="">请选择目标班级</option>' +
    list.map((c) => `<option value="${c.id}">${c.className}</option>`).join('');
}

function buildTypeForm() {
  const saved = captureTypeForm();
  const targetOpts = targetClassOptions();
  let html = '';
  if (transferType === '转班') {
    html += `<div class="form-row"><label>目标班级 *</label><select id="tfTargetClass">${targetOpts}</select></div>`;
  } else if (transferType === '休学') {
    html += `<div class="form-row"><label>预计复学时间 *</label><input type="date" id="tfResumeDate"></div>`;
    html += `<div class="form-row"><label>事由</label><input type="text" id="tfReason" maxlength="200" placeholder="如 因病休学"></div>`;
  } else if (transferType === '复学') {
    html += `<div class="form-row"><label>返校班级 *</label><select id="tfTargetClass">${targetOpts}</select></div>`;
  } else if (transferType === '转学') {
    html += `<div class="form-row"><label>转学去向 *</label><input type="text" id="tfDestination" maxlength="100" placeholder="如 上海市第一中学"></div>`;
    html += `<div class="form-row"><label>事由</label><input type="text" id="tfReason" maxlength="200" placeholder="如 随父母工作迁移"></div>`;
  } else { // 退学
    html += `<div class="form-row"><label>事由</label><input type="text" id="tfReason" maxlength="200" placeholder="如 个人原因退学"></div>`;
  }
  html += `<div class="form-row"><label>生效日期 *（默认今天）</label><input type="date" id="tfDate"></div>`;
  el.tfTypeForm.innerHTML = html;
  restoreTypeForm(saved);
  if (!$('tfDate').value) $('tfDate').value = fmtDateInput(new Date());
}

// ---------- 执行异动 ----------
function showTfErr(msg) {
  el.tfError.textContent = msg;
  el.tfError.classList.remove('hidden');
}

el.tfSubmit.addEventListener('click', async () => {
  el.tfError.classList.add('hidden');
  if (!selectedStudent) return showTfErr('请先选择学生（先选年级和班级，再搜索学生）');
  const toClassId = ['转班', '复学'].includes(transferType) ? Number($('tfTargetClass').value) : null;
  const reason = $('tfReason') ? $('tfReason').value.trim() : '';
  const destination = $('tfDestination') ? $('tfDestination').value.trim() : '';
  const resumeDate = $('tfResumeDate') ? $('tfResumeDate').value : '';
  const effectiveDate = $('tfDate').value;

  if (['转班', '复学'].includes(transferType) && !toClassId) {
    return showTfErr(transferType === '复学' ? '请选择返校班级' : '请选择目标班级');
  }
  if (transferType === '休学' && !resumeDate) return showTfErr('请选择预计复学时间');
  if (transferType === '转学' && !destination) return showTfErr('请填写转学去向');
  if (!effectiveDate) return showTfErr('请选择生效日期');

  // 表结构无独立字段：休学/转学把关键信息并入事由，避免丢失
  let finalReason = reason;
  if (transferType === '休学' && resumeDate) {
    finalReason = reason ? `${reason}（预计复学：${resumeDate}）` : `预计复学：${resumeDate}`;
  }
  if (transferType === '转学' && destination) {
    finalReason = reason ? `${reason}（转学去向：${destination}）` : `转学去向：${destination}`;
  }

  try {
    const data = await apiFetch('/api/transfers', {
      method: 'POST',
      body: JSON.stringify({
        studentId: selectedStudent.id,
        transferType,
        toClassId,
        reason: finalReason,
        effectiveDate,
      }),
    });
    showToast(`异动成功：${transferType} → ${selectedStudent.name}`);
    resetSelection();
    await loadStudents();
    await loadStats();
    await loadHistory();
  } catch (err) { showTfErr(err.message); }
});

// ---------- 历史记录（筛选 + 分页 + 导出） ----------
async function loadHistory() {
  try {
    const q = new URLSearchParams();
    if (el.tfHistoryClass.value) q.set('classId', el.tfHistoryClass.value);
    if (el.tfFrom.value) q.set('startDate', el.tfFrom.value);
    if (el.tfTo.value) q.set('endDate', el.tfTo.value);
    const d = await apiFetch('/api/transfers?' + q.toString());
    historyRows = d.transfers || [];
    historyPage = 1;
    renderHistory();
  } catch (err) {
    el.historyBody.innerHTML = `<tr><td colspan="9" class="plan-empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderHistory() {
  const total = historyRows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (historyPage > totalPages) historyPage = totalPages;
  const start = (historyPage - 1) * PAGE_SIZE;
  const pageRows = historyRows.slice(start, start + PAGE_SIZE);

  if (!pageRows.length) {
    el.historyBody.innerHTML = '<tr><td colspan="9" class="plan-empty">暂无异动记录</td></tr>';
  } else {
    el.historyBody.innerHTML = pageRows.map((r, i) => {
      const delBtn = currentRole === 'admin'
        ? `<button type="button" class="btn-text del" data-act="tdel" data-id="${r.id}" data-name="${r.studentName}" data-label="${r.transferType}">删除</button>`
        : '<span style="color:#bbb">—</span>';
      return `
      <tr>
        <td>${start + i + 1}</td>
        <td>${String(r.effectiveDate || '').slice(0, 10)}</td>
        <td><b>${escapeHtml(r.studentName)}</b></td>
        <td>${escapeHtml(r.studentNo)}</td>
        <td><span class="tag tag-${TYPE_CLASS[r.transferType] || 'other'}">${escapeHtml(r.transferType)}</span></td>
        <td>${escapeHtml(r.fromClass || '—')} <span style="color:var(--primary)">→</span> ${escapeHtml(r.toClass || '—')}</td>
        <td>${escapeHtml(r.reason || '—')}</td>
        <td>${escapeHtml(r.operatorName || '—')}</td>
        <td>${delBtn}</td>
      </tr>`;
    }).join('');
  }
  el.pageInfo.textContent = `第 ${historyPage} / ${totalPages} 页（共 ${total} 条）`;
  el.pagePrev.disabled = historyPage <= 1;
  el.pageNext.disabled = historyPage >= totalPages;
}

el.tfHistoryClass.addEventListener('change', loadHistory);
el.tfQuery.addEventListener('click', loadHistory);
el.pagePrev.addEventListener('click', () => { if (historyPage > 1) { historyPage -= 1; renderHistory(); } });
el.pageNext.addEventListener('click', () => { historyPage += 1; renderHistory(); });

// 导出历史 Excel（与当前筛选一致）
el.btnExportHistory.addEventListener('click', () => {
  const q = new URLSearchParams();
  if (el.tfHistoryClass.value) q.set('classId', el.tfHistoryClass.value);
  if (el.tfFrom.value) q.set('startDate', el.tfFrom.value);
  if (el.tfTo.value) q.set('endDate', el.tfTo.value);
  window.location.href = '/api/transfers/export?' + q.toString();
});

// 删除异动记录（仅管理员；后端二次校验）
el.historyBody.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act="tdel"]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  openConfirm('删除异动记录', `确定删除 ${btn.dataset.name} 的「${btn.dataset.label}」记录吗？此操作不可恢复。`, async () => {
    try {
      await apiFetch('/api/transfers/' + id, { method: 'DELETE' });
      showToast('异动记录已删除');
      await loadStats();
      await loadHistory();
    } catch (err) {
      showToast('删除失败：' + err.message);
    }
  });
});

// ---------- 本月统计 ----------
async function loadStats() {
  const now = new Date();
  const from = fmtDateInput(new Date(now.getFullYear(), now.getMonth(), 1));
  const to = fmtDateInput(now);
  try {
    const d = await apiFetch(`/api/transfers?startDate=${from}&endDate=${to}`);
    const rows = d.transfers || [];
    const cnt = { total: rows.length, 转班: 0, 休学: 0, 复学: 0 };
    for (const r of rows) {
      if (cnt[r.transferType] !== undefined) cnt[r.transferType] += 1;
    }
    el.statTotal.textContent = cnt.total;
    el.statZhuanban.textContent = cnt['转班'];
    el.statXiuxue.textContent = cnt['休学'];
    el.statFuxue.textContent = cnt['复学'];
  } catch (_) {}
}

// ---------- 用户菜单（个人中心 / 帮助文档 / 退出登录）----------
// 顶部导航栏（含右上角用户菜单）由统一组件 navbar.js 渲染与接管，页面脚本不再重复绑定。
el.btnBack.addEventListener('click', () => { window.location.href = '/dashboard'; });

// ---------- 初始化 ----------
(async function init() {
  try {
    const me = await apiFetch('/api/auth/me');
    const name = displayNameForNav(me.user);
    el.userInfo.textContent = name;
    el.userInfoNav.textContent = name;
    el.opAvatar.textContent = ((me.user.realName || me.user.displayName || me.user.username) || '?').charAt(0);
    currentRole = me.user.role;
    if (currentRole === 'student') { window.location.href = '/dashboard'; return; }
    if (currentRole === 'teacher') {
      myClassId = me.user.classId || null;
      // 教师：显示"当前管理班级"提示，隐藏历史班级筛选（后端已强制本班）
      el.currentClassInfo.classList.remove('hidden');
      el.tfHistoryClass.classList.add('hidden');
    }
  } catch (_) {}

  // 历史筛选默认：本月
  const now = new Date();
  el.tfFrom.value = fmtDateInput(new Date(now.getFullYear(), now.getMonth(), 1));
  el.tfTo.value = fmtDateInput(now);

  // 历史班级筛选（管理员可见）
  try {
    const clsData = await apiFetch('/api/classes');
    el.tfHistoryClass.innerHTML = '<option value="">全部班级</option>' +
      (clsData.classes || []).map((c) => `<option value="${c.id}">${c.className}</option>`).join('');
  } catch (_) {}

  buildTypeForm();
  await loadClasses();
  // 教师：显示所带班级名称
  if (currentRole === 'teacher') {
    const cls = classes.find((c) => c.id === myClassId);
    if (cls) el.currentClassName.textContent = cls.className;
  }
  await loadStats();
  await loadHistory();
})();
