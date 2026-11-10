// ============================================================
// 后台管理页面逻辑（/admin，仅管理员）
// 标签页：账号 / 年级 / 班级 / 学年
// ============================================================
'use strict';

const ROLE_CN = { admin: '管理员', teacher: '教师', student: '学生', monitor: '班长' };

// 导航栏显示名：真实姓名（教师带角色后缀）
function displayNameForNav(u) {
  const nm = (u && (u.realName || u.displayName || u.username)) || '';
  return u && u.role === 'teacher' ? `${nm}（教师）` : nm;
}

const $ = (id) => document.getElementById(id);
const el = {
  btnBack: $('btnBack'),
  btnUser: $('btnUser'),
  userInfo: $('userInfo'),
  userDropdown: $('userDropdown'),
  menuProfile: $('menuProfile'),
  menuLogout: $('menuLogout'),

  // 账号
  btnAddUser: $('btnAddUser'),
  btnImportUser: $('btnImportUser'),
  // 教师批量导入
  btnTeacherTemplate: $('btnTeacherTemplate'),
  btnTeacherTpl: $('btnTeacherTpl'),
  teacherImportModal: $('teacherImportModal'),
  teacherImportFile: $('teacherImportFile'),
  teacherPreviewWrap: $('teacherPreviewWrap'),
  teacherPreview: $('teacherPreview'),
  teacherResultWrap: $('teacherResultWrap'),
  teacherResult: $('teacherResult'),
  teacherImportSubmit: $('teacherImportSubmit'),
  teacherImportCancel: $('teacherImportCancel'),
  linkLegacyImport: $('linkLegacyImport'),
  userList: $('userList'),
  userModal: $('userModal'),
  userModalTitle: $('userModalTitle'),
  uUsername: $('uUsername'),
  uPassword: $('uPassword'),
  uPasswordRow: $('uPasswordRow'),
  uRealName: $('uRealName'),
  uRealNameRow: $('uRealNameRow'),
  uRole: $('uRole'),
  uClass: $('uClass'),
  uClassRow: $('uClassRow'),
  uSubject: $('uSubject'),
  uTeachBlock: $('uTeachBlock'),
  uTeachList: $('uTeachList'),
  btnAddTeach: $('btnAddTeach'),
  uLockState: $('uLockState'),
  uResetLockRow: $('uResetLockRow'),
  uResetLock: $('uResetLock'),
  uActive: $('uActive'),
  uError: $('uError'),
  uCancel: $('uCancel'),
  uSubmit: $('uSubmit'),
  // 添加带班（年级 → 班级 → 在该班角色）
  teachModal: $('teachModal'),
  tmGrade: $('tmGrade'),
  tmClass: $('tmClass'),
  tmClassNote: $('tmClassNote'),
  tmRole: $('tmRole'),
  tmError: $('tmError'),
  tmCancel: $('tmCancel'),
  tmSubmit: $('tmSubmit'),
  userImportModal: $('userImportModal'),
  userImportFile: $('userImportFile'),
  userImportResult: $('userImportResult'),
  userImportCancel: $('userImportCancel'),
  userImportSubmit: $('userImportSubmit'),
  // 教师任课班级（作业模块）
  tcModal: $('tcModal'),
  tcTeacherId: $('tcTeacherId'),
  tcTeacherName: $('tcTeacherName'),
  tcList: $('tcList'),
  tcError: $('tcError'),
  tcCancel: $('tcCancel'),
  tcSubmit: $('tcSubmit'),

  // 年级
  gradeYearFilter: $('gradeYearFilter'),
  btnAddGrade: $('btnAddGrade'),
  btnImportGrade: $('btnImportGrade'),
  gradeList: $('gradeList'),
  gradeModal: $('gradeModal'),
  gradeModalTitle: $('gradeModalTitle'),
  gName: $('gName'),
  gCode: $('gCode'),
  gYear: $('gYear'),
  gYearRow: $('gYearRow'),
  gError: $('gError'),
  gCancel: $('gCancel'),
  gSubmit: $('gSubmit'),
  gradeImportModal: $('gradeImportModal'),
  gradeImportFile: $('gradeImportFile'),
  gradeImportResult: $('gradeImportResult'),
  gradeImportCancel: $('gradeImportCancel'),
  gradeImportSubmit: $('gradeImportSubmit'),

  // 班级
  clsYearFilter: $('clsYearFilter'),
  clsGradeFilter: $('clsGradeFilter'),
  btnAddClass: $('btnAddClass'),
  btnImportClass: $('btnImportClass'),
  classList: $('classList'),
  classModal: $('classModal'),
  classModalTitle: $('classModalTitle'),
  cName: $('cName'),
  cGrade: $('cGrade'),
  cYear: $('cYear'),
  cYearRow: $('cYearRow'),
  // 选科组合 / 选科科目（v34）
  cStream: $('cStream'),
  cElectives: $('cElectives'),
  cEffectiveSubjects: $('cEffectiveSubjects'),
  cHeadTeacher: $('cHeadTeacher'),
  cDeputyTeacher: $('cDeputyTeacher'),
  cError: $('cError'),
  cCancel: $('cCancel'),
  cSubmit: $('cSubmit'),
  classImportModal: $('classImportModal'),
  classImportFile: $('classImportFile'),
  classImportResult: $('classImportResult'),
  classImportCancel: $('classImportCancel'),
  classImportSubmit: $('classImportSubmit'),

  // 学年
  currentYearVal: $('currentYearVal'),
  switchYearSelect: $('switchYearSelect'),
  btnSwitchYear: $('btnSwitchYear'),
  targetYearInput: $('targetYearInput'),
  modeDesc: $('modeDesc'),
  yearImportRow: $('yearImportRow'),
  yearImportFile: $('yearImportFile'),
  btnExecYear: $('btnExecYear'),
  yearMsg: $('yearMsg'),

  // 学期设置
  termStatus: $('termStatus'),
  termFirstStart: $('termFirstStart'),
  termFirstEnd: $('termFirstEnd'),
  termSecondStart: $('termSecondStart'),
  termSecondEnd: $('termSecondEnd'),
  termCurrent: $('termCurrent'),
  btnSaveTerm: $('btnSaveTerm'),
  btnTermDefault: $('btnTermDefault'),
  btnTermClear: $('btnTermClear'),
  termMsg: $('termMsg'),

  confirmModal: $('confirmModal'),
  confirmTitle: $('confirmTitle'),
  confirmMessage: $('confirmMessage'),
  confirmCancel: $('confirmCancel'),
  confirmOk: $('confirmOk'),
  toast: $('toast'),
};

let editUserId = null;
let editGradeId = null;
let editClassId = null;
let classes = [];
let teachers = [];
let allGrades = []; // 年级表（新建班级下拉用，含无班级的年级）

// ---------- 工具 ----------
let toastTimer = null;
function showToast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), ms);
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('未登录'); }
  if (res.status === 403) { window.location.href = '/dashboard'; throw new Error('无权限'); }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const e = new Error((data && data.error) ? data.error : `请求失败（${res.status}）`);
    e.status = res.status;
    e.needConfirm = !!(data && data.needConfirm);
    e.existingTeacher = data && data.existingTeacher;
    // 后端业务错误码（如班级删除的 HAS_ACTIVE_STUDENTS）透传给调用方
    e.code = data && data.code;
    e.hint = data && data.hint;
    e.activeStudents = data && data.activeStudents;
    e.totalStudents = data && data.totalStudents;
    throw e;
  }
  return data;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fileForm(fileInput) {
  const file = fileInput.files[0];
  if (!file) throw new Error('请选择 Excel 文件');
  const fd = new FormData();
  fd.append('file', file);
  return fd;
}

async function apiUpload(url, formData) {
  const res = await fetch(url, { method: 'POST', body: formData });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('未登录'); }
  if (res.status === 403) { window.location.href = '/dashboard'; throw new Error('无权限'); }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) ? data.error : `请求失败（${res.status}）`);
  return data;
}

// ---------- 标签页切换（URL 路由驱动，刷新保持子页） ----------
const TAB_PATH = {
  users: '/admin/account-management',
  grades: '/admin/grade-management',
  classes: '/admin/class-management',
  years: '/admin/academic-year-management',
};
const PATH_TAB = Object.fromEntries(Object.entries(TAB_PATH).map(([k, v]) => [v, k]));

function currentTabFromPath() {
  return PATH_TAB[location.pathname] || 'users';
}

// ---------- 页面模式 ----------
// 后台管理已拆成 4 个独立页面（账号/年级/班级/学年管理），每页由 window.ADMIN_PAGE 声明自己是谁；
// admin.html（旧的单页 Tab 结构）仍兼容：无 ADMIN_PAGE 时按 URL 推断。
const IS_STANDALONE = !!window.ADMIN_PAGE;
const ADMIN_PAGE = window.ADMIN_PAGE || PATH_TAB[location.pathname] || 'users';
const PANEL_OF = { users: 'tabUsers', grades: 'tabGrades', classes: 'tabClasses', years: 'tabYears' };

function switchTab(tab) {
  // 只操作当前页真实存在的 Tab 与面板（独立页没有 Tab 栏）
  document.querySelectorAll('.admin-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  const panels = [...document.querySelectorAll('.admin-tab-panel')];
  if (panels.length === 0) return;
  panels.forEach((p) => p.classList.add('hidden'));
  const target = document.getElementById(PANEL_OF[tab] || '');
  if (target) target.classList.remove('hidden');
  if (IS_STANDALONE) return;   // 独立页的数据由 init 按页面加载，这里不再触发
  if (tab === 'grades') { loadGradeYearFilter(); loadGrades(); }
  if (tab === 'classes') { loadClassFilters(); loadClassList(); }
  if (tab === 'years') { loadSettings(); }
}

document.querySelectorAll('.admin-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const t = tab.dataset.tab;
    history.pushState({}, '', TAB_PATH[t]);
    switchTab(t);
    updateBackButton();   // 返回按钮文案/目标随子页变化
  });
});
window.addEventListener('popstate', () => { switchTab(currentTabFromPath()); updateBackButton(); });

