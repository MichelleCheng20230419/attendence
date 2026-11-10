// 考勤分析中心 API
// 按角色与筛选（年级/班级/时间）计算统计数据
// 另含「搜索学生」：GET /api/attendance/student/search + /api/attendance/student/:id/detail
//
// 统计口径（v2.8.0，按场次汇总）：
//   · 每场签到独立存储（attendance_sessions + attendance_records.session_id）
//   · 应到人次  = 所选时间段内场次数 × 在读学生数（每场每人应签到 1 次）
//   · 实到人次  = 实际签到记录数（present + late）
//   · 请假人次  = 请假记录数（leave）
//   · 缺勤人次  = 应到 − 实到 − 请假（>=0）
//   · 同一天多场次各自独立计入（不按天去重，多场数据全部保留）
// 一致性约束：实到 + 请假 <= 应到；统计卡片 = 各班级/年级明细汇总
const express = require('express');
const pool = require('../db');

const router = express.Router();

function fmtDateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 解析时间范围（YYYY-MM-DD，<=366天）
function parseRange(q) {
  const start = String(q.startDate || '');
  const end = String(q.endDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    const err = new Error('日期格式应为 YYYY-MM-DD');
    err.status = 400;
    throw err;
  }
  const startTs = new Date(start + 'T00:00:00');
  const endTs = new Date(end + 'T23:59:59.999');
  if (isNaN(startTs.getTime()) || startTs > endTs) {
    const err = new Error('日期范围无效（开始日期不能晚于结束日期）');
    err.status = 400;
    throw err;
  }
  if (Math.round((endTs - startTs) / 86400000) > 366) {
    const err = new Error('分析范围不能超过 366 天');
    err.status = 400;
    throw err;
  }
  return { start: startTs, end: endTs };
}

// 解析数据范围（角色权限 + 年级/班级筛选）
async function resolveScope(req) {
  const role = req.session.user.role;
  // 角色校验必须前置：班长（叫号提醒+随机点名）与学生不可查看考勤分析
  // （否则会先因缺少日期参数返回 400，掩盖权限判定）
  if (role === 'student' || role === 'monitor') {
    const err = new Error(role === 'monitor'
      ? '无权限：班长不可查看考勤分析（请老师查看）'
      : '学生个人考勤视图开发中，暂不可用');
    err.status = 403;
    throw err;
  }
  const range = parseRange(req.query);
  if (role === 'teacher') {
    const u = await pool.query('SELECT class_id FROM users WHERE id = $1', [req.session.user.id]);
    const classId = u.rows[0] && u.rows[0].class_id;
    if (!classId) {
      const err = new Error('当前教师账号未绑定班级');
      err.status = 400;
      throw err;
    }
    return { ...range, role, classIds: [classId], grade: null, includeNonEnrolled: req.query.includeNonEnrolled === '1' ? '1' : '0' };
  }
  // admin：按年级/班级筛选（缺省=全部）
  let classIds = null;
  if (req.query.classId) {
    classIds = [Number(req.query.classId)];
    if (!Number.isInteger(classIds[0])) {
      const err = new Error('班级参数无效');
      err.status = 400;
      throw err;
    }
  }
  const grade = req.query.grade ? String(req.query.grade) : null;
  const includeNonEnrolled = req.query.includeNonEnrolled === '1' ? '1' : '0';
  return { ...range, role, classIds, grade, includeNonEnrolled };
}

