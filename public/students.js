// ============================================================
// 学生管理页面逻辑（/students）
// ============================================================
'use strict';

const PAGE_SIZE = 20;

const $ = (id) => document.getElementById(id);
const el = {
  btnBack: $('btnBack'),
  btnUser: $('btnUser'),
  userInfo: $('userInfo'),
  userDropdown: $('userDropdown'),
  menuProfile: $('menuProfile'),
  menuLogout: $('menuLogout'),
  btnAddStudent: $('btnAddStudent'),
  btnImport: $('btnImport'),
  filterClass: $('filterClass'),
  filterName: $('filterName'),
  filterCount: $('filterCount'),
  studentList: $('studentList'),
  pagePrev: $('pagePrev'),
  pageNext: $('pageNext'),
  pageInfo: $('pageInfo'),
  addStudentModal: $('addStudentModal'),
  asNo: $('asNo'),
  asName: $('asName'),
  asClass: $('asClass'),
  asGender: $('asGender'),
  asBirthDate: $('asBirthDate'),
  asIdCard: $('asIdCard'),
  asNationality: $('asNationality'),
  asPoliticalStatus: $('asPoliticalStatus'),
  asEnrollmentDate: $('asEnrollmentDate'),
  asPhone: $('asPhone'),
  asEmergencyPhone: $('asEmergencyPhone'),
  asEmergencyContact: $('asEmergencyContact'),
  asAddress: $('asAddress'),
  asGraduationSchool: $('asGraduationSchool'),
  asRemarks: $('asRemarks'),
  asError: $('asError'),
  asCancel: $('asCancel'),
  asSubmit: $('asSubmit'),
  editStudentModal: $('editStudentModal'),
  esNo: $('esNo'),
  esName: $('esName'),
  esClass: $('esClass'),
  esGender: $('esGender'),
  esBirthDate: $('esBirthDate'),
  esIdCard: $('esIdCard'),
  esNationality: $('esNationality'),
  esPoliticalStatus: $('esPoliticalStatus'),
  esEnrollmentDate: $('esEnrollmentDate'),
  esPhone: $('esPhone'),
  esEmergencyPhone: $('esEmergencyPhone'),
  esEmergencyContact: $('esEmergencyContact'),
  esAddress: $('esAddress'),
  esGraduationSchool: $('esGraduationSchool'),
  esRemarks: $('esRemarks'),
  esError: $('esError'),
  esCancel: $('esCancel'),
  esSubmit: $('esSubmit'),
  btnColSettings: $('btnColSettings'),
  colPanel: $('colPanel'),
  importModal: $('importModal'),
  importText: $('importText'),
  importFile: $('importFile'),
  importFileInfo: $('importFileInfo'),
  importPreview: $('importPreview'),
  importCancel: $('importCancel'),
  importSubmit: $('importSubmit'),
  btnTransfer: $('btnTransfer'),
  confirmModal: $('confirmModal'),
  confirmTitle: $('confirmTitle'),
  confirmMessage: $('confirmMessage'),
  confirmCancel: $('confirmCancel'),
  confirmOk: $('confirmOk'),
  toast: $('toast'),
};

// 导航栏显示名：真实姓名（教师带角色后缀）
function displayNameForNav(u) {
  const nm = (u && (u.realName || u.displayName || u.username)) || '';
  return u && u.role === 'teacher' ? `${nm}（教师）` : nm;
}

let students = [];
let classes = [];
let currentRole = '';
let currentUserClassId = null;
let page = 1;
let editStudentId = null;

// ---------- 表格列显示配置（本地持久化） ----------
const COL_KEY = 'students_table_cols_v1';
const EXTRA_COLS = ['gender', 'graduationSchool', 'phone'];
function loadColConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(COL_KEY));
    if (Array.isArray(saved)) return EXTRA_COLS.filter((c) => saved.includes(c));
  } catch (_) {}
  return [...EXTRA_COLS]; // 默认全部显示
}
let visibleCols = loadColConfig();

function saveColConfig() {
  localStorage.setItem(COL_KEY, JSON.stringify(visibleCols));
}

