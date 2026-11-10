// ============================================================
// 巡堂巡查面板 API（数据统计 → 巡查面板）
//   权限：与巡堂记录一致（页面权限 inspection；管理员固定全部权限）
//   GET /api/inspection/stats/options            筛选项（时间快捷项 / 年级列表）
//   GET /api/inspection/stats/overview           统计卡片（总数 / 已解决 / 处理中 / 待处理 + 解决率）
//   GET /api/inspection/stats/class-ranking      班级问题排行（默认按问题数从少到多；支持列头排序）
//   GET /api/inspection/stats/trend              问题趋势（按周）
//   GET /api/inspection/stats/type-distribution  问题类型分布（饼图）
//   GET /api/inspection/stats/export             导出当前筛选结果（Excel）
//   筛选参数（各接口通用）：range=week|month|term|all|custom + startDate/endDate（custom 用）+ gradeId
// ============================================================
const express = require('express');
const XLSX = require('xlsx');
const pool = require('../db');
const { requireInspectionPage } = require('../lib/inspectionAccess');
const termLib = require('../lib/term');

const router = express.Router();

// 与巡堂记录保持一致的字典（标签口径统一）
const CATEGORY_LABEL = {
  hygiene: '卫生', discipline: '纪律', equipment: '设备', teaching: '教学', other: '其他',
};
const STATUS_LABEL = { pending: '待处理', processing: '处理中', resolved: '已解决' };
// 饼图固定展示的 6 类（教师行为/学生行为归为"其他"以外的扩展位，暂无数据时显示 0）
const PIE_CATEGORIES = ['hygiene', 'discipline', 'equipment', 'teaching', 'other'];
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// 把 range 解析成 [startDate, endDate]（本地日期字符串）
async function resolveRange(q) {
  const range = String(q.range || 'month');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const fmt = fmtDate;
  if (range === 'custom') {
    const s = String(q.startDate || '').trim();
    const e = String(q.endDate || '').trim();
    const ok = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x);
    return { range, startDate: ok(s) ? s : fmt(new Date(today.getFullYear(), today.getMonth(), 1)), endDate: ok(e) ? e : fmt(today) };
  }
  if (range === 'week') {
    const day = (today.getDay() + 6) % 7;             // 周一为一周开始
    const start = new Date(today); start.setDate(today.getDate() - day);
    return { range, startDate: fmt(start), endDate: fmt(today) };
  }
  if (range === 'term') {
    // 本学期：按「系统管理 → 学年管理 → 学期设置」配置的起止日期
    // 未配置时回退内置默认口径，并把 configured=false 透出给前端提示
    const t = await termLib.resolveTermRange(today);
    return {
      range, startDate: t.startDate, endDate: t.endDate,
      termConfigured: t.configured, termLabel: t.label, termSource: t.source,
    };
  }
  if (range === 'all') return { range, startDate: null, endDate: null };
  // 默认本月（1 号 ~ 今天）
  return { range: 'month', startDate: fmt(new Date(today.getFullYear(), today.getMonth(), 1)), endDate: fmt(today) };
}

// 组装 WHERE（日期 + 年级），返回 { sql, params }
async function buildFilter(q) {
  const r = await resolveRange(q);
  const where = [];
  const params = [];
  if (r.startDate) { params.push(r.startDate); where.push(`i.issue_date >= $${params.length}::date`); }
  if (r.endDate) { params.push(r.endDate); where.push(`i.issue_date <= $${params.length}::date`); }
  let gradeName = null;
  const gradeId = q.gradeId ? Number(q.gradeId) : null;
  if (gradeId && Number.isInteger(gradeId)) {
    const g = await pool.query('SELECT grade_name FROM grades WHERE id = $1', [gradeId]);
    if (g.rowCount > 0) {
      gradeName = g.rows[0].grade_name;
      params.push(gradeName);
      where.push(`c.grade = $${params.length}`);
    } else {
      // 年级不存在：显式返回空结果（而不是忽略筛选条件返回全量）
      where.push('FALSE');
      gradeName = null;
    }
  }
  return {
    range: r.range, startDate: r.startDate, endDate: r.endDate, gradeId: gradeId || null, gradeName,
    termConfigured: r.termConfigured === undefined ? null : r.termConfigured,
    termLabel: r.termLabel || null, termSource: r.termSource || null,
    whereSql: where.length ? ' WHERE ' + where.join(' AND ') : '', params,
  };
}

