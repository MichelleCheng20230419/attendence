// ============================================================
// 叫号系统 API（教师发布 → 班长接收/播报/标记已处理）
//   POST   /api/announcements               发布叫号（任课老师/班主任：仅所带班级；管理员：任意班级）
//   GET    /api/announcements               教师端列表（老师=自己发布的；管理员=全部）
//   GET    /api/announcements/inbox         班长端列表（仅本班，含未读/未播报统计）
//   GET    /api/announcements/:id           详情（发布者/管理员/本班班长）
//   POST   /api/announcements/:id/process   标记已处理（仅本班班长）
//   POST   /api/announcements/:id/played    标记已播报（仅本班班长，语音播报后调用）
//   DELETE /api/announcements/:id           删除（发布者/管理员）
// 权限（与需求表一致）：
//   任课老师/班主任 → 发布所带班级、查看/删除自己发布的
//   班长           → 只看本班、标记已处理、播报（不能发布）
//   管理员         → 发布任意班级、查看全部
//   学生           → 403
// ============================================================
const express = require('express');
const pool = require('../db');

const router = express.Router();

const PRIORITIES = new Set(['normal', 'urgent']);
const STATUSES = new Set(['pending', 'processed']);

function actorOf(req) { return (req.session && req.session.user) || null; }
const isAdmin = (a) => !!a && a.role === 'admin';
const isTeacher = (a) => !!a && a.role === 'teacher';
const isMonitor = (a) => !!a && a.role === 'monitor';

// 解析 "YYYY-MM-DD HH:MM"（或 ISO 串）
function parseWhen(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0);
  return isNaN(d.getTime()) ? null : d;
}

