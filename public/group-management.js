// ============================================================
// 小组管理（系统管理 → 小组管理，独立页面，仅管理员）
//   · 小组列表（名称/描述/权限/成员数/创建时间）
//   · 新建 / 编辑小组（名称、描述、权限勾选树：页面 + 页面下操作）
//   · 管理成员（勾选用户，一个用户可属于多个小组）
// ============================================================
const $ = (id) => document.getElementById(id);
const el = {
  groupList: $('groupList'), groupEmpty: $('groupEmpty'),
  btnAddGroup: $('btnAddGroup'), btnBack: $('btnBack'),
  groupModal: $('groupModal'), groupModalTitle: $('groupModalTitle'),
  gName: $('gName'), gDesc: $('gDesc'), gError: $('gError'), gCancel: $('gCancel'), gSubmit: $('gSubmit'),
  permTree: $('permTree'),
  memberModal: $('memberModal'), mmGroupName: $('mmGroupName'), mmSearch: $('mmSearch'),
  mmOnlySelected: $('mmOnlySelected'), mmCount: $('mmCount'), mmList: $('mmList'), mmError: $('mmError'),
  mmCancel: $('mmCancel'), mmSubmit: $('mmSubmit'),
  confirmModal: $('confirmModal'), confirmTitle: $('confirmTitle'), confirmMessage: $('confirmMessage'),
  confirmOk: $('confirmOk'), confirmCancel: $('confirmCancel'),
  toast: $('toast'),
};

const STATE = {
  catalog: [],          // 权限目录（服务端下发）
  groups: [],           // 小组列表
  users: [],            // 用户列表（成员选择）
  editingId: null,      // 正在编辑的小组 id（null = 新建）
  memberGroupId: null,  // 正在管理成员的小组 id
  selectedUserIds: [],  // 成员弹窗里已勾选的用户
  confirmAction: null,
};