function applyColConfig() {
  for (const c of EXTRA_COLS) {
    const show = visibleCols.includes(c);
    const th = document.getElementById('th' + c[0].toUpperCase() + c.slice(1));
    if (th) th.classList.toggle('hidden', !show);
    el.colPanel.querySelector(`input[data-col="${c}"]`).checked = show;
  }
  renderRows(filteredStudents().slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE));
}

el.btnColSettings.addEventListener('click', (e) => {
  e.stopPropagation();
  el.colPanel.classList.toggle('hidden');
});
document.addEventListener('click', () => el.colPanel.classList.add('hidden'));
el.colPanel.addEventListener('click', (e) => {
  const cb = e.target.closest('input[data-col]');
  if (!cb) return;
  const c = cb.dataset.col;
  if (cb.checked) { if (!visibleCols.includes(c)) visibleCols.push(c); }
  else visibleCols = visibleCols.filter((x) => x !== c);
  saveColConfig();
  applyColConfig();
});

// ---------- 工具 ----------
let toastTimer = null;
function showToast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), ms);
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('未登录'); }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) ? data.error : `请求失败（${res.status}）`);
  return data;
}

// ---------- 数据加载 ----------
async function loadClasses() {
  try {
    const data = await apiFetch('/api/classes');
    classes = data.classes || [];
    // 班级下拉（添加/编辑 + 筛选）
    const opts = classes.map((c) => `<option value="${c.id}">${c.className}</option>`).join('');
    el.asClass.innerHTML = '<option value="">请选择班级</option>' + opts;
    el.esClass.innerHTML = '<option value="">请选择班级</option>' + opts;
    el.filterClass.innerHTML = '<option value="">全部班级</option>' +
      classes.map((c) => `<option value="${c.id}">${c.className}</option>`).join('');
  } catch (err) {
    console.error('[班级加载失败]', err.message);
  }
}

async function loadStudents() {
  try {
    // 教师：固定加载自己所带班级的学生（无需班级筛选）
    let url = '/api/students';
    if (currentRole === 'teacher' && currentUserClassId) {
      url += '?classId=' + currentUserClassId;
    }
    const data = await apiFetch(url);
    students = data.students || [];
    applyFilter();
  } catch (err) {
    showToast('加载失败：' + err.message);
  }
}

// ---------- 筛选 / 搜索 / 分页 ----------
function filteredStudents() {
  const cls = el.filterClass.value;
  const kw = el.filterName.value.trim().toLowerCase();
  return students.filter((s) => {
    if (cls && String(s.classId) !== cls) return false;
    if (kw && !s.name.toLowerCase().includes(kw) && !s.studentNo.toLowerCase().includes(kw)) return false;
    return true;
  });
}

function applyFilter() {
  const list = filteredStudents();
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  el.filterCount.textContent = `共 ${list.length} 名学生`;

  const start = (page - 1) * PAGE_SIZE;
  const pageRows = list.slice(start, start + PAGE_SIZE);
  renderRows(pageRows);

  el.pageInfo.textContent = `第 ${page} / ${totalPages} 页`;
  el.pagePrev.disabled = page <= 1;
  el.pageNext.disabled = page >= totalPages;
}

function renderRows(rows) {
  if (rows.length === 0) {
    el.studentList.innerHTML = '<tr><td colspan="7" class="plan-empty">暂无学生</td></tr>';
    return;
  }
  el.studentList.innerHTML = rows.map((s) => {
    const showGender = visibleCols.includes('gender');
    const showGrad = visibleCols.includes('graduationSchool');
    const showPhone = visibleCols.includes('phone');
    const actions = currentRole === 'student'
      ? '<span style="color:#bbb">—</span>'
      : `<button type="button" class="btn-text edit" data-act="edit" data-id="${s.id}">✏️ 编辑</button>` +
        `<button type="button" class="btn-text del" data-act="del" data-id="${s.id}">🗑️ 删除</button>`;
    return `
      <tr>
        <td>${s.studentNo}</td>
        <td><b>${s.name}</b></td>
        <td class="col-gender ${showGender ? '' : 'hidden'}">${s.gender || '-'}</td>
        <td>${s.className || '未分班'}</td>
        <td class="col-graduationSchool ${showGrad ? '' : 'hidden'}">${s.graduationSchool || '-'}</td>
        <td class="col-phone ${showPhone ? '' : 'hidden'}">${s.phone || '-'}</td>
        <td class="td-actions">${actions}</td>
      </tr>`;
  }).join('');
}

