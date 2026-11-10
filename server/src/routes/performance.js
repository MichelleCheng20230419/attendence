// ============================================================
// 课堂表现 API（点名记录 + 点赞数据）
//   GET /api/performance/options   可查看范围（班级/学科/是否可导出）
//   GET /api/performance/records   点名记录（按角色限班级·学科）
//   GET /api/performance/likes     点赞排名（按角色限班级·学科）
//   GET /api/performance/export    导出 Excel（type=records|likes）
// 权限（与需求一致）：
//   班长    本班全部学科（仅查看，不可导出）
//   学科老师 本学科（可导出本学科）
//   班主任  本班全部学科（可导出本班）
//   管理员  全校全部学科（可导出全校）
//   学生    403
// ============================================================
const express = require('express');
const pool = require('../db');
const termLib = require('../lib/term');
const XLSX = require('xlsx');
const { SUBJECTS, SUBJECT_SET } = require('../subjects');

const router = express.Router();

function actorOf(req) { return (req.session && req.session.user) || null; }

// 加载当前用户可查看的范围
//   { isAdmin, isMonitor, isTeacher, classes: [{classId, className, role, subject}], scopeLabel }
//   classes = [] 表示没有任何可查看班级；isAdmin → classes 为全部班级
// 权限（按角色菜单矩阵）：管理员（全校）/ 班主任（本班全部学科）/ 任课老师（本学科）
//   班长 → 默认返回 null（课堂表现/点名记录不开放）；
//          仅"点赞排行榜"这类班长可见的只读接口传 { allowMonitor: true }，
//          此时班长范围 = 自己班（users.class_id）全部学科、只读、不可导出
//   学生 → 返回 null（上层返回 403）
async function loadScope(a, opts = {}) {
  if (a.role === 'admin') {
    const r = await pool.query('SELECT id, class_name, grade, grade_id FROM classes ORDER BY grade NULLS LAST, class_name');
    return {
      isAdmin: true,
      isMonitor: false,
      isTeacher: false,
      scopeLabel: '全校',
      classes: r.rows.map((x) => ({ classId: x.id, className: x.class_name, grade: x.grade || null, gradeId: x.grade_id || null, role: 'admin', subject: null })),
    };
  }
  if (a.role === 'monitor') {
    if (!opts.allowMonitor) return null;      // 班长默认不看课堂表现
    const me = await pool.query('SELECT class_id FROM users WHERE id = $1', [a.id]);
    const cid = (me.rows[0] && me.rows[0].class_id) || null;
    if (!cid) {
      return { isAdmin: false, isMonitor: true, isTeacher: false, mySubject: null, scopeLabel: '未绑定班级', classes: [] };
    }
    const c = await pool.query('SELECT id, class_name, grade, grade_id FROM classes WHERE id = $1', [cid]);
    const cls = c.rows[0];
    return {
      isAdmin: false,
      isMonitor: true,
      isTeacher: false,
      mySubject: null,                        // 班长：本班全部学科
      scopeLabel: `本班（${(cls && cls.class_name) || '班级 #' + cid}）`,
      classes: [{
        classId: cid,
        className: (cls && cls.class_name) || `班级 #${cid}`,
        grade: (cls && cls.grade) || null,
        gradeId: (cls && cls.grade_id) || null,
        role: 'monitor',
        subject: null,
      }],
    };
  }
  if (a.role !== 'teacher') return null;   // 学生：不可查看课堂表现
  if (a.role === 'teacher') {
    const me = await pool.query('SELECT subject FROM users WHERE id = $1', [a.id]);
    const mySubject = (me.rows[0] && me.rows[0].subject) || null;
    const tc = await pool.query(
      `SELECT tc.class_id,
              COALESCE(tc.role_in_class, CASE WHEN tc.is_head_teacher THEN 'head_teacher' ELSE 'subject_teacher' END) AS role_in_class,
              tc.subject, c.class_name, c.grade, c.grade_id
         FROM teacher_classes tc LEFT JOIN classes c ON c.id = tc.class_id
        WHERE tc.teacher_id = $1
        ORDER BY c.class_name NULLS LAST, tc.class_id`,
      [a.id]
    );
    const classes = tc.rows.map((x) => ({
      classId: x.class_id,
      className: x.class_name || `班级 #${x.class_id}`,
      grade: x.grade || null,
      gradeId: x.grade_id || null,
      role: x.role_in_class,
      // 班主任：不限学科；任课老师：该班所属学科（没设则用账号所教学科）
      subject: x.role_in_class === 'head_teacher' ? null : (x.subject || mySubject || null),
    }));
    const hasHead = classes.some((c) => c.role === 'head_teacher');
    return { isAdmin: false, isMonitor: false, isTeacher: true, mySubject, scopeLabel: hasHead ? '本班全部学科' : '本学科', classes };
  }
  return null;
}

