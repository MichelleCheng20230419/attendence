// ============================================================
// 作业管理页（任课老师 / 班主任 / 管理员）
// 路径：/homework-manage
//  1) 发布作业：班级（可多选，仅自己所带班级）+ 学科 + 标题 + 截止时间 + 备注
//  2) 作业列表：**当天（默认）** 的全部作业 —— 系统每天 0 点自动发布的「每日作业」+ 老师手动发布的作业
//     列：班级/学科/标题/截止时间/已交-未交/提交率/状态/操作（查看提交情况·编辑·删除）
//     自动作业标「每日作业」标签、发布者=系统，不可编辑/删除（改选科后对新的一天生效）
//  3) 提交详情：已交/未交名单 + 提交率；点学生姓名 → 该生作业记录；可导出
//  4) 班长在签到操作台录入提交情况后，本页每 30 秒自动刷新（切回本标签页也会立即刷新）
// ============================================================
const $ = (id) => document.getElementById(id);
const el = {
  userInfo: $('userInfo'), btnUser: $('btnUser'), userDropdown: $('userDropdown'),
  menuProfile: $('menuProfile'), menuLogout: $('menuLogout'), btnBack: $('btnBack'),
  btnPublish: $('btnPublish'), btnExport: $('btnExport'),
  fClass: $('fClass'), fSubject: $('fSubject'), fDate: $('fDate'),
  fMine: $('fMine'), btnToday: $('btnToday'), btnAllDates: $('btnAllDates'),
  teachHint: $('teachHint'),
  scTasks: $('scTasks'), scDaily: $('scDaily'), scRate: $('scRate'), scMissing: $('scMissing'),
  taskBody: $('taskBody'), taskEmpty: $('taskEmpty'),
  pubModal: $('pubModal'), pubTitle: $('pubTitle'), pubClasses: $('pubClasses'),
  pubSubject: $('pubSubject'), pubSubjectHint: $('pubSubjectHint'), pubHomeworkTitle: $('pubHomeworkTitle'),
  pubAdminBanner: $('pubAdminBanner'), pubSubjectSel: $('pubSubjectSel'),
  pubClassLabel: $('pubClassLabel'), pubSubjectLabel: $('pubSubjectLabel'),
  pubDeadlineDate: $('pubDeadlineDate'), pubDeadlineTime: $('pubDeadlineTime'),
  pubRemark: $('pubRemark'), pubError: $('pubError'), pubCancel: $('pubCancel'), pubSubmit: $('pubSubmit'),
  detailModal: $('detailModal'), detailTitle: $('detailTitle'),
  detailBody: $('detailBody'), detailClose: $('detailClose'), detailExport: $('detailExport'),
  detailBack: $('detailBack'), hwInfoTitle: $('hwInfoTitle'), hwInfoGrid: $('hwInfoGrid'), hwStatCards: $('hwStatCards'),
  detailRangeInfo: $('detailRangeInfo'), detailPageInfo: $('detailPageInfo'),
  detailPrev: $('detailPrev'), detailNext: $('detailNext'),
  studentModal: $('studentModal'), stSummary: $('stSummary'), stSubjects: $('stSubjects'), stCustomRange: $('stCustomRange'),
  stFrom: $('stFrom'), stTo: $('stTo'), stApply: $('stApply'), stBody: $('stBody'), stClose: $('stClose'),
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

let me = null;
let classes = [];
let tasks = [];
let currentTaskId = null;
let detailData = null;
let detailTab = 'not';
let stRange = 'month';
let stStudentId = null;
let editingTask = null;
// 个人中心"教学设置"（发布作业时自动带出；每次打开发布弹窗/页面重新可见时都会重新读取）
let teachSubject = null;
let teachClasses = [];   // [{classId, className, isHeadTeacher}]
let teachLoaded = false;
let teachFetching = null; // 并发去重
let SUBJECT_LOCKED = false; // 教师：学科筛选锁定为个人中心绑定的所教学科
const SUBJECT_ALL = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '政治', '地理', '其他'];
const HW_SETTINGS_REV_KEY = 'hwTeachSettingsRev'; // 个人中心保存后写入，用于跨标签页同步

// 确保已拿到当前用户（页面初始化可能尚未完成，避免读不到教学设置）
let meFetching = null;
async function ensureMe() {
  if (me) return me;
  if (meFetching) return meFetching;
  meFetching = (async () => {
    try {
      const res = await apiFetch('/api/auth/me');
      me = res.user;
      el.userInfo.textContent = ((me.realName || me.displayName || me.username) || '') +
        (me.role === 'teacher' ? '（教师）' : '');
    } catch (_) { /* 保持 me 为 null，由调用方处理 */ }
    meFetching = null;
    return me;
  })();
  return meFetching;
}