el.filterClass.addEventListener('change', () => { page = 1; applyFilter(); });
el.filterName.addEventListener('input', () => { page = 1; applyFilter(); });
el.pagePrev.addEventListener('click', () => { if (page > 1) { page -= 1; applyFilter(); } });
el.pageNext.addEventListener('click', () => { page += 1; applyFilter(); });

// ---------- 表格操作（编辑/删除） ----------
el.studentList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  const s = students.find((x) => x.id === id);
  if (!s) return;
  if (act === 'edit') openEditModal(s);
  else if (act === 'del') deleteStudent(s);
});

// ---------- 添加学生 ----------
function fillClassSelect(select, selectedId) {
  select.innerHTML = '<option value="">请选择班级</option>' +
    classes.map((c) => `<option value="${c.id}" ${selectedId === c.id ? 'selected' : ''}>${c.className}</option>`).join('');
}

function resetAddFields() {
  el.asNo.value = '';
  el.asName.value = '';
  el.asGender.value = '';
  el.asBirthDate.value = '';
  el.asIdCard.value = '';
  el.asNationality.value = '';
  el.asPoliticalStatus.value = '';
  el.asEnrollmentDate.value = '';
  el.asPhone.value = '';
  el.asEmergencyPhone.value = '';
  el.asEmergencyContact.value = '';
  el.asAddress.value = '';
  el.asGraduationSchool.value = '';
  el.asRemarks.value = '';
}

function openAddModal() {
  resetAddFields();
  fillClassSelect(el.asClass, null);
  el.asError.classList.add('hidden');
  el.addStudentModal.classList.remove('hidden');
}

function closeAddModal() { el.addStudentModal.classList.add('hidden'); }

el.btnAddStudent.addEventListener('click', openAddModal);
el.asCancel.addEventListener('click', closeAddModal);
el.addStudentModal.addEventListener('click', (e) => { if (e.target === el.addStudentModal) closeAddModal(); });

el.asSubmit.addEventListener('click', async () => {
  const studentNo = el.asNo.value.trim();
  const name = el.asName.value.trim();
  const classId = Number(el.asClass.value);
  if (!studentNo) return showAddErr('学号不能为空');
  if (studentNo.length > 20) return showAddErr('学号长度不能超过 20 个字符');
  if (!name) return showAddErr('姓名不能为空');
  if (!classId) return showAddErr('必须选择班级');
  if (students.some((s) => s.studentNo === studentNo)) return showAddErr(`学号 ${studentNo} 已存在`);
  try {
    const data = await apiFetch('/api/students', {
      method: 'POST',
      body: JSON.stringify({
        studentNo,
        name,
        classId,
        gender: el.asGender.value,
        birthDate: el.asBirthDate.value,
        idCard: el.asIdCard.value.trim(),
        nationality: el.asNationality.value.trim(),
        politicalStatus: el.asPoliticalStatus.value.trim(),
        enrollmentDate: el.asEnrollmentDate.value,
        phone: el.asPhone.value.trim(),
        emergencyPhone: el.asEmergencyPhone.value.trim(),
        emergencyContact: el.asEmergencyContact.value.trim(),
        address: el.asAddress.value.trim(),
        graduationSchool: el.asGraduationSchool.value.trim(),
        remarks: el.asRemarks.value.trim(),
      }),
    });
    showToast(`已添加学生：${data.student.name}`);
    closeAddModal();
    await loadStudents();
  } catch (err) { showAddErr(err.message); }
});

function showAddErr(msg) { el.asError.textContent = msg; el.asError.classList.remove('hidden'); }

