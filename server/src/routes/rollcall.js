// ============================================================
// 随机点名 API（班长端签到操作台）
//   GET  /api/rollcall/classes              可点名班级（班长=本班 / 教师=所带班级 / 管理员=全部）
//   GET  /api/rollcall/candidates           候选学生（scope=all 全班 / absent 仅未签到学生）
//   POST /api/rollcall/pick                 随机抽取一名学生并记录（支持 excludeIds 本次课内不重复）
//   GET  /api/rollcall/records              点名记录（按班级/日期）
//   GET  /api/rollcall/records/export       导出点名记录（xlsx）
// 权限：
//   班长  → 仅自己所属班级
//   教师  → 仅自己所带（含班主任）班级
//   管理员→ 全部班级
//   学生  → 403
// ============================================================
const express = require('express');
const pool = require('../db');
const XLSX = require('xlsx');
const { SUBJECTS, SUBJECT_SET } = require('../subjects');

const router = express.Router();

const SCOPE_ALL = 'all';
const SCOPE_ABSENT = 'absent';

function actorOf(req) {
  return (req.session && req.session.user) || null;
}
function isAdmin(a) { return !!a && a.role === 'admin'; }
function isTeacher(a) { return !!a && a.role === 'teacher'; }
function isMonitor(a) { return !!a && a.role === 'monitor'; }

// 允许点名的班级 id 列表（null = 全部班级，仅管理员）
async function allowedClassIds(a) {
  if (isAdmin(a)) return null;
  if (isMonitor(a)) {
    const r = await pool.query('SELECT class_id FROM users WHERE id = $1', [a.id]);
    const cid = r.rows[0] && r.rows[0].class_id;
    return cid ? [cid] : [];
  }
  if (isTeacher(a)) {
    const r = await pool.query('SELECT class_id FROM teacher_classes WHERE teacher_id = $1', [a.id]);
    let ids = r.rows.map((x) => x.class_id);
    if (ids.length === 0) {
      const m = await pool.query('SELECT class_id FROM users WHERE id = $1', [a.id]);
      if (m.rows[0] && m.rows[0].class_id) ids = [m.rows[0].class_id];
    }
    return [...new Set(ids)];
  }
  return [];
}

// 解析并校验 classId（未传时：班长/教师取自己的第一个班级；管理员必须显式指定）
async function resolveClassId(req, a, raw) {
  const allowed = await allowedClassIds(a);
  let cid = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : null;
  if (cid !== null && !Number.isInteger(cid)) return { error: '班级参数无效', status: 400 };
  if (cid === null) {
    if (allowed === null) return { error: '请选择班级', status: 400 };
    if (allowed.length === 0) return { error: '当前账号未绑定班级，无法点名', status: 400 };
    cid = allowed[0];
  }
  if (allowed !== null && !allowed.includes(cid)) {
    return { error: '无权限：只能对本班/自己所带班级点名', status: 403 };
  }
  const c = await pool.query('SELECT id, class_name, grade FROM classes WHERE id = $1', [cid]);
  if (c.rowCount === 0) return { error: '班级不存在', status: 404 };
  return { classId: cid, className: c.rows[0].class_name, grade: c.rows[0].grade || null };
}

