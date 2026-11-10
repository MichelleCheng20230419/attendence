// ============================================================
// 个人中心页面逻辑（/profile）
// ============================================================
'use strict';

const APP_VERSION = '1.8.0';
const ROLE_CN = { admin: '管理员', teacher: '教师', student: '学生' };

const $ = (id) => document.getElementById(id);
const el = {
  avatar: $('avatar'),
  profileTitle: $('profileTitle'),
  roleTag: $('roleTag'),
  roleTag2: $('roleTag2'),
  fName: $('fName'),
  fEmployeeNo: $('fEmployeeNo'),
  fOrg: $('fOrg'),
  fPhone: $('fPhone'),
  fEmail: $('fEmail'),
  fGrade: $('fGrade'),
  fClass: $('fClass'),
  fStudentCount: $('fStudentCount'),
  fWeekRate: $('fWeekRate'),
  fLastLoginAt: $('fLastLoginAt'),
  fLastLoginIp: $('fLastLoginIp'),
  btnSave: $('btnSave'),
  btnBack: $('btnBack'),
  btnChangePass: $('btnChangePass'),
  btnUser: $('btnUser'),
  userInfo: $('userInfo'),
  userDropdown: $('userDropdown'),
  menuProfile: $('menuProfile'),
  menuLogout: $('menuLogout'),
  pwdModal: $('pwdModal'),
  pwdOld: $('pwdOld'),
  pwdNew: $('pwdNew'),
  pwdConfirm: $('pwdConfirm'),
  pwdError: $('pwdError'),
  pwdCancel: $('pwdCancel'),
  pwdSubmit: $('pwdSubmit'),
  // 教学设置（仅教师显示）：未锁定→首次确认表单；已锁定→只读展示
  teachCard: $('teachCard'),
  teachCardTitle: $('teachCardTitle'),
  teachSetupBox: $('teachSetupBox'),
  teachReadBox: $('teachReadBox'),
  tSetupName: $('tSetupName'),
  tSubject: $('tSubject'),
  tGrade: $('tGrade'),
  tClasses: $('tClasses'),
  tHeadNote: $('tHeadNote'),
  tMsg: $('tMsg'),
  tSave: $('tSave'),
  tReadSubject: $('tReadSubject'),
  tReadClasses: $('tReadClasses'),
  toast: $('toast'),
};

let profile = null;   // GET /api/user/profile 返回的 user
let classes = [];     // [{id, className, grade}]

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

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- 加载 ----------
let currentYear = null;

async function loadClasses() {
  try {
    const data = await apiFetch('/api/classes');
    classes = data.classes || [];
    currentYear = data.currentAcademicYear || null;
  } catch (err) {
    console.error('[班级加载失败]', err.message);
    classes = [];
  }
}

// 个人中心联动：年级下拉只显示“当前学年”的年级；班级按年级过滤
// 兜底：当前学年下没有班级时（如学年切换但新学年数据未建立），回退显示全部班级
function currentYearClasses() {
  if (!currentYear) return classes;
  const list = classes.filter((c) => !c.academicYear || c.academicYear === currentYear);
  return list.length > 0 ? list : classes;
}

function fillClassSelects() {
  const list = currentYearClasses();
  const grades = [...new Set(list.map((c) => c.grade).filter(Boolean))];
  el.fGrade.innerHTML = '<option value="">请选择年级</option>' +
    grades.map((g) => `<option value="${g}">${g}</option>`).join('');

  // 按用户当前班级预选
  const cur = profile && profile.classId ? list.find((c) => c.id === profile.classId) : null;
  if (cur && cur.grade) {
    el.fGrade.value = cur.grade;
  }
  renderClassOptions();
}

function renderClassOptions() {
  const list = currentYearClasses();
  const grade = el.fGrade.value;
  const filtered = grade ? list.filter((c) => c.grade === grade) : list;
  el.fClass.innerHTML = '<option value="">请选择班级</option>' +
    filtered.map((c) => `<option value="${c.id}">${c.className}</option>`).join('');
  if (profile && profile.classId) {
    el.fClass.value = String(profile.classId);
  }
}