// 加载范围内场次 / 学生 / 记录
// 只统计已结束的签到场次（status = 'closed'）：
//   · 进行中（active）与未触发（pending/未来）场次不计入
//   · 范围结束时间取 min(用户选择的结束时间, 当前时间)，未来场次不计入
// 场次归属（v33 / 方案 A）：唯一真源 = attendance_sessions.class_id
//   · class_id IS NULL → 全校场次（历史"全部班级"计划 / 管理员发起）→ 所有班级都算
//   · class_id = 本班   → 只有该班算
//   （此前从"来源计划"推导归属，导致手工发起的全校场次被算给每个班、
//     且"全部班级"计划的多班场次无法区分——统一改为直接读 class_id）
async function loadData(scope) {
  const now = new Date();
  const end = scope.end > now ? now : scope.end;

  // 归属班级集合：显式班级筛选 > 年级 > 未筛选（全部班级，不做限制）
  let ownClassIds = null;
  if (scope.classIds && scope.classIds.length) {
    ownClassIds = scope.classIds.slice();
  } else if (scope.grade) {
    const g = await pool.query('SELECT id FROM classes WHERE grade = $1', [scope.grade]);
    ownClassIds = g.rows.map((r) => r.id);
  }

  const sp = [scope.start, end];
  let sessionWhere = `s.start_time >= $1 AND s.start_time <= $2
          AND s.start_time <= now()
          AND s.status = 'closed'`;
  if (ownClassIds !== null) {
    sp.push(ownClassIds);
    sessionWhere += `
          AND (s.class_id IS NULL OR s.class_id = ANY($${sp.length}::int[]))`;
  }
  const sessions = (
    await pool.query(
      `SELECT s.id, s.start_time, s.slot, s.auto_generated FROM attendance_sessions s
        WHERE ${sessionWhere}
        ORDER BY s.start_time`,
      sp
    )
  ).rows;

  const p = [];
  let sql = 'SELECT id FROM students WHERE is_active = true';
  if (scope.includeNonEnrolled !== '1') {
    sql += " AND status = '在读'";
  }
  if (scope.classIds && scope.classIds.length) {
    p.push(scope.classIds);
    sql += ` AND class_id = ANY($${p.length})`;
  }
  if (scope.grade) {
    p.push(scope.grade);
    sql += ` AND class_id IN (SELECT id FROM classes WHERE grade = $${p.length})`;
  }
  const students = (await pool.query(sql, p)).rows.map((r) => r.id);

  let recs = [];
  if (sessions.length && students.length) {
    recs = (
      await pool.query(
        `SELECT session_id, student_id, status, leave_reason
           FROM attendance_records
          WHERE session_id = ANY($1) AND student_id = ANY($2)`,
        [sessions.map((s) => s.id), students]
      )
    ).rows;
  }
  // 本班有记录的场次 / 无任何记录的场次（无记录 = 该场本班未录入签到）
  const withRecords = new Set(recs.map((r) => r.session_id));
  const missingSessions = sessions.filter((s) => !withRecords.has(s.id));
  return { sessions, students, recs, missingSessions };
}

// 按状态统计记录数（每场每学生最多一条，UNIQUE 约束保证）
function countRecs(recs) {
  let present = 0, late = 0, leave = 0;
  for (const r of recs) {
    if (r.status === 'present') present += 1;
    else if (r.status === 'late') late += 1;
    else if (r.status === 'leave') leave += 1;
  }
  return { present, late, leave, attended: present + late };
}

// 请假人次的事由构成（病假/事假/公假），用于"请假人数和类型"展示
function countLeaveReasons(recs) {
  const byReason = { sick: 0, personal: 0, official: 0, unknown: 0 };
  for (const r of recs) {
    if (r.status !== 'leave') continue;
    if (r.leave_reason && byReason[r.leave_reason] !== undefined) byReason[r.leave_reason] += 1;
    else byReason.unknown += 1;
  }
  return byReason;
}

function rateOf(attended, expected) {
  return expected > 0 ? Math.round((attended / expected) * 1000) / 10 : null;
}

// 校验并修正：实到 + 请假 不得超过 应到（钳制到上限，避免异常数据展示）
function clampAttend(expected, attended, leave) {
  let warning = false;
  if (attended + leave > expected) {
    warning = true;
    if (leave > expected) leave = expected;
    attended = expected - leave;
  }
  return { attended, leave, absent: expected - attended - leave, warning };
}

