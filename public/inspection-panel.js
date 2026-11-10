// ============================================================
// 巡查面板（数据统计 → 巡查面板）
//   筛选（时间/年级）→ 统计卡片 → 班级问题排行（可点表头排序）
//   → 问题趋势折线图（按周）→ 问题类型分布饼图 → 导出 Excel
//   权限：与巡堂记录一致（页面权限 inspection）
// ============================================================
const $ = (id) => document.getElementById(id);
const { apiFetch, showToast, escapeHtml } = window.INSP;

const FILTER = { range: 'month', startDate: '', endDate: '', gradeId: '' };
const SORT = { key: 'total', order: 'asc' };   // 默认按问题数从少到多
let trendChart = null, typeChart = null;

function currentQuery() {
  const p = new URLSearchParams();
  p.set('range', FILTER.range);
  if (FILTER.range === 'custom') {
    if (FILTER.startDate) p.set('startDate', FILTER.startDate);
    if (FILTER.endDate) p.set('endDate', FILTER.endDate);
  }
  if (FILTER.gradeId) p.set('gradeId', FILTER.gradeId);
  return p;
}

function renderFilterNote(f) {
  const note = $('filterNote');
  if (!note || !f) return;
  const span = (f.startDate || f.endDate) ? `${f.startDate || '不限'} ~ ${f.endDate || '不限'}` : '全部时间';
  note.textContent = `统计范围：${span}${f.gradeName ? ' · ' + f.gradeName : ' · 全部年级'}`;
  // 「本学期」口径来自 系统管理 → 学年管理 → 学期设置；未配置时提示管理员去设置
  if (f.range === 'term') {
    if (f.termConfigured === false) {
      note.textContent += '｜⚠️ 请先设置当前学期的起止日期（当前按默认口径统计）';
      note.classList.add('warn');
    } else {
      if (f.termLabel) note.textContent += `｜${f.termLabel}`;
      note.classList.remove('warn');
    }
  } else {
    note.classList.remove('warn');
  }
}

// ---------------- 统计卡片 ----------------
async function loadOverview() {
  const d = await apiFetch('/api/inspection/stats/overview?' + currentQuery().toString());
  $('scTotal').textContent = d.total;
  $('scResolved').textContent = d.resolved;
  $('scProcessing').textContent = d.processing;
  $('scPending').textContent = d.pending;
  $('scTotalSub').textContent = `涉及 ${d.classCount} 个班级`;
  $('scResolvedSub').textContent = `解决率 ${d.resolveRate}%`;
  renderFilterNote(d.filter);
}

// ---------------- 班级排行 ----------------
function renderSortArrows() {
  document.querySelectorAll('.rank-table th.sortable').forEach((th) => {
    const arrow = th.querySelector('.arrow');
    if (!arrow) return;
    arrow.textContent = th.dataset.sort === SORT.key ? (SORT.order === 'asc' ? '▲' : '▼') : '';
  });
}

async function loadRanking() {
  const q = currentQuery();
  q.set('sort', SORT.key);
  q.set('order', SORT.order);
  const d = await apiFetch('/api/inspection/stats/class-ranking?' + q.toString());
  const rows = d.ranking || [];
  $('rankBody').innerHTML = rows.map((r) => `
    <tr data-class="${r.classId || ''}">
      <td>${r.rank}</td>
      <td>${escapeHtml(r.className)}</td>
      <td><b>${r.total}</b></td>
      <td style="color:#237804">${r.resolved}</td>
      <td style="color:${r.pending > 0 ? '#CF1322' : 'inherit'}">${r.pending}</td>
      <td><span class="rate-bar">${r.resolveRate}%</span></td>
    </tr>`).join('');
  $('rankEmpty').classList.toggle('hidden', rows.length > 0);
  renderSortArrows();
}

