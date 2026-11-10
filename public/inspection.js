// ============================================================
// 巡堂记录：问题列表页（首页）
//   筛选（状态/年级→班级联动/日期/关键词）+ 分页 + 状态标签着色 + 照片缩略图（点击放大）+ 详情跳转
// ============================================================
const $ = (id) => document.getElementById(id);
const { apiFetch, showToast, escapeHtml, STATUS_CLASS, fmtDateShort, loadMeta, actionAllowed } = window.INSP;

const STATE = { page: 1, pageSize: 20, total: 0, issues: [], grades: [], classes: [], canDelete: false, pendingDelete: null, loadSeq: 0 };

// 年级下拉（当前学年的年级表）
function renderGradeOptions() {
  const sel = $('fGrade');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部年级</option>' +
    STATE.grades.map((g) => `<option value="${g.id}">${escapeHtml(g.gradeName)}</option>`).join('');
  if (cur && STATE.grades.some((g) => String(g.id) === String(cur))) sel.value = cur;
}

// 未选年级 → 班级下拉禁用并提示"请先选择年级"；选了年级 → 只列该年级班级（+「全部班级」）
function renderClassOptions(keepValue) {
  const sel = $('fClass');
  if (!sel) return;
  const gid = $('fGrade') ? $('fGrade').value : '';
  if (!gid) {
    sel.disabled = true;
    sel.innerHTML = '<option value="">请先选择年级</option>';
    return;
  }
  const list = STATE.classes.filter((c) => String(c.gradeId) === String(gid));
  sel.disabled = list.length === 0;
  sel.innerHTML = (list.length ? '<option value="">全部班级</option>' : '<option value="">该年级暂无班级</option>') +
    list.map((c) => `<option value="${c.id}">${escapeHtml(c.className)}</option>`).join('');
  if (keepValue && list.some((c) => String(c.id) === String(keepValue))) sel.value = keepValue;
}

function thumbHtml(issue) {
  const photos = issue.photos || [];
  if (!photos.length) return '<span class="insp-nophoto">无</span>';
  const show = photos.slice(0, 3);
  const more = issue.photoCount > show.length ? `<span class="insp-thumb-more">+${issue.photoCount - show.length}</span>` : '';
  return `<span class="insp-thumbs">${show.map((p) => `<img class="insp-thumb" src="${escapeHtml(p.url)}" alt="照片" data-photo="${escapeHtml(p.url)}" data-caption="${escapeHtml(issue.className + ' · ' + issue.issueDate)}">`).join('')}${more}</span>`;
}

function render() {
  const body = $('issueBody');
  if (!body) return;
  const rows = STATE.issues || [];
  body.innerHTML = rows.map((i) => `
    <tr data-id="${i.id}">
      <td class="insp-date">${escapeHtml(fmtDateShort(i.issueDate))}</td>
      <td>${escapeHtml(i.className)}</td>
      <td class="insp-desc">
        <div>${escapeHtml(i.description.slice(0, 80))}${i.description.length > 80 ? '…' : ''}</div>
        <div class="dt"><span class="prio ${i.priority === 'urgent' ? 'urgent' : ''}">${escapeHtml(i.priorityLabel)}</span> · ${escapeHtml(i.categoryLabel)} · ${escapeHtml(i.createdByName)} · ${escapeHtml(window.INSP.fmtDateTime(i.createdAt))}${i.feedbackCount ? ' · ' + i.feedbackCount + ' 条反馈' : ''}</div>
      </td>
      <td>${thumbHtml(i)}</td>
      <td><span class="st ${STATUS_CLASS[i.status] || 'pending'}" data-status="${i.status}">${escapeHtml(i.statusLabel)}</span></td>
      <td><button class="btn-text" data-detail="${i.id}">详情</button>${
        STATE.canDelete ? `<button class="btn-text del" data-del="${i.id}" title="删除这条巡堂记录（仅管理员，删除后不可恢复）">删除</button>` : ''
      }</td>
    </tr>`).join('');
  const empty = $('issueEmpty');
  if (empty) empty.classList.toggle('hidden', rows.length > 0);
  // 分页信息
  const total = STATE.total;
  const pages = Math.max(1, Math.ceil(total / STATE.pageSize));
  const from = total === 0 ? 0 : (STATE.page - 1) * STATE.pageSize + 1;
  const to = Math.min(total, STATE.page * STATE.pageSize);
  if ($('rangeInfo')) $('rangeInfo').textContent = `显示 ${from}-${to} 条，共 ${total} 条`;
  if ($('pageInfo')) $('pageInfo').textContent = `第 ${STATE.page} / ${pages} 页`;
  if ($('btnPrev')) $('btnPrev').disabled = STATE.page <= 1;
  if ($('btnNext')) $('btnNext').disabled = STATE.page >= pages;
}