// 某班"当前签到场次"：优先本班进行中的场次（含全校场次），其次今天最近一场
//   （都用于「仅未签到学生」的判定）
//   班级隔离（方案 A）：按 attendance_sessions.class_id 收敛——别班的班级专属场次绝不参与
//   （此前取"全局最新进行中场次"，会让 A 班老师点到 B 班场次的未签到名单）
async function currentSession(classId) {
  const cid = Number(classId);
  const hasClass = Number.isInteger(cid) && cid > 0;
  const args = [hasClass, hasClass ? cid : null];
  const classCond = '($1::boolean = false OR class_id IS NULL OR class_id = $2)';
  // 排序：老场次（手动/计划，auto_generated=false）优先 —— 它是"现在正在进行的签到"；
  //   其次才是每天自动签到场次，且按"当前时间段"优先（中午前早自习、中午后晚自修），
  //   最后 id DESC 兜底（老行为：取最新一场）
  const preferMorning = new Date().getHours() < 12;
  const order = `ORDER BY (auto_generated = true) ASC,
                          CASE WHEN auto_generated = true AND slot = '${preferMorning ? 'morning' : 'evening'}' THEN 0 ELSE 1 END,
                          CASE WHEN class_id = $2 THEN 0 ELSE 1 END,
                          id DESC LIMIT 1`;
  const cols = 'id, start_time, deadline, status, class_id, auto_generated, slot, session_date';
  const act = await pool.query(
    `SELECT ${cols} FROM attendance_sessions
      WHERE status = 'active' AND ${classCond} ${order}`,
    args
  );
  if (act.rowCount > 0) return { ...act.rows[0], isActive: true };
  const today = await pool.query(
    `SELECT ${cols} FROM attendance_sessions
      WHERE start_time >= date_trunc('day', now()) AND start_time <= now()
        AND ${classCond} ${order}`,
    args
  );
  if (today.rowCount > 0) return { ...today.rows[0], isActive: false };
  return null;
}

// 未签到学生 id
//   · 老场次：「没有 present/late/leave 记录」= 未签到（老口径，保持不变）
//   · 每天自动签到（v35）：默认**全员已签到** → 这里必须是「被显式标为缺勤的人」；
//     若还按"没有记录"判定，"还没保存过"会被当成"全班未到"（点名的语义就错了）
async function unsignedStudentIds(sessionId, classId, isAuto) {
  if (!sessionId) return null;
  if (isAuto) {
    const r = await pool.query(
      `SELECT s.id FROM students s
        WHERE s.class_id = $1 AND s.is_active = true AND s.status = '在读'
          AND EXISTS (
            SELECT 1 FROM attendance_records r
             WHERE r.session_id = $2 AND r.student_id = s.id AND r.status = 'absent'
          )`,
      [classId, sessionId]
    );
    return r.rows.map((x) => x.id);
  }
  const r = await pool.query(
    `SELECT s.id FROM students s
      WHERE s.class_id = $1 AND s.is_active = true AND s.status = '在读'
        AND NOT EXISTS (
          SELECT 1 FROM attendance_records r
           WHERE r.session_id = $2 AND r.student_id = s.id AND r.status IN ('present', 'late', 'leave')
        )`,
    [classId, sessionId]
  );
  return r.rows.map((x) => x.id);
}

// 「仅未签到」这个范围在不同模型下叫法不同：自动签到场次下叫「仅缺勤」（=被点掉的人）
function absentScopeLabel(sess) {
  return (sess && sess.auto_generated) ? '仅缺勤' : '仅未签到';
}

function seatLabel(row) {
  const r = row && row.seat_row;
  const c = row && row.seat_col;
  // 0/空 表示未排座（与座位表"0=未分配"口径一致）
  if (!Number.isInteger(r) || !Number.isInteger(c) || r <= 0 || c <= 0) return null;
  return `${r}排${c}座`;
}