// ---------------- 趋势图 ----------------
const TREND_COLOR = '#4A90D9';
function renderTrend(points) {
  const canvas = $('trendChart');
  $('trendEmpty').classList.toggle('hidden', points.length > 0);
  if (trendChart) { trendChart.destroy(); trendChart = null; }
  if (!canvas || !window.Chart) return;
  trendChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: points.map((p) => p.label),
      datasets: [
        {
          label: '问题数',
          data: points.map((p) => p.total),
          borderColor: TREND_COLOR,
          backgroundColor: 'rgba(74,144,217,.14)',
          fill: true,
          tension: 0.32,
          pointRadius: 4,
          pointBackgroundColor: '#fff',
          pointBorderColor: TREND_COLOR,
          pointBorderWidth: 2,
        },
        {
          label: '已解决',
          data: points.map((p) => p.resolved),
          borderColor: '#52C41A',
          backgroundColor: 'rgba(82,196,26,.10)',
          fill: false,
          tension: 0.32,
          pointRadius: 3,
          borderDash: [5, 4],
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            title: (items) => {
              const p = points[items[0].dataIndex];
              return p ? `${p.weekStart} ~ ${p.weekEnd}` : '';
            },
          },
        },
      },
      scales: {
        x: { title: { display: true, text: '周次', font: { size: 12 } }, grid: { display: false } },
        y: { title: { display: true, text: '问题数', font: { size: 12 } }, beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
}

async function loadTrend() {
  const d = await apiFetch('/api/inspection/stats/trend?' + currentQuery().toString());
  LAST.trendPoints = d.points || [];
  renderTrend(LAST.trendPoints);
}

// ---------------- 类型分布饼图 ----------------
const TYPE_COLORS = ['#4A90D9', '#F5A623', '#8B5CF6', '#13C2C2', '#9AA3B0', '#EB5757', '#52C41A'];
function renderType(items, total) {
  const canvas = $('typeChart');
  const shown = items.filter((i) => i.count > 0);
  $('typeEmpty').classList.toggle('hidden', shown.length > 0);
  if (typeChart) { typeChart.destroy(); typeChart = null; }
  if (!canvas || !window.Chart) return;
  if (!shown.length) return;
  typeChart = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: shown.map((i) => `${i.label} ${i.count}（${i.percent}%）`),
      datasets: [{
        data: shown.map((i) => i.count),
        backgroundColor: shown.map((_, idx) => TYPE_COLORS[idx % TYPE_COLORS.length]),
        borderColor: '#fff',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '46%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const it = shown[ctx.dataIndex];
              return `${it.label}：${it.count} 条（${it.percent}%）`;
            },
          },
        },
      },
    },
  });
}

async function loadTypes() {
  const d = await apiFetch('/api/inspection/stats/type-distribution?' + currentQuery().toString());
  LAST.typeItems = d.items || [];
  renderType(LAST.typeItems, d.total || 0);
}

// ---------------- 导出 ----------------
function exportUrl() {
  return '/api/inspection/stats/export?' + currentQuery().toString();
}
function exportExcel() {
  window.location.href = exportUrl();
  showToast('正在导出当前筛选结果…');
}

// 最近一次加载的数据（渲染 + 供无头测试断言使用，不改变页面行为）
const LAST = { typeItems: [], trendPoints: [] };
window.__panel = {
  charts: () => ({ trend: trendChart, type: typeChart }),
  exportUrl,
  filter: () => Object.assign({}, FILTER),
  sort: () => Object.assign({}, SORT),
  typeItems: () => LAST.typeItems,
  trendPoints: () => LAST.trendPoints,
};

// ---------------- 事件 ----------------
async function refreshAll() {
  try {
    await Promise.all([loadOverview(), loadRanking(), loadTrend(), loadTypes()]);
  } catch (e) {
    showToast('加载失败：' + e.message, 3200);
  }
}

document.querySelectorAll('.rank-table th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (SORT.key === key) SORT.order = SORT.order === 'asc' ? 'desc' : 'asc';
    else { SORT.key = key; SORT.order = key === 'className' ? 'asc' : 'desc'; }
    loadRanking().catch((e) => showToast('排序失败：' + e.message, 3000));
  });
});

if ($('pRange')) {
  $('pRange').addEventListener('change', () => {
    FILTER.range = $('pRange').value;
    const custom = FILTER.range === 'custom';
    if ($('customWrap')) $('customWrap').style.display = custom ? 'inline-flex' : 'none';
    if (!custom) refreshAll();
  });
}
if ($('btnApply')) $('btnApply').addEventListener('click', () => {
  FILTER.range = $('pRange').value;
  FILTER.startDate = $('pStart') ? $('pStart').value : '';
  FILTER.endDate = $('pEnd') ? $('pEnd').value : '';
  FILTER.gradeId = $('pGrade') ? $('pGrade').value : '';
  refreshAll();
});
if ($('pGrade')) $('pGrade').addEventListener('change', () => { FILTER.gradeId = $('pGrade').value; refreshAll(); });
if ($('btnExport')) $('btnExport').addEventListener('click', exportExcel);
if ($('btnBack')) $('btnBack').addEventListener('click', () => { window.location.href = '/dashboard'; });

(async function init() {
  try { if (window.DSHNavbar && window.DSHNavbar.ready) await window.DSHNavbar.ready; } catch (_) {}
  let opt = null;
  try { opt = await apiFetch('/api/inspection/stats/options'); } catch (e) { showToast('筛选项加载失败：' + e.message, 3200); }
  if (opt) {
    const sel = $('pRange');
    if (sel) {
      sel.innerHTML = (opt.ranges || []).map((r) => `<option value="${r.key}">${escapeHtml(r.label)}</option>`).join('');
      sel.value = 'month';
    }
    const g = $('pGrade');
    if (g) g.innerHTML = '<option value="">全部</option>' + (opt.grades || []).map((x) => `<option value="${x.id}">${escapeHtml(x.gradeName)}</option>`).join('');
  }
  // 自定义时间默认今天
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  if ($('pStart') && !$('pStart').value) { $('pStart').value = iso.slice(0, 8) + '01'; }
  if ($('pEnd') && !$('pEnd').value) { $('pEnd').value = iso; }
  await refreshAll();
})();