// 读取个人中心绑定的学科与班级（API：/api/teacher/subject、/api/teacher/classes）
// 同时刷新 /api/auth/me（所带班级可能刚在个人中心改过）
// 注意：不依赖页面初始化时序 —— 每次调用都会主动确保已登录信息可用
async function loadTeachingSettings() {
  const u = await ensureMe();
  if (!u || u.role !== 'teacher') {
    teachSubject = null;
    teachClasses = [];
    teachLoaded = true;
    renderTeachHint();
    return { subject: null, classes: [] };
  }
  if (teachFetching) return teachFetching; // 复用进行中的请求
  teachFetching = (async () => {
    try {
      const [sub, cls, meRes] = await Promise.all([
        apiFetch('/api/teacher/subject'),
        apiFetch('/api/teacher/classes'),
        apiFetch('/api/auth/me').catch(() => null),
      ]);
      teachSubject = sub.subject || null;
      teachClasses = cls.classes || [];
      if (meRes && meRes.user) me = meRes.user;
    } catch (_) {
      teachSubject = null;
      teachClasses = [];
    } finally {
      teachLoaded = true;
      teachFetching = null;
    }
    renderTeachHint();
    renderClassFilterOptions(); // 班级筛选下拉同步最新所带班级
    return { subject: teachSubject, classes: teachClasses };
  })();
  return teachFetching;
}

// 班级筛选下拉（教师：只显示自己所带班级；管理员：全部班级）
function renderClassFilterOptions() {
  if (!el.fClass) return;
  const cur = el.fClass.value;
  const admin = isAdminUser();
  const mine = admin ? classes.map((c) => c.id) : ((me && me.teachClassIds) || []);
  el.fClass.innerHTML = `<option value="">${admin ? '全部班级' : '全部所带班级'}</option>` +
    classes.filter((c) => mine.includes(c.id))
      .map((c) => `<option value="${c.id}">${escHtml(c.className)}</option>`).join('');
  if (cur && el.fClass.querySelector(`option[value="${cur}"]`)) el.fClass.value = cur;
}

// 页面重新可见 / 从缓存恢复 / 窗口获得焦点 → 重新读取教学设置（避免显示旧科目）
function syncTeachingSettingsOnWake() {
  if (!me || me.role !== 'teacher') return;
  const prevSubject = teachSubject;
  loadTeachingSettings().then(async () => {
    // 若发布弹窗正开着，同步刷新其中的学科/班级
    if (!el.pubModal.classList.contains('hidden') && !editingTask) {
      renderPublishBindings();
    }
    // 绑定学科变化（管理员改了/刚完成绑定）→ 同步筛选框并重新拉取列表
    if (teachSubject !== prevSubject) {
      applySubjectLock(null);
      await refresh();
    } else {
      applySubjectLock(null);
    }
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncTeachingSettingsOnWake();
});
window.addEventListener('focus', syncTeachingSettingsOnWake);
window.addEventListener('pageshow', (e) => {
  if (e.persisted) syncTeachingSettingsOnWake(); // 从往返缓存恢复
});
// 跨标签页：个人中心保存教学设置后通知其他标签页（同源）
window.addEventListener('storage', (e) => {
  if (e.key === HW_SETTINGS_REV_KEY) syncTeachingSettingsOnWake();
});

// 顶部提示：未绑定时引导到个人中心
function renderTeachHint() {
  // 管理员：不受"教学设置"约束（可发布到任意班级/任意学科），不显示绑定提醒
  if (isAdminUser()) {
    el.teachHint.classList.remove('hidden');
    el.teachHint.innerHTML = '🛠 管理员模式：可选择任意班级与学科发布作业（用于测试/配置），列表标注「管理员发布」';
    return;
  }
  const missing = [];
  if (!teachSubject) missing.push('所教学科');
  if (teachClasses.length === 0) missing.push('所带班级');
  if (missing.length === 0) {
    el.teachHint.classList.add('hidden');
    return;
  }
  el.teachHint.classList.remove('hidden');
  el.teachHint.innerHTML = `⚠️ 请先到<a href="/profile" style="color:#AD6800;text-decoration:underline">个人中心 → 📚 教学设置</a>` +
    `绑定${missing.join('、')}后再使用作业管理`;
  // 未绑定学科时，任务列表同步给出明确提示（班主任同样适用，不再只在 needSubject 时提示）
  if (!teachSubject) {
    el.taskEmpty.classList.add('hidden');
    el.taskBody.innerHTML = `<tr><td colspan="8" class="empty-tip-small">
      ⚠️ 请先到 <a href="/profile" style="color:var(--primary)">个人中心 → 📚 教学设置</a> 绑定<b>所教学科</b>，之后才能查看/发布本学科作业
    </td></tr>`;
  }
}

// ---------- 初始化 ----------
(async function init() {
  await ensureMe();
  try {
    const cd = await apiFetch('/api/classes');
    classes = cd.classes || [];
  } catch (_) { classes = []; }
  // 班级下拉：教师=所带班级；管理员=全部班级
  renderClassFilterOptions();
  // 默认只看【今天】：班主任一进来就能看到当天各科「每日作业」+ 手动作业
  if (el.fDate && !el.fDate.value) el.fDate.value = todayStr();
  await loadTeachingSettings(); // 新增：读取个人中心教学设置（学科/班级自动带出）
  await refresh();
  startAutoRefresh();           // 班长录入后本页自动同步（30 秒 + 切回标签页立即刷新）
})();

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 班长在「签到操作台 → 作业统计」录入后，班主任端要能看到最新结果：
//   · 每 30 秒静默刷新一次；切回本标签页（visibilitychange）时立即刷新
//   · 发布/详情弹窗打开时不刷新，避免打断正在进行的操作
let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.hidden) return;
    if (el.pubModal && !el.pubModal.classList.contains('hidden')) return;
    if (el.detailModal && !el.detailModal.classList.contains('hidden')) return;
    refresh().catch(() => {});
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && el.pubModal.classList.contains('hidden') && el.detailModal.classList.contains('hidden')) {
      refresh().catch(() => {});
    }
  });
}