// 统一的"问题 + 班级"基表（年级筛选依赖 classes.grade）
const FROM_SQL = 'FROM inspection_issues i LEFT JOIN classes c ON c.id = i.class_id';

// ---------------- 筛选项 ----------------
router.get('/inspection/stats/options', requireInspectionPage, async (req, res, next) => {
  try {
    const grades = await pool.query('SELECT id, grade_name FROM grades ORDER BY sort_order, id');
    // 「本学期」口径来自学期设置：未配置时前端给提示
    const term = await termLib.resolveTermRange();
    res.json({
      ranges: [
        { key: 'week', label: '本周' },
        { key: 'month', label: '本月' },
        { key: 'term', label: '本学期' },
        { key: 'all', label: '全部' },
        { key: 'custom', label: '自定义' },
      ],
      term: {
        configured: term.configured,
        source: term.source,
        label: term.label,
        currentTerm: term.currentTerm,
        currentTermLabel: term.currentTermLabel,
        startDate: term.startDate,
        endDate: term.endDate,
      },
      termConfigured: term.configured,
      grades: grades.rows.map((r) => ({ id: r.id, gradeName: r.grade_name })),
      categories: Object.keys(CATEGORY_LABEL).map((k) => ({ key: k, label: CATEGORY_LABEL[k] })),
      statuses: Object.keys(STATUS_LABEL).map((k) => ({ key: k, label: STATUS_LABEL[k] })),
    });
  } catch (err) { next(err); }
});

