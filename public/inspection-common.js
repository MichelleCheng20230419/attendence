// ============================================================
// 巡堂记录：公共工具（列表 / 创建 / 详情三页共用）
//   暴露 window.INSP：apiFetch / showToast / escapeHtml / STATUS_CLASS
//        / loadMeta（权限 + 字典）/ fmtDateTime / openLightbox
// ============================================================
(function () {
  'use strict';

  async function apiFetch(path, options = {}) {
    const res = await fetch(path, {
      headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
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
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const STATUS_CLASS = { pending: 'pending', processing: 'processing', resolved: 'resolved' };

  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function fmtDateTime(v) {
    if (!v) return '--';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtDateShort(v) {
    if (!v) return '--';
    const s = String(v).slice(0, 10);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[2]}-${m[3]}` : s;
  }

  // 权限 + 字典（列表/创建/详情页都用它决定按钮是否可用）
  const META = { data: null };
  async function loadMeta(force) {
    if (META.data && !force) return META.data;
    META.data = await apiFetch('/api/inspection/status');
    return META.data;
  }
  function actionAllowed(key) {
    const acts = (META.data && META.data.actions) || [];
    const hit = acts.find((a) => a.key === key);
    return !!(hit && hit.allowed);
  }

  // 照片放大
  function openLightbox(url, caption) {
    const box = document.getElementById('lightbox');
    const img = document.getElementById('lbImg');
    if (!box || !img) return;
    img.src = url;
    box.classList.remove('hidden');
    const cap = document.getElementById('lbCaption');
    if (cap) cap.textContent = caption || '';
  }
  function closeLightbox() {
    const box = document.getElementById('lightbox');
    if (box) box.classList.add('hidden');
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-photo]');
    if (el) { openLightbox(el.dataset.photo, el.dataset.caption || ''); return; }
    if (e.target.id === 'lbClose' || (e.target.id === 'lightbox')) closeLightbox();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

  window.INSP = {
    apiFetch, showToast, escapeHtml, STATUS_CLASS,
    todayStr, fmtDateTime, fmtDateShort,
    loadMeta, actionAllowed, openLightbox, closeLightbox,
  };
})();