async function refresh() {
  const params = new URLSearchParams();
  const onlyMine = !!(el.fMine && el.fMine.checked);
  // 默认：includeDaily=1 → 列表里同时包含【系统自动发布的每日作业】与【老师手动发布的作业】
  // 勾选「只看我发布的」→ 只按发布人过滤（此时不再带每日作业，语义与标签一致）
  if (onlyMine) params.set('mine', '1');
  else params.set('includeDaily', '1');
  if (el.fClass.value) params.set('classId', el.fClass.value);
  if (el.fSubject.value) params.set('subject', el.fSubject.value);
  if (el.fDate.value) params.set('date', el.fDate.value);
  // 只在"首次加载（列表还是空的）"时占位"加载中…"
  //   避免 30 秒自动刷新时把已有列表清空一瞬 —— 那会让老师看到闪一下的白屏/加载中，
  //   也会与"边看边点"的操作抢 DOM（老列表保留到新数据回来再整体替换）
  if (!tasks.length) el.taskBody.innerHTML = '<tr><td colspan="8" class="empty-tip-small">加载中…</td></tr>';
  try {
    const data = await apiFetch('/api/homework/tasks?' + params.toString());
    tasks = data.tasks || [];
    applySubjectLock(data);       // 学科筛选：教师固定为个人中心绑定的所教学科（只读）
    renderSummary(data.stats || {});
    renderTasks(tasks, data);
  } catch (err) {
    el.taskBody.innerHTML = `<tr><td colspan="8" class="empty-tip-small">加载失败：${escHtml(err.message)}</td></tr>`;
  }
}

// 学科筛选框：
//   · **班主任** → 不锁定（默认「全部」）：作业模块角色模型 = "班主任看本班全部科目"，
//     且「每日作业」每天自动发布 6 科，锁定成单科会让班主任看不到当天其它科（本轮需求明确要求"看到当天各科"）
//   · **纯任课老师**（没有班主任班级） → 锁定为所教学科并置灰（与"任课老师只能看自己所教学科作业"一致）
//   · 未绑定学科的任课老师 → 保持可选，并由提示引导去个人中心绑定
function applySubjectLock(data) {
  const isTeacher = (me && me.role === 'teacher') || !!teachSubject;
  const bound = teachSubject || (data && data.mySubject) || null;
  // 是否班主任：以接口返回为准（服务端按 teacher_classes / classes.head_teacher_id 计算），me 兜底
  const isHeadTeacher = !!(data && data.isHeadTeacher) ||
    !!(me && (me.isHeadTeacher === true || (Array.isArray(me.headClassIds) && me.headClassIds.length > 0)));
  const onlySubjectTeacher = isTeacher && !isHeadTeacher;
  const freeSelect = (title) => {
    const keep = el.fSubject.value;
    el.fSubject.innerHTML = '<option value="">全部</option>' +
      SUBJECT_ALL.map((s) => `<option>${s}</option>`).join('');
    el.fSubject.disabled = false;
    el.fSubject.title = title || '';
    if (keep && el.fSubject.querySelector(`option[value="${keep}"]`)) el.fSubject.value = keep;
    SUBJECT_LOCKED = false;
  };
  if (onlySubjectTeacher) {
    if (bound) {
      el.fSubject.innerHTML = `<option>${escHtml(bound)}</option>`;
      el.fSubject.value = bound;
      el.fSubject.disabled = true;
      el.fSubject.title = `学科筛选固定为你的所教学科（${bound}）：来自个人中心 → 📚 教学设置，如需修改请联系管理员`;
      SUBJECT_LOCKED = true;
      return;
    }
    // 未绑定学科：保持可筛选"全部"，并由顶部提示/列表提示引导去绑定
    freeSelect('');
    return;
  }
  // 班主任 / 管理员：不限制（可看本班全部科目，含当天各科「每日作业」）
  freeSelect(isTeacher && isHeadTeacher ? '你是班主任：可查看本班全部科目（含每天自动发布的各科「每日作业」）' : '');
}

function renderSummary(stats) {
  el.scTasks.textContent = stats.taskCount || 0;
  if (el.scDaily) el.scDaily.textContent = tasks.filter((t) => t.isDaily).length;
  const rate = stats.avgRate || 0;
  el.scRate.textContent = stats.studentSlots > 0 ? rate + '%' : '—';
  el.scRate.style.color = rate >= 90 ? 'var(--success)' : (rate >= 60 ? 'var(--warning)' : 'var(--danger)');
  el.scMissing.textContent = stats.notSubmittedCount || 0;
}

function taskStatus(deadlineIso) {
  const now = Date.now();
  const d = deadlineIso ? new Date(deadlineIso).getTime() : null;
  if (!d) return { cls: 'future', text: '—' };
  if (d > now) return { cls: 'doing', text: '进行中' };
  return { cls: 'done', text: '已截止' };
}