// ---------------- 统计卡片 ----------------
router.get('/inspection/stats/overview', requireInspectionPage, async (req, res, next) => {
  try {
    const f = await buildFilter(req.query);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE i.status = 'resolved')::int AS resolved,
              count(*) FILTER (WHERE i.status = 'processing')::int AS processing,
              count(*) FILTER (WHERE i.status = 'pending')::int AS pending,
              count(DISTINCT i.class_id)::int AS class_count
         ${FROM_SQL} ${f.whereSql}`, f.params
    );
    const r0 = rows[0] || {};
    const total = r0.total || 0;
    res.json({
      filter: { range: f.range, startDate: f.startDate, endDate: f.endDate, gradeId: f.gradeId, gradeName: f.gradeName, termConfigured: f.termConfigured, termLabel: f.termLabel },
      total,
      resolved: r0.resolved || 0,
      processing: r0.processing || 0,
      pending: r0.pending || 0,
      classCount: r0.class_count || 0,
      resolveRate: total > 0 ? Math.round(((r0.resolved || 0) / total) * 1000) / 10 : 0,
    });
  } catch (err) { next(err); }
});

// ---------------- 班级问题排行 ----------------
// 默认：按问题数从少到多（问题最少的排最前）；支持 ?sort=total|resolved|pending|processing|rate|className&order=asc|desc
// 注意：排序表达式用聚合表达式（不能引用未 SELECT 的别名，否则 SQL 报错）
const RANK_ORDER_EXPR = {
  total: 'count(*)',
  resolved: "count(*) FILTER (WHERE i.status = 'resolved')",
  pending: "count(*) FILTER (WHERE i.status = 'pending')",
  processing: "count(*) FILTER (WHERE i.status = 'processing')",
  rate: "(count(*) FILTER (WHERE i.status = 'resolved'))::numeric / GREATEST(count(*), 1)",
  className: "COALESCE(c.class_name, '未指定班级')",
};
const RANK_SORT_KEYS = Object.keys(RANK_ORDER_EXPR);

router.get('/inspection/stats/class-ranking', requireInspectionPage, async (req, res, next) => {
  try {
    const f = await buildFilter(req.query);
    const rawSort = String(req.query.sort || 'total');
    const sortKey = RANK_SORT_KEYS.indexOf(rawSort) >= 0 ? rawSort : 'total';
    const order = String(req.query.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const expr = RANK_ORDER_EXPR[sortKey];
    // 排序二级键固定为班级名，保证同分顺序稳定
    const orderSql = sortKey === 'className'
      ? `${expr} ${order}`
      : `${expr} ${order}, COALESCE(c.class_name, '未指定班级') ASC`;
    const { rows } = await pool.query(
      `SELECT COALESCE(i.class_id, 0) AS class_id,
              COALESCE(c.class_name, '未指定班级') AS class_name,
              count(*)::int AS total,
              count(*) FILTER (WHERE i.status = 'resolved')::int AS resolved,
              count(*) FILTER (WHERE i.status = 'processing')::int AS processing,
              count(*) FILTER (WHERE i.status = 'pending')::int AS pending
         ${FROM_SQL} ${f.whereSql}
        GROUP BY COALESCE(i.class_id, 0), COALESCE(c.class_name, '未指定班级')
        ORDER BY ${orderSql}`, f.params
    );
    const ranking = rows.map((r, idx) => ({
      rank: idx + 1,
      classId: r.class_id || null,
      className: r.class_name,
      total: r.total,
      resolved: r.resolved,
      processing: r.processing,
      pending: r.pending,
      resolveRate: r.total > 0 ? Math.round((r.resolved / r.total) * 1000) / 10 : 0,
    }));
    res.json({
      filter: { range: f.range, startDate: f.startDate, endDate: f.endDate, gradeId: f.gradeId, gradeName: f.gradeName, termConfigured: f.termConfigured, termLabel: f.termLabel },
      sort: sortKey,
      order: order.toLowerCase(),
      ranking,
    });
  } catch (err) { next(err); }
});

// ---------------- 问题趋势（按周） ----------------
router.get('/inspection/stats/trend', requireInspectionPage, async (req, res, next) => {
  try {
    const f = await buildFilter(req.query);
    const { rows } = await pool.query(
      `SELECT date_trunc('week', i.issue_date)::date AS week_start,
              count(*)::int AS total,
              count(*) FILTER (WHERE i.status = 'resolved')::int AS resolved
         ${FROM_SQL} ${f.whereSql}
        GROUP BY week_start
        ORDER BY week_start`, f.params
    );
    const points = rows.map((r) => {
      const d = new Date(r.week_start);
      const end = new Date(d); end.setDate(d.getDate() + 6);
      return {
        weekStart: fmtDate(d),
        weekEnd: fmtDate(end),
        label: `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`,
        total: r.total,
        resolved: r.resolved,
      };
    });
    res.json({
      filter: { range: f.range, startDate: f.startDate, endDate: f.endDate, gradeId: f.gradeId, gradeName: f.gradeName, termConfigured: f.termConfigured, termLabel: f.termLabel },
      points,
    });
  } catch (err) { next(err); }
});

// ---------------- 问题类型分布（饼图） ----------------
router.get('/inspection/stats/type-distribution', requireInspectionPage, async (req, res, next) => {
  try {
    const f = await buildFilter(req.query);
    const { rows } = await pool.query(
      `SELECT i.category, count(*)::int AS total ${FROM_SQL} ${f.whereSql} GROUP BY i.category`, f.params
    );
    const map = {};
    rows.forEach((r) => { map[r.category] = r.total; });
    const total = rows.reduce((s, r) => s + r.total, 0);
    const items = PIE_CATEGORIES.map((k) => ({
      key: k,
      label: CATEGORY_LABEL[k],
      count: map[k] || 0,
      percent: total > 0 ? Math.round(((map[k] || 0) / total) * 1000) / 10 : 0,
    }));
    // 数据里出现字典外的类型也一并返回（避免统计口径丢数据）
    Object.keys(map).forEach((k) => {
      if (PIE_CATEGORIES.indexOf(k) < 0) {
        items.push({ key: k, label: CATEGORY_LABEL[k] || k, count: map[k], percent: total > 0 ? Math.round((map[k] / total) * 1000) / 10 : 0 });
      }
    });
    res.json({
      filter: { range: f.range, startDate: f.startDate, endDate: f.endDate, gradeId: f.gradeId, gradeName: f.gradeName, termConfigured: f.termConfigured, termLabel: f.termLabel },
      total,
      items,
    });
  } catch (err) { next(err); }
});

// ---------------- 导出 Excel（当前筛选结果） ----------------
router.get('/inspection/stats/export', requireInspectionPage, async (req, res, next) => {
  try {
    const f = await buildFilter(req.query);
    const { rows } = await pool.query(
      `SELECT i.id, i.issue_date, COALESCE(c.class_name, '未指定班级') AS class_name, c.grade,
              i.category, i.priority, i.status, i.description, i.created_by_name, i.created_at,
              (SELECT count(*)::int FROM inspection_photos ph WHERE ph.issue_id = i.id) AS photos,
              (SELECT count(*)::int FROM inspection_feedbacks fb WHERE fb.issue_id = i.id) AS feedbacks,
              (SELECT fb.solution FROM inspection_feedbacks fb WHERE fb.issue_id = i.id ORDER BY fb.created_at DESC, fb.id DESC LIMIT 1) AS last_solution,
              (SELECT fb.feedback_by_name FROM inspection_feedbacks fb WHERE fb.issue_id = i.id ORDER BY fb.created_at DESC, fb.id DESC LIMIT 1) AS last_feedback_by
         ${FROM_SQL} ${f.whereSql}
        ORDER BY i.issue_date DESC, i.id DESC`, f.params
    );
    const ov = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE i.status = 'resolved')::int AS resolved,
              count(*) FILTER (WHERE i.status = 'processing')::int AS processing,
              count(*) FILTER (WHERE i.status = 'pending')::int AS pending
         ${FROM_SQL} ${f.whereSql}`, f.params
    );
    const o = ov.rows[0] || { total: 0, resolved: 0, processing: 0, pending: 0 };
    const data = rows.map((r) => ({
      日期: r.issue_date instanceof Date ? fmtDate(r.issue_date) : String(r.issue_date).slice(0, 10),
      年级: r.grade || '',
      班级: r.class_name,
      问题类型: CATEGORY_LABEL[r.category] || r.category,
      紧急程度: r.priority === 'urgent' ? '紧急' : '普通',
      状态: STATUS_LABEL[r.status] || r.status,
      问题描述: r.description,
      照片数: r.photos,
      反馈条数: r.feedbacks,
      最近反馈人: r.last_feedback_by || '',
      最近解决方案: r.last_solution || '',
      记录人: r.created_by_name || '',
      记录时间: r.created_at ? String(r.created_at).slice(0, 19) : '',
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data.length ? data : [{ 提示: '当前筛选条件下没有巡堂问题' }]);
    XLSX.utils.book_append_sheet(wb, ws, '巡堂问题明细');
    // 第二个 sheet：统计汇总
    const summary = [
      { 项目: '筛选时间', 值: `${f.startDate || '不限'} ~ ${f.endDate || '不限'}` },
      { 项目: '年级', 值: f.gradeName || '全部' },
      { 项目: '问题总数', 值: o.total },
      { 项目: '已解决', 值: o.resolved },
      { 项目: '处理中', 值: o.processing },
      { 项目: '待处理', 值: o.pending },
      { 项目: '解决率', 值: (o.total > 0 ? Math.round((o.resolved / o.total) * 1000) / 10 : 0) + '%' },
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), '统计汇总');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fname = `巡查面板_${f.startDate || '不限'}_${f.endDate || '不限'}${f.gradeName ? '_' + f.gradeName : ''}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="inspection.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(buf);
  } catch (err) { next(err); }
});

router.use((err, req, res, next) => {
  console.error('[巡查面板错误]', err);
  res.status(500).json({ error: '服务器内部错误', detail: err && err.message });
});

module.exports = router;