// GET /api/attendance/analysis/overview —— 统计卡片
router.get('/attendance/analysis/overview', async (req, res, next) => {
  try {
    const scope = await resolveScope(req);
    const { sessions, students, recs, missingSessions } = await loadData(scope);
    const expected = sessions.length * students.length;
    const c = countRecs(recs);
    const fixed = clampAttend(expected, c.attended, c.leave);
    const fmtHM = (d) => {
      const x = new Date(d);
      const p2 = (n) => String(n).padStart(2, '0');
      return `${p2(x.getMonth() + 1)}-${p2(x.getDate())} ${p2(x.getHours())}:${p2(x.getMinutes())}`;
    };
    res.json({
      totalSessions: sessions.length,
      totalDays: new Set(sessions.map((s) => fmtDateKey(new Date(s.start_time)))).size,
      totalStudents: students.length,
      expected,
      attended: fixed.attended,
      leave: fixed.leave,
      absent: fixed.absent,
      rate: rateOf(fixed.attended, expected),
      warning: fixed.warning,
      // 请假构成（病假/事假/公假）——前端展示"请假人数和类型"
      leaveByReason: countLeaveReasons(recs),
      // 本班无签到记录的场次（已按应到计入，但该场本班未录入）——前端据此提示
      sessionsWithRecords: sessions.length - missingSessions.length,
      sessionsWithoutRecords: missingSessions.length,
      // 每天自动签到（v35）：其中有多少场是"早/晚自动生成"的（前端说明"一天两场各计 1 次"）
      autoSessionCount: sessions.filter((s) => s.auto_generated === true).length,
      missingSessions: missingSessions.slice(0, 20).map((s) => ({
        sessionId: s.id,
        at: fmtHM(s.start_time),
        // 每天自动签到（v35）：两场的 start_time 都是生成时刻 → 用时段名区分（早自习/晚自修）
        slot: s.slot || null,
        slotLabel: s.slot === 'morning' ? '早自习' : (s.slot === 'evening' ? '晚自修' : null),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance/analysis/trend —— 出勤率趋势（按天；当天多场合并统计）
router.get('/attendance/analysis/trend', async (req, res, next) => {
  try {
    const scope = await resolveScope(req);
    const { sessions, students, recs } = await loadData(scope);

    const byDate = new Map();
    const sessionDate = {};
    for (const s of sessions) {
      const d = fmtDateKey(new Date(s.start_time));
      sessionDate[s.id] = d;
      if (!byDate.has(d)) byDate.set(d, { expected: 0, attended: 0, leave: 0 });
      byDate.get(d).expected += students.length; // 每场每人 1 次
    }
    for (const r of recs) {
      const d = sessionDate[r.session_id];
      const item = byDate.get(d);
      if (!item) continue;
      if (r.status === 'present' || r.status === 'late') item.attended += 1;
      else if (r.status === 'leave') item.leave += 1;
    }
    const points = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => {
        const fixed = clampAttend(v.expected, v.attended, v.leave);
        return { date, expected: v.expected, attended: fixed.attended, rate: rateOf(fixed.attended, v.expected) };
      });
    res.json({ points });
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance/analysis/ranking —— 班级排行榜 / 班级明细（管理员）
router.get('/attendance/analysis/ranking', async (req, res, next) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: '无权限：仅管理员可查看班级排行榜' });
    }
    const scope = await resolveScope(req);
    const { sessions, students, recs } = await loadData(scope);

    // 学生 → 当前班级（未分班为 null）
    const stuClasses = (
      await pool.query('SELECT id, class_id FROM students WHERE id = ANY($1)', [students])
    ).rows.reduce((m, r) => { m[r.id] = r.class_id; return m; }, {});

    const classes = (
      await pool.query('SELECT id, class_name, grade FROM classes ORDER BY id')
    ).rows;

    // 班级在读学生数（与应到同口径：仅 status=在读）
    const cnt = (
      await pool.query(
        "SELECT class_id, count(*)::int AS n FROM students WHERE is_active = true AND status = '在读' GROUP BY class_id"
      )
    ).rows.reduce((m, r) => { m[r.class_id] = r.n; return m; }, {});

    // 应到：每班在读学生 × 场次数；实到/请假：按记录数归集
    const agg = {};
    for (const sid of students) {
      const cid = stuClasses[sid] ?? null;
      if (!agg[cid]) agg[cid] = { expected: 0, attended: 0, leave: 0 };
      agg[cid].expected += sessions.length;
    }
    for (const r of recs) {
      const cid = stuClasses[r.student_id] ?? null;
      const a = agg[cid];
      if (!a) continue;
      if (r.status === 'present' || r.status === 'late') a.attended += 1;
      else if (r.status === 'leave') a.leave += 1;
    }

    const makeRow = (cid, className, grade) => {
      const a = agg[cid] || { expected: 0, attended: 0, leave: 0 };
      const fixed = clampAttend(a.expected, a.attended, a.leave);
      return {
        classId: cid,
        className,
        grade,
        studentCount: cnt[cid] || 0,
        expected: a.expected,
        attended: fixed.attended,
        leave: fixed.leave,
        absent: fixed.absent,
        rate: rateOf(fixed.attended, a.expected),
        warning: fixed.warning,
      };
    };

    const rows = classes
      .filter((c) => (scope.grade ? c.grade === scope.grade : true))
      .map((c) => makeRow(c.id, c.class_name, c.grade));
    if (agg[null] && agg[null].expected > 0) {
      rows.push(makeRow(null, '未分班', null));
    }
    rows.sort((x, y) => (y.rate === null ? -1 : y.rate) - (x.rate === null ? -1 : x.rate));
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance/analysis/grade-compare —— 年级对比（管理员）
router.get('/attendance/analysis/grade-compare', async (req, res, next) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: '无权限：仅管理员可查看年级对比' });
    }
    const scope = await resolveScope(req);
    const { sessions, students, recs } = await loadData(scope);

    const stuGrades = (
      await pool.query('SELECT s.id, c.grade FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ANY($1)', [students])
    ).rows.reduce((m, r) => { m[r.id] = r.grade; return m; }, {});

    const grades = [...new Set(Object.values(stuGrades).filter(Boolean))];
    const agg = {};
    for (const g of grades) agg[g] = { expected: 0, attended: 0 };
    for (const sid of students) {
      const g = stuGrades[sid];
      if (agg[g]) agg[g].expected += sessions.length;
    }
    for (const r of recs) {
      const g = stuGrades[r.student_id];
      const a = agg[g];
      if (!a) continue;
      if (r.status === 'present' || r.status === 'late') a.attended += 1;
    }
    const rows = grades.map((g) => {
      const fixed = clampAttend(agg[g].expected, agg[g].attended, 0);
      return { grade: g, expected: agg[g].expected, attended: fixed.attended, rate: rateOf(fixed.attended, agg[g].expected) };
    });
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/attendance/analysis/student-detail —— 学生个人明细（教师/管理员）
router.get('/attendance/analysis/student-detail', async (req, res, next) => {
  try {
    const scope = await resolveScope(req);
    if (scope.classIds === null || scope.classIds.length !== 1) {
      return res.status(400).json({ error: '请选择一个具体班级查看学生明细' });
    }
    const { sessions, students, recs } = await loadData(scope);
    const expected = sessions.length;

    const map = {};
    for (const sid of students) map[sid] = { attended: 0, leave: 0 };
    for (const r of recs) {
      const m = map[r.student_id];
      if (!m) continue;
      if (r.status === 'present' || r.status === 'late') m.attended += 1;
      else if (r.status === 'leave') m.leave += 1;
    }
    const names = (
      await pool.query(
        'SELECT id, student_no, name FROM students WHERE id = ANY($1)',
        [students]
      )
    ).rows.reduce((m, r) => { m[r.id] = r; return m; }, {});

    const rows = students.map((sid) => {
      const m = map[sid] || { attended: 0, leave: 0 };
      const fixed = clampAttend(expected, m.attended, m.leave);
      const st = names[sid];
      return {
        studentNo: st ? st.student_no : '',
        name: st ? st.name : '',
        expected,
        attended: fixed.attended,
        leave: fixed.leave,
        absent: fixed.absent,
        rate: rateOf(fixed.attended, expected),
      };
    });
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 学生搜索 + 学生考勤详情（考勤分析面板「搜索学生」）
//   GET /api/attendance/student/search?keyword=&classId=&grade=&includeNonEnrolled=
//   GET /api/attendance/student/:id/detail?startDate=&endDate=
//   模糊搜索姓名/学号；详情口径与班级统计完全一致（见文件头）：
//     应到 = 该生所在班在时间段内应参加的场次数（场次归属规则同 loadData）
//     实到 = present + late；请假 = leave；缺勤 = 应到 − 实到 − 请假
//   权限：与考勤分析一致（管理员 / 教师；教师仅本班；班长与学生 403）
// ============================================================
function denyAnalysis(role) {
  const err = new Error(role === 'monitor'
    ? '无权限：班长不可查看考勤分析（请老师查看）'
    : '学生个人考勤视图开发中，暂不可用');
  err.status = 403;
  return err;
}

function fmtDateKeyOf(d) { return fmtDateKey(new Date(d)); }
function fmtHMS(d) {
  const x = new Date(d);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(x.getHours())}:${p2(x.getMinutes())}:${p2(x.getSeconds())}`;
}
const REC_STATUS_LABEL = { present: '已签到', late: '迟到', leave: '请假', absent: '缺勤' };

// GET /api/attendance/student/search —— 按姓名/学号模糊搜索学生
router.get('/attendance/student/search', async (req, res, next) => {
  try {
    const role = req.session.user.role;
    if (role === 'student' || role === 'monitor') throw denyAnalysis(role);
    const keyword = String(req.query.keyword || '').trim();
    if (!keyword) { const e = new Error('请输入学生姓名或学号'); e.status = 400; throw e; }
    if (keyword.length > 50) { const e = new Error('搜索关键词过长（最多 50 字）'); e.status = 400; throw e; }

    const p = [keyword];                 // $1 = 原样关键词（精确匹配优先）
    p.push(`%${keyword}%`);              // $2 = 模糊匹配
    const where = ['s.is_active = true', `(s.name ILIKE $2 OR s.student_no ILIKE $2)`];

    if (role === 'teacher') {
      const u = await pool.query('SELECT class_id FROM users WHERE id = $1', [req.session.user.id]);
      const cid = (u.rows[0] && u.rows[0].class_id) || null;
      if (!cid) { const e = new Error('当前教师账号未绑定班级'); e.status = 400; throw e; }
      p.push(cid);
      where.push(`s.class_id = $${p.length}`);
    } else {
      if (req.query.classId) {
        const cid = Number(req.query.classId);
        if (!Number.isInteger(cid)) { const e = new Error('班级参数无效'); e.status = 400; throw e; }
        p.push(cid);
        where.push(`s.class_id = $${p.length}`);
      }
      if (req.query.grade) { p.push(String(req.query.grade)); where.push(`c.grade = $${p.length}`); }
    }
    // 与班级统计同口径：默认只看在读学生（勾选"包含非在读"后放开）
    if (req.query.includeNonEnrolled !== '1') where.push(`s.status = '在读'`);

    const rows = (
      await pool.query(
        `SELECT s.id, s.student_no, s.name, s.status, s.class_id, c.class_name, c.grade
           FROM students s LEFT JOIN classes c ON c.id = s.class_id
          WHERE ${where.join(' AND ')}
          ORDER BY (s.name = $1) DESC, (s.student_no = $1) DESC, s.class_id NULLS LAST, s.name, s.student_no
          LIMIT 50`,
        p
      )
    ).rows;

    res.json({
      keyword,
      total: rows.length,
      students: rows.map((r) => ({
        id: r.id,
        studentNo: r.student_no,
        name: r.name,
        status: r.status,
        classId: r.class_id,
        className: r.class_name || '未分班',
        grade: r.grade || null,
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/attendance/student/:id/detail —— 单个学生的考勤统计 + 签到记录明细
router.get('/attendance/student/:id/detail', async (req, res, next) => {
  try {
    const role = req.session.user.role;
    if (role === 'student' || role === 'monitor') throw denyAnalysis(role);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { const e = new Error('学生参数无效'); e.status = 400; throw e; }

    const stu = (
      await pool.query(
        `SELECT s.id, s.student_no, s.name, s.status, s.class_id, c.class_name, c.grade
           FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.id = $1`,
        [id]
      )
    ).rows[0];
    if (!stu) { const e = new Error('学生不存在'); e.status = 404; throw e; }

    if (role === 'teacher') {
      const u = await pool.query('SELECT class_id FROM users WHERE id = $1', [req.session.user.id]);
      const cid = (u.rows[0] && u.rows[0].class_id) || null;
      if (!cid) { const e = new Error('当前教师账号未绑定班级'); e.status = 400; throw e; }
      if (stu.class_id !== cid) { const e = new Error('无权限：只能查看本班学生的考勤'); e.status = 403; throw e; }
    }

    const range = parseRange(req.query);
    const now = new Date();
    const end = range.end > now ? now : range.end;

    // 场次归属：与该生所在班一致（全校场次 class_id IS NULL 计入；本班专属计入；别班专属不计入）
    const sp = [range.start, end];
    let sessionWhere = `s.start_time >= $1 AND s.start_time <= $2
          AND s.start_time <= now()
          AND s.status = 'closed'`;
    if (stu.class_id) {
      sp.push([stu.class_id]);
      sessionWhere += `
          AND (s.class_id IS NULL OR s.class_id = ANY($${sp.length}::int[]))`;
    }
    const sessions = (
      await pool.query(`SELECT s.id, s.start_time, s.slot, s.auto_generated FROM attendance_sessions s WHERE ${sessionWhere} ORDER BY s.start_time`, sp)
    ).rows;

    let recs = [];
    if (sessions.length) {
      recs = (
        await pool.query(
          `SELECT session_id, status, checkin_time, leave_reason, check_in_method
             FROM attendance_records WHERE session_id = ANY($1) AND student_id = $2`,
          [sessions.map((s) => s.id), id]
        )
      ).rows;
    }
    const bySid = new Map(recs.map((r) => [r.session_id, r]));
    const expected = sessions.length;
    const c = countRecs(recs);
    const fixed = clampAttend(expected, c.attended, c.leave);

    res.json({
      student: {
        id: stu.id,
        studentNo: stu.student_no,
        name: stu.name,
        status: stu.status,
        classId: stu.class_id,
        className: stu.class_name || '未分班',
        grade: stu.grade || null,
      },
      range: { startDate: fmtDateKeyOf(range.start), endDate: fmtDateKeyOf(range.end), sessions: sessions.length },
      stats: {
        expected,
        attended: fixed.attended,
        leave: fixed.leave,
        absent: fixed.absent,
        rate: rateOf(fixed.attended, expected),
        present: c.present,
        late: c.late,
        warning: fixed.warning,
      },
      records: sessions.map((s) => {
        const r = bySid.get(s.id);
        const status = r ? r.status : 'absent';   // 无记录 = 缺勤（与班级统计口径一致）
        return {
          sessionId: s.id,
          date: fmtDateKeyOf(s.start_time),
          sessionTime: fmtHMS(s.start_time),
          // 每天自动签到（v35）：早/晚两场的 start_time 都是"生成时刻"，直接显示时间会两条都像 00:00，
          //   因此给出 slotLabel（早自习/晚自修），前端优先显示它
          slot: s.slot || null,
          slotLabel: s.slot === 'morning' ? '早自习' : (s.slot === 'evening' ? '晚自修' : null),
          autoGenerated: s.auto_generated === true,
          status,
          statusLabel: REC_STATUS_LABEL[status] || status,
          checkinTime: r && r.checkin_time ? fmtHMS(r.checkin_time) : null,
          leaveReason: (r && r.leave_reason) || null,
          method: (r && r.check_in_method) || null,
        };
      }),
    });
  } catch (err) { next(err); }
});

// 统一错误处理（必须放在所有路由之后）
router.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

module.exports = router;