function renderTasks(list, data) {
  // 未绑定学科的任课老师：给出明确提示并引导到个人中心
  if (data && data.needSubject) {
    el.taskEmpty.classList.add('hidden');
    el.taskBody.innerHTML = `<tr><td colspan="8" class="empty-tip-small">
      ⚠️ 请先到 <a href="/profile" style="color:var(--primary)">个人中心 → 📚 教学设置</a> 绑定<b>所教学科</b>，之后才能查看本学科作业
    </td></tr>`;
    return;
  }
  el.taskEmpty.classList.toggle('hidden', list.length > 0);
  if (SUBJECT_LOCKED) {
    el.taskEmpty.textContent = `暂无你的${(data && data.mySubject) || ''}作业（任课老师只能发布/查看自己所教学科的作业）`;
  } else if (el.fDate && el.fDate.value) {
    el.taskEmpty.textContent = `${el.fDate.value} 暂无作业（每天 0 点会自动为各班级发布当天「每日作业」条目；也可点「＋ 发布作业」手动发布）`;
  }
  el.taskBody.innerHTML = list.map((t) => {
    const rate = t.total > 0 ? Math.round((t.submitted / t.total) * 1000) / 10 : 0;
    const tag = rate >= 90 ? 'green' : (rate >= 60 ? 'orange' : 'red');
    const st = taskStatus(t.deadline);
    // 管理员发布的作业：标注「管理员发布」（管理员可模拟任课老师发布用于测试）
    const adminTag = t.publisherIsAdmin
      ? ' <span class="hw-admin-tag" title="由管理员账号发布（测试/配置用）">管理员发布</span>' : '';
    // 每日作业：系统自动发布 → 标「每日作业」，不可编辑/删除（改班级选科后对新的一天生效）
    const dailyTag = t.isDaily
      ? ' <span class="hw-admin-tag hw-daily-tag" title="系统每天 0 点自动为每个班发布当天各科「每日作业」条目">每日作业</span>' : '';
    const dailyHint = t.isDaily ? ' <span class="hint" style="font-size:11px">系统自动发布</span>' : '';
    // 状态：班长还没录入提交情况 → 待录入（更贴近"待提交"语义）
    const statusCell = !t.recorded
      ? '<span class="hw-status-tag future" title="班长还没录入提交情况">待提交</span>'
      : `<span class="hw-status-tag ${st.cls}">${st.text}</span>`;
    const actions = t.isDaily
      ? `<button class="btn btn-primary btn-sm js-detail" data-id="${t.id}">查看未交名单</button>`
      : `<button class="btn btn-primary btn-sm js-detail" data-id="${t.id}">查看提交情况</button>
         <button class="btn btn-secondary btn-sm js-edit" data-id="${t.id}">编辑</button>
         <button class="btn btn-danger-ghost btn-sm js-del" data-id="${t.id}" data-title="${escHtml(t.title)}">删除</button>`;
    return `<tr>
      <td>${escHtml(t.className || '')}</td>
      <td>${escHtml(t.subject)}</td>
      <td><b>${escHtml(t.title)}</b>${dailyTag}${adminTag}${dailyHint}</td>
      <td style="white-space:nowrap">${escHtml(t.deadlineText || '')}</td>
      <td><b>${t.submitted}</b> / ${t.total - t.submitted}</td>
      <td><span class="hw-rate-tag ${tag}">${rate}%</span></td>
      <td>${statusCell}</td>
      <td style="white-space:nowrap">${actions}</td>
    </tr>`;
  }).join('');
}

el.taskBody.addEventListener('click', (e) => {
  const d = e.target.closest('.js-detail');
  if (d) { openDetail(Number(d.dataset.id)); return; }
  const ed = e.target.closest('.js-edit');
  if (ed) {
    const t = tasks.find((x) => x.id === Number(ed.dataset.id));
    if (t) openPublishModal(t);
    return;
  }
  const del = e.target.closest('.js-del');
  if (del) {
    const id = Number(del.dataset.id);
    if (!window.confirm(`确定删除作业「${del.dataset.title}」吗？该作业的提交记录将一并删除。`)) return;
    apiFetch('/api/homework/tasks/' + id, { method: 'DELETE' })
      .then(() => { showToast('作业已删除'); refresh(); })
      .catch((err) => showToast('删除失败：' + err.message));
  }
});