function fmtWhen(d) {
  if (!d) return null;
  const x = new Date(d);
  const z = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${z(x.getMonth() + 1)}-${z(x.getDate())} ${z(x.getHours())}:${z(x.getMinutes())}`;
}

async function classOf(id) {
  const r = await pool.query('SELECT id, class_name FROM classes WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// 教师可发布/查看的班级（与自己带班记录一致）
async function teacherClassIds(teacherId) {
  const r = await pool.query('SELECT class_id FROM teacher_classes WHERE teacher_id = $1', [teacherId]);
  let ids = r.rows.map((x) => x.class_id);
  if (ids.length === 0) {
    const m = await pool.query('SELECT class_id FROM users WHERE id = $1', [teacherId]);
    if (m.rows[0] && m.rows[0].class_id) ids = [m.rows[0].class_id];
  }
  return [...new Set(ids)];
}

async function monitorClassId(monitorId) {
  const r = await pool.query('SELECT class_id FROM users WHERE id = $1', [monitorId]);
  return (r.rows[0] && r.rows[0].class_id) || null;
}

function mapRow(r) {
  return {
    id: r.id,
    classId: r.class_id,
    className: r.class_name || null,
    studentId: r.student_id,
    studentName: r.student_name || null,
    studentNo: r.student_no || null,
    location: r.location,
    scheduledTime: r.scheduled_time,
    scheduledText: fmtWhen(r.scheduled_time),
    note: r.note || null,
    priority: r.priority,
    status: r.status,
    isPlayed: !!r.is_played,
    createdAt: r.created_at,
    teacherId: r.teacher_id,
    teacherName: r.teacher_name || null,
    processedAt: r.processed_at,
    processedByName: r.processed_by_name || null,
  };
}

const SELECT_BASE = `
  SELECT a.id, a.class_id, a.student_id, a.teacher_id, a.teacher_name, a.location, a.scheduled_time,
         a.note, a.priority, a.status, a.is_played, a.created_at, a.processed_at, a.processed_by_name,
         c.class_name, s.name AS student_name, s.student_no
    FROM announcements a
    LEFT JOIN classes c ON c.id = a.class_id
    LEFT JOIN students s ON s.id = a.student_id`;

// ------------------------------------------------------------
// POST /api/announcements —— 发布叫号
// body: { classId, studentId, location, scheduledTime, note?, priority? }
// ------------------------------------------------------------
router.post('/announcements', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!isAdmin(a) && !isTeacher(a)) {
      return res.status(403).json({ error: isMonitor(a) ? '无权限：班长不能发布叫号（由老师发布）' : '无权限：学生不能发布叫号' });
    }
    const body = req.body || {};
    const classId = Number(body.classId);
    const studentId = Number(body.studentId);
    const location = String(body.location || '').trim();
    const note = String(body.note || '').trim();
    const priority = PRIORITIES.has(String(body.priority)) ? String(body.priority) : 'normal';
    if (!Number.isInteger(classId)) return res.status(400).json({ error: '请选择班级' });
    if (!Number.isInteger(studentId)) return res.status(400).json({ error: '请选择学生' });
    if (!location) return res.status(400).json({ error: '请填写"到何处"' });
    if (location.length > 100) return res.status(400).json({ error: '"到何处"不能超过 100 字' });
    if (note.length > 500) return res.status(400).json({ error: '备注不能超过 500 字' });
    const when = parseWhen(body.scheduledTime);
    if (!when) return res.status(400).json({ error: '请选择"何时"（日期 + 时间）' });

    if (!isAdmin(a)) {
      const mine = await teacherClassIds(a.id);
      if (!mine.includes(classId)) return res.status(403).json({ error: '无权限：只能给所带班级发布叫号' });
    }
    const cls = await classOf(classId);
    if (!cls) return res.status(404).json({ error: '班级不存在' });
    const stu = await pool.query(
      "SELECT id, name FROM students WHERE id = $1 AND class_id = $2 AND is_active = true AND status = '在读'",
      [studentId, classId]
    );
    if (stu.rowCount === 0) return res.status(404).json({ error: '该学生不在所选班级（或在读状态不符）' });

    const ins = await pool.query(
      `INSERT INTO announcements (class_id, student_id, teacher_id, teacher_name, location, scheduled_time, note, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [classId, studentId, a.id, a.displayName || a.username, location, when, note || null, priority]
    );
    const created = await pool.query(`${SELECT_BASE} WHERE a.id = $1`, [ins.rows[0].id]);
    res.status(201).json({ announcement: mapRow(created.rows[0]) });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------
// GET /api/announcements —— 教师端列表（老师=自己发布的；管理员=全部）
// 参数：classId? status? date? limit?
// ------------------------------------------------------------
router.get('/announcements', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!isAdmin(a) && !isTeacher(a)) {
      return res.status(403).json({ error: '无权限：班长/学生请使用班长端叫号列表' });
    }
    const p = [];
    const where = [];
    if (!isAdmin(a)) {
      p.push(a.id);
      where.push(`a.teacher_id = $${p.length}`);
    }
    if (req.query.classId) {
      const cid = Number(req.query.classId);
      if (!Number.isInteger(cid)) return res.status(400).json({ error: '班级参数无效' });
      p.push(cid);
      where.push(`a.class_id = $${p.length}`);
    }
    const status = String(req.query.status || '').trim();
    if (status) {
      if (!STATUSES.has(status)) return res.status(400).json({ error: '状态参数无效' });
      p.push(status);
      where.push(`a.status = $${p.length}`);
    }
    const date = String(req.query.date || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      p.push(date);
      where.push(`a.created_at >= $${p.length}::date AND a.created_at < ($${p.length}::date + interval '1 day')`);
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const { rows } = await pool.query(
      `${SELECT_BASE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit}`,
      p
    );
    const stat = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'pending')::int AS pending
         FROM announcements a ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
      p
    );
    // 发布页需要的班级与学生
    const classes = isAdmin(a)
      ? (await pool.query('SELECT id, class_name, grade FROM classes ORDER BY grade NULLS LAST, class_name')).rows
      : (await pool.query(
        `SELECT c.id, c.class_name, c.grade FROM classes c WHERE c.id = ANY($1::int[]) ORDER BY c.class_name`,
        [await teacherClassIds(a.id)]
      )).rows;
    res.json({
      total: stat.rows[0].total,
      pending: stat.rows[0].pending,
      announcements: rows.map(mapRow),
      classes: classes.map((x) => ({ classId: x.id, className: x.class_name, grade: x.grade || null })),
      canPublish: true,
    });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------