// 解析多班级参数（年级联动筛选用）：classIds=1,2,3 → [1,2,3]
function parseClassIds(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return [...new Set(list.map((s) => Number(String(s).trim())).filter((n) => Number.isInteger(n) && n > 0))];
}

// 校验并解析请求的班级筛选（必须在范围内）
//   rawClassId：单个班级（classId 参数，优先）
//   rawClassIds：多个班级（classIds=1,2,3 —— 年级联动时"班级=全部班级"= 该年级全部可见班级）
function pickClass(scope, rawClassId, rawClassIds) {
  const all = scope.isAdmin;
  if (rawClassId === undefined || rawClassId === null || rawClassId === '') {
    const ids = parseClassIds(rawClassIds);
    if (ids.length) {
      if (all) return { classIds: ids };
      if (!ids.every((id) => scope.classes.some((c) => c.classId === id))) {
        return { error: '无权限：不在你的查看范围内', status: 403 };
      }
      return { classIds: ids };
    }
    if (all) return { classIds: null };                       // 全校
    if (scope.classes.length === 0) return { error: '当前账号未绑定班级', status: 400 };
    return { classIds: scope.classes.map((c) => c.classId) };
  }
  const cid = Number(rawClassId);
  if (!Number.isInteger(cid)) return { error: '班级参数无效', status: 400 };
  if (all) return { classIds: [cid] };
  if (!scope.classes.some((c) => c.classId === cid)) return { error: '无权限：不在你的查看范围内', status: 403 };
  return { classIds: [cid] };
}

// 组装"班级 + 学科"过滤条件（SQL 片段 + 参数）——教师在不同班级可能是班主任或任课老师
function scopeConditions(scope, classIds) {
  // 返回 { sql: '(...)', params: [...] }；sql 为 null 表示不限制
  const parts = [];
  const params = [];
  if (classIds) {
    params.push(classIds);
    parts.push(`r.class_id = ANY($${params.length}::int[])`);
  }
  if (!scope.isAdmin && !scope.isMonitor) {
    const per = [];
    for (const c of scope.classes) {
      if (classIds && !classIds.includes(c.classId)) continue;
      if (c.subject) {
        params.push(c.classId);
        params.push(c.subject);
        per.push(`(r.class_id = $${params.length - 1} AND r.subject = $${params.length})`);
      } else {
        params.push(c.classId);
        per.push(`r.class_id = $${params.length}`);
      }
    }
    parts.push(per.length ? '(' + per.join(' OR ') + ')' : 'FALSE');
  }
  return { sql: parts.length ? parts.join(' AND ') : null, params };
}