// ---------- 发布 / 编辑作业 ----------
async function openPublishModal(task) {
  editingTask = task || null;
  el.pubTitle.textContent = task ? '✏️ 编辑作业' : '＋ 发布作业';
  el.pubSubmit.textContent = task ? '保存' : '发布';
  el.pubError.classList.add('hidden');
  el.pubSubmit.disabled = false;

  // 编辑已有作业：学科/班级直接来自该作业（不可修改），无需读取教学设置
  if (task) {
    el.pubClasses.innerHTML = `<span style="font-size:13px">${escHtml(task.className || '')}（编辑时不可更换班级）</span>`;
    el.pubSubject.value = task.subject || '';
    el.pubSubject.readOnly = true;
    pubSubjectHint('该作业已发布，学科不可修改');
    fillPublishRest(task);
    el.pubModal.classList.remove('hidden');
    setTimeout(() => el.pubHomeworkTitle.focus(), 60);
    return;
  }

  // 新建作业：每次打开都【重新请求】个人中心教学设置（不使用页面加载时的缓存值）
  el.pubHomeworkTitle.value = '';
  el.pubRemark.value = '';
  el.pubClasses.innerHTML = '<span style="font-size:13px;color:var(--text-light)">正在读取个人中心教学设置…</span>';
  el.pubSubject.value = '';
  el.pubSubject.readOnly = true;
  pubSubjectHint('正在读取个人中心教学设置…');
  el.pubSubmit.disabled = true;
  el.pubModal.classList.remove('hidden');
  await loadTeachingSettings(); // 内部会先确保已登录信息可用
  renderPublishBindings();
  const dl = new Date(Date.now() + 24 * 3600 * 1000);
  el.pubDeadlineDate.value = fmtD(dl);
  el.pubDeadlineTime.value = `${pad(dl.getHours())}:${pad(dl.getMinutes())}`;
  if (!el.pubSubmit.disabled) setTimeout(() => el.pubHomeworkTitle.focus(), 60);
}

// 只读学科字段下方的小提示
function pubSubjectHint(text, warn) {
  if (!el.pubSubjectHint) return;
  el.pubSubjectHint.textContent = text || '';
  el.pubSubjectHint.style.color = warn ? 'var(--danger)' : 'var(--text-light)';
}

// 依据最新教学设置渲染发布表单的 班级（默认全选）/ 学科（只读自动带出）
//   管理员：以任课老师身份发布（测试用）—— 任意班级多选 + 任意学科下拉，发布老师仍是管理员账号
function isAdminUser() {
  return !!(me && (me.role === 'admin' || (Array.isArray(me.roles) && me.roles.includes('admin'))));
}
function renderPublishBindings() {
  if (editingTask) return; // 编辑模式不覆盖
  if (isAdminUser()) {
    el.pubSubmit.disabled = false;
    if (el.pubAdminBanner) el.pubAdminBanner.classList.remove('hidden');
    if (el.pubClassLabel) el.pubClassLabel.textContent = '班级 *（可多选，管理员可选任意班级）';
    if (el.pubSubjectLabel) el.pubSubjectLabel.textContent = '学科 *（管理员可选择任意学科）';
    el.pubClasses.innerHTML = classes.length
      ? classes.map((c) => `
        <label class="pub-class-item">
          <input type="checkbox" class="pub-class-cb" value="${c.id}" checked>
          <span>${escHtml(c.className)}${c.grade ? '（' + escHtml(c.grade) + '）' : ''}</span>
        </label>`).join('')
      : '<span style="font-size:13px;color:var(--danger)">系统中还没有班级，请先到「班级管理」创建</span>';
    // 学科：下拉任选（默认沿用列表筛选的学科）
    el.pubSubject.classList.add('hidden');
    el.pubSubjectSel.classList.remove('hidden');
    if (!el.pubSubjectSel.options.length) {
      el.pubSubjectSel.innerHTML = SUBJECT_ALL.map((s) => `<option>${s}</option>`).join('');
    }
    el.pubSubjectSel.value = el.fSubject.value || el.pubSubjectSel.value || '数学';
    pubSubjectHint('管理员测试发布：可选择任意班级与任意学科；发布老师记录为当前管理员账号，列表标注「管理员发布」');
    return;
  }
  if (el.pubAdminBanner) el.pubAdminBanner.classList.add('hidden');
  if (el.pubClassLabel) el.pubClassLabel.textContent = '班级 *（可多选，只显示我所带班级）';
  if (el.pubSubjectLabel) el.pubSubjectLabel.textContent = '学科 *（来自个人中心 → 教学设置，不可修改）';
  el.pubSubjectSel.classList.add('hidden');
  el.pubSubject.classList.remove('hidden');
  const boundList = teachClasses.length > 0 ? teachClasses : [];
  const unbound = !teachSubject || boundList.length === 0;
  el.pubSubmit.disabled = false;
  if (unbound) {
    const missing = [];
    if (!teachSubject) missing.push('所教学科');
    if (boundList.length === 0) missing.push('所带班级');
    el.pubClasses.innerHTML = `
      <div style="font-size:13px;line-height:1.7">
        ⚠️ 你还没有在个人中心绑定<b>${missing.join('、')}</b>，无法发布作业。<br>
        <a href="/profile" class="btn btn-primary btn-sm" style="margin-top:8px;display:inline-block">去个人中心绑定 →</a>
      </div>`;
    el.pubSubject.value = '';
    pubSubjectHint('请先到个人中心绑定所教学科', true);
    el.pubSubmit.disabled = true;
    showToast('请先到个人中心绑定所教学科' + (boundList.length === 0 ? '和所带班级' : ''), 3200);
    return;
  }
  // 班级：默认全部勾选（可取消）
  el.pubClasses.innerHTML = boundList.map((c) => `
    <label class="pub-class-item">
      <input type="checkbox" class="pub-class-cb" value="${c.classId}" checked>
      <span>${escHtml(c.className)}${c.isHeadTeacher ? '（班主任）' : ''}</span>
    </label>`).join('');
  if (el.fClass.value) {
    // 列表已按班级筛选时，只勾选该班级（仍可手动调整）
    el.pubClasses.querySelectorAll('.pub-class-cb').forEach((cb) => {
      cb.checked = String(cb.value) === String(el.fClass.value);
    });
    if (![...el.pubClasses.querySelectorAll('.pub-class-cb')].some((cb) => cb.checked)) {
      el.pubClasses.querySelectorAll('.pub-class-cb').forEach((cb) => { cb.checked = true; });
    }
  }
  // 学科：自动带出个人中心绑定的所教学科，只读不可修改
  el.pubSubject.value = teachSubject;
  el.pubSubject.readOnly = true;
  pubSubjectHint('已绑定：' + teachSubject + '（如需修改请到个人中心 → 📚 教学设置）');
}

