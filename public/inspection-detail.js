// ============================================================
// 巡堂记录：问题详情页（问题信息 + 照片 + 反馈记录 + 添加反馈）
//   状态流转由后端按规则计算（前端只展示"处理前 → 处理后"结果）
// ============================================================
const $ = (id) => document.getElementById(id);
const { apiFetch, showToast, escapeHtml, STATUS_CLASS, fmtDateTime, loadMeta, actionAllowed } = window.INSP;

const STATE = { issueId: null, issue: null, photos: [], feedbacks: [] };

function issueIdFromUrl() {
  try { return Number(new URLSearchParams(window.location.search).get('id')) || null; } catch (_) { return null; }
}

function render() {
  const i = STATE.issue;
  if (!i) return;
  $('dDate').textContent = i.issueDate || '--';
  $('dClass').textContent = i.className || '--';
  $('dCategory').textContent = i.categoryLabel || '--';
  $('dPriority').innerHTML = `<span class="prio ${i.priority === 'urgent' ? 'urgent' : ''}">${escapeHtml(i.priorityLabel)}</span>`;
  $('dDesc').textContent = i.description || '--';
  $('dStatus').innerHTML = `<span class="st ${STATUS_CLASS[i.status] || 'pending'}" data-status="${i.status}">${escapeHtml(i.statusLabel)}</span>`;
  $('dCreator').textContent = `${i.createdByName || '--'} · ${fmtDateTime(i.createdAt)}`;

  const ph = $('dPhotos');
  if (ph) {
    ph.innerHTML = STATE.photos.length
      ? STATE.photos.map((p) => `<img src="${escapeHtml(p.url)}" alt="照片" title="点击放大" data-photo="${escapeHtml(p.url)}" data-caption="${escapeHtml(p.fileName || '')}">`).join('')
      : '<span class="thumbs-empty">无</span>';
  }

  const list = $('fbList');
  if (list) {
    list.innerHTML = STATE.feedbacks.length ? STATE.feedbacks.map((f) => `
      <div class="fb-item" data-fb="${f.id}">
        <div class="fb-head">
          <b>${escapeHtml(f.feedbackByName || '--')}</b>
          <span class="fb-time">${escapeHtml(fmtDateTime(f.createdAt))}</span>
          <span class="fb-label">是否解决：</span>
          <span class="st ${f.feedbackStatus === 'resolved' ? 'resolved' : (f.feedbackStatus === 'unresolved' ? 'pending' : 'processing')}">${escapeHtml(f.feedbackStatusLabel)}</span>
        </div>
        <div class="fb-sol">${escapeHtml(f.solution || '')}</div>
      </div>`).join('') : '<div class="fb-empty">暂无反馈记录</div>';
  }
}

async function load() {
  const err = $('errBox');
  if (err) err.classList.add('hidden');
  try {
    const data = await apiFetch('/api/inspection/issues/' + STATE.issueId);
    STATE.issue = data.issue;
    STATE.photos = data.photos || [];
    STATE.feedbacks = data.feedbacks || [];
    render();
  } catch (e) {
    if (err) { err.textContent = '加载失败：' + e.message; err.classList.remove('hidden'); }
    showToast('加载失败：' + e.message, 3200);
  }
}

async function submitFeedback() {
  const solution = ($('fbSolution').value || '').trim();
  const feedbackStatus = $('fbStatus').value;
  const err = $('errBox');
  if (err) err.classList.add('hidden');
  if (!solution) { if (err) { err.textContent = '请填写解决方案'; err.classList.remove('hidden'); } showToast('请填写解决方案'); return; }
  const btn = $('btnSubmitFb');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const data = await apiFetch('/api/inspection/issues/' + STATE.issueId + '/feedbacks', {
      method: 'POST',
      body: JSON.stringify({ feedbackStatus, solution }),
    });
    showToast(`反馈已提交：状态 ${data.statusBeforeLabel} → ${data.statusAfterLabel}`, 3000);
    $('fbSolution').value = '';
    await load();
  } catch (e) {
    if (err) { err.textContent = e.message; err.classList.remove('hidden'); }
    showToast(e.message, 3200);
  } finally {
    btn.disabled = false;
    btn.textContent = '提交反馈';
  }
}

if ($('btnSubmitFb')) $('btnSubmitFb').addEventListener('click', submitFeedback);
if ($('btnBack')) $('btnBack').addEventListener('click', () => { window.location.href = '/inspection'; });

(async function init() {
  try { if (window.DSHNavbar && window.DSHNavbar.ready) await window.DSHNavbar.ready; } catch (_) {}
  STATE.issueId = issueIdFromUrl();
  if (!STATE.issueId) {
    const err = $('errBox');
    if (err) { err.textContent = '缺少问题编号（请从巡堂记录列表进入）'; err.classList.remove('hidden'); }
    return;
  }
  let meta = null;
  try { meta = await loadMeta(true); } catch (e) { showToast('权限信息加载失败：' + e.message, 3200); }
  if (meta) {
    const sel = $('fbStatus');
    if (sel) sel.innerHTML = (meta.feedbackStatuses || []).map((s) => `<option value="${s.key}">${escapeHtml(s.label)}</option>`).join('');
    if (sel) sel.value = 'processing';
  }
  // 没有"添加反馈"权限 → 隐藏表单并提示
  if (!actionAllowed('add_feedback')) {
    const form = $('fbForm');
    if (form) form.classList.add('hidden');
    const tip = $('fbDeny');
    if (tip) tip.classList.remove('hidden');
  }
  await load();
})();