// 时间范围：date(单日) / from~to / period(week|month|term|all)
//   period=term（本学期）走「系统管理 → 学年管理 → 学期设置」配置的上下学期起止日期；
//   未配置时回退内置默认口径，并透出 termConfigured=false 供前端提示。
//   offset：调用方已占用的参数个数（scope/subject 先入参）——本函数生成的占位符必须接着编号，
//           否则 `$1` 会与前面的参数冲突（PostgreSQL 会把 class_id 当日期解析 → 500）。
async function resolveTime(q, offset = 0) {
  const date = String(q.date || '');
  const from = String(q.from || '');
  const to = String(q.to || '');
  const period = String(q.period || '');
  const conds = [];
  const params = [];
  let term = null;
  const P = (v) => { params.push(v); return offset + params.length; };   // 返回该参数的真实占位符序号
  const okDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (okDate(date)) {
    const i = P(date);
    conds.push(`r.created_at >= $${i}::date AND r.created_at < ($${i}::date + interval '1 day')`);
  } else if (okDate(from) || okDate(to)) {
    if (okDate(from)) conds.push(`r.created_at >= $${P(from)}::date`);
    if (okDate(to)) conds.push(`r.created_at < ($${P(to)}::date + interval '1 day')`);
  } else if (['week', 'month', 'term'].includes(period)) {
    if (period === 'week') conds.push("r.created_at >= date_trunc('week', now())");
    else if (period === 'month') conds.push("r.created_at >= date_trunc('month', now())");
    else {
      const t = await termLib.resolveTermRange();
      term = {
        termConfigured: t.configured,
        termSource: t.source,
        termLabel: t.label,
        termCurrent: t.currentTermLabel,
        termStart: t.startDate,
        termEnd: t.endDate,
      };
      if (t.startDate) conds.push(`r.created_at >= $${P(t.startDate)}::date`);
      if (t.endDate) conds.push(`r.created_at < ($${P(t.endDate)}::date + interval '1 day')`);
    }
  }
  return {
    sql: conds.length ? conds.join(' AND ') : null,
    params,
    label: date || period || (from || to ? `${from}~${to}` : 'all'),
    ...(term || {}),
  };
}

function seatLabel(row) {
  const r = row && row.seat_row;
  const c = row && row.seat_col;
  if (!Number.isInteger(r) || !Number.isInteger(c) || r <= 0 || c <= 0) return null;
  return `${r}排${c}座`;
}

function subjectFilter(q, scope) {
  const subject = String(q.subject || '').trim();
  if (subject && !SUBJECT_SET.has(subject)) return { error: '学科参数无效', status: 400 };
  return { subject: subject || null };
}

// ------------------------------------------------------------
// GET /api/performance/options —— 可查看范围（供页面初始化筛选）
// ------------------------------------------------------------
router.get('/performance/options', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    const scope = await loadScope(a);
    if (!scope) return res.status(403).json({ error: '无权限：仅管理员/班主任/任课老师可查看课堂表现' });
    // 各班可用学科（班主任/管理员/班长=全部学科；任课老师=自己所教学科）
    const classes = scope.classes.map((c) => ({
      classId: c.classId,
      className: c.className,
      grade: c.grade,
      gradeId: c.gradeId || null,
      role: c.role,
      subjects: c.subject ? [c.subject] : SUBJECTS.slice(),
    }));
    res.json({
      role: a.role,
      scopeLabel: scope.scopeLabel,
      isAdmin: scope.isAdmin,
      isMonitor: scope.isMonitor,
      isTeacher: scope.isTeacher,
      canExport: !scope.isMonitor,            // 班长不可导出
      subjects: SUBJECTS,
      mySubject: scope.mySubject || null,
      classes,
    });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------
// GET /api/performance/records —— 点名记录
// ------------------------------------------------------------
router.get('/performance/records', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    const scope = await loadScope(a);
    if (!scope) return res.status(403).json({ error: '无权限：仅管理员/班主任/任课老师可查看点名记录' });
    const pc = pickClass(scope, req.query.classId, req.query.classIds);
    if (pc.error) return res.status(pc.status).json({ error: pc.error });
    const sf = subjectFilter(req.query, scope);
    if (sf.error) return res.status(sf.status).json({ error: sf.error });

    const conds = [];
    const params = [];
    const sc = scopeConditions(scope, pc.classIds);
    if (sc.sql) { conds.push(sc.sql); params.push(...sc.params); }
    if (sf.subject) { params.push(sf.subject); conds.push(`r.subject = $${params.length}`); }
    const tm = await resolveTime(req.query, params.length);
    if (tm.sql) { conds.push(tm.sql); params.push(...tm.params); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);

    const rows = await pool.query(
      `SELECT r.id, r.created_at, r.scope, r.subject, r.picked_by_name, r.class_id,
              s.student_no, s.name, s.seat_row, s.seat_col, c.class_name
         FROM rollcall_records r
         LEFT JOIN students s ON s.id = r.student_id
         LEFT JOIN classes c ON c.id = r.class_id
         ${where}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${limit}`,
      params
    );
    const total = await pool.query(`SELECT count(*)::int AS n FROM rollcall_records r ${where}`, params);
    res.json({
      scopeLabel: scope.scopeLabel,
      total: total.rows[0].n,
      range: tm.label,
      termConfigured: tm.termConfigured === undefined ? null : tm.termConfigured,
      termLabel: tm.termLabel || null,
      termStart: tm.termStart || null,
      termEnd: tm.termEnd || null,
      records: rows.rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        classId: r.class_id,
        className: r.class_name,
        subject: r.subject || null,
        studentNo: r.student_no,
        name: r.name,
        seatLabel: seatLabel(r),
        scopeLabel: r.scope === 'absent' ? '仅未签到' : '全班',
        operatorName: r.picked_by_name,
      })),
    });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------