// 编辑模式的其余字段填充
function fillPublishRest(task) {
  el.pubHomeworkTitle.value = task ? task.title : '';
  const dl = task && task.deadline ? new Date(task.deadline) : new Date(Date.now() + 24 * 3600 * 1000);
  el.pubDeadlineDate.value = fmtD(dl);
  el.pubDeadlineTime.value = `${pad(dl.getHours())}:${pad(dl.getMinutes())}`;
  el.pubRemark.value = (task && task.remark) || '';
}
function closePublishModal() { el.pubModal.classList.add('hidden'); editingTask = null; }

el.btnPublish.addEventListener('click', () => openPublishModal(null));
el.pubCancel.addEventListener('click', closePublishModal);
el.pubModal.addEventListener('click', (e) => { if (e.target === el.pubModal) closePublishModal(); });

el.pubSubmit.addEventListener('click', async () => {
  // 管理员模式从下拉取学科（任选）；教师模式取个人中心绑定的只读学科
  const subject = (!editingTask && isAdminUser()) ? el.pubSubjectSel.value : el.pubSubject.value;
  const title = el.pubHomeworkTitle.value.trim();
  const remark = el.pubRemark.value.trim();
  const dateStr = el.pubDeadlineDate.value;
  const timeStr = el.pubDeadlineTime.value || '23:59';
  el.pubError.classList.add('hidden');
  if (!editingTask && !subject) {
    el.pubError.textContent = isAdminUser() ? '请选择学科' : '请先到个人中心绑定所教学科';
    el.pubError.classList.remove('hidden');
    return;
  }
  if (!title) { el.pubError.textContent = '请填写作业标题'; el.pubError.classList.remove('hidden'); return; }
  if (!dateStr) { el.pubError.textContent = '请选择提交截止日期'; el.pubError.classList.remove('hidden'); return; }
  const deadline = `${dateStr} ${timeStr}`;
  el.pubSubmit.disabled = true;
  try {
    if (editingTask) {
      await apiFetch('/api/homework/tasks/' + editingTask.id, {
        method: 'PUT',
        body: JSON.stringify({ title, deadline, remark }),
      });
      showToast('作业已更新');
    } else {
      const classIds = [...el.pubClasses.querySelectorAll('.pub-class-cb:checked')].map((cb) => Number(cb.value));
      if (classIds.length === 0) {
        el.pubError.textContent = '请至少选择一个班级';
        el.pubError.classList.remove('hidden');
        el.pubSubmit.disabled = false;
        return;
      }
      const data = await apiFetch('/api/homework/tasks', {
        method: 'POST',
        body: JSON.stringify({ classIds, subject, title, deadline, remark }),
      });
      const created = (data.created || []).length;
      const skipped = (data.skipped || []).length;
      showToast(`已发布到 ${created} 个班级` + (skipped ? `（${skipped} 个班级已存在同名作业，已跳过）` : ''));
    }
    closePublishModal();
    await refresh();
  } catch (err) {
    el.pubError.textContent = err.message;
    el.pubError.classList.remove('hidden');
  } finally {
    el.pubSubmit.disabled = false;
  }
});

// ---------- 提交详情（卡片式：信息卡 + 4 统计卡 + 明细分页） ----------
const DETAIL_PAGE_SIZE = 20;
let detailPage = 1;

