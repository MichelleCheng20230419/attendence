// ============================================================
// 叫号管理页（/announcements）—— 教师 / 管理员
//   发布叫号：班级（所带班级；管理员任意）+ 学生（姓名/学号搜索）+ 到何处 + 何时 + 备注 + 紧急
//   叫号列表：教师=自己发布的；管理员=全部；可筛选状态/日期，支持删除、查看详情
// 权限由后端强制校验，本页仅做镜像（隐藏/禁用）
// ============================================================
const $ = (id) => document.getElementById(id);
const el = {
  btnBack: $('btnBack'),
  btnRefresh: $('btnRefresh'),
  anClass: $('anClass'),
  anStudent: $('anStudent'),
  anStudentId: $('anStudentId'),
  anSuggest: $('anSuggest'),
  anStudentMsg: $('anStudentMsg'),
  anLocation: $('anLocation'),
  anDate: $('anDate'),
  anTime: $('anTime'),
  anNote: $('anNote'),
  anUrgent: $('anUrgent'),
  anSubmit: $('anSubmit'),
  anPublishMsg: $('anPublishMsg'),
  anCount: $('anCount'),
  anFilterStatus: $('anFilterStatus'),
  anFilterDate: $('anFilterDate'),
  anFilterReset: $('anFilterReset'),
  anBody: $('anBody'),
  toast: $('anToast'),
  detailMask: $('anDetailMask'),
  detailTitle: $('anDetailTitle'),
  detailBody: $('anDetailBody'),
  detailClose: $('anDetailClose'),
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

// ---------- 状态 ----------
let me = null;
let classes = [];        // [{ classId, className, grade }]
let students = [];       // 当前班级在读学生 [{ id, name, studentNo }]
let suggestIndex = -1;
let list = [];

const pad2 = (n) => String(n).padStart(2, '0');
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function nowHM() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtDateTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 初始化 ----------
async function init() {
  try {
    const r = await apiFetch('/api/auth/me');
    me = r.user;
    if (!me || (me.role !== 'teacher' && me.role !== 'admin')) { window.location.href = '/dashboard'; return; }
  } catch (e) { return; }

  el.anDate.value = todayIso();
  el.anTime.value = nowHM();

  await loadClasses();
  await loadList();

  if (classes.length > 0) {
    el.anClass.value = String(classes[0].classId);
    await loadStudents(classes[0].classId);
  }
}

async function loadClasses() {
  // 班级列表随 /api/announcements 一起返回（教师=所带班级；管理员=全部）
  const data = await apiFetch('/api/announcements?limit=1');
  classes = data.classes || [];
  el.anClass.innerHTML = classes.length
    ? classes.map((c) => `<option value="${c.classId}">${esc(c.className)}${c.grade ? '（' + esc(c.grade) + '）' : ''}</option>`).join('')
    : '<option value="">（无可发布班级）</option>';
  el.anSubmit.disabled = classes.length === 0;
  return data;
}

async function loadStudents(classId) {
  students = [];
  resetStudentPick();
  if (!classId) return;
  const d = await apiFetch(`/api/students?status=${encodeURIComponent('在读')}&classId=${classId}`);
  students = (d.students || []).map((s) => ({ id: s.id, name: s.name, studentNo: s.studentNo }));
}

function resetStudentPick() {
  el.anStudent.value = '';
  el.anStudentId.value = '';
  el.anStudentMsg.textContent = '未选择学生';
  el.anStudentMsg.style.color = '#9aa3b0';
  hideSuggest();
}

// ---------- 学生搜索建议 ----------
function showSuggest(kw) {
  const k = String(kw || '').trim().toLowerCase();
  const list = (k
    ? students.filter((s) => String(s.name || '').toLowerCase().includes(k)
      || String(s.studentNo || '').toLowerCase().includes(k))
    : students
  ).slice(0, 30);
  if (list.length === 0) {
    el.anSuggest.innerHTML = '<div style="color:#9aa3b0;cursor:default;font-size:13px">未找到匹配学生</div>';
    el.anSuggest.classList.remove('hidden');
    return;
  }
  el.anSuggest.innerHTML = list.map((s, i) =>
    `<div data-id="${s.id}" data-name="${esc(s.name)}" data-i="${i}">${esc(s.name)}<span class="an-sug-no">${esc(s.studentNo || '')}</span></div>`
  ).join('');
  el.anSuggest.classList.remove('hidden');
  suggestIndex = -1;
}
function hideSuggest() { el.anSuggest.classList.add('hidden'); suggestIndex = -1; }

function pickStudent(id, name) {
  el.anStudentId.value = String(id);
  el.anStudent.value = name;
  el.anStudentMsg.textContent = `已选择：${name}`;
  el.anStudentMsg.style.color = '#15803d';
  hideSuggest();
}

// ---------- 发布 ----------
async function publish() {
  const classId = Number(el.anClass.value);
  const studentId = Number(el.anStudentId.value);
  const location = el.anLocation.value.trim();
  const date = el.anDate.value;
  const time = el.anTime.value;
  const note = el.anNote.value.trim();

  if (!Number.isInteger(classId) || classId <= 0) { showToast('请先选择班级'); return; }
  if (!Number.isInteger(studentId) || studentId <= 0) { showToast('请搜索并选择学生'); return; }
  if (!location) { showToast('请填写"到何处"'); el.anLocation.focus(); return; }
  if (!date || !time) { showToast('请选择"何时"（日期 + 时间）'); return; }

  el.anSubmit.disabled = true;
  el.anPublishMsg.textContent = '发布中…';
  try {
    await apiFetch('/api/announcements', {
      method: 'POST',
      body: JSON.stringify({
        classId, studentId, location,
        scheduledTime: `${date} ${time}`,
        note,
        priority: el.anUrgent.checked ? 'urgent' : 'normal',
      }),
    });
    el.anPublishMsg.textContent = '✅ 已发布，班长端将收到并语音播报';
    el.anPublishMsg.style.color = '#15803d';
    showToast('叫号已发布');
    // 重置表单（保留班级、日期时间）
    resetStudentPick();
    el.anLocation.value = '';
    el.anNote.value = '';
    el.anUrgent.checked = false;
    el.anDate.value = todayIso();
    el.anTime.value = nowHM();
    await loadList();
  } catch (e) {
    el.anPublishMsg.textContent = '❌ ' + e.message;
    el.anPublishMsg.style.color = '#cf1322';
    showToast(e.message, 3400);
  } finally {
    el.anSubmit.disabled = classes.length === 0;
  }
}

// ---------- 列表 ----------
async function loadList() {
  const qs = [];
  if (el.anFilterStatus.value) qs.push('status=' + el.anFilterStatus.value);
  if (el.anFilterDate.value) qs.push('date=' + el.anFilterDate.value);
  let data;
  try {
    data = await apiFetch('/api/announcements' + (qs.length ? '?' + qs.join('&') : ''));
  } catch (e) {
    el.anBody.innerHTML = `<tr><td colspan="7"><div class="an-empty">
      <div class="an-empty-title">😕 ${esc(e.message)}</div>
      <div class="an-empty-sub">请点击右上角「↻ 刷新」重试</div></div></td></tr>`;
    return;
  }
  list = data.announcements || [];
  el.anCount.innerHTML = `共 <b>${data.total || 0}</b> 条，待处理 <span class="pend">${data.pending || 0}</span> 条`;
  renderList();
}

function renderList() {
  if (list.length === 0) {
    el.anBody.innerHTML = `<tr><td colspan="7">${EMPTY_HTML}</td></tr>`;
    return;
  }
  el.anBody.innerHTML = list.map((a) => {
    const urgent = a.priority === 'urgent';
    const stLabel = a.status === 'processed' ? '✅ 已处理' : '⏳ 待处理';
    return `<tr class="${urgent ? 'urgent' : ''}" data-id="${a.id}">
      <td class="an-when">${fmtDateTime(a.createdAt)}</td>
      <td>${esc(a.className || ('#' + a.classId))}</td>
      <td><span class="an-stu">${esc(a.studentName || ('#' + a.studentId))}</span>${a.studentNo ? `<span class="an-stu-no">${esc(a.studentNo)}</span>` : ''}${urgent ? ' <span class="an-tag urgent">⚡ 紧急</span>' : ''}</td>
      <td class="an-loc-cell">${esc(a.location)}</td>
      <td class="an-when">${esc(a.scheduledText || '—')}</td>
      <td><span class="an-tag ${a.status}">${stLabel}</span>${a.isPlayed ? '<br><span class="an-tag played">🔊 已播报</span>' : ''}</td>
      <td><div class="an-ops">
        <button class="an-op" data-act="detail" data-id="${a.id}">详情</button>
        <button class="an-op danger" data-act="del" data-id="${a.id}">删除</button>
      </div></td>
    </tr>`;
  }).join('');
}

// 空状态：占位图 + 提示文案
const EMPTY_HTML = `
  <div class="an-empty">
    <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="18" y="26" width="84" height="62" rx="10" fill="#eaf2ff" stroke="#c7dbff" stroke-width="2"/>
      <rect x="30" y="14" width="60" height="20" rx="7" fill="#dbe9ff" stroke="#c7dbff" stroke-width="2"/>
      <path d="M30 48h34M30 60h50M30 72h26" stroke="#a9c6f5" stroke-width="3" stroke-linecap="round"/>
      <circle cx="86" cy="80" r="17" fill="#fff" stroke="#c7dbff" stroke-width="2"/>
      <path d="M86 72v9l6 4" stroke="#94a3b8" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <div class="an-empty-title">暂无叫号记录</div>
    <div class="an-empty-sub">在上方「发布叫号」中选择班级与学生，发布后即显示在这里</div>
  </div>`;

// ---------- 详情 ----------
function openDetail(a) {
  el.detailTitle.textContent = `叫号详情 #${a.id}`;
  el.detailBody.innerHTML = `
    <dt>班级</dt><dd>${esc(a.className || ('#' + a.classId))}</dd>
    <dt>学生</dt><dd>${esc(a.studentName || '')}${a.studentNo ? `（${esc(a.studentNo)}）` : ''}</dd>
    <dt>到何处</dt><dd>${esc(a.location)}</dd>
    <dt>何时</dt><dd>${esc(a.scheduledText || '—')}</dd>
    <dt>备注</dt><dd>${a.note ? esc(a.note) : '—'}</dd>
    <dt>优先级</dt><dd>${a.priority === 'urgent' ? '⚡ 紧急' : '普通'}</dd>
    <dt>发布人</dt><dd>${esc(a.teacherName || ('#' + a.teacherId))}</dd>
    <dt>发布时间</dt><dd>${fmtDateTime(a.createdAt)}</dd>
    <dt>状态</dt><dd>${a.status === 'processed' ? '已处理' : '待处理'}${a.isPlayed ? '（已语音播报）' : '（未播报）'}</dd>
    <dt>处理人</dt><dd>${a.processedByName ? esc(a.processedByName) : '—'}</dd>
    <dt>处理时间</dt><dd>${a.processedAt ? fmtDateTime(a.processedAt) : '—'}</dd>`;
  el.detailMask.classList.remove('hidden');
}
function closeDetail() { el.detailMask.classList.add('hidden'); }

async function del(id) {
  if (!window.confirm('确认删除这条叫号吗？')) return;
  try {
    await apiFetch('/api/announcements/' + id, { method: 'DELETE' });
    showToast('已删除');
    await loadList();
  } catch (e) { showToast(e.message, 3400); }
}

// ---------- 事件绑定 ----------
el.anClass.addEventListener('change', async () => {
  await loadStudents(Number(el.anClass.value));
});

el.anStudent.addEventListener('input', () => {
  el.anStudentId.value = '';
  el.anStudentMsg.textContent = '未选择学生';
  el.anStudentMsg.style.color = '#9aa3b0';
  showSuggest(el.anStudent.value);
});
el.anStudent.addEventListener('focus', () => showSuggest(el.anStudent.value));
el.anStudent.addEventListener('keydown', (e) => {
  const items = el.anSuggest.querySelectorAll('div[data-id]');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (items.length === 0) return;
    e.preventDefault();
    suggestIndex = e.key === 'ArrowDown'
      ? Math.min(suggestIndex + 1, items.length - 1)
      : Math.max(suggestIndex - 1, 0);
    items.forEach((it, i) => it.classList.toggle('active', i === suggestIndex));
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const target = suggestIndex >= 0 ? items[suggestIndex] : (items.length === 1 ? items[0] : null);
    if (target) pickStudent(Number(target.dataset.id), target.dataset.name);
    return;
  }
  if (e.key === 'Escape') hideSuggest();
});
el.anSuggest.addEventListener('mousedown', (e) => {
  const d = e.target.closest('div[data-id]');
  if (!d) return;
  e.preventDefault();
  pickStudent(Number(d.dataset.id), d.dataset.name);
});
document.addEventListener('click', (e) => {
  if (!el.anSuggest.contains(e.target) && e.target !== el.anStudent) hideSuggest();
});

el.anSubmit.addEventListener('click', publish);
el.btnRefresh.addEventListener('click', async () => { await loadList(); showToast('已刷新'); });
el.btnBack.addEventListener('click', () => { window.location.href = '/dashboard'; });
el.anFilterStatus.addEventListener('change', loadList);
el.anFilterDate.addEventListener('change', loadList);
el.anFilterReset.addEventListener('click', async () => {
  el.anFilterStatus.value = '';
  el.anFilterDate.value = '';
  await loadList();
});

el.anBody.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.act === 'del') { del(id); return; }
  const a = list.find((x) => x.id === id);
  if (a) openDetail(a);
});

el.detailClose.addEventListener('click', closeDetail);
el.detailMask.addEventListener('click', (e) => { if (e.target === el.detailMask) closeDetail(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

init();