// GET /api/rollcall/classes —— 可点名的班级（含人数与未签到人数）
router.get('/rollcall/classes', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!isAdmin(a) && !isTeacher(a) && !isMonitor(a)) {
      return res.status(403).json({ error: '无权限：学生账号不可使用随机点名' });
    }
    const allowed = await allowedClassIds(a);
    const p = [];
    let where = "WHERE c.status <> 'archived'";
    if (allowed !== null) {
      if (allowed.length === 0) return res.json({ classes: [], defaultClassId: null, session: null, scopeSupport: { all: true, absent: false } });
      p.push(allowed);
      where += ` AND c.id = ANY($${p.length}::int[])`;
    }
    const { rows } = await pool.query(
      `SELECT c.id, c.class_name, c.grade,
              (SELECT count(*)::int FROM students s
                WHERE s.class_id = c.id AND s.is_active = true AND s.status = '在读') AS student_count
         FROM classes c ${where}
        ORDER BY c.grade NULLS LAST, c.class_name`,
      p
    );
    const classes = [];
    const sessByClass = new Map();
    for (const r of rows) {
      // 每个班各自的"当前场次"（本班专属优先，其次全校场次）——不再共用一个全局场次
      const sess = await currentSession(r.id);
      sessByClass.set(r.id, sess);
      let unsigned = null;
      if (sess) unsigned = (await unsignedStudentIds(sess.id, r.id, sess.auto_generated === true)).length;
      // 本班最近一次点名所用学科（作为点名页的默认学科）
      const last = await pool.query(
        `SELECT subject FROM rollcall_records
          WHERE class_id = $1 AND subject IS NOT NULL
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [r.id]
      );
      let lastSubject = (last.rows[0] && last.rows[0].subject) || null;
      if (!lastSubject) {
        // 没有历史记录时，回退到该班班主任的所教学科
        const ht = await pool.query(
          `SELECT u.subject FROM classes c LEFT JOIN users u ON u.id = c.head_teacher_id WHERE c.id = $1`,
          [r.id]
        );
        lastSubject = (ht.rows[0] && ht.rows[0].subject) || null;
      }
      classes.push({
        classId: r.id,
        className: r.class_name,
        grade: r.grade || null,
        studentCount: r.student_count,
        unsignedCount: unsigned,
        lastSubject,
      });
    }
    // 默认班级：当前账号绑定/所属班级优先，否则第一个
    let defaultClassId = classes.length ? classes[0].classId : null;
    const m = await pool.query('SELECT class_id FROM users WHERE id = $1', [a.id]);
    const mine = m.rows[0] && m.rows[0].class_id;
    if (mine && classes.some((c) => c.classId === mine)) defaultClassId = mine;
    const sess = defaultClassId ? (sessByClass.get(defaultClassId) || null) : null;
    res.json({
      classes,
      role: a.role,
      // 点赞权限：班长 / 任课老师 / 班主任 / 管理员（学生不可）
      canLike: isMonitor(a) || isTeacher(a) || isAdmin(a),
      defaultClassId,
      subjects: SUBJECTS,
      session: sess ? {
        id: sess.id, isActive: !!sess.isActive, startTime: sess.start_time, deadline: sess.deadline,
        autoGenerated: sess.auto_generated === true,
        slotLabel: sess.slot === 'morning' ? '早自习' : (sess.slot === 'evening' ? '晚自修' : null),
      } : null,
      scopeSupport: { all: true, absent: !!sess },
      // 「仅未签到」的显示名（自动签到场次下叫「仅缺勤」）
      absentScopeLabel: absentScopeLabel(sess),
    });
  } catch (err) { next(err); }
});

// GET /api/rollcall/candidates?classId=&scope=all|absent —— 候选学生
router.get('/rollcall/candidates', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!isAdmin(a) && !isTeacher(a) && !isMonitor(a)) {
      return res.status(403).json({ error: '无权限：学生账号不可使用随机点名' });
    }
    const cls = await resolveClassId(req, a, req.query.classId);
    if (cls.error) return res.status(cls.status).json({ error: cls.error });
    const scope = String(req.query.scope || SCOPE_ALL) === SCOPE_ABSENT ? SCOPE_ABSENT : SCOPE_ALL;

    const sess = await currentSession(cls.classId);
    let ids = null;
    if (scope === SCOPE_ABSENT) {
      ids = await unsignedStudentIds(sess && sess.id, cls.classId, !!(sess && sess.auto_generated));
      if (ids === null) {
        return res.status(400).json({ error: '当前没有签到场次，无法按"' + absentScopeLabel(sess) + '"点名' });
      }
    }
    const p = [cls.classId];
    let sql = `SELECT s.id, s.student_no, s.name, s.seat_row, s.seat_col
                 FROM students s
                WHERE s.class_id = $1 AND s.is_active = true AND s.status = '在读'`;
    if (ids !== null) {
      if (ids.length === 0) {
        return res.json({
          classId: cls.classId, className: cls.className, scope, sessionId: sess && sess.id,
          absentScopeLabel: absentScopeLabel(sess), autoSession: !!(sess && sess.auto_generated), candidates: [],
        });
      }
      p.push(ids);
      sql += ` AND s.id = ANY($${p.length}::int[])`;
    }
    sql += ' ORDER BY s.student_no';
    const { rows } = await pool.query(sql, p);
    res.json({
      classId: cls.classId,
      className: cls.className,
      scope,
      sessionId: sess ? sess.id : null,
      sessionActive: !!(sess && sess.isActive),
      // 「仅未签到」在每天自动签到场次下语义 = 仅缺勤（被点掉的人）→ 前端据此改文案
      absentScopeLabel: absentScopeLabel(sess),
      autoSession: !!(sess && sess.auto_generated),
      sessionSlotLabel: sess && sess.slot === 'morning' ? '早自习' : (sess && sess.slot === 'evening' ? '晚自修' : null),
      candidates: rows.map((r) => ({
        id: r.id,
        studentNo: r.student_no,
        name: r.name,
        seatRow: r.seat_row,
        seatCol: r.seat_col,
        seatLabel: seatLabel(r),
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/rollcall/pick —— 随机抽取一名学生并写入点名记录
// body: { classId?, scope?, excludeIds?: [..], subject? }
router.post('/rollcall/pick', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!isAdmin(a) && !isTeacher(a) && !isMonitor(a)) {
      return res.status(403).json({ error: '无权限：学生账号不可使用随机点名' });
    }
    const body = req.body || {};
    const cls = await resolveClassId(req, a, body.classId);
    if (cls.error) return res.status(cls.status).json({ error: cls.error });
    const scope = String(body.scope || SCOPE_ALL) === SCOPE_ABSENT ? SCOPE_ABSENT : SCOPE_ALL;
    // 学科（本次点名所属学科）：可选；传了必须是合法学科
    const subjectRaw = body.subject === undefined || body.subject === null ? '' : String(body.subject).trim();
    if (subjectRaw && !SUBJECT_SET.has(subjectRaw)) {
      return res.status(400).json({ error: '学科不在可选范围内' });
    }
    const subject = subjectRaw || null;
    const excludeIds = Array.isArray(body.excludeIds)
      ? [...new Set(body.excludeIds.map(Number).filter((x) => Number.isInteger(x) && x > 0))]
      : [];

    const sess = await currentSession(cls.classId);
    let poolIds = null;
    if (scope === SCOPE_ABSENT) {
      if (!sess) {
        return res.status(400).json({ error: '当前没有签到场次，无法按"' + absentScopeLabel(sess) + '"点名' });
      }
      poolIds = await unsignedStudentIds(sess.id, cls.classId, sess.auto_generated === true);
      if (poolIds === null) return res.status(400).json({ error: '当前没有签到场次，无法按"' + absentScopeLabel(sess) + '"点名' });
    }
    const p = [cls.classId];
    let sql = `SELECT s.id, s.student_no, s.name, s.seat_row, s.seat_col
                 FROM students s
                WHERE s.class_id = $1 AND s.is_active = true AND s.status = '在读'`;
    if (poolIds !== null) {
      if (poolIds.length === 0) return res.status(400).json({ error: '本班学生都已签到，无需抽查' });
      p.push(poolIds);
      sql += ` AND s.id = ANY($${p.length}::int[])`;
    }
    if (excludeIds.length > 0) {
      p.push(excludeIds);
      sql += ` AND NOT (s.id = ANY($${p.length}::int[]))`;
    }
    const { rows } = await pool.query(sql, p);
    if (rows.length === 0) {
      return res.status(409).json({
        error: excludeIds.length > 0 ? '本次课内所有学生都已被点到，已无新同学可抽（可关闭"不重复抽取"或重新开始）' : '没有可抽取的学生',
        remaining: 0,
      });
    }
    const picked = rows[Math.floor(Math.random() * rows.length)];

    const ins = await pool.query(
      `INSERT INTO rollcall_records (class_id, student_id, session_id, scope, picked_by, picked_by_name, subject)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [cls.classId, picked.id, sess ? sess.id : null, scope, a.id, a.displayName || a.username, subject]
    );
    // 该生在本学科的累计点赞（供点名页展示"已赞 N 次"）
    const likes = subject
      ? await pool.query(
        'SELECT COALESCE(SUM(like_count), 0)::int AS n FROM student_likes WHERE student_id = $1 AND subject = $2',
        [picked.id, subject]
      )
      : { rows: [{ n: 0 }] };
    res.status(201).json({
      recordId: ins.rows[0].id,
      pickedAt: ins.rows[0].created_at,
      classId: cls.classId,
      className: cls.className,
      scope,
      subject,
      likeCount: likes.rows[0].n,
      sessionId: sess ? sess.id : null,
      remaining: Math.max(0, rows.length - 1),
      total: rows.length,
      student: {
        id: picked.id,
        studentNo: picked.student_no,
        name: picked.name,
        seatRow: picked.seat_row,
        seatCol: picked.seat_col,
        seatLabel: seatLabel(picked),
      },
    });
  } catch (err) { next(err); }
});