async function loadProfile() {
  try {
    const data = await apiFetch('/api/user/profile');
    profile = data.user;
    const u = profile;

    // 头像：姓名首字
    const nm = u.realName || u.displayName || u.username || '';
    const initial = (nm || '?').charAt(0);
    el.avatar.textContent = initial;
    el.profileTitle.textContent = nm;
    el.userInfo.textContent = u.role === 'teacher' ? `${nm}（教师）` : nm;

    const roleCN = ROLE_CN[u.role] || u.role;
    el.roleTag.textContent = roleCN;
    el.roleTag.className = 'tag role-tag ' + (u.role === 'admin' ? 'admin' : u.role === 'teacher' ? 'active' : 'pending');
    el.roleTag2.textContent = roleCN;
    el.roleTag2.className = 'tag role-tag ' + (u.role === 'admin' ? 'admin' : u.role === 'teacher' ? 'active' : 'pending');

    el.fName.value = u.displayName || '';
    el.fEmployeeNo.value = u.employeeNo || '—';
    el.fOrg.value = u.organization || '';
    el.fPhone.value = u.phone || '';
    el.fEmail.value = u.email || '';

    // 班级信息
    fillClassSelects();
    const cs = data.classStats;
    if (cs) {
      el.fStudentCount.textContent = cs.studentCount;
      el.fWeekRate.textContent = cs.weekRate !== null ? cs.weekRate + '%' : '—';
    } else {
      el.fStudentCount.textContent = '—';
      el.fWeekRate.textContent = '—';
    }

    // 上次登录
    const ll = data.lastLogin;
    el.fLastLoginAt.textContent = ll && ll.at ? fmtTime(ll.at) : '—';
    el.fLastLoginIp.textContent = ll && ll.ip ? ll.ip : '—';
  } catch (err) {
    console.error('[个人资料加载失败]', err.message);
    showToast('加载失败：' + err.message);
  }
}

// ---------- 年级/班级联动 ----------
el.fGrade.addEventListener('change', () => {
  profile = profile || {};
  delete profile.classId; // 切换年级后需重新选班级
  renderClassOptions();
});

// ---------- 保存 ----------
function validateForm() {
  const name = el.fName.value.trim();
  const phone = el.fPhone.value.trim();
  const email = el.fEmail.value.trim();
  if (!name) return '姓名不能为空';
  if (phone && !/^\d{11}$/.test(phone)) return '手机号必须是 11 位数字';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '邮箱格式不正确（需包含 @ 和 .）';
  return null;
}

el.btnSave.addEventListener('click', async () => {
  const err = validateForm();
  if (err) { showToast(err); return; }
  const classId = el.fClass.value ? Number(el.fClass.value) : null;
  const body = {
    displayName: el.fName.value.trim(),
    organization: el.fOrg.value.trim(),
    phone: el.fPhone.value.trim(),
    email: el.fEmail.value.trim(),
    classId,
  };
  try {
    await apiFetch('/api/user/profile', { method: 'PUT', body: JSON.stringify(body) });
    showToast('保存成功');
    await loadProfile();
  } catch (e) {
    showToast('保存失败：' + e.message);
  }
});

// ---------- 教学设置（仅教师显示） ----------
//   profile_locked = false → 首次登录：可编辑，点"确认并锁定"后写库并锁定
//   profile_locked = true  → 只读展示（"如需修改，请联系管理员"）
let teachClasses = [];        // [{classId, className, grade, roleInClass, isHeadTeacher}]
let teachProfileLocked = true;
let teachSetupMode = false;

function teachMsg(text, isError = false) {
  if (!text) { el.tMsg.classList.add('hidden'); el.tMsg.textContent = ''; return; }
  el.tMsg.textContent = text;
  el.tMsg.classList.remove('hidden');
  el.tMsg.style.color = isError ? 'var(--danger)' : 'var(--success)';
}

function roleLabelOfClass(c) {
  return c.roleInClass === 'head_teacher' || c.isHeadTeacher ? '班主任' : '任课老师';
}