function detailRateClass(rate) {
  return rate >= 90 ? 'ok' : (rate >= 60 ? 'warn' : 'bad');
}
function detailStatusText(task) {
  const st = taskStatus(task.deadline);
  return { text: st.text, cls: st.cls };
}
function renderDetailInfo(data) {
  const t = data.task;
  const st = detailStatusText(t);
  if (el.hwInfoTitle) el.hwInfoTitle.textContent = t.title || '（未命名作业）';
  const items = [
    ['班级', t.className || '—'],
    ['学科', t.subject || '—'],
    ['发布老师', (t.teacherName || '—') + (t.publisherIsAdmin ? '（管理员）' : '')],
    ['截止时间', t.deadlineText || '—'],
    ['作业日期', t.date || '—'],
    ['状态', `<span class="hw-status-tag ${st.cls}">${escHtml(st.text)}</span>`],
  ];
  if (t.remark) items.push(['备注', t.remark]);
  if (el.hwInfoGrid) {
    el.hwInfoGrid.innerHTML = items.map(([k, v]) =>
      `<div class="hw-info-item"><span class="k">${escHtml(k)}：</span><span class="v">${typeof v === 'string' ? escHtml(v) : v}</span></div>`).join('');
  }
  if (el.hwStatCards) {
    const s = data.stats || { total: 0, submitted: 0, notSubmitted: 0, rate: 0 };
    el.hwStatCards.innerHTML = `
      <div class="hw-stat-card total"><div class="hsc-label">应交人数</div><div class="hsc-value">${s.total}</div></div>
      <div class="hw-stat-card done"><div class="hsc-label">已交人数</div><div class="hsc-value">${s.submitted}</div></div>
      <div class="hw-stat-card miss"><div class="hsc-label">未交人数</div><div class="hsc-value">${s.notSubmitted}</div></div>
      <div class="hw-stat-card rate ${detailRateClass(s.rate)}"><div class="hsc-label">提交率</div><div class="hsc-value">${s.rate}%</div></div>`;
  }
}

async function openDetail(taskId) {
  currentTaskId = taskId;
  detailTab = 'all';
  detailPage = 1;
  document.querySelectorAll('#detailModal .hw-detail-tabs .btn[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === 'all');
  });
  try {
    const data = await apiFetch('/api/homework/tasks/' + taskId);
    detailData = data;
    el.detailTitle.textContent = '📋 作业提交情况';
    renderDetailInfo(data);
    renderDetailList();
    el.detailModal.classList.remove('hidden');
  } catch (err) {
    showToast('打开详情失败：' + err.message);
  }
}

// 明细行 = 全班学生，带 序号 / 学号 / 姓名 / 状态标签 / 提交时间（每页 20 条）
function detailRows() {
  if (!detailData) return [];
  const subs = detailData.submissions || {};
  const when = detailData.updatedAt || {};
  const rows = (detailData.students || []).map((s) => {
    const done = subs[s.id] === true;
    return {
      id: s.id, studentNo: s.studentNo, name: s.name, done,
      when: done && when[s.id] ? new Date(when[s.id]).toLocaleString('zh-CN', { hour12: false }) : '',
    };
  });
  if (detailTab === 'done') return rows.filter((r) => r.done);
  if (detailTab === 'not') return rows.filter((r) => !r.done);
  return rows;
}

function renderDetailList() {
  if (!detailData) return;
  const list = detailRows();
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / DETAIL_PAGE_SIZE));
  if (detailPage > totalPages) detailPage = totalPages;
  if (detailPage < 1) detailPage = 1;
  const start = (detailPage - 1) * DETAIL_PAGE_SIZE;
  const pageRows = list.slice(start, start + DETAIL_PAGE_SIZE);

  if (el.detailRangeInfo) {
    el.detailRangeInfo.textContent = total === 0 ? '显示 0-0 条，共 0 条'
      : `显示 ${start + 1}-${Math.min(start + DETAIL_PAGE_SIZE, total)} 条，共 ${total} 条`;
  }
  if (el.detailPageInfo) el.detailPageInfo.textContent = `第 ${detailPage} / ${totalPages} 页`;
  if (el.detailPrev) el.detailPrev.disabled = detailPage <= 1;
  if (el.detailNext) el.detailNext.disabled = detailPage >= totalPages;

  if (pageRows.length === 0) {
    const tip = detailTab === 'not' ? '全部已交 ✅' : (detailTab === 'done' ? '暂无已交学生' : '该班级暂无在读学生');
    el.detailBody.innerHTML = `<tr><td colspan="5" class="empty-tip-small">${tip}</td></tr>`;
    return;
  }
  el.detailBody.innerHTML = pageRows.map((r, i) => `
    <tr>
      <td class="col-idx">${start + i + 1}</td>
      <td>${escHtml(r.studentNo)}</td>
      <td><span class="hw-stu-link ${r.done ? 'ok' : ''}" data-id="${r.id}" data-name="${escHtml(r.name)}">${escHtml(r.name)}</span></td>
      <td>${r.done ? '<span class="hw-stu-tag ok">✅ 已交</span>' : '<span class="hw-stu-tag no">❌ 未交</span>'}</td>
      <td style="color:var(--text-light)">${r.done ? escHtml(r.when || '已标记') : '—'}</td>
    </tr>`).join('');
}

document.querySelectorAll('#detailModal .hw-detail-tabs .btn[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#detailModal .hw-detail-tabs .btn[data-tab]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    detailTab = btn.dataset.tab;
    detailPage = 1;
    renderDetailList();
  });
});
if (el.detailPrev) el.detailPrev.addEventListener('click', () => { detailPage -= 1; renderDetailList(); });
if (el.detailNext) el.detailNext.addEventListener('click', () => { detailPage += 1; renderDetailList(); });
const closeDetail = () => el.detailModal.classList.add('hidden');
if (el.detailBack) el.detailBack.addEventListener('click', closeDetail);
el.detailClose.addEventListener('click', closeDetail);
el.detailModal.addEventListener('click', (e) => { if (e.target === el.detailModal) closeDetail(); });
el.detailBody.addEventListener('click', (e) => {
  const link = e.target.closest('.hw-stu-link');
  if (!link) return;
  openStudent(Number(link.dataset.id));
});
el.detailExport.addEventListener('click', () => {
  if (!detailData) return;
  const t = detailData.task;
  const params = new URLSearchParams({ date: t.date, classId: t.classId });
  if (t.subject) params.set('subject', t.subject);
  params.set('teacherId', t.teacherId || '');
  window.location.href = '/api/homework/export?' + params.toString();
});