// ============================================================
// 账号管理
// ============================================================
async function loadUsers() {
  try {
    const data = await apiFetch('/api/users');
    renderUsers(data.users || []);
  } catch (err) { showToast('加载失败：' + err.message); }
}

function renderUsers(users) {
  if (!users.length) { el.userList.innerHTML = '<tr><td colspan="6" class="plan-empty">暂无账号</td></tr>'; return; }
  el.userList.innerHTML = users.map((u) => {
    // 带班班级（仅教师）：班级 + 在该班角色（班主任/任课老师）+ 学科
    let classCell = u.className || '—';
    if (u.role === 'teacher') {
      const list = u.teachingClasses || [];
      if (list.length === 0) {
        classCell = '<span class="hint" style="font-size:12px">未设置带班</span>';
      } else {
        classCell = list.map((t) => {
          const head = t.roleInClass === 'head_teacher' || t.isHeadTeacher;
          const subj = t.subject || u.subject || '';
          return `<span class="tag ${head ? 'active' : 'pending'}" style="margin:2px 2px 0 0">${t.className || ('#' + t.classId)}·${head ? '班主任' : '任课老师'}${subj ? '·' + subj : ''}</span>`;
        }).join('');
      }
      classCell += ` <button type="button" class="btn-text" data-act="teach" data-id="${u.id}">设置</button>`;
    }
    // 角色列：按【班级级带班角色】汇总显示 管理员/班主任/任课老师/班长/学生
    const roleTag = u.roleLabel || ROLE_CN[u.role] || u.role;
    const roleSub = u.role === 'teacher'
      ? `<br><span class="hint" style="font-size:11px">${u.subject ? '所教：' + u.subject + ' · ' : ''}${u.profileLocked ? '🔒 已锁定' : '⏳ 待确认教学设置'}</span>`
      : '';
    return `
    <tr>
      <td><b>${u.username}</b>${u.displayName && u.displayName !== u.username ? `<br><span class="hint" style="font-size:12px">${u.displayName}</span>` : ''}</td>
      <td><span class="tag ${u.role}">${roleTag}</span>${roleSub}</td>
      <td>${classCell}</td>
      <td>${u.isActive ? '<span class="tag active">启用</span>' : '<span class="tag archived">禁用</span>'}</td>
      <td>${fmtTime(u.createdAt)}</td>
      <td class="td-actions">
        <button type="button" class="btn-text edit" data-act="edit" data-id="${u.id}">编辑</button>
        <button type="button" class="btn-text" data-act="reset" data-id="${u.id}">重置密码</button>
        <button type="button" class="btn-text del" data-act="del" data-id="${u.id}">删除</button>
      </td>
    </tr>`;
  }).join('');
}

// ---------- 教师带班记录（按班级分别设置角色） ----------
// teachRows: [{ classId, roleInClass }]
//   表格只展示 年级 / 班级 / 在该班角色 / 操作（不再让用户填学科）；
//   学科统一使用账号级「所教学科」——它在后端作为每个带班班级的默认学科生效。
let teachRows = [];

function classOf(id) { return classes.find((c) => Number(c.id) === Number(id)) || null; }
function classLabel(c) {
  if (!c) return '未知班级';
  const g = c.gradeName || c.grade_name || c.grade || '';
  return `${g ? g + ' ' : ''}${c.className || c.class_name || ('#' + c.id)}`;
}
function renderTeachRows() {
  if (!teachRows.length) {
    el.uTeachList.innerHTML = '<tr><td colspan="4" class="plan-empty">未设置带班班级（该教师暂不属于任何班级）</td></tr>';
    return;
  }
  el.uTeachList.innerHTML = teachRows.map((r, i) => {
    const c = classOf(r.classId);
    // 班级来源：本地班级缓存（可能只加载了当前学年）→ 行数据里服务端返回的班级名兜底
    const gradeText = (c && (c.gradeName || c.grade_name || c.grade)) || r.grade || '—';
    const classText = (c && (c.className || c.class_name)) || r.className || ('#' + r.classId);
    return `<tr>
      <td>${gradeText}</td>
      <td><b>${classText}</b></td>
      <td>
        <select class="tc-role" data-idx="${i}">
          <option value="head_teacher" ${r.roleInClass === 'head_teacher' ? 'selected' : ''}>班主任</option>
          <option value="subject_teacher" ${r.roleInClass !== 'head_teacher' ? 'selected' : ''}>任课老师</option>
        </select>
      </td>
      <td style="text-align:right"><button type="button" class="btn-text del" data-act="delTeach" data-idx="${i}">🗑️ 删除</button></td>
    </tr>`;
  }).join('');
}

if (el.uTeachList) el.uTeachList.addEventListener('change', (e) => {
  const i = Number(e.target.dataset.idx);
  if (!Number.isInteger(i) || !teachRows[i]) return;
  if (e.target.classList.contains('tc-role')) teachRows[i].roleInClass = e.target.value;
});
if (el.uTeachList) el.uTeachList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act="delTeach"]');
  if (!btn) return;
  teachRows.splice(Number(btn.dataset.idx), 1);
  renderTeachRows();
});

// ---------- 添加带班弹窗（年级/班级下拉与「年级管理」「班级管理」同源） ----------
//   年级：GET /api/grades?academicYear=当前学年       （与「年级管理」同一个接口）
//   班级：GET /api/classes?gradeId=xx&academicYear=xx （选中年级后按年级+学年拉取）
let accountYear = null;      // 当前学年（/api/settings）
let gradeOptions = [];       // 当前学年年级（/api/grades）

async function loadCurrentYearGrades() {
  try {
    const s = await apiFetch('/api/settings');
    accountYear = s.currentAcademicYear || null;
  } catch (_) { accountYear = null; }
  const fetchGrades = async (year) => {
    const url = '/api/grades' + (year ? '?academicYear=' + encodeURIComponent(year) : '');
    const d = await apiFetch(url);
    return d.grades || [];
  };
  try {
    gradeOptions = await fetchGrades(accountYear);
    // 兜底：当前学年还没有任何年级时，列出全部学年的年级（避免下拉为空无法添加教师）
    if (gradeOptions.length === 0 && accountYear) {
      const all = await fetchGrades(null);
      if (all.length > 0) {
        gradeOptions = all;
        showToast(`当前学年（${accountYear}）暂无年级，已列出全部学年的年级`, 3200);
      }
    }
  } catch (err) {
    gradeOptions = [];
    showUserErr('年级加载失败：' + err.message);
  }
  return gradeOptions;
}

// 把按年级/学年取回的班级合并进本地缓存（供带班记录表格显示年级/班级名）
function mergeClassesIntoCache(list) {
  for (const c of list || []) {
    const i = classes.findIndex((x) => Number(x.id) === Number(c.id));
    if (i >= 0) classes[i] = { ...classes[i], ...c };
    else classes.push(c);
  }
}

async function renderTeachClassOptions() {
  const gradeId = el.tmGrade.value ? Number(el.tmGrade.value) : null;
  const grade = gradeOptions.find((g) => Number(g.id) === gradeId) || null;
  const year = (grade && grade.academic_year) || accountYear;
  el.tmClass.innerHTML = '<option value="">加载中…</option>';
  if (el.tmClassNote) el.tmClassNote.textContent = '';
  let list = [];
  if (gradeId) {
    try {
      const q = new URLSearchParams({ gradeId: String(gradeId) });
      if (year) q.set('academicYear', year);
      const d = await apiFetch('/api/classes?' + q.toString());
      list = d.classes || [];
      mergeClassesIntoCache(list);
    } catch (err) {
      el.tmError.textContent = '班级加载失败：' + err.message;
      el.tmError.classList.remove('hidden');
    }
  }
  const used = new Set(teachRows.map((r) => Number(r.classId)));
  const avail = list.filter((c) => !used.has(Number(c.id)));
  el.tmClass.innerHTML = avail.length
    ? avail.map((c) => `<option value="${c.id}">${c.className || c.class_name}</option>`).join('')
    : '<option value="">（该年级暂无班级或已全部添加）</option>';
  if (el.tmClassNote) {
    el.tmClassNote.textContent = grade
      ? `${grade.grade_name}（${grade.academic_year}）· 可选 ${avail.length} 个班级`
        + (avail.length === 0 && list.length === 0 ? '（该年级下还没有班级，请先在「班级」标签页添加）' : '')
      : '';
  }
}

async function openTeachRowModal() {
  const grades = await loadCurrentYearGrades();
  if (!grades.length) {
    showUserErr(`当前学年（${accountYear || '未设置'}）暂无年级，请先在「年级」标签页添加年级`);
    return;
  }
  el.tmGrade.innerHTML = grades.map((g) => `<option value="${g.id}">${g.grade_name}</option>`).join('');
  el.tmRole.value = 'subject_teacher';
  el.tmError.classList.add('hidden');
  await renderTeachClassOptions();
  el.teachModal.classList.remove('hidden');
}
if (el.btnAddTeach) el.btnAddTeach.addEventListener('click', openTeachRowModal);
if (el.tmGrade) el.tmGrade.addEventListener('change', () => { renderTeachClassOptions(); });
if (el.tmCancel) el.tmCancel.addEventListener('click', () => el.teachModal.classList.add('hidden'));
if (el.teachModal) el.teachModal.addEventListener('click', (e) => { if (e.target === el.teachModal) el.teachModal.classList.add('hidden'); });
if (el.tmSubmit) el.tmSubmit.addEventListener('click', () => {
  const cid = el.tmClass.value ? Number(el.tmClass.value) : null;
  if (!cid) {
    el.tmError.textContent = '请选择要添加的班级';
    el.tmError.classList.remove('hidden');
    return;
  }
  if (teachRows.some((r) => Number(r.classId) === cid)) {
    el.tmError.textContent = '该班级已在带班记录中';
    el.tmError.classList.remove('hidden');
    return;
  }
  const grade = gradeOptions.find((g) => Number(g.id) === Number(el.tmGrade.value)) || null;
  const c = classOf(cid) || {};
  teachRows.push({
    classId: cid,
    roleInClass: el.tmRole.value,
    className: c.className || c.class_name || null,
    grade: c.gradeName || c.grade_name || c.grade || (grade && grade.grade_name) || null,
  });
  renderTeachRows();
  el.teachModal.classList.add('hidden');
});