async function loadTeachingSettings() {
  if (!profile || profile.role !== 'teacher') return; // 非教师不显示该区块
  el.teachCard.classList.remove('hidden');
  try {
    const s = await apiFetch('/api/teacher/settings');
    teachProfileLocked = s.profileLocked === true;
    teachSetupMode = !teachProfileLocked;
    teachClasses = s.classes || [];
    el.tSubject.value = s.subject || '';
    renderTeachMode();
    // 首次登录（未锁定）：引导到教学设置区块
    if (teachSetupMode) {
      try { el.teachCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {}
    }
  } catch (err) {
    // 已锁定/异常时也保持界面可用：默认按只读处理
    teachMsg('教学设置加载失败：' + err.message, true);
  }
}

function renderTeachMode() {
  el.teachSetupBox.classList.toggle('hidden', !teachSetupMode);
  el.teachReadBox.classList.toggle('hidden', teachSetupMode);
  el.teachCardTitle.textContent = teachSetupMode ? '📚 教学设置（首次确认）' : '📚 教学设置';
  if (teachSetupMode) {
    el.tSetupName.textContent = (profile && (profile.realName || profile.displayName || profile.username)) || '—';
    renderTeachClasses();
  } else {
    el.tReadSubject.textContent = el.tSubject.value || '未设置';
    el.tReadClasses.textContent = teachClasses.length
      ? teachClasses.map((c) => `${c.className}（${roleLabelOfClass(c)}）`).join('、')
      : '未设置';
  }
}

// 只渲染"当前学年 + 所选年级"的班级；已绑定但不在列表中的班级单独展示（避免"看不见却仍生效"）
function renderTeachClasses() {
  const list = currentYearClasses();
  const bound = new Map(teachClasses.map((c) => [c.classId, c]));
  const headIds = teachClasses.filter((c) => c.isHeadTeacher || c.roleInClass === 'head_teacher').map((c) => c.classId);
  const extra = teachClasses.filter((c) => !list.some((x) => x.id === c.classId));

  // 年级下拉（按当前学年）
  const grades = [...new Set(list.map((c) => c.grade).filter(Boolean))];
  const prev = el.tGrade.value;
  el.tGrade.innerHTML = '<option value="">全部年级</option>' +
    grades.map((g) => `<option value="${g}">${g}</option>`).join('');
  if (prev && grades.includes(prev)) el.tGrade.value = prev;

  const grade = el.tGrade.value;
  const shown = grade ? list.filter((c) => c.grade === grade) : list;
  const all = shown.concat(extra.map((c) => ({ id: c.classId, className: c.className, grade: c.grade })));
  el.tClasses.innerHTML = all.length === 0
    ? '<span class="hint" style="font-size:12px">该年级暂无班级</span>'
    : all.map((c) => {
        const cur = bound.get(c.id);
        const isHead = headIds.includes(c.id);
        const roleText = isHead ? '班主任' : '任课老师';
        return `<label class="teach-class-item ${isHead ? 'head' : ''}">
          <input type="checkbox" class="teach-class-cb" value="${c.id}" ${cur ? 'checked' : ''} ${isHead ? 'data-head="1"' : ''}>
          <span>${c.className}</span><span style="font-size:11px">（${roleText}）</span>
        </label>`;
      }).join('');
  el.tHeadNote.classList.toggle('hidden', headIds.length === 0);
  if (headIds.length > 0) {
    el.tHeadNote.textContent = 'ℹ️ 你已担任班主任的班级会自动保留（不可取消）';
  }
}

el.tGrade.addEventListener('change', renderTeachClasses);

// "确认并锁定"：一次性提交学科 + 所带班级，并锁定（profile_locked = true）
el.tSave.addEventListener('click', async () => {
  const subject = el.tSubject.value || '';
  const classIds = [...el.tClasses.querySelectorAll('.teach-class-cb:checked')].map((cb) => Number(cb.value));
  if (!subject) { teachMsg('请先选择所教学科', true); showToast('请先选择所教学科'); return; }
  if (classIds.length === 0) { teachMsg('请至少选择一个所带班级', true); showToast('请至少选择一个所带班级'); return; }
  el.tSave.disabled = true;
  teachMsg('');
  try {
    const res = await apiFetch('/api/teacher/classes', {
      method: 'PUT',
      body: JSON.stringify({ subject, classIds, lock: true }),
    });
    teachClasses = res.classes || [];
    teachProfileLocked = res.profileLocked === true;
    teachSetupMode = !teachProfileLocked;
    renderTeachMode();
    // 通知其他标签页（如"作业管理"）刷新教学设置，避免显示旧科目
    try { localStorage.setItem('hwTeachSettingsRev', String(Date.now())); } catch (_) {}
    showToast('教学设置已确认并锁定');
    setTimeout(() => { window.location.href = '/dashboard'; }, 700);
  } catch (err) {
    teachMsg('保存失败：' + err.message, true);
    showToast('保存失败：' + err.message);
  } finally {
    el.tSave.disabled = false;
  }
});

// 班主任班级不可取消（与后端规则一致，前端同步提示）
el.tClasses.addEventListener('change', (e) => {
  const cb = e.target;
  if (cb && cb.classList.contains('teach-class-cb') && cb.dataset.head === '1' && !cb.checked) {
    cb.checked = true;
    showToast('班主任班级自动保留，不能取消');
  }
});

// 页面重新可见 / 从往返缓存恢复时，刷新教学设置（避免显示旧值）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && profile && profile.role === 'teacher') {
    loadTeachingSettings();
  }
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted && profile && profile.role === 'teacher') loadTeachingSettings();
});