function renderSummary(summary) {
  const el = $('inspSummary');
  if (!el || !summary) return;
  el.innerHTML =
    `待处理 <b style="color:#CF1322">${summary.pending || 0}</b>` +
    `处理中 <b style="color:#AD6800">${summary.processing || 0}</b>` +
    `已解决 <b style="color:#237804">${summary.resolved || 0}</b>` +
    `共 <b>${summary.total || 0}</b> 条`;
}

async function load() {
  const err = $('issueError');
  if (err) err.classList.add('hidden');
  // 序号防串：连续切换筛选（状态/班级/日期/关键词）时，先发的请求可能后到 →
  // 会让列表显示上一个筛选条件的结果（"筛了日期却还是全部"）；过期响应直接丢弃
  const seq = ++STATE.loadSeq;
  const params = new URLSearchParams();
  const status = $('fStatus') ? $('fStatus').value : '';
  const gradeId = $('fGrade') ? $('fGrade').value : '';
  const classId = $('fClass') ? $('fClass').value : '';
  const date = $('fDate') ? $('fDate').value : '';
  const keyword = $('fKeyword') ? $('fKeyword').value.trim() : '';
  if (status) params.set('status', status);
  // 选了年级：未选班级 → 按年级筛（该年级全部班级的问题）；选了班级 → 班级优先
  if (gradeId) params.set('gradeId', gradeId);
  if (classId) params.set('classId', classId);
  if (date) params.set('date', date);
  if (keyword) params.set('keyword', keyword);
  params.set('page', String(STATE.page));
  params.set('pageSize', String(STATE.pageSize));
  try {
    const data = await apiFetch('/api/inspection/issues?' + params.toString());
    if (seq !== STATE.loadSeq) return;      // 已有更新的筛选请求在跑 → 丢弃本次结果
    STATE.issues = data.issues || [];
    STATE.total = data.total || 0;
    render();
    renderSummary(data.summary);
    // 列表 URL 同步（刷新/分享保持筛选）
    const qs = params.toString();
    try { history.replaceState({}, '', '/inspection' + (qs ? '?' + qs : '')); } catch (_) {}
  } catch (e) {
    if (seq !== STATE.loadSeq) return;
    if (err) { err.textContent = '加载失败：' + e.message; err.classList.remove('hidden'); }
    showToast('加载失败：' + e.message, 3200);
  }
}

// ---------- 删除（仅管理员，必须二次确认） ----------
function openDeleteModal(id) {
  const issue = (STATE.issues || []).find((x) => String(x.id) === String(id));
  STATE.pendingDelete = id;
  const msg = $('delMessage');
  if (msg && issue) {
    msg.textContent = `确定要删除这条巡堂记录吗？删除后不可恢复。` +
      `（${issue.issueDate} · ${issue.className || '未指定班级'} · ${String(issue.description || '').slice(0, 30)}${String(issue.description || '').length > 30 ? '…' : ''}）`;
  }
  const m = $('delModal');
  if (m) m.classList.remove('hidden');
}

function closeDeleteModal() {
  STATE.pendingDelete = null;
  const m = $('delModal');
  if (m) m.classList.add('hidden');
}

async function doDelete() {
  const id = STATE.pendingDelete;
  if (!id) return;
  const btn = $('delOk');
  if (btn) { btn.disabled = true; btn.textContent = '删除中…'; }
  try {
    const r = await apiFetch('/api/inspection/issues/' + id, { method: 'DELETE' });
    closeDeleteModal();
    const d = (r && r.deleted) || {};
    showToast(`删除成功（问题 1 条${d.photos ? ' · 照片 ' + d.photos + ' 张' : ''}${d.feedbacks ? ' · 反馈 ' + d.feedbacks + ' 条' : ''}）`);
    await load();
  } catch (e) {
    showToast('删除失败：' + e.message, 3200);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '确认删除'; }
  }
}

