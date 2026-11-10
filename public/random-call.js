// ============================================================
// 🎲 随机点名（独立页面 /random-call）—— 课堂大屏展示
//   班级 / 范围（全班·仅未签到）/ 不重复抽取 → 开始点名（姓名滚动）→ 结果（姓名+学号+座位）
//   → 再次点名；全班点完 → 提示"是否重置"；点名记录表格 + 导出 Excel
// 接口：GET /api/rollcall/classes | candidates | POST pick | GET records | records/export
// ============================================================
'use strict';

const $ = (id) => document.getElementById(id);
const el = {
  btnBack: $('btnBack'), btnFull: $('btnFull'),
  rcClass: $('rcClass'), rcSubject: $('rcSubject'), rcScopeSeg: $('rcScopeSeg'),
  rcScopeAll: $('rcScopeAll'), rcScopeAbsent: $('rcScopeAbsent'),
  rcScopeAllLab: $('rcScopeAllLab'), rcScopeAbsentLab: $('rcScopeAbsentLab'),
  rcNoRepeat: $('rcNoRepeat'), rcMeta: $('rcMeta'),
  rcName: $('rcName'), rcChipNo: $('rcChipNo'), rcChipSeat: $('rcChipSeat'),
  rcLike: $('rcLike'), rcLikeInfo: $('rcLikeInfo'),
  rcHint: $('rcHint'), rcStart: $('rcStart'),
  rcRecCount: $('rcRecCount'), rcRecSubject: $('rcRecSubject'),
  rcToggleRecords: $('rcToggleRecords'), rcExport: $('rcExport'),
  rcTableWrap: $('rcTableWrap'), rcRecBody: $('rcRecBody'),
  rcModal: $('rcModal'), rcModalTitle: $('rcModalTitle'), rcModalText: $('rcModalText'),
  rcModalCancel: $('rcModalCancel'), rcModalOk: $('rcModalOk'),
  rcToast: $('rcToast'),
};

const state = {
  classes: [],
  subjects: [],
  canLike: false,
  absentScopeLabel: '仅未签到',   // 「仅未签到 / 仅缺勤」显示名（后端按场次模型返回）
  pickedIds: new Set(),   // 本次课已点到（不重复抽取用）
  rolling: false,
  timer: null,
  result: null,
  likeBusy: false,
  recordsCollapsed: false,
  // 滚动动画时长（正常 2.2 秒；无头自动化可用 ?rollFast=1 缩短）
  spinMs: (() => {
    try { return new URLSearchParams(location.search).get('rollFast') === '1' ? 150 : 2200; } catch (_) { return 2200; }
  })(),
};