// ---------------- 基础工具 ----------------
async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || ('请求失败（' + res.status + '）'));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function showToast(msg, ms = 2400) {
  if (!el.toast) return;
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.toast.classList.add('hidden'), ms);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(v) {
  if (!v) return '--';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openConfirm(title, message, fn) {
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  STATE.confirmAction = fn;
  el.confirmModal.classList.remove('hidden');
}
function closeConfirm() {
  el.confirmModal.classList.add('hidden');
  STATE.confirmAction = null;
}

// ---------------- 小组列表 ----------------
const PAGE_LABEL = () => {
  const m = {};
  STATE.catalog.forEach((p) => { m[p.key] = p.label; });
  return m;
};

function renderGroups() {
  const labels = PAGE_LABEL();
  if (!el.groupList) return;
  if (!STATE.groups.length) {
    el.groupList.innerHTML = '';
    if (el.groupEmpty) el.groupEmpty.classList.remove('hidden');
    return;
  }
  if (el.groupEmpty) el.groupEmpty.classList.add('hidden');
  el.groupList.innerHTML = STATE.groups.map((g) => {
    const pages = (g.permissions && g.permissions.pages) || [];
    const badges = pages.length
      ? pages.map((k) => `<span class="perm-badge">${escapeHtml(labels[k] || k)}</span>`).join('')
      : '<span class="perm-badge muted">仅默认菜单</span>';
    return `
      <tr data-id="${g.id}">
        <td><b>${escapeHtml(g.name)}</b></td>
        <td>${escapeHtml(g.description || '--')}</td>
        <td>${badges}</td>
        <td><span class="member-count">${g.memberCount}</span> 人</td>
        <td>${fmtTime(g.createdAt)}</td>
        <td class="td-actions">
          <button class="btn-text edit" data-act="edit" data-id="${g.id}">编辑</button>
          <button class="btn-text member" data-act="members" data-id="${g.id}">管理成员</button>
          <button class="btn-text del" data-act="del" data-id="${g.id}">删除</button>
        </td>
      </tr>`;
  }).join('');
}

async function loadGroups() {
  const data = await apiFetch('/api/groups');
  STATE.groups = data.groups || [];
  renderGroups();
}

// ---------------- 权限勾选树 ----------------
// 排版：一级权限一行（卡片）· 子权限缩进 24px 横向排列
//   - 无子权限 / 锁定项：说明文字另起一行（带 └ 分支符号）
// 交互：勾选一级权限 → 自动勾选全部子权限；取消 → 全部取消；
//       子权限可单独勾选（勾子项时自动带上所属一级权限，避免"勾了却不生效"）
function renderPermTree(selected) {
  const pages = (selected && selected.pages) || [];
  const actions = (selected && selected.actions) || [];
  if (!el.permTree) return;
  el.permTree.innerHTML = STATE.catalog.map((p) => {
    const locked = p.key === 'system_management';      // 系统管理仅管理员，不通过小组授予
    const def = !!p.default;                            // 签到操作 = 默认权限
    const checked = locked ? false : (def || pages.indexOf(p.key) >= 0);
    const acts = p.actions || [];
    let body = '';
    if (acts.length) {
      body = `<div class="perm-body">
        <div class="perm-actions" data-actions-for="${p.key}">
          ${acts.map((a) => `<label class="perm-chip">
            <input type="checkbox" data-action="${a.key}" data-page="${p.key}" ${actions.indexOf(a.key) >= 0 && checked ? 'checked' : ''}>
            <span>${escapeHtml(a.label)}</span>
          </label>`).join('')}
        </div>
      </div>`;
    } else if (p.desc) {
      body = `<div class="perm-body">
        <div class="perm-desc-line"><span class="perm-branch">└</span><span class="perm-desc-text">${escapeHtml(p.desc)}${locked ? '（仅管理员，不可通过小组授予）' : (def ? '' : '')}</span></div>
      </div>`;
    }
    return `
      <div class="perm-page ${locked ? 'locked' : ''} ${checked ? 'on' : ''}" data-page-card="${p.key}">
        <label class="perm-head">
          <input type="checkbox" data-page="${p.key}" ${checked ? 'checked' : ''} ${(locked || def) ? 'disabled' : ''}>
          <span class="perm-name">${escapeHtml(p.label)}</span>
          ${acts.length ? `<span class="perm-tag">${acts.length} 项操作</span>` : ''}
        </label>
        ${body}
      </div>`;
  }).join('');
}

function readPermTree() {
  const pages = [];
  const actions = [];
  el.permTree.querySelectorAll('input[data-page]').forEach((cb) => {
    if (cb.dataset.page === 'system_management') return;       // 系统管理不写入
    if (cb.checked) pages.push(cb.dataset.page);
  });
  el.permTree.querySelectorAll('input[data-action]').forEach((cb) => {
    if (cb.checked) actions.push(cb.dataset.action);
  });
  return { pages, actions };
}

// 一级权限卡片高亮与子项状态同步
function syncPermTree() {
  el.permTree.querySelectorAll('.perm-page').forEach((card) => {
    const pageCb = card.querySelector('input[data-page]');
    if (!pageCb) return;
    card.classList.toggle('on', pageCb.checked);
  });
}

if (el.permTree) {
  el.permTree.addEventListener('change', (e) => {
    const cb = e.target.closest && e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    // 子权限复选框同时带 data-action 与 data-page（用于分组），必须先按 data-action 判定，
    // 否则会被误当成"一级权限"而联动全部子项
    if (cb.dataset.action) {
      // 子权限可单独勾选：勾上时自动带上所属一级权限（后端只保存"页面 + 其下操作"）
      if (cb.checked) {
        const parent = el.permTree.querySelector(`input[data-page="${cb.dataset.page}"]:not([data-action])`);
        if (parent && !parent.checked && !parent.disabled) parent.checked = true;
      }
      syncPermTree();
      return;
    }
    if (cb.dataset.page) {
      // 勾选/取消一级权限 → 同步其下全部子权限
      const box = el.permTree.querySelector(`[data-actions-for="${cb.dataset.page}"]`);
      if (box) {
        box.querySelectorAll('input[data-action]').forEach((child) => { child.checked = cb.checked; });
      }
      syncPermTree();
    }
  });
}

// ---------------- 新建 / 编辑 ----------------
function openGroupModal(group) {
  STATE.editingId = group ? group.id : null;
  el.groupModalTitle.textContent = group ? '编辑小组' : '新建小组';
  el.gName.value = group ? group.name : '';
  el.gDesc.value = group ? (group.description || '') : '';
  el.gError.classList.add('hidden');
  renderPermTree(group ? group.permissions : { pages: [], actions: [] });   // 新建：默认不勾选任何权限
  el.groupModal.classList.remove('hidden');
}
function closeGroupModal() { el.groupModal.classList.add('hidden'); }

async function submitGroup() {
  const name = el.gName.value.trim();
  const description = el.gDesc.value.trim();
  const permissions = readPermTree();
  if (!name) { el.gError.textContent = '请填写小组名称'; el.gError.classList.remove('hidden'); return; }
  el.gSubmit.disabled = true;
  try {
    if (STATE.editingId) {
      await apiFetch('/api/groups/' + STATE.editingId, { method: 'PUT', body: JSON.stringify({ name, description, permissions }) });
      showToast('小组已更新');
    } else {
      await apiFetch('/api/groups', { method: 'POST', body: JSON.stringify({ name, description, permissions }) });
      showToast('小组已创建');
    }
    closeGroupModal();
    await loadGroups();
  } catch (err) {
    el.gError.textContent = err.message;
    el.gError.classList.remove('hidden');
  } finally {
    el.gSubmit.disabled = false;
  }
}

// ---------------- 成员管理 ----------------
function roleLabel(role) {
  return ({ admin: '管理员', teacher: '教师', monitor: '班长', student: '学生' })[role] || role;
}

function renderMembers() {
  const kw = (el.mmSearch.value || '').trim().toLowerCase();
  const onlySel = el.mmOnlySelected.checked;
  const list = STATE.users.filter((u) => {
    if (onlySel && STATE.selectedUserIds.indexOf(u.id) < 0) return false;
    if (!kw) return true;
    return (u.username || '').toLowerCase().includes(kw) ||
      String(u.realName || u.displayName || '').toLowerCase().includes(kw);
  });
  el.mmList.innerHTML = list.length ? list.map((u) => {
    const checked = STATE.selectedUserIds.indexOf(u.id) >= 0;
    return `
      <label class="member-row">
        <input type="checkbox" data-uid="${u.id}" ${checked ? 'checked' : ''}>
        <span>${escapeHtml(u.realName || u.displayName || u.username)}</span>
        <span class="role-tag">${roleLabel(u.role)} · ${escapeHtml(u.username)}</span>
        <span class="cls">${escapeHtml(u.className || '')}</span>
      </label>`;
  }).join('') : '<div class="empty-tip">没有匹配的用户</div>';
  el.mmCount.textContent = '已选 ' + STATE.selectedUserIds.length + ' 人';
}

async function openMemberModal(group) {
  STATE.memberGroupId = group.id;
  el.mmGroupName.textContent = group.name;
  el.mmError.classList.add('hidden');
  el.mmSearch.value = '';
  el.mmOnlySelected.checked = false;
  el.mmList.innerHTML = '<div class="empty-tip">加载中…</div>';
  el.memberModal.classList.remove('hidden');
  try {
    if (!STATE.users.length) {
      const data = await apiFetch('/api/users');
      STATE.users = data.users || [];
    }
    const detail = await apiFetch('/api/groups/' + group.id);
    STATE.selectedUserIds = ((detail.group && detail.group.members) || []).map((m) => m.id);
    renderMembers();
  } catch (err) {
    el.mmError.textContent = err.message;
    el.mmError.classList.remove('hidden');
    el.mmList.innerHTML = '';
  }
}
function closeMemberModal() { el.memberModal.classList.add('hidden'); }

async function submitMembers() {
  el.mmSubmit.disabled = true;
  try {
    await apiFetch('/api/groups/' + STATE.memberGroupId + '/members', {
      method: 'PUT',
      body: JSON.stringify({ userIds: STATE.selectedUserIds }),
    });
    showToast('成员已保存（' + STATE.selectedUserIds.length + ' 人）');
    closeMemberModal();
    await loadGroups();
  } catch (err) {
    el.mmError.textContent = err.message;
    el.mmError.classList.remove('hidden');
  } finally {
    el.mmSubmit.disabled = false;
  }
}

// ---------------- 事件绑定 ----------------
if (el.groupList) {
  el.groupList.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const group = STATE.groups.find((g) => g.id === id);
    if (!group) return;
    if (btn.dataset.act === 'edit') openGroupModal(group);
    else if (btn.dataset.act === 'members') openMemberModal(group);
    else if (btn.dataset.act === 'del') {
      openConfirm('删除小组', `确定删除小组「${group.name}」？该小组的成员关联会一并删除（用户的其它小组不受影响）。`, async () => {
        try {
          await apiFetch('/api/groups/' + id, { method: 'DELETE' });
          showToast('小组已删除');
          await loadGroups();
        } catch (err) { showToast(err.message, 3200); }
      });
    }
  });
}
if (el.btnAddGroup) el.btnAddGroup.addEventListener('click', () => openGroupModal(null));
if (el.gCancel) el.gCancel.addEventListener('click', closeGroupModal);
if (el.gSubmit) el.gSubmit.addEventListener('click', submitGroup);
if (el.groupModal) el.groupModal.addEventListener('click', (e) => { if (e.target === el.groupModal) closeGroupModal(); });

