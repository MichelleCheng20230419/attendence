// ============================================================
// 点赞排行榜（班长端签到操作台入口 → 独立页面）
//   需求：班长可查看本班点赞排行榜（按点赞数从高到低）
//         支持按学科筛选、按时间筛选（本周 / 本月 / 本学期 / 全部）
//         只读：班长只能看本班数据，不能修改、不能导出
//   数据：GET /api/performance/likes?subject=&period=（班长范围由后端强制为本班）
//         GET /api/likes/options（学科字典 + 可查看范围）
// ============================================================
const $ = (id) => document.getElementById(id);
const STATE = { subjects: [], period: 'month', subject: '' };

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer = null;
function showToast(msg, ms = 2600) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
async function apiFetch(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('未登录'); }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) ? data.error : `请求失败（${res.status}）`);
  return data;
}

function renderRows(list) {
  const body = $('lrBody');
  if (!body) return;
  body.innerHTML = (list || []).map((r) => `
    <tr>
      <td class="lr-rank ${r.rank <= 3 ? 'top' : ''}">${r.rank <= 3 ? '🏅 ' + r.rank : r.rank}</td>
      <td class="lr-name">${escHtml(r.name || '—')}</td>
      <td>${escHtml(r.studentNo || '—')}</td>
      <td class="lr-likes">${r.likes}</td>
    </tr>`).join('');
  const empty = $('lrEmpty');
  if (empty) empty.classList.toggle('hidden', (list || []).length > 0);
}

// 「本学期」口径提示：未配置时引导去学期设置
function renderTermHint(d) {
  const hint = $('lrTermHint');
  if (!hint) return;
  if (STATE.period !== 'term') { hint.classList.add('hidden'); hint.textContent = ''; return; }
  hint.classList.remove('hidden');
  if (d && d.termConfigured === false) {
    hint.className = 'lr-term-hint warn';
    hint.textContent = `⚠️ 请先设置当前学期的起止日期：当前「本学期」按默认口径统计（${d.termStart || '—'} ~ ${d.termEnd || '—'}）。管理员可在 系统管理 → 学年管理 → 学期设置 中配置。`;
  } else if (d && d.termStart) {
    hint.className = 'lr-term-hint';
    hint.textContent = `本学期统计区间：${d.termStart} ~ ${d.termEnd}（${d.termLabel || '来自学期设置'}）`;
  } else {
    hint.classList.add('hidden');
  }
}

// 请求序号：快速切换筛选（如同时改学科+时间）时，丢弃过期响应，避免旧数据覆盖新结果
let reqSeq = 0;

async function load() {
  const params = new URLSearchParams();
  params.set('period', STATE.period);
  if (STATE.subject) params.set('subject', STATE.subject);
  const seq = ++reqSeq;
  try {
    const d = await apiFetch('/api/performance/likes?' + params.toString());
    if (seq !== reqSeq) return;   // 已有更新的请求 → 丢弃本次结果
    renderRows(d.ranking);
    renderTermHint(d);
    const n = (d.ranking || []).length;
    if ($('lrCount')) {
      $('lrCount').textContent = n ? `共 ${n} 名同学获得点赞（按点赞次数从高到低排序）` : '';
    }
    if ($('lrScope')) $('lrScope').textContent = d.scopeLabel || '—';
    if ($('lrReadonly')) $('lrReadonly').textContent = d.isMonitor ? '（只读，不可修改）' : '';
  } catch (e) {
    if (seq !== reqSeq) return;
    renderRows([]);
    if ($('lrCount')) $('lrCount').textContent = '';
    showToast('加载失败：' + e.message, 3400);
  }
}

// ---------- 事件 ----------
if ($('lrSubject')) $('lrSubject').addEventListener('change', () => { STATE.subject = $('lrSubject').value; load(); });
if ($('lrPeriod')) $('lrPeriod').addEventListener('change', () => { STATE.period = $('lrPeriod').value; load(); });
if ($('btnBack')) $('btnBack').addEventListener('click', () => { window.location.href = '/dashboard'; });

// ---------- 初始化 ----------
(async function init() {
  try { if (window.DSHNavbar && window.DSHNavbar.ready) await window.DSHNavbar.ready; } catch (_) {}
  try {
    const opt = await apiFetch('/api/likes/options');
    STATE.subjects = opt.subjects || [];
    if ($('lrSubject')) {
      $('lrSubject').innerHTML = '<option value="">全部学科</option>' +
        STATE.subjects.map((s) => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
    }
    if ($('lrScope')) $('lrScope').textContent = opt.scopeLabel || '—';
    if ($('lrReadonly')) $('lrReadonly').textContent = opt.isMonitor ? '（只读，不可修改）' : '';
  } catch (e) {
    showToast('筛选项加载失败：' + e.message, 3400);
  }
  await load();
})();
