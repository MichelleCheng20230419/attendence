// ============================================================
// 巡堂记录：记录问题页（表单 + 照片上传）
//   权限：create_issue（带照片时还需要 upload_photo）
// ============================================================
const $ = (id) => document.getElementById(id);
const { apiFetch, showToast, escapeHtml, todayStr, loadMeta, actionAllowed } = window.INSP;

const MAX_FILES = 9;
const MAX_SIZE = 5 * 1024 * 1024;
const STATE = { files: [] };   // { file, url }
// 年级 / 班级 两级联动：一次取回「当前学年的年级 + 班级」，切换年级时本地过滤（40+ 班也不卡）
const META_CLASSES = { grades: [], classes: [] };

// 未选年级 → 班级下拉禁用并提示"请先选择年级"
function renderGradeOptions() {
  const sel = $('fGrade');
  if (!sel) return;
  sel.innerHTML = '<option value="">请选择年级</option>' +
    META_CLASSES.grades.map((g) => `<option value="${g.id}">${escapeHtml(g.gradeName)}</option>`).join('');
}

function renderClassOptions(keepValue) {
  const sel = $('fClass');
  if (!sel) return;
  const gid = $('fGrade') ? $('fGrade').value : '';
  if (!gid) {
    sel.disabled = true;
    sel.innerHTML = '<option value="">请先选择年级</option>';
    return;
  }
  const list = META_CLASSES.classes.filter((c) => String(c.gradeId) === String(gid));
  sel.disabled = list.length === 0;
  sel.innerHTML = (list.length ? '<option value="">请选择班级</option>' : '<option value="">该年级暂无班级</option>') +
    list.map((c) => `<option value="${c.id}">${escapeHtml(c.className)}</option>`).join('');
  if (keepValue && list.some((c) => String(c.id) === String(keepValue))) sel.value = keepValue;
}

function renderPhotos() {
  const box = $('photoBox');
  if (!box) return;
  const items = STATE.files.map((f, i) => `
    <div class="photo-item">
      <img src="${f.url}" alt="${escapeHtml(f.file.name)}">
      <button type="button" class="rm" data-rm="${i}" title="移除">✕</button>
    </div>`).join('');
  const add = `<button type="button" class="photo-add" id="btnAddPhoto" title="选择照片">＋</button>`;
  box.innerHTML = items + add;
  $('btnAddPhoto').addEventListener('click', () => $('photoInput').click());
  box.querySelectorAll('[data-rm]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.rm);
      URL.revokeObjectURL(STATE.files[i].url);
      STATE.files.splice(i, 1);
      renderPhotos();
      updateHint();
    });
  });
  updateHint();
}

function updateHint() {
  const h = $('photoHint');
  if (!h) return;
  h.textContent = STATE.files.length ? `已选择 ${STATE.files.length} 张照片（最多 ${MAX_FILES} 张）` : '尚未选择照片';
}

function addFiles(fileList) {
  const err = $('errBox');
  if (err) err.classList.add('hidden');
  for (const file of Array.from(fileList || [])) {
    if (!/^image\/(jpeg|png)$/.test(file.type)) {
      showToast(`「${file.name}」不是 JPG/PNG 图片，已跳过`, 3000);
      continue;
    }
    if (file.size > MAX_SIZE) {
      showToast(`「${file.name}」超过 5MB，已跳过`, 3000);
      continue;
    }
    if (STATE.files.length >= MAX_FILES) {
      showToast(`最多上传 ${MAX_FILES} 张照片`, 3000);
      break;
    }
    STATE.files.push({ file, url: URL.createObjectURL(file) });
  }
  renderPhotos();
}

async function submit(e) {
  if (e) e.preventDefault();
  const err = $('errBox');
  if (err) err.classList.add('hidden');
  const description = ($('fDescription').value || '').trim();
  if (!description) { showErr('请填写问题描述'); return; }
  if (!$('fGrade').value) { showErr('请先选择年级'); return; }
  if (!$('fClass').value) { showErr('请选择班级'); return; }
  const fd = new FormData();
  fd.append('description', description);
  fd.append('classId', $('fClass').value);
  fd.append('category', $('fCategory').value);
  fd.append('priority', $('fPriority').value);
  fd.append('issueDate', $('fIssueDate').value || todayStr());
  STATE.files.forEach((f) => fd.append('photos', f.file, f.file.name));

  const btn = $('btnSubmit');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const data = await apiFetch('/api/inspection/issues', { method: 'POST', body: fd });
    showToast('已记录问题（' + (data.issue ? data.issue.statusLabel : '待处理') + '）');
    setTimeout(() => { window.location.href = '/inspection/detail?id=' + (data.issue ? data.issue.id : ''); }, 600);
  } catch (e2) {
    showErr(e2.message);
    btn.disabled = false;
    btn.textContent = '提交';
  }
}

function showErr(msg) {
  const err = $('errBox');
  if (err) { err.textContent = msg; err.classList.remove('hidden'); }
  showToast(msg, 3200);
}

// ---------- 事件 ----------
if ($('photoInput')) $('photoInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
if ($('btnAddPhoto')) $('btnAddPhoto').addEventListener('click', () => $('photoInput').click());
if ($('issueForm')) $('issueForm').addEventListener('submit', submit);
// 先选年级 → 班级下拉随之刷新
if ($('fGrade')) $('fGrade').addEventListener('change', () => renderClassOptions());
if ($('btnCancel')) $('btnCancel').addEventListener('click', () => { window.location.href = '/inspection'; });
if ($('btnBack')) $('btnBack').addEventListener('click', () => { window.location.href = '/inspection'; });

(async function init() {
  try { if (window.DSHNavbar && window.DSHNavbar.ready) await window.DSHNavbar.ready; } catch (_) {}
  if ($('fIssueDate')) $('fIssueDate').value = todayStr();

  let meta = null;
  try { meta = await loadMeta(true); } catch (e) { showToast('权限信息加载失败：' + e.message, 3200); }
  if (meta) {
    const cat = $('fCategory');
    if (cat) cat.innerHTML = (meta.categories || []).map((c) => `<option value="${c.key}">${escapeHtml(c.label)}</option>`).join('');
    const prio = $('fPriority');
    if (prio) prio.innerHTML = (meta.priorities || []).map((p) => `<option value="${p.key}">${escapeHtml(p.label)}</option>`).join('');
  }
  // 没有"记录问题"权限 → 禁用表单
  if (!actionAllowed('create_issue')) {
    const tip = $('denyTip');
    if (tip) tip.classList.remove('hidden');
    ['fIssueDate', 'fGrade', 'fClass', 'fCategory', 'fPriority', 'fDescription', 'photoInput'].forEach((id) => { const el = $(id); if (el) el.disabled = true; });
    const b = $('btnSubmit');
    if (b) { b.disabled = true; b.title = '没有「记录问题」权限'; }
    const add = $('btnAddPhoto');
    if (add) add.disabled = true;
  } else if (!actionAllowed('upload_photo')) {
    const add = $('btnAddPhoto');
    if (add) { add.disabled = true; add.title = '没有「上传照片」权限（可不选照片提交）'; }
    if ($('photoHint')) $('photoHint').textContent = '没有「上传照片」权限，可不选照片提交';
  }
  // 年级 / 班级 两级联动（未选年级时班级下拉不可用并提示）
  try {
    const c = await apiFetch('/api/inspection/classes');
    META_CLASSES.grades = c.grades || [];
    META_CLASSES.classes = c.classes || [];
    renderGradeOptions();
    renderClassOptions();
  } catch (e) { showToast('年级/班级加载失败：' + e.message, 3200); }
  renderPhotos();
})();