// ---------- 修改密码 ----------
function openPwdModal() {
  el.pwdOld.value = '';
  el.pwdNew.value = '';
  el.pwdConfirm.value = '';
  el.pwdError.classList.add('hidden');
  el.pwdModal.classList.remove('hidden');
}

function closePwdModal() {
  el.pwdModal.classList.add('hidden');
}

el.btnChangePass.addEventListener('click', openPwdModal);
el.pwdCancel.addEventListener('click', closePwdModal);
el.pwdModal.addEventListener('click', (e) => { if (e.target === el.pwdModal) closePwdModal(); });

el.pwdSubmit.addEventListener('click', async () => {
  const oldPassword = el.pwdOld.value;
  const newPassword = el.pwdNew.value;
  const confirmPassword = el.pwdConfirm.value;
  if (!oldPassword || !newPassword || !confirmPassword) {
    el.pwdError.textContent = '请填写完整的密码信息';
    el.pwdError.classList.remove('hidden');
    return;
  }
  try {
    await apiFetch('/api/user/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword, confirmPassword }),
    });
    closePwdModal();
    showToast('密码修改成功，下次请用新密码登录');
  } catch (e) {
    el.pwdError.textContent = e.message;
    el.pwdError.classList.remove('hidden');
  }
});

// ---------- 用户菜单（个人中心 / 帮助文档 / 退出登录）----------
// 顶部导航栏（含右上角用户菜单）由统一组件 navbar.js 渲染与接管，页面脚本不再重复绑定。

// 统一页头返回按钮：返回上一页；若无上一页（直接打开/新标签）则回签到操作台
el.btnBack.addEventListener('click', () => {
  let cameFromSameOrigin = false;
  try {
    // 仅在顶层窗口判断来源（iframe 内嵌时 document.referrer 指向宿主页面，不能作为"上一页"依据）
    cameFromSameOrigin = window.top === window.self
      && !!document.referrer
      && document.referrer.indexOf(window.location.origin) === 0;
  } catch (_) { cameFromSameOrigin = false; }
  if (cameFromSameOrigin && window.history.length > 1) window.history.back();
  else window.location.href = '/dashboard';
});

// ---------- 初始化 ----------
(async function init() {
  await loadClasses();
  await loadProfile();
  await loadTeachingSettings(); // 新增：教师"教学设置"区块（非教师不显示）
})();