// GET /api/rollcall/records?classId=&date=&subject=&limit= —— 点名记录
router.get('/rollcall/records', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!isAdmin(a) && !isTeacher(a) && !isMonitor(a)) {
      return res.status(403).json({ error: '无权限：学生账号不可查看点名记录' });
    }
    const cls = await resolveClassId(req, a, req.query.classId);
    if (cls.error) return res.status(cls.status).json({ error: cls.error });
    const date = String(req.query.date || '');
    const subject = String(req.query.subject || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
    const p = [cls.classId];
    let where = 'WHERE r.class_id = $1';
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      p.push(date);
      where += ` AND r.created_at >= $${p.length}::date AND r.created_at < ($${p.length}::date + interval '1 day')`;
    }
    if (subject && SUBJECT_SET.has(subject)) {
      p.push(subject);
      where += ` AND r.subject = $${p.length}`;
    }
    p.push(limit);
    const { rows } = await pool.query(
      `SELECT r.id, r.scope, r.created_at, r.picked_by_name, r.subject,
              s.name AS student_name, s.student_no, s.seat_row, s.seat_col,
              c.class_name
         FROM rollcall_records r
         LEFT JOIN students s ON s.id = r.student_id
         LEFT JOIN classes c ON c.id = r.class_id
         ${where}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $${p.length}`,
      p
    );
    const total = await pool.query('SELECT count(*)::int AS n FROM rollcall_records r ' + where, p.slice(0, p.length - 1));
    // 本班已用过学科（供筛选下拉）
    const used = await pool.query(
      `SELECT DISTINCT subject FROM rollcall_records WHERE class_id = $1 AND subject IS NOT NULL ORDER BY subject`,
      [cls.classId]
    );
    res.json({
      classId: cls.classId,
      className: cls.className,
      total: total.rows[0].n,
      subjectsUsed: used.rows.map((x) => x.subject),
      records: rows.map((r) => ({
        id: r.id,
        studentName: r.student_name,
        studentNo: r.student_no,
        seatLabel: seatLabel(r),
        scope: r.scope,
        scopeLabel: r.scope === SCOPE_ABSENT ? '仅未签到' : '全班',
        subject: r.subject || null,
        className: r.class_name,
        pickedByName: r.picked_by_name,
        createdAt: r.created_at,
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/rollcall/likes —— 点赞（班长 / 任课老师 / 班主任 / 管理员；学生不可）
//   body: { classId?, studentId, subject, count? }
//   班级范围：班长=本班；教师=所带班级；管理员=任意班级
router.post('/rollcall/likes', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!isMonitor(a) && !isTeacher(a) && !isAdmin(a)) {
      return res.status(403).json({ error: '无权限：学生账号不能点赞（班长/任课老师/班主任/管理员可点赞）' });
    }
    const body = req.body || {};
    const studentId = Number(body.studentId);
    if (!Number.isInteger(studentId)) return res.status(400).json({ error: '缺少有效的 studentId' });
    const subject = String(body.subject || '').trim();
    if (!SUBJECT_SET.has(subject)) return res.status(400).json({ error: '请选择学科' });
    const count = Math.min(Math.max(Number(body.count) || 1, 1), 10);

    const cls = await resolveClassId(req, a, body.classId);
    if (cls.error) return res.status(cls.status).json({ error: cls.error });
    const stu = await pool.query(
      "SELECT id, name FROM students WHERE id = $1 AND class_id = $2 AND is_active = true AND status = '在读'",
      [studentId, cls.classId]
    );
    if (stu.rowCount === 0) return res.status(404).json({ error: '该学生不在本班（或在读状态不符）' });

    const ins = await pool.query(
      `INSERT INTO student_likes (student_id, class_id, subject, operator_id, operator_name, like_count)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [studentId, cls.classId, subject, a.id, a.displayName || a.username, count]
    );
    const subjectTotal = await pool.query(
      'SELECT COALESCE(SUM(like_count), 0)::int AS n FROM student_likes WHERE student_id = $1 AND subject = $2',
      [studentId, subject]
    );
    const allTotal = await pool.query(
      'SELECT COALESCE(SUM(like_count), 0)::int AS n FROM student_likes WHERE student_id = $1',
      [studentId]
    );
    res.status(201).json({
      likeId: ins.rows[0].id,
      createdAt: ins.rows[0].created_at,
      classId: cls.classId,
      className: cls.className,
      subject,
      count,
      student: { id: stu.rows[0].id, name: stu.rows[0].name },
      likeCount: subjectTotal.rows[0].n,     // 该生 · 本学科 累计点赞
      totalLikes: allTotal.rows[0].n,        // 该生 · 全部学科 累计点赞
    });
  } catch (err) { next(err); }
});

// GET /api/rollcall/records/export?classId=&date= —— 导出点名记录（xlsx）
router.get('/rollcall/records/export', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!isAdmin(a) && !isTeacher(a) && !isMonitor(a)) {
      return res.status(403).json({ error: '无权限：学生账号不可导出点名记录' });
    }
    const cls = await resolveClassId(req, a, req.query.classId);
    if (cls.error) return res.status(cls.status).json({ error: cls.error });
    const date = String(req.query.date || '');
    const p = [cls.classId];
    let where = 'WHERE r.class_id = $1';
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      p.push(date);
      where += ` AND r.created_at >= $${p.length}::date AND r.created_at < ($${p.length}::date + interval '1 day')`;
    }
    const { rows } = await pool.query(
      `SELECT r.created_at, s.student_no, s.name, s.seat_row, s.seat_col, r.scope, r.picked_by_name, c.class_name
         FROM rollcall_records r
         LEFT JOIN students s ON s.id = r.student_id
         LEFT JOIN classes c ON c.id = r.class_id
         ${where}
        ORDER BY r.created_at ASC, r.id ASC`,
      p
    );
    if (rows.length === 0) return res.status(404).json({ error: '没有可导出的点名记录' });
    const fmt = (d) => {
      const x = new Date(d);
      const z = (n) => String(n).padStart(2, '0');
      return `${x.getFullYear()}-${z(x.getMonth() + 1)}-${z(x.getDate())} ${z(x.getHours())}:${z(x.getMinutes())}:${z(x.getSeconds())}`;
    };
    const data = rows.map((r) => ({
      时间: fmt(r.created_at),
      班级: r.class_name || '',
      学科: r.subject || '未标学科',
      学号: r.student_no || '',
      姓名: r.name || '',
      座位: seatLabel(r) || '未排座',
      点名范围: r.scope === SCOPE_ABSENT ? '仅未签到' : '全班',
      操作人: r.picked_by_name || '',
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 20 }, { wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, '点名记录');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fn = `点名记录_${cls.className}${/^\d{4}-\d{2}-\d{2}$/.test(date) ? '_' + date : ''}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fn)}`);
    res.send(buf);
  } catch (err) { next(err); }
});

module.exports = router;