// GET /api/likes/options —— 点赞排行榜筛选项
//   **仅班长**（该页面只对班长开放；老师/班主任/管理员的点赞排名走「课堂表现」）
//   返回：{ subjects, scopeLabel, isMonitor, className, classId, canExport }
// ------------------------------------------------------------
router.get('/likes/options', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (a.role !== 'monitor') return res.status(403).json({ error: '无权限：点赞排行榜仅班长端可见（老师请用「课堂表现」）' });
    const scope = await loadScope(a, { allowMonitor: true });
    if (!scope) return res.status(403).json({ error: '无权限查看点赞排行榜' });
    const first = scope.classes[0] || null;
    res.json({
      role: a.role,
      isMonitor: !!scope.isMonitor,
      isAdmin: !!scope.isAdmin,
      isTeacher: !!scope.isTeacher,
      scopeLabel: scope.scopeLabel,
      canExport: false,                  // 点赞排行榜：班长端只读，不提供导出
      subjects: SUBJECTS,
      classId: first ? first.classId : null,
      className: first ? first.className : null,
    });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------
// GET /api/performance/likes —— 点赞排名
//   班长（allowMonitor）→ 仅本班、全部学科、只读；教师/管理员同课堂表现口径
// ------------------------------------------------------------
router.get('/performance/likes', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    const scope = await loadScope(a, { allowMonitor: true });
    if (!scope) return res.status(403).json({ error: '无权限：仅管理员/班主任/任课老师/班长可查看点赞数据' });
    const pc = pickClass(scope, req.query.classId, req.query.classIds);
    if (pc.error) return res.status(pc.status).json({ error: pc.error });
    const sf = subjectFilter(req.query, scope);
    if (sf.error) return res.status(sf.status).json({ error: sf.error });

    const conds = [];
    const params = [];
    const sc = scopeConditions(scope, pc.classIds);
    if (sc.sql) { conds.push(sc.sql); params.push(...sc.params); }
    if (sf.subject) { params.push(sf.subject); conds.push(`r.subject = $${params.length}`); }
    const tm = await resolveTime(req.query, params.length);
    if (tm.sql) { conds.push(tm.sql); params.push(...tm.params); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const rows = await pool.query(
      `SELECT r.student_id, s.student_no, s.name, s.seat_row, s.seat_col,
              SUM(r.like_count)::int AS likes,
              count(*)::int AS times,
              max(r.created_at) AS last_at
         FROM student_likes r
         LEFT JOIN students s ON s.id = r.student_id
         ${where}
        GROUP BY r.student_id, s.student_no, s.name, s.seat_row, s.seat_col
        ORDER BY likes DESC, s.student_no ASC
        LIMIT 200`,
      params
    );
    res.json({
      scopeLabel: scope.scopeLabel,
      range: tm.label,
      termConfigured: tm.termConfigured === undefined ? null : tm.termConfigured,
      termLabel: tm.termLabel || null,
      termStart: tm.termStart || null,
      termEnd: tm.termEnd || null,
      ranking: rows.rows.map((r, i) => ({
        rank: i + 1,
        studentId: r.student_id,
        studentNo: r.student_no,
        name: r.name,
        seatLabel: seatLabel(r),
        likes: r.likes,
        times: r.times,
        lastAt: r.last_at,
      })),
      // 班长端（只读）标识与范围，便于前端展示"本班（只读）"
      isMonitor: !!scope.isMonitor,
      mySubject: scope.mySubject || null,
      className: (scope.classes[0] && scope.classes[0].className) || null,
    });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------
// GET /api/performance/export?type=records|likes —— 导出 Excel
// ------------------------------------------------------------
router.get('/performance/export', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    const scope = await loadScope(a);
    if (!scope) return res.status(403).json({ error: '无权限：仅管理员/班主任/任课老师可导出' });
    if (scope.isMonitor) return res.status(403).json({ error: '无权限：班长不可导出（请老师导出）' });
    const type = String(req.query.type || 'records') === 'likes' ? 'likes' : 'records';

    const pc = pickClass(scope, req.query.classId, req.query.classIds);
    if (pc.error) return res.status(pc.status).json({ error: pc.error });
    const sf = subjectFilter(req.query, scope);
    if (sf.error) return res.status(sf.status).json({ error: sf.error });

    const conds = [];
    const params = [];
    const sc = scopeConditions(scope, pc.classIds);
    if (sc.sql) { conds.push(sc.sql); params.push(...sc.params); }
    if (sf.subject) { params.push(sf.subject); conds.push(`r.subject = $${params.length}`); }
    // 时间条件放在 scope/subject 之后，并接着已有的参数编号（offset）
    const tm = await resolveTime(req.query, params.length);
    if (tm.sql) { conds.push(tm.sql); params.push(...tm.params); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const fmt = (d) => {
      const x = new Date(d);
      const z = (n) => String(n).padStart(2, '0');
      return `${x.getFullYear()}-${z(x.getMonth() + 1)}-${z(x.getDate())} ${z(x.getHours())}:${z(x.getMinutes())}`;
    };

    let data = [];
    let sheetName = '点名记录';
    if (type === 'records') {
      const rows = await pool.query(
        `SELECT r.created_at, r.subject, r.picked_by_name, c.class_name, s.student_no, s.name, s.seat_row, s.seat_col, r.scope
           FROM rollcall_records r
           LEFT JOIN students s ON s.id = r.student_id
           LEFT JOIN classes c ON c.id = r.class_id
           ${where}
          ORDER BY r.created_at DESC, r.id DESC LIMIT 5000`,
        params
      );
      if (rows.rowCount === 0) return res.status(404).json({ error: '没有可导出的点名记录' });
      data = rows.rows.map((r) => ({
        时间: fmt(r.created_at),
        班级: r.class_name || '',
        学科: r.subject || '未标学科',
        学号: r.student_no || '',
        姓名: r.name || '',
        座位: seatLabel(r) || '未排座',
        点名范围: r.scope === 'absent' ? '仅未签到' : '全班',
        操作人: r.picked_by_name || '',
      }));
    } else {
      sheetName = '点赞数据';
      const rows = await pool.query(
        `SELECT r.student_id, s.student_no, s.name, s.seat_row, s.seat_col,
                SUM(r.like_count)::int AS likes, count(*)::int AS times
           FROM student_likes r
           LEFT JOIN students s ON s.id = r.student_id
           ${where}
          GROUP BY r.student_id, s.student_no, s.name, s.seat_row, s.seat_col
          ORDER BY likes DESC, s.student_no ASC LIMIT 5000`,
        params
      );
      if (rows.rowCount === 0) return res.status(404).json({ error: '没有可导出的点赞数据' });
      data = rows.rows.map((r, i) => ({
        排名: i + 1,
        学号: r.student_no || '',
        姓名: r.name || '',
        座位: seatLabel(r) || '未排座',
        点赞次数: r.likes,
        点赞场次: r.times,
      }));
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = Object.keys(data[0] || { a: 1 }).map(() => ({ wch: 14 }));
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const clsName = pc.classIds && pc.classIds.length === 1
      ? (scope.classes.find((c) => c.classId === pc.classIds[0]) || {}).className || ''
      : (scope.isAdmin ? '全校' : '所带班级');
    const fn = `课堂表现_${type === 'likes' ? '点赞数据' : '点名记录'}_${clsName}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fn)}`);
    res.send(buf);
  } catch (err) { next(err); }
});

module.exports = router;