// GET /api/announcements/inbox —— 班长端列表（仅本班）
// 参数：classId?（必须是自己班级）limit?
// 返回：announcements（按发布时间倒序）、pendingCount（未处理）、unplayed（待播报）
// ------------------------------------------------------------
router.get('/announcements/inbox', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!isMonitor(a)) return res.status(403).json({ error: '无权限：仅班长可查看班长端叫号列表' });
    const myClassId = await monitorClassId(a.id);
    if (!myClassId) return res.status(400).json({ error: '当前班长账号未绑定班级' });
    const cid = req.query.classId ? Number(req.query.classId) : myClassId;
    if (cid !== myClassId) return res.status(403).json({ error: '无权限：只能查看本班叫号' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const { rows } = await pool.query(
      `${SELECT_BASE} WHERE a.class_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit}`,
      [cid]
    );
    const cls = await classOf(myClassId);
    res.json({
      classId: myClassId,
      className: cls ? cls.class_name : null,
      announcements: rows.map(mapRow),
      pendingCount: rows.filter((r) => r.status === 'pending').length,
      unplayed: rows.filter((r) => !r.is_played).map(mapRow),
    });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------
// GET /api/announcements/:id —— 详情（发布者 / 管理员 / 本班班长）
// ------------------------------------------------------------
router.get('/announcements/:id', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的叫号ID' });
    const { rows } = await pool.query(`${SELECT_BASE} WHERE a.id = $1`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: '叫号不存在' });
    const row = rows[0];
    const canView = isAdmin(a)
      || (isTeacher(a) && row.teacher_id === a.id)
      || (isMonitor(a) && (await monitorClassId(a.id)) === row.class_id);
    if (!canView) return res.status(403).json({ error: '无权限查看该叫号' });
    res.json({ announcement: mapRow(row) });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------
// POST /api/announcements/:id/process —— 班长标记已处理
// ------------------------------------------------------------
router.post('/announcements/:id/process', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!isMonitor(a)) return res.status(403).json({ error: '无权限：仅班长可标记已处理' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的叫号ID' });
    const myClassId = await monitorClassId(a.id);
    const cur = await pool.query('SELECT id, class_id, status FROM announcements WHERE id = $1', [id]);
    if (cur.rowCount === 0) return res.status(404).json({ error: '叫号不存在' });
    if (cur.rows[0].class_id !== myClassId) return res.status(403).json({ error: '无权限：只能处理本班叫号' });
    await pool.query(
      `UPDATE announcements
          SET status = 'processed', processed_at = now(), processed_by = $2, processed_by_name = $3,
              is_played = TRUE
        WHERE id = $1`,
      [id, a.id, a.displayName || a.username]
    );
    const { rows } = await pool.query(`${SELECT_BASE} WHERE a.id = $1`, [id]);
    res.json({ ok: true, announcement: mapRow(rows[0]) });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------
// POST /api/announcements/:id/played —— 班长标记已语音播报
// ------------------------------------------------------------
router.post('/announcements/:id/played', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!isMonitor(a)) return res.status(403).json({ error: '无权限：仅班长端播报' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的叫号ID' });
    const myClassId = await monitorClassId(a.id);
    const cur = await pool.query('SELECT id, class_id FROM announcements WHERE id = $1', [id]);
    if (cur.rowCount === 0) return res.status(404).json({ error: '叫号不存在' });
    if (cur.rows[0].class_id !== myClassId) return res.status(403).json({ error: '无权限：只能播报本班叫号' });
    await pool.query('UPDATE announcements SET is_played = TRUE WHERE id = $1', [id]);
    res.json({ ok: true, id });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------
// DELETE /api/announcements/:id —— 删除（发布者 / 管理员）
// ------------------------------------------------------------
router.delete('/announcements/:id', async (req, res, next) => {
  try {
    const a = actorOf(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的叫号ID' });
    const cur = await pool.query('SELECT id, teacher_id FROM announcements WHERE id = $1', [id]);
    if (cur.rowCount === 0) return res.status(404).json({ error: '叫号不存在' });
    if (!isAdmin(a) && cur.rows[0].teacher_id !== a.id) {
      return res.status(403).json({ error: '无权限：只能删除自己发布的叫号' });
    }
    await pool.query('DELETE FROM announcements WHERE id = $1', [id]);
    res.json({ deleted: true, id });
  } catch (err) { next(err); }
});

module.exports = router;