// 教师带班班级 / 班主任设置弹窗（列表「设置」快捷入口）
async function openTeacherClasses(u) {
  await refreshClassesForModal();
  el.tcTeacherId.value = String(u.id);
  el.tcTeacherName.textContent = u.realName || u.displayName || u.username;
  const mine = new Map((u.teachingClasses || []).map((t) => [Number(t.classId), t]));
  el.tcList.innerHTML = classes.map((c) => {
    const cur = mine.get(Number(c.id));
    return `
    <div class="tc-row">
      <label><input type="checkbox" class="tc-cb" value="${c.id}" ${cur ? 'checked' : ''}> ${classLabel(c)}</label>
      <select class="tc-role" data-cid="${c.id}" ${cur ? '' : 'disabled'}>
        <option value="head_teacher" ${cur && cur.roleInClass === 'head_teacher' ? 'selected' : ''}>班主任（本班全部科目）</option>
        <option value="subject_teacher" ${cur && cur.roleInClass !== 'head_teacher' ? 'selected' : ''}>任课老师（只看自己本学科）</option>
      </select>
    </div>`;
  }).join('');
  el.tcError.classList.add('hidden');
  el.tcModal.classList.remove('hidden');
}

if (el.tcList) el.tcList.addEventListener('change', (e) => {
  if (e.target.classList.contains('tc-cb')) {
    const sel = el.tcList.querySelector(`.tc-role[data-cid="${e.target.value}"]`);
    if (sel) sel.disabled = !e.target.checked;
  }
});

if (el.tcCancel) el.tcCancel.addEventListener('click', () => el.tcModal.classList.add('hidden'));
if (el.tcModal) el.tcModal.addEventListener('click', (e) => { if (e.target === el.tcModal) el.tcModal.classList.add('hidden'); });
if (el.tcSubmit) el.tcSubmit.addEventListener('click', async () => {
  const teacherId = Number(el.tcTeacherId.value);
  const list = [];
  el.tcList.querySelectorAll('.tc-cb:checked').forEach((cb) => {
    const cid = Number(cb.value);
    const sel = el.tcList.querySelector(`.tc-role[data-cid="${cid}"]`);
    list.push({ classId: cid, roleInClass: (sel && sel.value) || 'subject_teacher' });
  });
  try {
    await apiFetch('/api/users/teacher-classes', {
      method: 'POST',
      body: JSON.stringify({ teacherId, classes: list }),
    });
    el.tcModal.classList.add('hidden');
    showToast('带班班级已保存（按班级分别设置角色）');
    await loadUsers();
  } catch (err) {
    el.tcError.textContent = err.message;
    el.tcError.classList.remove('hidden');
  }
});

if (el.userList) el.userList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  const d = await apiFetch('/api/users');
  const u = (d.users || []).find((x) => x.id === id);
  if (!u) return;
  if (act === 'edit') openEditUser(u);
  else if (act === 'reset') resetUserPassword(u);
  else if (act === 'del') deleteUser(u);
  else if (act === 'teach') openTeacherClasses(u);
});

async function loadClassOptions() {
  const d = await apiFetch('/api/classes');
  // 接口返回 snake_case，这里补齐 camelCase 便于前端使用
  classes = (d.classes || []).map((c) => ({
    ...c,
    className: c.className || c.class_name,
    gradeName: c.gradeName || c.grade_name || c.grade || '',
    academicYear: c.academicYear || c.academic_year || '',
  }));
}

async function loadTeachers() {
  const d = await apiFetch('/api/users');
  teachers = (d.users || []).filter((u) => u.role === 'teacher');
}

function userClassOptions(selectedId) {
  return '<option value="">请选择班级</option>' +
    classes.map((c) => `<option value="${c.id}" ${selectedId === c.id ? 'selected' : ''}>${c.className}（${c.grade}·${c.academicYear || '—'}）</option>`).join('');
}

// 打开弹窗前刷新班级列表（新建班级后立即可选）
async function refreshClassesForModal() {
  try {
    await loadClassOptions();
  } catch (err) {
    console.error('[班级刷新失败]', err.message);
  }
}

async function openAddUser() {
  editUserId = null;
  el.userModalTitle.textContent = '添加账号';
  el.uUsername.value = ''; el.uUsername.disabled = false;
  el.uPasswordRow.classList.remove('hidden'); el.uPassword.value = '';
  el.uRealName.value = '';
  el.uRole.value = 'teacher';
  teachRows = [];
  el.uSubject.value = '';
  // 新教师：教学设置默认"待教师首次登录确认"（未锁定）
  el.uLockState.textContent = '⏳ 待教师首次登录确认（新建教师账号默认未锁定）';
  el.uResetLock.checked = false;
  el.uResetLockRow.classList.add('hidden');
  await refreshClassesForModal();
  el.uClass.innerHTML = userClassOptions(null);
  el.uActive.checked = true;
  updateUserClassVisibility();
  renderTeachRows();
  el.uError.classList.add('hidden');
  el.userModal.classList.remove('hidden');
}

async function openEditUser(u) {
  editUserId = u.id;
  el.userModalTitle.textContent = `编辑账号：${u.username}`;
  el.uUsername.value = u.username; el.uUsername.disabled = true;
  el.uPasswordRow.classList.add('hidden');
  el.uRealName.value = u.realName || '';
  el.uRole.value = u.role;
  el.uSubject.value = u.subject || '';
  // 教学设置锁定状态：已锁定（教师只读）/ 待教师确认
  el.uResetLock.checked = false;
  if (u.role === 'teacher') {
    el.uLockState.textContent = u.profileLocked
      ? '🔒 已锁定（教师端只读，仅管理员可修改）'
      : '⏳ 待教师首次登录确认';
    el.uResetLockRow.classList.toggle('hidden', !u.profileLocked);
  } else {
    el.uLockState.textContent = '（非教师账号不适用）';
    el.uResetLockRow.classList.add('hidden');
  }
  await refreshClassesForModal();
  el.uClass.innerHTML = userClassOptions(u.classId);
  // 带班记录：班级 + 在该班角色（学科统一用账号级「所教学科」，表格不再展示/编辑每班学科）
  // 同时记录服务端返回的班级名/年级，避免班级缓存未覆盖该学年时表格显示 #id
  teachRows = (u.teachingClasses || []).map((t) => ({
    classId: Number(t.classId),
    roleInClass: t.roleInClass === 'head_teacher' || t.isHeadTeacher ? 'head_teacher' : 'subject_teacher',
    className: t.className || null,
    grade: t.grade || null,
  }));
  el.uActive.checked = !!u.isActive;
  updateUserClassVisibility();
  renderTeachRows();
  el.uError.classList.add('hidden');
  el.userModal.classList.remove('hidden');
}

function updateUserClassVisibility() {
  const role = el.uRole.value;
  el.uTeachBlock.classList.toggle('hidden', role !== 'teacher');
  el.uClassRow.classList.toggle('hidden', !(role === 'student' || role === 'monitor'));
  el.uRealNameRow.classList.toggle('hidden', role !== 'teacher');
}

if (el.btnAddUser) el.btnAddUser.addEventListener('click', openAddUser);
if (el.uRole) el.uRole.addEventListener('change', updateUserClassVisibility);
if (el.uCancel) el.uCancel.addEventListener('click', () => el.userModal.classList.add('hidden'));
if (el.userModal) el.userModal.addEventListener('click', (e) => { if (e.target === el.userModal) el.userModal.classList.add('hidden'); });

if (el.uSubmit) el.uSubmit.addEventListener('click', async () => {
  const username = el.uUsername.value.trim();
  const password = el.uPassword.value;
  const role = el.uRole.value;
  const realName = el.uRealName.value.trim();
  const classId = el.uClass.value ? Number(el.uClass.value) : null;
  const isActive = el.uActive.checked;
  const subject = el.uSubject.value || '';
  if (!username) return showUserErr('用户名不能为空');
  if (role === 'teacher' && !realName) return showUserErr('教师账号必须填写真实姓名');
  if ((role === 'student' || role === 'monitor') && !classId) return showUserErr('学生/班长账号必须选择班级');
  // 教师：提交【班级级带班记录】（只有班级 + 在该班角色；学科统一取账号级「所教学科」，
  //       故每班不再单独保存学科，避免表格里看不到的旧值覆盖账号学科）
  const teachingClasses = role === 'teacher'
    ? teachRows.map((r) => ({ classId: r.classId, roleInClass: r.roleInClass, subject: null }))
    : null;
  let teacherClassId = classId;
  if (role === 'teacher') {
    const headRow = teachingClasses.find((r) => r.roleInClass === 'head_teacher') || teachingClasses[0];
    teacherClassId = headRow ? headRow.classId : classId;
  }
  const payload = { username, password, role, realName, classId: teacherClassId, isActive, subject, teachingClasses };
  // 新教师：明确不锁定（由教师首次登录确认）；编辑时可勾选"重置为待确认"
  if (role === 'teacher' && editUserId === null) payload.profileLocked = false;
  const resetProfileLock = role === 'teacher' && editUserId !== null && el.uResetLock.checked;
  const doSave = async (force) => {
    try {
      if (editUserId === null) {
        if (password.length < 6) return showUserErr('密码至少 6 位');
        const data = await apiFetch('/api/users', { method: 'POST', body: JSON.stringify({ ...payload, force }) });
        showToast(`已添加账号：${data.user.username}`);
      } else {
        const data = await apiFetch('/api/users/' + editUserId, { method: 'PUT', body: JSON.stringify({ role, realName, classId: teacherClassId, isActive, subject, teachingClasses, resetProfileLock, force }) });
        showToast(resetProfileLock ? `已更新账号：${data.user.username}（教学设置已重置为待确认）` : `已更新账号：${data.user.username}`);
      }
      el.userModal.classList.add('hidden');
      await loadUsers();
      await loadClassList();
    } catch (err) {
      if (err.needConfirm) {
        openConfirm('班主任冲突', `${err.message}（原班主任：${err.existingTeacher ? err.existingTeacher.name : ''}）`, () => doSave(true));
        return;
      }
      showUserErr(err.message);
    }
  };
  await doSave(false);
});