// ---------- 学生作业记录 ----------
function openStudent(studentId) {
  stStudentId = studentId;
  stRange = 'month';
  document.querySelectorAll('#studentModal .range-quick .btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.range === 'month');
  });
  el.stCustomRange.classList.add('hidden');
  el.studentModal.classList.remove('hidden');
  loadStudentRecords();
}

function rangeDates() {
  const today = new Date();
  if (stRange === 'week') {
    const d = new Date(today);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return { from: fmtD(d), to: fmtD(today) };
  }
  if (stRange === 'month') {
    return { from: fmtD(new Date(today.getFullYear(), today.getMonth(), 1)), to: fmtD(today) };
  }
  if (stRange === 'all') return { from: '', to: '' };
  return { from: el.stFrom.value || '', to: el.stTo.value || '' };
}

document.querySelectorAll('#studentModal .range-quick .btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#studentModal .range-quick .btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    stRange = btn.dataset.range;
    const isCustom = stRange === 'custom';
    el.stCustomRange.classList.toggle('hidden', !isCustom);
    if (isCustom) {
      if (!el.stFrom.value) {
        const d = new Date();
        el.stFrom.value = fmtD(new Date(d.getFullYear(), d.getMonth(), 1));
        el.stTo.value = fmtD(d);
      }
      return;
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
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  el.stBody.innerHTML = '<tr><td colspan="6" class="empty-tip-small">加载中…</td></tr>';
  if (el.stSubjects) el.stSubjects.innerHTML = '<div class="hsc-empty">加载中…</div>';
  try {
    const data = await apiFetch(`/api/homework/student/${stStudentId}?` + params.toString());
    const st = data.student;
    const stats = data.stats || {};
    el.stSummary.innerHTML = `${escHtml(st.name)}（${escHtml(st.studentNo)}） · 共 <b>${stats.total}</b> 次作业 · 已交 <b>${stats.submitted}</b> · 未交 <b>${stats.notSubmitted}</b> · 提交率 <b>${stats.rate}%</b>`;
    renderSubjectChart(data.bySubject);
    const records = data.records || [];
    if (records.length === 0) {
      el.stBody.innerHTML = '<tr><td colspan="6" class="empty-tip-small">该时间范围内没有作业记录</td></tr>';
      return;
    }
    el.stBody.innerHTML = records.map((r) => {
      const when = r.updatedAt ? new Date(r.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '';
      return `<tr>
        <td>${escHtml(r.date)}</td>
        <td style="white-space:nowrap">${escHtml(r.deadlineText || '')}</td>
        <td>${escHtml(r.subject)}</td>
        <td>${escHtml(r.title)}</td>
        <td>${r.isSubmitted ? '<span class="hw-rate-tag green">已交</span>' : '<span class="hw-rate-tag red">未交</span>'}</td>
        <td style="color:var(--text-light);font-size:12px">${r.isSubmitted ? escHtml(when) : '—'}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    el.stBody.innerHTML = `<tr><td colspan="6" class="empty-tip-small">加载失败：${escHtml(err.message)}</td></tr>`;
  }
}

el.stClose.addEventListener('click', () => el.studentModal.classList.add('hidden'));
el.studentModal.addEventListener('click', (e) => { if (e.target === el.studentModal) el.studentModal.classList.add('hidden'); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    el.studentModal.classList.add('hidden');
    el.detailModal.classList.add('hidden');
    el.pubModal.classList.add('hidden');
  }
});

// ---------- 筛选 / 导出 ----------
el.fClass.addEventListener('change', refresh);
el.fSubject.addEventListener('change', refresh);
el.fDate.addEventListener('change', refresh);
// 「今天」/「全部日期」/「只看我发布的」快捷筛选（作业管理页默认看当天，含每日作业）
if (el.btnToday) el.btnToday.addEventListener('click', () => { el.fDate.value = todayStr(); refresh(); });
if (el.btnAllDates) el.btnAllDates.addEventListener('click', () => { el.fDate.value = ''; refresh(); });
if (el.fMine) el.fMine.addEventListener('change', refresh);
el.btnExport.addEventListener('click', () => {
  const params = new URLSearchParams();
  if (el.fClass.value) params.set('classId', el.fClass.value);
  if (el.fSubject.value) params.set('subject', el.fSubject.value);
  if (el.fDate.value) params.set('date', el.fDate.value);
  window.location.href = '/api/homework/export?' + params.toString();
});

// ---------- 用户菜单（个人中心 / 帮助文档 / 退出登录）----------
// 顶部导航栏（含右上角用户菜单）由统一组件 navbar.js 渲染与接管，页面脚本不再重复绑定。
el.btnBack.addEventListener('click', () => { window.location.href = '/dashboard'; });