if (el.mmSearch) el.mmSearch.addEventListener('input', renderMembers);
if (el.mmOnlySelected) el.mmOnlySelected.addEventListener('change', renderMembers);
if (el.mmList) {
  el.mmList.addEventListener('change', (e) => {
    const cb = e.target.closest && e.target.closest('input[data-uid]');
    if (!cb) return;
    const uid = Number(cb.dataset.uid);
    const i = STATE.selectedUserIds.indexOf(uid);
    if (cb.checked && i < 0) STATE.selectedUserIds.push(uid);
    if (!cb.checked && i >= 0) STATE.selectedUserIds.splice(i, 1);
    el.mmCount.textContent = '已选 ' + STATE.selectedUserIds.length + ' 人';
  });
}
if (el.mmCancel) el.mmCancel.addEventListener('click', closeMemberModal);
if (el.mmSubmit) el.mmSubmit.addEventListener('click', submitMembers);
if (el.memberModal) el.memberModal.addEventListener('click', (e) => { if (e.target === el.memberModal) closeMemberModal(); });

if (el.confirmOk) el.confirmOk.addEventListener('click', () => { const fn = STATE.confirmAction; closeConfirm(); if (fn) fn(); });
if (el.confirmCancel) el.confirmCancel.addEventListener('click', closeConfirm);
if (el.confirmModal) el.confirmModal.addEventListener('click', (e) => { if (e.target === el.confirmModal) closeConfirm(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeConfirm(); closeGroupModal(); closeMemberModal();
});

if (el.btnBack) el.btnBack.addEventListener('click', () => { window.location.href = '/dashboard'; });

// ---------------- 初始化 ----------------
(async function init() {
  try {
    const me = await apiFetch('/api/auth/me');
    if (me.user.role !== 'admin') { window.location.href = '/dashboard'; return; }
  } catch (_) { window.location.href = '/login'; return; }
  try {
    const cat = await apiFetch('/api/permissions/catalog');
    STATE.catalog = cat.pages || [];
  } catch (err) {
    showToast('权限目录加载失败：' + err.message, 3200);
    STATE.catalog = [];
  }
  try {
    await loadGroups();
  } catch (err) {
    showToast('加载失败：' + err.message, 3200);
  }
})();