let toastTimer = null;
function showToast(msg, ms = 2600) {
  el.rcToast.textContent = msg;
  el.rcToast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.rcToast.classList.add('hidden'), ms);
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('未登录，请重新登录'); }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error((data && data.error) ? data.error : `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const pad2 = (n) => String(n).padStart(2, '0');
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function scope() { return el.rcScopeAbsent.checked ? 'absent' : 'all'; }
function subject() { return el.rcSubject.value || ''; }
function currentClass() {
  return state.classes.find((c) => Number(c.classId) === Number(el.rcClass.value)) || null;
}
function hint(text, warn) {
  el.rcHint.textContent = text || '';
  el.rcHint.className = 'rc-hint' + (warn ? ' warn' : '');
}
function syncSegStyle() {
  el.rcScopeAllLab.classList.toggle('on', el.rcScopeAll.checked);
  el.rcScopeAbsentLab.classList.toggle('on', el.rcScopeAbsent.checked);
  el.rcScopeAbsentLab.classList.toggle('off-disabled', el.rcScopeAbsent.disabled);
}

// ---------- 渲染 ----------
function renderSubjects() {
  const list = state.subjects.length ? state.subjects : ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '政治', '地理', '其他'];
  const cur = el.rcSubject.value;
  el.rcSubject.innerHTML = list.map((s) => `<option>${escHtml(s)}</option>`).join('');
  if (cur && list.includes(cur)) el.rcSubject.value = cur;
  // 记录筛选下拉同步学科列表（保留"全部学科"）
  const curRec = el.rcRecSubject.value;
  el.rcRecSubject.innerHTML = '<option value="">全部学科</option>' + list.map((s) => `<option>${escHtml(s)}</option>`).join('');
  if (curRec && list.includes(curRec)) el.rcRecSubject.value = curRec;
}

function renderClasses() {
  const list = state.classes;
  el.rcClass.innerHTML = list.length
    ? list.map((c) => `<option value="${c.classId}">${escHtml(c.className)}${c.grade ? '（' + escHtml(c.grade) + '）' : ''} · ${c.studentCount} 人</option>`).join('')
    : '<option value="">（无可点名班级）</option>';
  el.rcClass.disabled = list.length <= 1;
}

function renderMeta() {
  const c = currentClass();
  if (!c) { el.rcMeta.textContent = '—'; return; }
  // 「仅未签到」在每天自动签到场次下语义 = 仅缺勤（被点掉的人）→ 文案跟随后端返回
  const absentName = state.absentScopeLabel || '仅未签到';
  const scopeText = scope() === 'absent' ? absentName : '全班';
  const unsigned = (c.unsignedCount === null || c.unsignedCount === undefined) ? '—' : `${c.unsignedCount} 人`;
  el.rcMeta.innerHTML = `${escHtml(c.className)} · 在读 <b>${c.studentCount}</b> 人 · ${escHtml(absentName)} <b>${unsigned}</b> · 学科 <b>${escHtml(subject() || '未选')}</b> · 范围：${scopeText}`;
}

// 点赞按钮/计数（班长 / 任课老师 / 班主任 / 管理员可见；学生不可）
function renderLikeArea() {
  const show = state.canLike && !!state.result;
  el.rcLike.classList.toggle('hidden', !show);
  el.rcLikeInfo.classList.toggle('hidden', !show);
  if (show) {
    el.rcLike.disabled = state.likeBusy;
    el.rcLike.textContent = state.likeBusy ? '点赞中…' : '👍 点赞';
    el.rcLikeInfo.textContent = `${subject() || '本学科'} · ${state.result.student.name} 累计 ${state.result.likeCount || 0} 赞`;
  }
}

function renderScopeHint() {
  const c = currentClass();
  if (!c) { hint(''); return; }
  if (scope() === 'absent') {
    const absentName = state.absentScopeLabel || '仅未签到';
    if (c.unsignedCount === null || c.unsignedCount === undefined) {
      hint('当前没有签到场次，无法按"' + absentName + '"点名（可切换到「全班」）', true);
    } else if (c.unsignedCount === 0) {
      hint('本班没有' + (absentName === '仅缺勤' ? '缺勤' : '未签到') + '学生，切换到「全班」可继续点名', true);
    } else {
      hint((absentName === '仅缺勤' ? '缺勤 ' : '未签到 ') + c.unsignedCount + ' 人可抽（签到抽查）');
    }
  } else {
    hint(`将从 ${c.studentCount} 名在读学生中随机抽取`);
  }
}

function resetStage() {
  state.result = null;
  el.rcName.className = 'rc-name idle';
  el.rcName.textContent = '🎯 点击开始点名';
  el.rcChipNo.classList.add('hidden');
  el.rcChipSeat.classList.add('hidden');
  el.rcStart.textContent = '开始点名';
  el.rcStart.disabled = false;
  renderLikeArea();          // 结果清空 → 隐藏点赞按钮
  renderScopeHint();
}

// ---------- 点名记录 ----------
async function loadRecords() {
  const cid = Number(el.rcClass.value);
  if (!cid) {
    el.rcRecBody.innerHTML = '<tr><td colspan="7" class="rc-empty">请先选择班级</td></tr>';
    el.rcRecCount.textContent = '';
    return;
  }
  try {
    const subj = el.rcRecSubject.value ? '&subject=' + encodeURIComponent(el.rcRecSubject.value) : '';
    const d = await apiFetch(`/api/rollcall/records?classId=${cid}&limit=10${subj}`);
    const list = d.records || [];
    el.rcRecCount.textContent = `（最近 ${list.length} 条 / 共 ${d.total || 0} 条）`;
    el.rcRecBody.innerHTML = list.length
      ? list.map((r) => `<tr>
          <td>${fmtTime(r.createdAt)}</td>
          <td><b>${escHtml(r.studentName || '—')}</b></td>
          <td>${escHtml(r.studentNo || '—')}</td>
          <td>${escHtml(r.seatLabel || '未排座')}</td>
          <td><span class="rc-tag subject">${escHtml(r.subject || '未标学科')}</span></td>
          <td><span class="rc-tag ${r.scope === 'absent' ? 'absent' : ''}">${escHtml(r.scopeLabel || '')}</span></td>
          <td>${escHtml(r.pickedByName || '—')}</td>
        </tr>`).join('')
      : '<tr><td colspan="7" class="rc-empty">暂无点名记录</td></tr>';
  } catch (err) {
    el.rcRecBody.innerHTML = `<tr><td colspan="7" class="rc-empty">记录加载失败：${escHtml(err.message)}</td></tr>`;
  }
}

// ---------- 加载 / 刷新班级 ----------
let classesFetching = null;
async function loadClasses(keepClass = true) {
  if (classesFetching) return classesFetching;
  classesFetching = (async () => {
    const prev = keepClass ? el.rcClass.value : '';
    const d = await apiFetch('/api/rollcall/classes');
    state.classes = d.classes || [];
    state.subjects = d.subjects || [];
    state.canLike = !!d.canLike;
    // 「仅未签到 / 仅缺勤」在没有场次时不可用
    state.absentScopeLabel = d.absentScopeLabel || '仅未签到';
    const absentOk = !!(d.scopeSupport && d.scopeSupport.absent);
    // 单选项文案跟随语义（每天自动签到场次下 = 仅缺勤学生）；只改文本节点，不动 input 本身
    if (el.rcScopeAbsentLab && el.rcScopeAbsentLab.lastChild && el.rcScopeAbsentLab.lastChild.nodeType === 3) {
      el.rcScopeAbsentLab.lastChild.textContent = state.absentScopeLabel === '仅缺勤' ? ' 仅缺勤学生' : ' 仅未签到学生';
    }
    el.rcScopeAbsent.disabled = !absentOk;
    if (!absentOk && el.rcScopeAbsent.checked) el.rcScopeAll.checked = true;
    syncSegStyle();
    renderSubjects();
    renderClasses();
    if (prev && state.classes.some((c) => String(c.classId) === String(prev))) el.rcClass.value = prev;
    else if (d.defaultClassId) el.rcClass.value = String(d.defaultClassId);
    // 默认学科：本班上次所用学科（无则班主任所教学科，再否则列表第一个）
    const cur = currentClass();
    if (cur && cur.lastSubject && state.subjects.includes(cur.lastSubject)) el.rcSubject.value = cur.lastSubject;
    renderMeta();
    renderScopeHint();
    if (!state.classes.length) {
      el.rcName.textContent = '无可点名班级';
      el.rcName.className = 'rc-name idle';
      hint('当前账号未绑定班级，请联系管理员', true);
      el.rcStart.disabled = true;
    } else {
      resetStage();
    }
    return d;
  })().finally(() => { classesFetching = null; });
  return classesFetching;
}

// ---------- 开始点名 ----------
async function startRoll() {
  if (state.rolling) return;
  const cid = Number(el.rcClass.value);
  if (!cid) { showToast('请选择班级'); return; }
  state.rolling = true;
  el.rcStart.disabled = true;
  el.rcChipNo.classList.add('hidden');
  el.rcChipSeat.classList.add('hidden');

  let candidates = [];
  try {
    const d = await apiFetch(`/api/rollcall/candidates?classId=${cid}&scope=${scope()}`);
    candidates = d.candidates || [];
  } catch (err) {
    state.rolling = false;
    el.rcStart.disabled = false;
    el.rcName.className = 'rc-name idle';
    el.rcName.textContent = '无法点名';
    hint(err.message, true);
    showToast(err.message);
    return;
  }
  if (!candidates.length) {
    state.rolling = false;
    el.rcStart.disabled = false;
    el.rcName.className = 'rc-name idle';
    el.rcName.textContent = scope() === 'absent' ? '本班学生都已签到' : '没有可抽取的学生';
    hint(scope() === 'absent' ? '可切换到「全班」继续点名' : '该班级暂无在读学生', true);
    return;
  }

  // 滚动动画（姓名快速滚动）
  const names = candidates.map((c) => c.name);
  el.rcName.className = 'rc-name rolling';
  let tick = 0;
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    el.rcName.textContent = names[tick % names.length];
    tick += 1;
  }, 60);
  hint('正在随机抽取…');
  await new Promise((r) => setTimeout(r, state.spinMs));
  clearInterval(state.timer);
  state.timer = null;

  try {
    const body = { classId: cid, scope: scope(), subject: subject() || undefined };
    if (el.rcNoRepeat.checked && state.pickedIds.size > 0) body.excludeIds = [...state.pickedIds];
    const d = await apiFetch('/api/rollcall/pick', { method: 'POST', body: JSON.stringify(body) });
    state.result = d;
    state.pickedIds.add(d.student.id);
    el.rcName.className = 'rc-name done';
    el.rcName.textContent = d.student.name;
    el.rcChipNo.textContent = `学号：${d.student.studentNo || '—'}`;
    el.rcChipSeat.textContent = `座位：${d.student.seatLabel || '未排座'}`;
    el.rcChipNo.classList.remove('hidden');
    el.rcChipSeat.classList.remove('hidden');
    el.rcStart.textContent = '再次点名';
    hint(`本次课已点到 ${state.pickedIds.size} 人${typeof d.remaining === 'number' ? ` · 剩余可选 ${d.remaining} 人` : ''} · 学科：${d.subject || subject() || '未选'}`);
    renderLikeArea();
    await loadRecords();
    await refreshClassCounts();
  } catch (err) {
    if (err.status === 409) {
      // 全班都点过 → 询问是否重置
      openModal(
        '本次课所有学生已点过',
        `${err.message}是否重置本次课的点名记录，从头开始重新抽取？`,
        () => {
          state.pickedIds = new Set();
          showToast('已重置，可重新开始点名');
          startRoll();
        }
      );
      el.rcName.className = 'rc-name idle';
      el.rcName.textContent = '本次课所有学生已点过';
      hint('可点击「重置」重新开始，或关闭"不重复抽取"', true);
    } else {
      el.rcName.className = 'rc-name idle';
      el.rcName.textContent = '抽取失败';
      hint(err.message, true);
      showToast(err.message);
    }
  } finally {
    state.rolling = false;
    el.rcStart.disabled = false;
  }
}

// 未签到人数会随签到变化 → 轻量刷新班级统计（不重置当前状态）
async function refreshClassCounts() {
  try {
    const d = await apiFetch('/api/rollcall/classes');
    const byId = new Map((d.classes || []).map((c) => [String(c.classId), c]));
    state.classes = state.classes.map((c) => byId.get(String(c.classId)) || c);
    renderMeta();
  } catch (_) { /* 忽略 */ }
}

// ---------- 点赞（班长 / 任课老师 / 班主任 / 管理员） ----------
async function likeCurrent() {
  if (!state.canLike || !state.result || state.likeBusy) return;
  const subj = subject();
  if (!subj) { showToast('请先选择学科'); return; }
  state.likeBusy = true;
  renderLikeArea();
  try {
    const d = await apiFetch('/api/rollcall/likes', {
      method: 'POST',
      body: JSON.stringify({ classId: Number(el.rcClass.value), studentId: state.result.student.id, subject: subj }),
    });
    state.result.likeCount = d.likeCount;
    showToast(`已为 ${d.student.name} 点赞（${subj} 累计 ${d.likeCount} 赞）`);
    // 轻微反馈动画
    el.rcLikeInfo.textContent = `${subj} · ${d.student.name} 累计 ${d.likeCount} 赞`;
  } catch (err) {
    showToast('点赞失败：' + err.message);
  } finally {
    state.likeBusy = false;
    renderLikeArea();
  }
}

// ---------- 重置确认弹窗 ----------
let modalOkHandler = null;
function openModal(title, text, onOk) {
  el.rcModalTitle.textContent = title;
  el.rcModalText.textContent = text;
  modalOkHandler = onOk;
  el.rcModal.classList.remove('hidden');
}
function closeModal() {
  el.rcModal.classList.add('hidden');
  modalOkHandler = null;
}

// ---------- 事件 ----------
el.btnBack.addEventListener('click', () => { window.location.href = '/dashboard'; });
el.btnFull.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (err) { showToast('全屏失败：' + err.message); }
});

el.rcClass.addEventListener('change', async () => {
  state.pickedIds = new Set();       // 换班级 → 重新开始本次课
  // 换班级后学科默认取该班上次所用学科
  const c = currentClass();
  if (c && c.lastSubject && state.subjects.includes(c.lastSubject)) el.rcSubject.value = c.lastSubject;
  renderMeta();
  renderScopeHint();
  resetStage();
  await loadRecords();
});

el.rcSubject.addEventListener('change', async () => {
  renderMeta();
  renderScopeHint();
  resetStage();
  await loadRecords();
});

el.rcRecSubject.addEventListener('change', () => { loadRecords(); });

[el.rcScopeAll, el.rcScopeAbsent].forEach((r) => r.addEventListener('change', async () => {
  state.pickedIds = new Set();
  syncSegStyle();
  renderMeta();
  renderScopeHint();
  resetStage();
  await refreshClassCounts();
  renderScopeHint();
}));

el.rcStart.addEventListener('click', startRoll);
el.rcLike.addEventListener('click', likeCurrent);

el.rcToggleRecords.addEventListener('click', () => {
  state.recordsCollapsed = !state.recordsCollapsed;
  el.rcTableWrap.classList.toggle('collapsed', state.recordsCollapsed);
  el.rcToggleRecords.textContent = state.recordsCollapsed ? '展开' : '折叠';
});

el.rcExport.addEventListener('click', () => {
  const cid = Number(el.rcClass.value);
  if (!cid) { showToast('请选择班级'); return; }
  window.open(`/api/rollcall/records/export?classId=${cid}`, '_blank');
});

el.rcModalCancel.addEventListener('click', closeModal);
el.rcModalOk.addEventListener('click', () => {
  const fn = modalOkHandler;
  closeModal();
  if (fn) fn();
});
el.rcModal.addEventListener('click', (e) => { if (e.target === el.rcModal) closeModal(); });

// 大屏快捷操作：空格 / 回车 = 开始点名（焦点不在控件上时）
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  if (e.code === 'Space' || e.code === 'Enter') {
    if (!el.rcModal.classList.contains('hidden')) return;
    e.preventDefault();
    if (!el.rcStart.disabled && !state.rolling) startRoll();
  }
  if (e.key === 'Escape') closeModal();
});

// ---------- 初始化 ----------
(async function init() {
  try {
    await loadClasses(false);
    await loadRecords();
  } catch (err) {
    hint('加载失败：' + err.message, true);
    showToast('加载失败：' + err.message);
  }
})();