// ---------- 事件 ----------
if ($('issueBody')) {
  $('issueBody').addEventListener('click', (e) => {
    const del = e.target.closest && e.target.closest('[data-del]');
    if (del) { openDeleteModal(del.dataset.del); return; }
    const btn = e.target.closest && e.target.closest('[data-detail]');
    if (btn) { window.location.href = '/inspection/detail?id=' + btn.dataset.detail; }
  });
}
if ($('delCancel')) $('delCancel').addEventListener('click', closeDeleteModal);
if ($('delModal')) $('delModal').addEventListener('click', (e) => { if (e.target === $('delModal')) closeDeleteModal(); });
if ($('delOk')) $('delOk').addEventListener('click', doDelete);
if ($('btnSearch')) $('btnSearch').addEventListener('click', () => { STATE.page = 1; load(); });
if ($('fKeyword')) $('fKeyword').addEventListener('keydown', (e) => { if (e.key === 'Enter') { STATE.page = 1; load(); } });
// 年级变了 → 班级下拉重新过滤（并回到"全部班级"），再查询
if ($('fGrade')) $('fGrade').addEventListener('change', () => { renderClassOptions(); STATE.page = 1; load(); });
for (const id of ['fStatus', 'fClass', 'fDate']) {
  const el = $(id);
  if (el) el.addEventListener('change', () => { STATE.page = 1; load(); });
}
if ($('btnReset')) $('btnReset').addEventListener('click', () => {
  if ($('fStatus')) $('fStatus').value = '';
  if ($('fGrade')) $('fGrade').value = '';
  renderClassOptions();
  if ($('fDate')) $('fDate').value = '';
  if ($('fKeyword')) $('fKeyword').value = '';
  STATE.page = 1;
  load();
});
if ($('btnPrev')) $('btnPrev').addEventListener('click', () => { if (STATE.page > 1) { STATE.page--; load(); } });
if ($('btnNext')) $('btnNext').addEventListener('click', () => { STATE.page++; load(); });
if ($('btnNewIssue')) $('btnNewIssue').addEventListener('click', () => { window.location.href = '/inspection/new'; });
if ($('btnBack')) $('btnBack').addEventListener('click', () => { window.location.href = '/dashboard'; });

(async function init() {
  try { if (window.DSHNavbar && window.DSHNavbar.ready) await window.DSHNavbar.ready; } catch (_) {}
  let qp = null;
  try { qp = new URLSearchParams(window.location.search); } catch (_) { qp = new URLSearchParams(); }
  if ($('fStatus') && qp.get('status')) $('fStatus').value = qp.get('status');
  if ($('fDate') && qp.get('date')) $('fDate').value = qp.get('date');
  if ($('fKeyword') && qp.get('keyword')) $('fKeyword').value = qp.get('keyword');
  if (qp.get('page')) STATE.page = Math.max(1, Number(qp.get('page')) || 1);

  let meta = null;
  try {
    meta = await loadMeta(true);
    window.INSP._meta = meta;
    // 删除按钮：仅管理员可见（教务组等小组成员只能查看/创建/反馈）
    STATE.canDelete = !!(meta && meta.canDelete);
  } catch (e) {
    showToast('权限信息加载失败：' + e.message, 3200);
  }
  // 状态下拉（字典来自后端）
  const sel = $('fStatus');
  if (sel && meta) {
    sel.innerHTML = '<option value="">全部</option>' + (meta.statuses || []).map((s) => `<option value="${s.key}">${escapeHtml(s.label)}</option>`).join('');
    if (document.querySelector('#fStatus option[value="' + (qp.get('status') || '') + '"]')) {
      sel.value = qp.get('status') || '';
    }
  }
  // 记录问题按钮：没有 create_issue 权限时禁用并提示
  if (!actionAllowed('create_issue')) {
    const b = $('btnNewIssue');
    if (b) { b.disabled = true; b.title = '没有「记录问题」权限（需要相应小组授权）'; b.classList.add('btn-secondary'); b.classList.remove('btn-primary'); }
  }
  // 年级 + 班级（两级联动）；URL 预填时先定年级再定班级，否则班级选项还没生成
  try {
    const c = await apiFetch('/api/inspection/classes');
    STATE.grades = c.grades || [];
    STATE.classes = c.classes || [];
    renderGradeOptions();
    const gPref = qp.get('gradeId') || '';
    if (gPref && $('fGrade') && STATE.grades.some((g) => String(g.id) === String(gPref))) $('fGrade').value = gPref;
    renderClassOptions(qp.get('classId') || '');
  } catch (_) {}
  await load();
})();