function showUserErr(msg) { el.uError.textContent = msg; el.uError.classList.remove('hidden'); }

function resetUserPassword(u) {
  openConfirm('重置密码', `确定将账号 ${u.username} 的密码重置为 123456 吗？`, async () => {
    try {
      await apiFetch(`/api/users/${u.id}/reset-password`, { method: 'POST' });
      showToast('密码已重置为 123456');
    } catch (err) { showToast('重置失败：' + err.message); }
  });
}

function deleteUser(u) {
  openConfirm('删除账号', `确定要删除账号 ${u.username} 吗？此操作不可恢复。`, async () => {
    try {
      await apiFetch(`/api/users/${u.id}`, { method: 'DELETE' });
      showToast(`已删除账号：${u.username}`);
      await loadUsers();
    } catch (err) { showToast('删除失败：' + err.message); }
  });
}

// ============================================================
// 教师账号批量导入（下载模板 → 上传 → 预览(dryRun) → 确认导入 → 结果）
//   GET  /api/teachers/template   下载模板
//   POST /api/teachers/import     导入（?dryRun=1 只校验不写库）
// ============================================================
const TI = { file: null, preview: null };

function tiEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTeacherPreview(data) {
  const box = el.teacherPreview;
  if (!box) return;
  const rows = (data.results || []).slice(0, 5);
  const more = (data.results || []).length > 5 ? `<div class="hint">仅预览前 5 行（共 ${data.results.length} 行）</div>` : '';
  const plans = rows.filter((r) => r.ok && r.plan).map((r) => r.plan);
  const newGrades = [...new Set(plans.flatMap((p) => p.newGrades || []))];
  const newClasses = [...new Set(plans.flatMap((p) => p.newClasses || []))];
  box.innerHTML =
    `<div class="ti-sum${data.failed ? ' err' : ' ok'}">共 ${data.total} 行：校验通过 ${data.success} 行${data.failed ? `，待处理问题 ${data.failed} 行` : ''}</div>` +
    `<table>
      <thead><tr><th>行</th><th>用户名</th><th>姓名</th><th>角色</th><th>学科</th><th>班级</th><th>校验</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.ok ? '' : 'err'}">
        <td>${r.row}</td>
        <td>${tiEsc(r.username || '—')}</td>
        <td>${tiEsc(r.name || '—')}</td>
        <td>${tiEsc(r.role || '—')}</td>
        <td>${tiEsc(r.subject || '—')}</td>
        <td>${tiEsc((r.classes || []).join('、') || '—')}</td>
        <td>${r.ok ? '<span class="ti-ok">✅ 通过</span>' : `<span class="ti-bad">✕ ${tiEsc(r.error)}</span>`}</td>
      </tr>`).join('')}</tbody>
    </table>` +
    (newGrades.length || newClasses.length
      ? `<div class="ti-note" style="margin-top:8px">将自动创建：${newGrades.length ? `年级 ${tiEsc(newGrades.join('、'))} ` : ''}${newClasses.length ? `｜班级 ${tiEsc(newClasses.join('、'))}` : ''}</div>`
      : '') +
    more;
}

function renderTeacherResult(data) {
  const box = el.teacherResult;
  if (!box) return;
  const c = data.created || {};
  box.innerHTML =
    `<div class="ti-sum${data.failed ? ' err' : ' ok'}">导入完成：成功 ${data.success} 条 · 失败 ${data.failed} 条</div>` +
    `<div class="hint">新增教师账号 ${(c.teachers || []).length} 个` +
    `${(c.classes || []).length ? ` · 自动创建班级 ${(c.classes || []).length} 个（${tiEsc((c.classes || []).join('、'))}）` : ''}` +
    `${(c.grades || []).length ? ` · 自动创建年级 ${tiEsc((c.grades || []).join('、'))}` : ''}</div>` +
    ((data.errors || []).length
      ? `<div class="ti-note" style="margin-top:8px">失败原因：</div><ul>${data.errors.map((e) => `<li class="ti-bad">${tiEsc(e)}</li>`).join('')}</ul>`
      : '');
}

async function apiUploadQuery(url, formData) {
  const res = await fetch(url, { method: 'POST', body: formData, credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) ? data.error : `请求失败（${res.status}）`);
  return data;
}

if (el.btnTeacherTemplate) el.btnTeacherTemplate.addEventListener('click', () => { window.location.href = '/api/teachers/template'; });
if (el.btnTeacherTpl) el.btnTeacherTpl.addEventListener('click', () => { window.location.href = '/api/teachers/template'; });

if (el.btnImportUser) el.btnImportUser.addEventListener('click', () => {
  TI.file = null;
  TI.preview = null;
  if (el.teacherImportFile) el.teacherImportFile.value = '';
  if (el.teacherPreviewWrap) el.teacherPreviewWrap.style.display = 'none';
  if (el.teacherResultWrap) el.teacherResultWrap.style.display = 'none';
  if (el.teacherImportSubmit) el.teacherImportSubmit.disabled = true;
  el.teacherImportModal.classList.remove('hidden');
});
if (el.linkLegacyImport) el.linkLegacyImport.addEventListener('click', (e) => {
  e.preventDefault();
  el.teacherImportModal.classList.add('hidden');
  el.userImportFile.value = '';
  el.userImportResult.className = 'import-preview';
  el.userImportResult.textContent = '';
  el.userImportModal.classList.remove('hidden');
});
if (el.teacherImportCancel) el.teacherImportCancel.addEventListener('click', () => el.teacherImportModal.classList.add('hidden'));
if (el.teacherImportModal) el.teacherImportModal.addEventListener('click', (e) => { if (e.target === el.teacherImportModal) el.teacherImportModal.classList.add('hidden'); });

// 选择文件 → 调 dryRun 预览（不写库）
if (el.teacherImportFile) el.teacherImportFile.addEventListener('change', async () => {
  const f = el.teacherImportFile.files && el.teacherImportFile.files[0];
  TI.file = f || null;
  if (el.teacherImportSubmit) el.teacherImportSubmit.disabled = true;
  if (el.teacherResultWrap) el.teacherResultWrap.style.display = 'none';
  if (!TI.file) { if (el.teacherPreviewWrap) el.teacherPreviewWrap.style.display = 'none'; return; }
  if (el.teacherPreviewWrap) el.teacherPreviewWrap.style.display = '';
  el.teacherPreview.innerHTML = '<div class="hint">正在校验…</div>';
  try {
    const fd = new FormData();
    fd.append('file', TI.file, TI.file.name);
    const data = await apiUploadQuery('/api/teachers/import?dryRun=1', fd);
    TI.preview = data;
    renderTeacherPreview(data);
    if (el.teacherImportSubmit) el.teacherImportSubmit.disabled = data.success === 0;
    if (data.success === 0) el.teacherPreview.innerHTML += '<div class="ti-note">没有可导入的行，请修正后再上传。</div>';
  } catch (err) {
    el.teacherPreview.innerHTML = `<div class="ti-bad">校验失败：${tiEsc(err.message)}</div>`;
  }
});

if (el.teacherImportSubmit) el.teacherImportSubmit.addEventListener('click', async () => {
  if (!TI.file) { showToast('请先选择 Excel 文件'); return; }
  el.teacherImportSubmit.disabled = true;
  el.teacherImportSubmit.textContent = '导入中…';
  try {
    const fd = new FormData();
    fd.append('file', TI.file, TI.file.name);
    const data = await apiUploadQuery('/api/teachers/import', fd);
    if (el.teacherResultWrap) el.teacherResultWrap.style.display = '';
    renderTeacherResult(data);
    await loadUsers();
    showToast(data.failed ? `导入完成：成功 ${data.success} 条 · 失败 ${data.failed} 条` : `导入完成：成功 ${data.success} 条`);
  } catch (err) {
    if (el.teacherResultWrap) el.teacherResultWrap.style.display = '';
    el.teacherResult.innerHTML = `<div class="ti-bad">导入失败：${tiEsc(err.message)}</div>`;
  } finally {
    el.teacherImportSubmit.disabled = false;
    el.teacherImportSubmit.textContent = '确认导入';
  }
});

// 旧版通用导入（学生/班长等角色）
if (el.userImportCancel) el.userImportCancel.addEventListener('click', () => el.userImportModal.classList.add('hidden'));
if (el.userImportModal) el.userImportModal.addEventListener('click', (e) => { if (e.target === el.userImportModal) el.userImportModal.classList.add('hidden'); });
if (el.userImportSubmit) el.userImportSubmit.addEventListener('click', async () => {
  try {
    const data = await apiUpload('/api/users/import', fileForm(el.userImportFile));
    el.userImportResult.textContent = `导入完成：新增 ${data.inserted}，跳过 ${data.skipped}${data.notFound > 0 ? `，班级不存在 ${data.notFound}` : ''}`;
    el.userImportResult.className = 'import-preview ok';
    await loadUsers();
  } catch (err) {
    el.userImportResult.textContent = err.message;
    el.userImportResult.className = 'import-preview err';
  }
});

// ============================================================
// 年级管理
// ============================================================
async function loadGradeYearFilter() {
  const s = await apiFetch('/api/settings');
  el.gradeYearFilter.innerHTML = '<option value="">全部学年</option>' +
    s.years.map((y) => `<option value="${y}">${y}</option>`).join('');
}

async function loadGrades() {
  try {
    const year = el.gradeYearFilter.value;
    const url = '/api/grades' + (year ? '?academicYear=' + encodeURIComponent(year) : '');
    const d = await apiFetch(url);
    renderGrades(d.grades || []);
  } catch (err) { showToast('加载失败：' + err.message); }
}

function renderGrades(grades) {
  if (!grades.length) { el.gradeList.innerHTML = '<tr><td colspan="6" class="plan-empty">暂无年级</td></tr>'; return; }
  el.gradeList.innerHTML = grades.map((g) => `
    <tr>
      <td><b>${g.grade_name}</b></td>
      <td>${g.grade_code || '—'}</td>
      <td>${g.academic_year}</td>
      <td>${g.class_count}</td>
      <td>${g.student_count}</td>
      <td class="td-actions">
        <button type="button" class="btn-text edit" data-act="gedit" data-id="${g.id}">编辑</button>
        <button type="button" class="btn-text del" data-act="gdel" data-id="${g.id}">删除</button>
      </td>
    </tr>`).join('');
}

if (el.gradeYearFilter) el.gradeYearFilter.addEventListener('change', loadGrades);
if (el.gradeList) el.gradeList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.act === 'gedit') {
    const d = await apiFetch('/api/grades');
    const g = (d.grades || []).find((x) => x.id === id);
    if (g) openEditGrade(g);
  } else if (btn.dataset.act === 'gdel') {
    openConfirm('删除年级', '确定删除该年级吗？（该年级下不能有班级）', async () => {
      try {
        await apiFetch('/api/grades/' + id, { method: 'DELETE' });
        showToast('年级已删除');
        await loadGrades();
      } catch (err) { showToast('删除失败：' + err.message); }
    });
  }
});

function openAddGrade() {
  editGradeId = null;
  el.gradeModalTitle.textContent = '添加年级';
  el.gName.value = ''; el.gCode.value = ''; el.gYear.value = '';
  el.gYearRow.classList.remove('hidden');
  el.gError.classList.add('hidden');
  el.gradeModal.classList.remove('hidden');
}

function openEditGrade(g) {
  editGradeId = g.id;
  el.gradeModalTitle.textContent = `编辑年级：${g.grade_name}`;
  el.gName.value = g.grade_name;
  el.gCode.value = g.grade_code || '';
  el.gYearRow.classList.add('hidden'); // 学年不可改
  el.gError.classList.add('hidden');
  el.gradeModal.classList.remove('hidden');
}

if (el.btnAddGrade) el.btnAddGrade.addEventListener('click', openAddGrade);
if (el.gCancel) el.gCancel.addEventListener('click', () => el.gradeModal.classList.add('hidden'));
if (el.gradeModal) el.gradeModal.addEventListener('click', (e) => { if (e.target === el.gradeModal) el.gradeModal.classList.add('hidden'); });

if (el.gSubmit) el.gSubmit.addEventListener('click', async () => {
  const gradeName = el.gName.value.trim();
  const gradeCode = el.gCode.value.trim();
  const academicYear = el.gYear.value.trim();
  if (!gradeName) return showGradeErr('年级名称不能为空');
  try {
    if (editGradeId === null) {
      if (!academicYear) return showGradeErr('学年不能为空');
      await apiFetch('/api/grades', { method: 'POST', body: JSON.stringify({ gradeName, gradeCode, academicYear }) });
      showToast('年级已添加');
    } else {
      await apiFetch('/api/grades/' + editGradeId, { method: 'PUT', body: JSON.stringify({ gradeName, gradeCode }) });
      showToast('年级已更新');
    }
    el.gradeModal.classList.add('hidden');
    await loadGrades();
  } catch (err) { showGradeErr(err.message); }
});

function showGradeErr(msg) { el.gError.textContent = msg; el.gError.classList.remove('hidden'); }

if (el.btnImportGrade) el.btnImportGrade.addEventListener('click', () => {
  el.gradeImportFile.value = '';
  el.gradeImportResult.className = 'import-preview';
  el.gradeImportResult.textContent = '';
  el.gradeImportModal.classList.remove('hidden');
});
if (el.gradeImportCancel) el.gradeImportCancel.addEventListener('click', () => el.gradeImportModal.classList.add('hidden'));
if (el.gradeImportModal) el.gradeImportModal.addEventListener('click', (e) => { if (e.target === el.gradeImportModal) el.gradeImportModal.classList.add('hidden'); });
if (el.gradeImportSubmit) el.gradeImportSubmit.addEventListener('click', async () => {
  try {
    const data = await apiUpload('/api/grades/import', fileForm(el.gradeImportFile));
    el.gradeImportResult.textContent = `导入完成：新增 ${data.inserted}，跳过 ${data.skipped}`;
    el.gradeImportResult.className = 'import-preview ok';
    await loadGradeYearFilter();
    await loadGrades();
  } catch (err) {
    el.gradeImportResult.textContent = err.message;
    el.gradeImportResult.className = 'import-preview err';
  }
});

// ============================================================
// 班级管理
// ============================================================
async function loadClassFilters() {
  const s = await apiFetch('/api/settings');
  el.clsYearFilter.innerHTML = '<option value="">全部学年</option>' +
    s.years.map((y) => `<option value="${y}">${y}</option>`).join('');
  const g = await apiFetch('/api/grades');
  el.clsGradeFilter.innerHTML = '<option value="">全部年级</option>' +
    g.grades.map((x) => `<option value="${x.id}">${x.grade_name}</option>`).join('');
}

async function loadClassList() {
  try {
    const q = new URLSearchParams();
    if (el.clsYearFilter.value) q.set('academicYear', el.clsYearFilter.value);
    if (el.clsGradeFilter.value) q.set('gradeId', el.clsGradeFilter.value);
    const d = await apiFetch('/api/classes/manage?' + q.toString());
    renderClassList(d.classes || []);
  } catch (err) { showToast('加载失败：' + err.message); }
}

// 班级列表里插入的文本先转义（班级名/科目名都来自库，避免 XSS 与 HTML 破坏）
function classEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderClassList(cls) {
  if (!cls.length) { el.classList.innerHTML = '<tr><td colspan="8" class="plan-empty">暂无班级</td></tr>'; return; }
  el.classList.innerHTML = cls.map((c) => {
    // 班主任列：正班主任（正）、副班主任（副）
    let teacherCell = '—';
    const parts = [];
    if (c.head_teacher_name) parts.push(`${c.head_teacher_name}（正）`);
    if (c.deputy_teacher_name) parts.push(`${c.deputy_teacher_name}（副）`);
    if (parts.length) teacherCell = parts.join('、');
    // 选科列（v34）：组合 + 选科科目；综合/未设置 → 提示走全局默认
    const stream = c.stream || '综合';
    const electives = Array.isArray(c.elective_subjects) ? c.elective_subjects : [];
    const streamCell = electives.length
      ? `<span class="tag active">${classEsc(stream)}</span> <span class="hint">${classEsc(electives.join('、'))}</span>`
      : `<span class="tag archived">${classEsc(stream)}</span> <span class="hint">未设置选科（每日作业走全局默认）</span>`;
    return `
    <tr>
      <td><b>📚 ${c.class_name}</b></td>
      <td>${c.grade_name || '—'}</td>
      <td>${c.academic_year || '—'}</td>
      <td>${streamCell}</td>
      <td>${teacherCell}</td>
      <td>${c.student_count}</td>
      <td>${c.status === 'archived' ? '<span class="tag archived">已归档</span>' : '<span class="tag active">活跃</span>'}</td>
      <td class="td-actions">
        <button type="button" class="btn-text edit" data-act="cedit" data-id="${c.id}">编辑</button>
        ${c.status === 'active'
          ? `<button type="button" class="btn-text" data-act="carchive" data-id="${c.id}">归档</button>`
          : `<button type="button" class="btn-text" data-act="cunarchive" data-id="${c.id}">取消归档</button>`}
        <button type="button" class="btn-text del" data-act="cdel" data-id="${c.id}">删除</button>
      </td>
    </tr>`;
  }).join('');
}

if (el.clsYearFilter) el.clsYearFilter.addEventListener('change', loadClassList);
if (el.clsGradeFilter) el.clsGradeFilter.addEventListener('change', loadClassList);
if (el.classList) el.classList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  if (act === 'cedit') {
    const d = await apiFetch('/api/classes/manage');
    const c = (d.classes || []).find((x) => x.id === id);
    if (c) openEditClass(c);
  } else if (act === 'carchive') {
    openConfirm('归档班级', '归档后该班级不再显示在签到/下拉列表中，但学生、考勤、作业等数据全部保留（可随时取消归档）。确定归档吗？', async () => {
      try {
        await apiFetch('/api/classes/' + id + '/archive', { method: 'POST' });
        showToast('班级已归档（数据保留，可取消归档）');
        await loadClassList();
      } catch (err) { showToast('归档失败：' + err.message); }
    });
  } else if (act === 'cunarchive') {
    openConfirm('取消归档', '取消归档后该班级重新出现在签到/下拉列表中。确定恢复吗？', async () => {
      try {
        await apiFetch('/api/classes/' + id + '/unarchive', { method: 'POST' });
        showToast('已取消归档，班级恢复为活跃');
        await loadClassList();
      } catch (err) { showToast('取消归档失败：' + err.message); }
    });
  } else if (act === 'cdel') {
    // 两步确认：先按"非强制"删除（后端会拦住在读学生），被拦后再让管理员显式确认彻底删除
    const doDelete = async (force) => {
      try {
        const r = await apiFetch(`/api/classes/${id}${force ? '?force=1' : ''}`, { method: 'DELETE' });
        showToast(`班级已彻底删除（同时清理 ${r.studentsRemoved || 0} 名学生及其全部历史）`);
        await loadClassList();
      } catch (err) {
        if (err.code === 'HAS_ACTIVE_STUDENTS') {
          openConfirm(
            '⚠️ 彻底删除班级（不可恢复）',
            `${err.message}\n\n继续将【连同 ${err.activeStudents} 名在读学生】及其考勤、作业、点名、点赞等全部历史一起删除，且无法恢复。\n推荐改用「归档」保留数据。确定彻底删除吗？`,
            () => doDelete(true)
          );
          return;
        }
        showToast('删除失败：' + err.message);
      }
    };
    openConfirm('删除班级', '删除会彻底清除该班级及其全部数据（不可恢复）。若有在读学生，将再次确认。\n如只想停用该班，请改用「归档」。', () => doDelete(false));
  }
});

// 加载全部年级（新建班级下拉：从 grades 表，含尚未建班的年级）
async function loadAllGrades() {
  try {
    const d = await apiFetch('/api/grades');
    allGrades = d.grades || [];
  } catch (err) {
    console.error('[年级加载失败]', err.message);
    allGrades = [];
  }
}

function fillClassGradeSelect(selectedGradeName) {
  el.cGrade.innerHTML = '<option value="">请选择年级</option>' +
    allGrades.map((g) => `<option value="${g.grade_name}" ${g.grade_name === selectedGradeName ? 'selected' : ''}>${g.grade_name}（${g.academic_year}）</option>`).join('');
}

// 教师下拉选项：显示"真实姓名（账号名）"，按年级过滤
function teacherSelectOptions(selectedId, gradeFilter) {
  const list = gradeFilter
    ? teachers.filter((t) => t.className && t.className.includes(gradeFilter) || false)
    : teachers;
  // 宽松：优先按班级名包含年级名过滤；若该年级无教师则显示全部（管理员可跨年级指派）
  const opts = list.length ? list : teachers;
  return '<option value="">无</option>' +
    opts.map((t) => `<option value="${t.id}" ${selectedId === t.id ? 'selected' : ''}>${(t.realName || t.displayName || t.username)}（${t.username}）</option>`).join('');
}

// ---------- 选科组合 / 选科科目（v34）----------
//   语文、数学、英语 = 所有班级默认都有（不在勾选项里）
//   理科 → 自动勾选 物理/化学/生物；文科 → 自动勾选 政治/历史/地理；小理/小文/综合 → 手动勾选
const CLASS_CORE_SUBJECTS = ['语文', '数学', '英语'];
const CLASS_ELECTIVE_SUBJECTS = ['物理', '化学', '生物', '政治', '历史', '地理'];
const CLASS_STREAM_PRESETS = { 理科: ['物理', '化学', '生物'], 文科: ['政治', '历史', '地理'], 小理: [], 小文: [], 综合: [] };

function renderElectiveCheckboxes(selected) {
  const sel = Array.isArray(selected) ? selected : [];
  const box = $('cElectives');
  if (!box) return;
  box.innerHTML = CLASS_ELECTIVE_SUBJECTS.map((s) => `
    <label class="dh-subject-chip${sel.includes(s) ? ' on' : ''}" data-subject="${classEsc(s)}">
      <input type="checkbox" class="c-elective" value="${classEsc(s)}" ${sel.includes(s) ? 'checked' : ''}> ${classEsc(s)}
    </label>`).join('');
}

function selectedElectives() {
  return [...document.querySelectorAll('#cElectives input.c-elective')]
    .filter((i) => i.checked).map((i) => i.value);
}

function setElectives(list) {
  const set = new Set(Array.isArray(list) ? list : []);
  document.querySelectorAll('#cElectives input.c-elective').forEach((i) => {
    i.checked = set.has(i.value);
    const chip = i.closest('.dh-subject-chip');
    if (chip) chip.classList.toggle('on', i.checked);
  });
  renderEffectiveHint();
}

// 该班开设学科 = 语文 + 数学 + 英语 + 选科科目（与后端 lib/classSubjects 同一口径）
function renderEffectiveHint() {
  const box = $('cEffectiveSubjects');
  if (!box) return;
  const electives = CLASS_ELECTIVE_SUBJECTS.filter((s) => selectedElectives().includes(s));
  const all = [...CLASS_CORE_SUBJECTS, ...electives];
  const stream = el.cStream ? el.cStream.value : '综合';
  box.textContent = electives.length
    ? `${stream} → 该班开设 ${all.length} 科：${all.join('、')}（班长端每日作业按此自动生成）`
    : `${stream} → 暂未设置选科科目：只含 语文、数学、英语；该班每日作业走「全局默认」科目（可在学年管理页配置）`;
}

const classElectiveBox = $('cElectives');
if (classElectiveBox) {
  classElectiveBox.addEventListener('change', (e) => {
    if (!e.target.classList.contains('c-elective')) return;
    const chip = e.target.closest('.dh-subject-chip');
    if (chip) chip.classList.toggle('on', e.target.checked);
    renderEffectiveHint();
  });
}
if (el.cStream) {
  el.cStream.addEventListener('change', () => {
    // 理科/文科 → 自动套用预设；小理/小文/综合 → 保留当前勾选（手动调整）
    const preset = CLASS_STREAM_PRESETS[el.cStream.value];
    if (preset && preset.length) setElectives(preset);
    else renderEffectiveHint();
  });
}

function openAddClass() {
  editClassId = null;
  el.classModalTitle.textContent = '添加班级';
  el.cName.value = '';
  fillClassGradeSelect(null);
  el.cYearRow.classList.remove('hidden');
  el.cYear.value = '';
  if (el.cStream) el.cStream.value = '综合';
  renderElectiveCheckboxes([]);
  renderEffectiveHint();
  el.cHeadTeacher.innerHTML = teacherSelectOptions(null, '');
  el.cDeputyTeacher.innerHTML = teacherSelectOptions(null, '');
  el.cError.classList.add('hidden');
  el.classModal.classList.remove('hidden');
}

function openEditClass(c) {
  editClassId = c.id;
  el.classModalTitle.textContent = `编辑班级：${c.class_name}`;
  el.cName.value = c.class_name;
  fillClassGradeSelect(c.grade);
  el.cYearRow.classList.add('hidden');
  if (el.cStream) el.cStream.value = c.stream || '综合';
  renderElectiveCheckboxes(Array.isArray(c.elective_subjects) ? c.elective_subjects : []);
  renderEffectiveHint();
  el.cHeadTeacher.innerHTML = teacherSelectOptions(c.head_teacher_id || null, c.grade_name || '');
  el.cDeputyTeacher.innerHTML = teacherSelectOptions(c.deputy_teacher_id || null, c.grade_name || '');
  el.cError.classList.add('hidden');
  el.classModal.classList.remove('hidden');
}

// 选年级后自动填充学年（添加模式）
if (el.cGrade) el.cGrade.addEventListener('change', () => {
  if (editClassId !== null) return;
  const g = allGrades.find((x) => x.grade_name === el.cGrade.value);
  if (g && g.academic_year) el.cYear.value = g.academic_year;
});

if (el.btnAddClass) el.btnAddClass.addEventListener('click', openAddClass);
if (el.cCancel) el.cCancel.addEventListener('click', () => el.classModal.classList.add('hidden'));
if (el.classModal) el.classModal.addEventListener('click', (e) => { if (e.target === el.classModal) el.classModal.classList.add('hidden'); });

if (el.cSubmit) el.cSubmit.addEventListener('click', async () => {
  const className = el.cName.value.trim();
  const gradeName = el.cGrade.value;
  const academicYear = el.cYear.value.trim();
  const headTeacherId = el.cHeadTeacher.value ? Number(el.cHeadTeacher.value) : null;
  const deputyTeacherId = el.cDeputyTeacher.value ? Number(el.cDeputyTeacher.value) : null;
  if (!className) return showClassErr('班级名称不能为空');
  if (!gradeName) return showClassErr('必须选择所属年级');
  // 选科组合 + 选科科目（v34）
  const stream = el.cStream ? el.cStream.value : '综合';
  const electiveSubjects = CLASS_ELECTIVE_SUBJECTS.filter((s) => selectedElectives().includes(s));
  const doSave = async (force) => {
    try {
      if (editClassId === null) {
        if (!academicYear) return showClassErr('学年不能为空');
        await apiFetch('/api/classes', { method: 'POST', body: JSON.stringify({ className, gradeName, academicYear, headTeacherId, deputyTeacherId, force, stream, electiveSubjects }) });
        showToast(electiveSubjects.length ? `班级已添加（${stream}：${electiveSubjects.join('、')}）` : '班级已添加');
      } else {
        await apiFetch('/api/classes/' + editClassId, { method: 'PUT', body: JSON.stringify({ className, headTeacherId, deputyTeacherId, force, stream, electiveSubjects }) });
        showToast('班级已更新');
      }
      el.classModal.classList.add('hidden');
      await loadClassList();
      await loadUsers();
    } catch (err) {
      if (err.needConfirm) {
        openConfirm('班主任冲突', `${err.message}（原正班主任：${err.existingTeacher ? err.existingTeacher.name : ''}）`, () => doSave(true));
        return;
      }
      showClassErr(err.message);
    }
  };
  await doSave(false);
});

function showClassErr(msg) { el.cError.textContent = msg; el.cError.classList.remove('hidden'); }

if (el.btnImportClass) el.btnImportClass.addEventListener('click', () => {
  el.classImportFile.value = '';
  el.classImportResult.className = 'import-preview';
  el.classImportResult.textContent = '';
  el.classImportModal.classList.remove('hidden');
});
if (el.classImportCancel) el.classImportCancel.addEventListener('click', () => el.classImportModal.classList.add('hidden'));
if (el.classImportModal) el.classImportModal.addEventListener('click', (e) => { if (e.target === el.classImportModal) el.classImportModal.classList.add('hidden'); });
if (el.classImportSubmit) el.classImportSubmit.addEventListener('click', async () => {
  try {
    const data = await apiUpload('/api/classes/import', fileForm(el.classImportFile));
    let msg = `导入完成：新增 ${data.inserted}，跳过 ${data.skipped}`;
    // 逐行失败原因（选科组合/科目非法、年级不存在、教师找不到等）直接展示，便于老师改表重传
    const errs = Array.isArray(data.errors) ? data.errors : [];
    if (errs.length) {
      msg += '\n跳过明细：\n' + errs.slice(0, 10).map((e) => `· ${e.name}：${e.reason}`).join('\n');
      if (errs.length > 10) msg += `\n· …另有 ${errs.length - 10} 条`;
    }
    el.classImportResult.textContent = msg;
    el.classImportResult.className = 'import-preview ' + (data.inserted > 0 ? 'ok' : 'err');
    await loadClassList();
  } catch (err) {
    el.classImportResult.textContent = err.message;
    el.classImportResult.className = 'import-preview err';
  }
});
// 下载导入模板（含选科组合/选科科目示例 + 填写说明）
const btnClassTemplate = $('btnClassTemplate');
if (btnClassTemplate) btnClassTemplate.addEventListener('click', () => {
  window.open('/api/classes/import-template', '_blank');
});

// ============================================================
// 学年管理
// ============================================================
// 学期设置：决定各页面「本学期」筛选的起止日期（存 system_settings）
let termDefaults = null;

function termRangeText(a, b) { return (a && b) ? `${a} ~ ${b}` : '未填写'; }

function renderTermSettings(term, defaults, resolved) {
  if (!term) return;
  if (defaults) termDefaults = defaults;
  el.termFirstStart.value = term.firstStart || '';
  el.termFirstEnd.value = term.firstEnd || '';
  el.termSecondStart.value = term.secondStart || '';
  el.termSecondEnd.value = term.secondEnd || '';
  el.termCurrent.value = term.currentTerm || 'first';
  if (!el.termStatus) return;
  const d = termDefaults || {};
  const label = term.currentTermLabel || '';
  // 各页面「本学期」实际统计区间：学期未结束 → 截到今天（本学期至今）
  const winText = (resolved && resolved.startDate)
    ? `<b>${resolved.startDate} ~ ${resolved.endDate}</b>` +
      (resolved.clipped ? `（学期结束日 ${resolved.rawEndDate}，未到则统计到今天）` : '')
    : '—';
  if (term.configured) {
    el.termStatus.className = 'term-status ok';
    const otherMissing = (term.missingTerms || []).filter((t) => t !== term.currentTerm);
    el.termStatus.innerHTML =
      `✅ 当前学期（<b>${label}</b>）起止日期已设置：${termRangeText(term.firstStart, term.firstEnd)}（上学期）｜${termRangeText(term.secondStart, term.secondEnd)}（下学期）<br>` +
      `各页面「本学期」按此统计：${winText}` +
      (otherMissing.length
        ? `<br>ℹ️ ${otherMissing.map((t) => (t === 'first' ? '上学期' : '下学期')).join('、')}起止日期尚未填写，切换到该学期前请先填写。`
        : '');
  } else {
    el.termStatus.className = 'term-status warn';
    el.termStatus.innerHTML =
      `⚠️ 请先设置<b>当前学期（${label}）</b>的起止日期：当前各页面「本学期」按默认口径统计（${winText}）。` +
      `默认参考：上学期 ${termRangeText(d.firstStart, d.firstEnd)}、下学期 ${termRangeText(d.secondStart, d.secondEnd)}。`;
  }
}

async function loadSettings() {
  const s = await apiFetch('/api/settings');
  el.currentYearVal.textContent = s.currentAcademicYear;
  el.switchYearSelect.innerHTML = s.years.map((y) => `<option value="${y}">${y}</option>`).join('');
  el.switchYearSelect.value = s.currentAcademicYear;
  renderTermSettings(s.term, s.termDefaults, s.termResolved);
}

function termPayload() {
  return {
    firstStart: el.termFirstStart ? el.termFirstStart.value : '',
    firstEnd: el.termFirstEnd ? el.termFirstEnd.value : '',
    secondStart: el.termSecondStart ? el.termSecondStart.value : '',
    secondEnd: el.termSecondEnd ? el.termSecondEnd.value : '',
    currentTerm: el.termCurrent ? el.termCurrent.value : 'first',
  };
}

if (el.btnSaveTerm) el.btnSaveTerm.addEventListener('click', async () => {
  el.termMsg.textContent = '保存中...';
  try {
    const r = await apiFetch('/api/settings/term', { method: 'PUT', body: JSON.stringify(termPayload()) });
    renderTermSettings(r.term, termDefaults, r.termResolved);
    el.termMsg.textContent = r.term.configured ? '已保存' : '已保存（起止日期留空 = 未配置，按默认口径统计）';
    showToast('学期设置已保存');
  } catch (err) {
    el.termMsg.textContent = '保存失败：' + err.message;
  }
});

if (el.btnTermDefault) el.btnTermDefault.addEventListener('click', () => {
  const d = termDefaults;
  if (!d) { el.termMsg.textContent = '默认值加载中，请稍后重试'; return; }
  el.termFirstStart.value = d.firstStart || '';
  el.termFirstEnd.value = d.firstEnd || '';
  el.termSecondStart.value = d.secondStart || '';
  el.termSecondEnd.value = d.secondEnd || '';
  el.termMsg.textContent = '已填入默认值，请点击「保存学期设置」后生效';
});

if (el.btnTermClear) el.btnTermClear.addEventListener('click', () => {
  el.termFirstStart.value = '';
  el.termFirstEnd.value = '';
  el.termSecondStart.value = '';
  el.termSecondEnd.value = '';
  el.termMsg.textContent = '已清空，保存后「本学期」按默认口径统计';
});

if (el.btnSwitchYear) el.btnSwitchYear.addEventListener('click', async () => {
  const year = el.switchYearSelect.value;
  if (!year) return;
  openConfirm('切换当前学年', `确定将当前学年切换为 ${year} 吗？签到与分析页面将按新学年显示。`, async () => {
    try {
      await apiFetch('/api/settings/current-year', { method: 'PUT', body: JSON.stringify({ academicYear: year }) });
      showToast(`当前学年已切换为 ${year}`);
      await loadSettings();
    } catch (err) { showToast('切换失败：' + err.message); }
  });
});

document.querySelectorAll('input[name="yearMode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const mode = radio.value;
    el.modeDesc.textContent =
      mode === 'A' ? 'A：一年级→二年级…六年级→毕业；新学年自动建立对应年级与班级，学生整体升级。' :
      mode === 'B' ? 'B：通过 Excel 导入新学年的年级、班级与学生名单。' :
      'C：一次性导入年级+班级+学生+教师带班（4 个 Sheet）。';
    el.yearImportRow.classList.toggle('hidden', mode === 'A');
  });
});

if (el.btnExecYear) el.btnExecYear.addEventListener('click', async () => {
  const targetYear = el.targetYearInput.value.trim();
  const mode = document.querySelector('input[name="yearMode"]:checked').value;
  if (!targetYear) { el.yearMsg.textContent = '请填写目标学年'; return; }
  el.yearMsg.textContent = '执行中...';
  el.btnExecYear.disabled = true;
  try {
    let data;
    if (mode === 'A') {
      data = await apiFetch('/api/academic-year/upgrade', { method: 'POST', body: JSON.stringify({ targetYear }) });
      el.yearMsg.textContent = `一键升级完成，当前学年已切换为 ${data.currentAcademicYear}`;
    } else {
      const fd = fileForm(el.yearImportFile);
      data = await apiUpload('/api/academic-year/import', fd);
      el.yearMsg.textContent = `组合导入完成：年级 ${data.grades}、班级 ${data.classes}、学生 ${data.students}、教师带班 ${data.teachers}`;
    }
    await loadSettings();
  } catch (err) {
    el.yearMsg.textContent = err.message;
  } finally {
    el.btnExecYear.disabled = false;
  }
});

// ============================================================
// 通用确认弹窗
// ============================================================
let confirmAction = null;
function openConfirm(title, message, onOk) {
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  confirmAction = onOk;
  el.confirmModal.classList.remove('hidden');
}
function closeConfirm() { el.confirmModal.classList.add('hidden'); confirmAction = null; }
if (el.confirmOk) el.confirmOk.addEventListener('click', () => { const fn = confirmAction; closeConfirm(); if (fn) fn(); });
if (el.confirmCancel) el.confirmCancel.addEventListener('click', closeConfirm);
if (el.confirmModal) el.confirmModal.addEventListener('click', (e) => { if (e.target === el.confirmModal) closeConfirm(); });

// ---------- 用户菜单（个人中心 / 帮助文档 / 退出登录）----------
// 顶部导航栏（含右上角用户菜单）由统一组件 navbar.js 渲染与接管，页面脚本不再重复绑定。
// 统一页头返回按钮：
//  - 独立页面模式（4 个后台子页各自成页）→ 一律「← 返回签到」回签到操作台
//  - 旧的单页 Tab 模式 → 子页返回后台管理首页，首页返回签到操作台
function updateBackButton() {
  if (!el.btnBack) return;
  if (IS_STANDALONE) {
    el.btnBack.innerHTML = '<span class="back-arrow">←</span> 返回签到';
    return;
  }
  const onHome = currentTabFromPath() === 'users';
  el.btnBack.innerHTML = onHome
    ? '<span class="back-arrow">←</span> 返回签到'
    : '<span class="back-arrow">←</span> 返回后台管理首页';
}
if (el.btnBack) el.btnBack.addEventListener('click', () => {
  if (IS_STANDALONE || currentTabFromPath() === 'users') {
    window.location.href = '/dashboard';
    return;
  }
  history.pushState({}, '', TAB_PATH.users);
  switchTab('users');
  updateBackButton();
});

// ---------- 初始化 ----------
(async function init() {
  try {
    const me = await apiFetch('/api/auth/me');
    if (el.userInfo) el.userInfo.textContent = displayNameForNav(me.user);
    if (me.user.role !== 'admin') { window.location.href = '/dashboard'; return; }
  } catch (_) {}
  updateBackButton();
  // 独立页模式：只加载本页需要的数据（避免访问不存在的元素）
  if (IS_STANDALONE) {
    try {
      if (ADMIN_PAGE === 'users') {
        await Promise.all([loadClassOptions(), loadTeachers()]);
        await loadUsers();
      } else if (ADMIN_PAGE === 'grades') {
        await loadGradeYearFilter();
        await loadGrades();
      } else if (ADMIN_PAGE === 'classes') {
        await Promise.all([loadClassOptions(), loadTeachers(), loadAllGrades()]);
        await loadClassFilters();
        await loadClassList();
      } else if (ADMIN_PAGE === 'years') {
        await loadSettings();
        await dhInit();
      }
    } catch (err) {
      showToast('加载失败：' + err.message);
    }
    return;
  }
  // 旧的单页 Tab 模式（admin.html）：按 URL 激活子页并加载全部数据
  switchTab(currentTabFromPath());
  await Promise.all([loadClassOptions(), loadTeachers(), loadAllGrades()]);
  await loadUsers();
  await loadGradeYearFilter();
  await loadGrades();
  await loadClassFilters();
  await loadClassList();
  await loadSettings();
  await dhInit();
})();

// ============================================================
// 每日作业科目配置（学年管理页 ·「📋 每日作业科目配置」卡片）
//   班长端每天按这里的科目自动生成「今日作业」条目；可配置"全局默认"，也可给某个班单独配置。
//   接口：GET/PUT /api/homework/daily-subjects（仅管理员可写）
// ============================================================
const DH = {
  el: {
    scope: $('dhScope'),
    scopeHint: $('dhScopeHint'),
    subjects: $('dhSubjects'),
    deadline: $('dhDeadline'),
    save: $('btnDhSave'),
    def: $('btnDhDefault'),
    reset: $('btnDhResetClass'),
    msg: $('dhMsg'),
  },
  state: { classId: null, allSubjects: [], effective: [], global: [], classSubjects: null, source: 'global', defaults: [], deadlineTime: '' },
};

function dhEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function dhSay(text, isErr) {
  const m = DH.el.msg;
  if (!m) return;
  m.textContent = text || '';
  m.className = 'dh-msg' + (isErr ? ' err' : '');
  if (text) setTimeout(() => { if (m.textContent === text) m.textContent = ''; }, 4000);
}

async function dhInit() {
  if (!DH.el.scope || !DH.el.subjects) return;   // 非学年管理页：不参与
  try {
    const d = await apiFetch('/api/classes');
    const list = d.classes || [];
    DH.el.scope.innerHTML = '<option value="">全局默认（所有班级）</option>' +
      list.map((c) => `<option value="${c.id}">${dhEsc(c.className)}（单独配置）</option>`).join('');
    await dhLoad();
  } catch (err) {
    DH.el.subjects.innerHTML = `<span class="hint">加载失败：${dhEsc(err.message)}</span>`;
  }
}

async function dhLoad() {
  const classId = DH.el.scope.value ? Number(DH.el.scope.value) : null;
  const d = await apiFetch('/api/homework/daily-subjects' + (classId ? '?classId=' + classId : ''));
  DH.state = {
    classId,
    allSubjects: d.allSubjects || [],
    effective: d.effective || [],
    global: d.global || [],
    classSubjects: d.classSubjects || null,
    source: d.source || 'global',
    sourceDetail: d.sourceDetail || '',
    stream: d.stream || null,
    electiveSubjects: d.electiveSubjects || [],
    classEffectiveSubjects: d.classEffectiveSubjects || [],
    className: d.className || null,
    defaults: d.defaults || [],
    deadlineTime: d.deadlineTime || d.deadlineDefault || '23:59',
  };
  if (DH.el.deadline) DH.el.deadline.value = DH.state.deadlineTime;
  dhRender();
}

function dhRender() {
  const st = DH.state;
  DH.el.subjects.innerHTML = st.allSubjects.map((s) => `
    <label class="dh-subject-chip${st.effective.includes(s) ? ' on' : ''}" data-subject="${dhEsc(s)}">
      <input type="checkbox" ${st.effective.includes(s) ? 'checked' : ''}> ${dhEsc(s)}
    </label>`).join('') || '<span class="hint">没有可选科目</span>';
  if (DH.el.scopeHint) {
    // 三级来源说清楚"为什么是这几科"：管理员覆盖 > 班级选科（v34）> 全局默认
    let hint;
    if (!st.classId) {
      hint = `全局默认（${st.global.length} 科）：未设置选科的班级（选科=综合）按此生成`;
    } else if (st.source === 'class') {
      hint = '该班已单独配置（优先于班级选科与全局默认）';
    } else if (st.source === 'class_stream') {
      const elect = (st.electiveSubjects || []).length ? st.electiveSubjects.join('、') : '（按组合预设）';
      hint = `按班级选科推导：${st.stream || '综合'}（${elect}）→ 语文、数学、英语 + 选科科目 = ${st.effective.length} 科；`
        + '如需临时改成本班专用科目，在下方勾选后点「保存科目」即可（会覆盖选科推导）';
    } else {
      hint = `该班未单独配置（当前选科：${st.stream || '综合'}）→ 使用全局默认 ${st.global.length} 科；`
        + '如需按选科生成，请在「班级管理」里设置该班的选科组合与选科科目';
    }
    DH.el.scopeHint.textContent = hint;
  }
  if (DH.el.reset) DH.el.reset.classList.toggle('hidden', !st.classId || !(st.classSubjects && st.classSubjects.length));
}

function dhCheckedSubjects() {
  return [...DH.el.subjects.querySelectorAll('.dh-subject-chip')]
    .filter((c) => c.querySelector('input') && c.querySelector('input').checked)
    .map((c) => c.dataset.subject);
}

async function dhSave(subjects) {
  const st = DH.state;
  // 班级范围下"一个都不选" = 清除该班单独配置（回到全局默认）
  if (!subjects.length && !st.classId) { dhSay('全局默认至少选择一个科目', true); return; }
  // 截止时间（可选，全局唯一配置；班级范围下同样保存到全局）
  const deadlineTime = DH.el.deadline && DH.el.deadline.value ? DH.el.deadline.value : null;
  try {
    const body = { classId: st.classId, subjects };
    if (deadlineTime) body.deadlineTime = deadlineTime;
    const d = await apiFetch('/api/homework/daily-subjects', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    DH.state.effective = d.effective || subjects;
    DH.state.global = d.global || DH.state.global;
    DH.state.classSubjects = d.classSubjects || null;
    DH.state.source = d.source || DH.state.source;
    if (d.deadlineTime) DH.state.deadlineTime = d.deadlineTime;
    dhRender();
    dhSay(st.classId
      ? (subjects.length ? '已保存（该班每天按此科目生成）' : '已清除该班配置，恢复使用全局默认')
      : `已保存（全局默认，所有未单独配置的班级生效；截止时间 ${DH.state.deadlineTime}）`);
    showToast('每日作业配置已保存');
  } catch (err) {
    dhSay('保存失败：' + err.message, true);
  }
}

if (DH.el.scope) DH.el.scope.addEventListener('change', () => { dhLoad().catch((e) => dhSay('加载失败：' + e.message, true)); });
if (DH.el.subjects) {
  DH.el.subjects.addEventListener('change', (e) => {
    const chip = e.target.closest('.dh-subject-chip');
    if (chip) chip.classList.toggle('on', !!e.target.checked);
  });
}
if (DH.el.save) DH.el.save.addEventListener('click', () => dhSave(dhCheckedSubjects()));
if (DH.el.def) {
  DH.el.def.addEventListener('click', () => {
    const defs = DH.state.defaults && DH.state.defaults.length ? DH.state.defaults : ['语文', '数学', '英语', '物理', '化学', '生物'];
    DH.el.subjects.querySelectorAll('.dh-subject-chip').forEach((c) => {
      const on = defs.includes(c.dataset.subject);
      c.querySelector('input').checked = on;
      c.classList.toggle('on', on);
    });
    dhSay('已勾选默认 6 科，别忘了点「保存科目」');
  });
}
if (DH.el.reset) {
  DH.el.reset.addEventListener('click', async () => {
    if (!DH.state.classId) return;
    try {
      const d = await apiFetch('/api/homework/daily-subjects', {
        method: 'PUT',
        body: JSON.stringify({ classId: DH.state.classId, subjects: [] }),
      });
      DH.state.effective = d.effective || d.global || [];
      DH.state.classSubjects = d.classSubjects || null;
      DH.state.source = d.source || 'global';
      dhRender();
      dhSay('该班已恢复使用全局默认');
      showToast('已恢复全局默认');
    } catch (err) {
      dhSay('恢复失败：' + err.message, true);
    }
  });
}