// ---------- 编辑学生 ----------
function openEditModal(s) {
  editStudentId = s.id;
  el.esNo.value = s.studentNo;
  el.esName.value = s.name;
  fillClassSelect(el.esClass, s.classId);
  el.esGender.value = s.gender || '';
  el.esBirthDate.value = s.birthDate || '';
  el.esIdCard.value = s.idCard || '';
  el.esNationality.value = s.nationality || '';
  el.esPoliticalStatus.value = s.politicalStatus || '';
  el.esEnrollmentDate.value = s.enrollmentDate || '';
  el.esPhone.value = s.phone || '';
  el.esEmergencyPhone.value = s.emergencyPhone || '';
  el.esEmergencyContact.value = s.emergencyContact || '';
  el.esAddress.value = s.address || '';
  el.esGraduationSchool.value = s.graduationSchool || '';
  el.esRemarks.value = s.remarks || '';
  el.esError.classList.add('hidden');
  el.editStudentModal.classList.remove('hidden');
}

function closeEditModal() { el.editStudentModal.classList.add('hidden'); editStudentId = null; }

el.esCancel.addEventListener('click', closeEditModal);
el.editStudentModal.addEventListener('click', (e) => { if (e.target === el.editStudentModal) closeEditModal(); });

el.esSubmit.addEventListener('click', async () => {
  const name = el.esName.value.trim();
  const classId = Number(el.esClass.value);
  if (!name) return showEditErr('姓名不能为空');
  if (!classId) return showEditErr('必须选择班级');
  try {
    const data = await apiFetch(`/api/students/${editStudentId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name,
        classId,
        gender: el.esGender.value,
        birthDate: el.esBirthDate.value,
        idCard: el.esIdCard.value.trim(),
        nationality: el.esNationality.value.trim(),
        politicalStatus: el.esPoliticalStatus.value.trim(),
        enrollmentDate: el.esEnrollmentDate.value,
        phone: el.esPhone.value.trim(),
        emergencyPhone: el.esEmergencyPhone.value.trim(),
        emergencyContact: el.esEmergencyContact.value.trim(),
        address: el.esAddress.value.trim(),
        graduationSchool: el.esGraduationSchool.value.trim(),
        remarks: el.esRemarks.value.trim(),
      }),
    });
    showToast(`更新成功：${data.student.name}`);
    closeEditModal();
    await loadStudents();
  } catch (err) { showEditErr(err.message); }
});

function showEditErr(msg) { el.esError.textContent = msg; el.esError.classList.remove('hidden'); }

// ---------- 删除学生 ----------
function deleteStudent(s) {
  openConfirm('删除学生', `确定要删除 ${s.name}（${s.studentNo}）吗？删除后该学生不再出现在签到名单中，考勤/作业等历史记录全部保留；若之后重新导入同一学号，会自动恢复该学生（含历史记录）。`, async () => {
    try {
      await apiFetch(`/api/students/${s.id}`, { method: 'DELETE' });
      showToast(`已删除学生：${s.name}`);
      await loadStudents();
    } catch (err) {
      showToast('删除失败：' + err.message);
    }
  });
}

// ---------- 导入名单 ----------
let importParsed = [];

function parseStudentText(text) {
  const lines = (text || '').split(/\r?\n/);
  const result = [];
  const seen = new Set();
  let invalid = 0;
  // 列顺序：学号,姓名,班级,性别,出生日期,身份证号,民族,政治面貌,家长电话,家庭住址,入学日期,初中毕业学校,紧急联系人,紧急联系人电话,备注
  const FIELD_COLS = [
    ['className', 2],
    ['gender', 3],
    ['birthDate', 4],
    ['idCard', 5],
    ['nationality', 6],
    ['politicalStatus', 7],
    ['phone', 8],
    ['address', 9],
    ['enrollmentDate', 10],
    ['graduationSchool', 11],
    ['emergencyContact', 12],
    ['emergencyPhone', 13],
    ['remarks', 14],
  ];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(学号|姓名|班级|student|name|no|编号|class)/i.test(line) && !/^\d/.test(line)) continue;
    // 含逗号时按逗号分隔（模板 15 列）；否则按空白分隔（兼容 学号 姓名 [班级]）
    const parts = /[,，]/.test(line)
      ? line.split(/[,，]/).map((s) => s.trim())
      : line.split(/[\t\s]+/).filter(Boolean);
    if (parts.length < 2) { invalid += 1; continue; }
    const studentNo = parts[0].trim();
    const name = parts[1].trim();
    if (!studentNo || !name) { invalid += 1; continue; }
    if (seen.has(studentNo)) continue;
    seen.add(studentNo);
    const st = { studentNo, name };
    for (const [key, idx] of FIELD_COLS) {
      const v = (parts[idx] || '').trim();
      if (v) st[key] = v;
    }
    result.push(st);
  }
  return { students: result, invalid };
}

function renderImportPreview() {
  const { students, invalid } = parseStudentText(el.importText.value);
  importParsed = students;
  const first = students.slice(0, 5).map((s) => `${s.studentNo} ${s.name}${s.className ? '（' + s.className + '）' : ''}`).join('、');
  const more = students.length > 5 ? ` 等 ${students.length} 人` : '';
  if (students.length === 0) {
    el.importPreview.textContent = invalid > 0 ? `解析失败 ${invalid} 行（需要 学号+姓名）` : '请输入名单或选择 CSV 文件';
    el.importPreview.className = 'import-preview err';
  } else {
    el.importPreview.textContent = `解析到 ${students.length} 名学生${invalid > 0 ? `，${invalid} 行无效已跳过` : ''}：${first}${more}`;
    el.importPreview.className = 'import-preview ok';
  }
  el.importSubmit.disabled = students.length === 0;
}

function openImportModal() {
  el.importText.value = '';
  el.importFile.value = '';
  el.importFileInfo.textContent = '';
  renderImportPreview();
  el.importModal.classList.remove('hidden');
}

function closeImportModal() { el.importModal.classList.add('hidden'); }

el.btnImport.addEventListener('click', openImportModal);
el.importCancel.addEventListener('click', closeImportModal);
el.importModal.addEventListener('click', (e) => { if (e.target === el.importModal) closeImportModal(); });
el.importText.addEventListener('input', renderImportPreview);

el.importFile.addEventListener('change', () => {
  const file = el.importFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let text = String(reader.result || '');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    el.importText.value = text;
    el.importFileInfo.textContent = `已读取文件：${file.name}（${file.size} 字节）`;
    renderImportPreview();
  };
  reader.readAsText(file, 'UTF-8');
});

el.importSubmit.addEventListener('click', async () => {
  const { students } = parseStudentText(el.importText.value);
  if (students.length === 0) return;
  try {
    const data = await apiFetch('/api/students/import', {
      method: 'POST',
      body: JSON.stringify({ students }),
    });
    closeImportModal();
    let msg = `导入完成：新增 ${data.inserted} 人`;
    if (data.skipped > 0) msg += `，跳过已存在 ${data.skipped} 人`;
    if (data.classNotFound > 0) msg += `，班级不存在 ${data.classNotFound} 人`;
    showToast(msg);
    await loadStudents();
  } catch (err) {
    showToast('导入失败：' + err.message);
  }
});

// ---------- 学生异动（跳转独立页面） ----------
el.btnTransfer.addEventListener('click', () => {
  window.location.href = '/admin/student-transfer';
});

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

// ---------- 用户菜单（个人中心 / 帮助文档 / 退出登录）----------
// 顶部导航栏（含右上角用户菜单）由统一组件 navbar.js 渲染与接管，页面脚本不再重复绑定。
el.btnBack.addEventListener('click', () => { window.location.href = '/dashboard'; });

// ---------- 初始化 ----------
(async function init() {
  try {
    const me = await apiFetch('/api/auth/me');
    el.userInfo.textContent = displayNameForNav(me.user);
    currentRole = me.user.role;
    currentUserClassId = me.user.classId || null;
    if (currentRole === 'student') {
      // 学生只读：隐藏操作按钮
      el.btnAddStudent.classList.add('hidden');
      el.btnImport.classList.add('hidden');
      el.btnTransfer.classList.add('hidden');
    }
    if (currentRole === 'teacher') {
      // 教师只管理自己班级：隐藏班级筛选下拉
      el.filterClass.classList.add('hidden');
    }
  } catch (_) {}
  await loadClasses();
  applyColConfig();
  await loadStudents();
})();
