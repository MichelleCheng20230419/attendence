// 后台管理 API：年级 / 班级 / 学年管理 / 学生异动
// 权限：年级/班级/学年仅管理员；异动 管理员+教师
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const pool = require('../db');
const termLib = require('../lib/term');
const classSubjects = require('../lib/classSubjects');   // 班级选科组合/选科科目统一口径（v34）
// 班主任唯一写入源（定义在 users.js，避免多份实现漂移）
const { syncTeacherClass } = require('./users');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ---------- 工具 ----------
function isAdmin(req) { return req.session.user.role === 'admin'; }
function isAdminOrTeacher(req) { return ['admin', 'teacher'].includes(req.session.user.role); }

// 操作日志（导入等批量动作留痕；日志失败不影响主流程）
async function logOperation(req, action, detail = {}) {
  try {
    const u = req.session.user;
    await pool.query(
      `INSERT INTO operation_logs (user_id, user_name, role, action, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [u.id, u.displayName || u.username, u.role, action, JSON.stringify(detail)]
    );
  } catch (_) { /* 日志失败不影响主流程 */ }
}

// 教师所带班级（users.class_id 主班级；管理员返回 null=不限制）
async function teacherClassIds(req) {
  if (isAdmin(req)) return null;
  const u = await pool.query('SELECT class_id FROM users WHERE id = $1', [req.session.user.id]);
  const cid = u.rows[0] && u.rows[0].class_id;
  return cid ? [cid] : [];
}

// 当前学年
async function getCurrentYear() {
  const r = await pool.query("SELECT value FROM system_settings WHERE key = 'current_academic_year'");
  return (r.rows[0] && r.rows[0].value) || '2026-2027';
}

// 解析 Excel buffer → 行数组
function parseExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

// ============================================================
// 年级管理
// ============================================================

// GET /api/grades —— 年级列表（可按学年筛选；含班级数/学生数）
// 管理员 + 教师（学生异动页年级下拉也使用）
// 参数：academicYear / academic_year（按学年过滤，前端下拉统一取「当前学年」）
router.get('/grades', async (req, res, next) => {
  try {
    if (!isAdminOrTeacher(req)) return res.status(403).json({ error: '无权限：仅管理员或教师' });
    const year = String(req.query.academicYear || req.query.academic_year || '');
    const p = [];
    let where = '';
    if (year) { p.push(year); where = 'WHERE g.academic_year = $1'; }
    const { rows } = await pool.query(
      `SELECT g.id, g.grade_name, g.grade_code, g.academic_year, g.sort_order,
              (SELECT count(*)::int FROM classes c WHERE c.grade_id = g.id) AS class_count,
              (SELECT count(*)::int FROM students s JOIN classes c ON c.id = s.class_id
                 WHERE c.grade_id = g.id AND s.is_active = true) AS student_count
         FROM grades g
         ${where}
        ORDER BY g.sort_order, g.grade_name`,
      p
    );
    res.json({ grades: rows });
  } catch (err) { next(err); }
});

// POST /api/grades —— 添加年级
router.post('/grades', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    const gradeName = String(req.body.gradeName ?? '').trim();
    const gradeCode = String(req.body.gradeCode ?? '').trim();
    const academicYear = String(req.body.academicYear ?? '').trim();
    const sortOrder = Number(req.body.sortOrder) || 0;
    if (!gradeName) return res.status(400).json({ error: '年级名称不能为空' });
    if (!academicYear) return res.status(400).json({ error: '学年不能为空' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO grades (grade_name, grade_code, academic_year, sort_order)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [gradeName, gradeCode, academicYear, sortOrder]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: '该学年下已存在同名年级' });
      throw e;
    }
  } catch (err) { next(err); }
});

// PUT /api/grades/:id —— 编辑年级（名称/代码）
router.put('/grades/:id', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    const id = Number(req.params.id);
    const gradeName = String(req.body.gradeName ?? '').trim();
    const gradeCode = String(req.body.gradeCode ?? '').trim();
    if (!gradeName) return res.status(400).json({ error: '年级名称不能为空' });
    const r = await pool.query(
      'UPDATE grades SET grade_name = $2, grade_code = $3 WHERE id = $1',
      [id, gradeName, gradeCode]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: '年级不存在' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '该学年下已存在同名年级' });
    next(err);
  }
});

// DELETE /api/grades/:id —— 删除年级（需无关联班级）
router.delete('/grades/:id', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    const id = Number(req.params.id);
    const cnt = await pool.query('SELECT count(*)::int AS n FROM classes WHERE grade_id = $1', [id]);
    if (cnt.rows[0].n > 0) return res.status(400).json({ error: `该年级下还有 ${cnt.rows[0].n} 个班级，无法删除` });
    const r = await pool.query('DELETE FROM grades WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: '年级不存在' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// POST /api/grades/import —— Excel 导入年级（模板：年级名称、年级代码、学年）
router.post('/grades/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
    const rows = parseExcel(req.file.buffer);
    let inserted = 0, skipped = 0;
    for (const r of rows) {
      const name = String(r['年级名称'] ?? '').trim();
      const code = String(r['年级代码'] ?? '').trim();
      const year = String(r['学年'] ?? '').trim();
      if (!name || !year) { skipped += 1; continue; }
      try {
        const rr = await pool.query(
          'INSERT INTO grades (grade_name, grade_code, academic_year) VALUES ($1,$2,$3)',
          [name, code, year]
        );
        inserted += rr.rowCount;
      } catch (e) {
        if (e.code === '23505') { skipped += 1; continue; }
        throw e;
      }
    }
    res.json({ inserted, skipped, total: rows.length });
  } catch (err) { next(err); }
});

// ============================================================
// 班级管理
// ============================================================

// GET /api/classes/manage —— 班级管理列表（按学年+年级筛选；含班主任/学生数/状态）
// 注：通用班级下拉用 GET /api/classes（attendance.js），此处为管理表格专用路径
router.get('/classes/manage', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    const year = String(req.query.academicYear || req.query.academic_year || '');
    const gradeIdRaw = req.query.gradeId !== undefined ? req.query.gradeId : req.query.grade_id;
    const gradeId = gradeIdRaw ? Number(gradeIdRaw) : null;
    const p = [];
    let where = 'WHERE 1=1';
    if (year) { p.push(year); where += ` AND c.academic_year = $${p.length}`; }
    if (gradeId) { p.push(gradeId); where += ` AND c.grade_id = $${p.length}`; }
    const { rows } = await pool.query(
      `SELECT c.id, c.class_name, c.grade, c.grade_id, c.academic_year, c.status,
              c.head_teacher_id, c.deputy_teacher_id, c.stream, c.elective_subjects, c.daily_subjects,
              g.grade_name,
              (SELECT count(*)::int FROM students s WHERE s.class_id = c.id AND s.is_active = true) AS student_count,
              (SELECT COALESCE(NULLIF(u.real_name, ''), u.display_name, u.username) FROM users u WHERE u.id = c.head_teacher_id) AS head_teacher_name,
              (SELECT COALESCE(NULLIF(u.real_name, ''), u.display_name, u.username) FROM users u WHERE u.id = c.deputy_teacher_id) AS deputy_teacher_name
         FROM classes c
         LEFT JOIN grades g ON g.id = c.grade_id
         ${where}
        ORDER BY c.academic_year DESC, c.grade_id, c.class_name`,
      p
    );
    res.json({
      classes: rows.map((r) => {
        const sc = classSubjects.readClassStream(r);
        return {
          ...r,
          // 选科组合 / 选科科目（JSONB → 数组）与"该班开设学科 = 语文+数学+英语+选科科目"
          stream: sc.stream,
          elective_subjects: sc.electiveSubjects,
          electiveSubjects: sc.electiveSubjects,
          effective_subjects: classSubjects.effectiveSubjects(sc),
          daily_subjects: Array.isArray(r.daily_subjects) && r.daily_subjects.length ? r.daily_subjects : null,
        };
      }),
    });
  } catch (err) { next(err); }
});

// 校验教师账号存在且为教师角色
async function checkTeacher(userId) {
  if (!Number.isInteger(userId)) return false;
  const r = await pool.query(
    "SELECT id FROM users WHERE id = $1 AND role = 'teacher'",
    [userId]
  );
  return r.rowCount > 0;
}

// 联动：班级正班主任 ↔ 教师所带班级（双向同步）
// P0 收敛：实现已统一到 users.js#syncTeacherClass（唯一写入源），此处保留说明：
//   1) 教师 users.class_id 同步为该班
//   2) 该教师原带的其他班级解除正班主任（classes 两列 + teacher_classes 记录一起降级）
//   3) 写入 teacher_classes 班主任记录 —— teacher_classes 是带班关系的权威来源，
//      如果只写 classes.head_teacher_id 而不写这里，教师端保存带班记录时会被反向清空
//   4) classes.head_teacher_id 为权威字段，teacher_id 为遗留兼容列（写同值，P2 计划删除）

// POST /api/classes —— 添加班级
// 支持 gradeId 或 gradeName+academicYear 两种年级传参；headTeacherId 正班主任 / deputyTeacherId 副班主任
router.post('/classes', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    const { className, gradeId, gradeName, academicYear, headTeacherId, deputyTeacherId } = req.body || {};
    const name = String(className ?? '').trim();
    const year = String(academicYear ?? '').trim();
    if (!name) return res.status(400).json({ error: '班级名称不能为空' });

    let g;
    if (gradeId !== undefined && gradeId !== null && gradeId !== '') {
      const gid = Number(gradeId);
      if (!Number.isInteger(gid)) return res.status(400).json({ error: '年级参数无效' });
      g = await pool.query('SELECT id, grade_name FROM grades WHERE id = $1', [gid]);
    } else if (gradeName) {
      if (!year) return res.status(400).json({ error: '学年不能为空' });
      g = await pool.query(
        'SELECT id, grade_name FROM grades WHERE grade_name = $1 AND academic_year = $2',
        [String(gradeName).trim(), year]
      );
    } else {
      return res.status(400).json({ error: '必须选择所属年级' });
    }
    if (g.rowCount === 0) return res.status(400).json({ error: '所选年级不存在' });
    const gid = g.rows[0].id;

    // 选科组合 / 选科科目（v34）：
    //   组合=理科/文科 且未显式给科目 → 自动套用预设（物理化学生物 / 政治历史地理）；
    //   小理/小文/综合 → 按传入的科目（可为空，表示"暂不设置，沿用全局默认"）
    const streamRaw = req.body.stream ?? req.body.classStream;
    const ns = classSubjects.normalizeStream(streamRaw);
    if (ns.error) return res.status(400).json({ error: ns.error });
    const electivesRaw = req.body.electiveSubjects ?? req.body.elective_subjects;
    let electives;
    if (electivesRaw === undefined || electivesRaw === null || (Array.isArray(electivesRaw) && electivesRaw.length === 0) || String(electivesRaw).trim() === '') {
      electives = classSubjects.streamPreset(ns.stream);          // 未给科目 → 用组合预设（理科/文科有值，其余为空）
    } else {
      const ne = classSubjects.normalizeElectives(electivesRaw);
      if (ne.error) return res.status(400).json({ error: ne.error });
      electives = ne.subjects;
    }

    let ht = headTeacherId === undefined || headTeacherId === null || headTeacherId === '' ? null : Number(headTeacherId);
    let dt = deputyTeacherId === undefined || deputyTeacherId === null || deputyTeacherId === '' ? null : Number(deputyTeacherId);
    if (ht && !(await checkTeacher(ht))) return res.status(400).json({ error: '正班主任必须是教师账号' });
    if (dt && !(await checkTeacher(dt))) return res.status(400).json({ error: '副班主任必须是教师账号' });
    if (ht && ht === dt) return res.status(400).json({ error: '正副班主任不能是同一人' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO classes (class_name, grade, grade_id, academic_year, head_teacher_id, deputy_teacher_id, status, stream, elective_subjects)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8::jsonb) RETURNING id`,
        [name, g.rows[0].grade_name, gid, year, ht, dt, ns.stream, JSON.stringify(electives)]
      );
      if (ht) await syncTeacherClass(ht, rows[0].id);
      res.status(201).json({
        id: rows[0].id,
        stream: ns.stream,
        electiveSubjects: electives,
        effectiveSubjects: classSubjects.effectiveSubjects({ stream: ns.stream, electiveSubjects: electives }),
      });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: '该学年下已存在同名班级' });
      throw e;
    }
  } catch (err) { next(err); }
});

// PUT /api/classes/:id —— 编辑班级（名称/正副班主任）
// 指定正班主任时：若该班级已有其他正班主任且未传 force → 409 需确认覆盖
router.put('/classes/:id', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    const id = Number(req.params.id);
    const name = String(req.body.className ?? '').trim();
    const headTeacherId = req.body.headTeacherId === undefined || req.body.headTeacherId === null || req.body.headTeacherId === ''
      ? null : Number(req.body.headTeacherId);
    const deputyTeacherId = req.body.deputyTeacherId === undefined || req.body.deputyTeacherId === null || req.body.deputyTeacherId === ''
      ? null : Number(req.body.deputyTeacherId);
    if (!name) return res.status(400).json({ error: '班级名称不能为空' });
    if (headTeacherId && !(await checkTeacher(headTeacherId))) return res.status(400).json({ error: '正班主任必须是教师账号' });
    if (deputyTeacherId && !(await checkTeacher(deputyTeacherId))) return res.status(400).json({ error: '副班主任必须是教师账号' });
    if (headTeacherId && headTeacherId === deputyTeacherId) return res.status(400).json({ error: '正副班主任不能是同一人' });

    // 冲突检查：班级已有其他正班主任
    let prevHead = null;
    if (headTeacherId) {
      const force = req.body.force === true || req.body.force === 'true';
      const cur = await pool.query('SELECT head_teacher_id FROM classes WHERE id = $1', [id]);
      const existing = cur.rows[0] && cur.rows[0].head_teacher_id;
      prevHead = existing || null;
      if (existing && existing !== headTeacherId && !force) {
        const t = await pool.query(
          'SELECT COALESCE(NULLIF(real_name, \'\'), display_name, username) AS name FROM users WHERE id = $1',
          [existing]
        );
        return res.status(409).json({
          needConfirm: true,
          error: `该班级已有正班主任 ${(t.rows[0] && t.rows[0].name) || '未知'}，是否覆盖？`,
          existingTeacher: { id: existing, name: (t.rows[0] && t.rows[0].name) || '未知' },
        });
      }
    }

    // 选科组合 / 选科科目（v34）：可选更新
    //   · 传了组合、没传科目 → 新组合有预设（理科/文科）用预设；小理/小文/综合 保留该班原有选科（避免误清空）
    //   · 传了科目 → 以传入为准（空数组 = 清空选科，回到"沿用全局默认"）
    const streamRaw = req.body.stream ?? req.body.classStream;
    const electivesRaw = req.body.electiveSubjects ?? req.body.elective_subjects;
    const hasStream = streamRaw !== undefined && streamRaw !== null && String(streamRaw).trim() !== '';
    const hasElectives = electivesRaw !== undefined && electivesRaw !== null;
    let newStream = null, newElectives = null;
    if (hasStream || hasElectives) {
      const cur = await pool.query('SELECT stream, elective_subjects FROM classes WHERE id = $1', [id]);
      if (cur.rowCount === 0) return res.status(404).json({ error: '班级不存在' });
      const curS = classSubjects.readClassStream(cur.rows[0]);
      if (hasStream) {
        const ns = classSubjects.normalizeStream(streamRaw);
        if (ns.error) return res.status(400).json({ error: ns.error });
        newStream = ns.stream;
      } else {
        newStream = curS.stream;
      }
      if (hasElectives) {
        const ne = classSubjects.normalizeElectives(electivesRaw);
        if (ne.error) return res.status(400).json({ error: ne.error });
        newElectives = ne.subjects;
      } else {
        const preset = classSubjects.streamPreset(newStream);
        newElectives = preset.length ? preset : curS.electiveSubjects;
      }
    }

    const r = await pool.query(
      `UPDATE classes SET class_name = $2, head_teacher_id = $3, teacher_id = $3, deputy_teacher_id = $4,
              stream = COALESCE($5, stream),
              elective_subjects = COALESCE($6::jsonb, elective_subjects)
        WHERE id = $1`,
      [id, name, headTeacherId, deputyTeacherId, newStream,
        newElectives === null ? null : JSON.stringify(newElectives)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: '班级不存在' });
    if (headTeacherId) await syncTeacherClass(headTeacherId, id);
    // 换班主任：原班主任在本班的带班记录降级为任课老师，避免残留"班主任"身份（三处来源对齐）
    if (headTeacherId && prevHead && prevHead !== headTeacherId) {
      await pool.query(
        `UPDATE teacher_classes SET role_in_class = 'subject_teacher', is_head_teacher = false
          WHERE class_id = $1 AND teacher_id = $2 AND role_in_class = 'head_teacher'`,
        [id, prevHead]
      );
      await pool.query(
        `UPDATE users SET roles = CASE
           WHEN EXISTS (SELECT 1 FROM teacher_classes tc WHERE tc.teacher_id = $1 AND tc.role_in_class = 'head_teacher')
           THEN '["head_teacher"]'::json ELSE '["subject_teacher"]'::json END
         WHERE id = $1 AND role = 'teacher'`,
        [prevHead]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '该学年下已存在同名班级' });
    next(err);
  }
});

// POST /api/classes/:id/archive —— 归档班级（软删除：保留全部数据，签到页面不再出现）
router.post('/classes/:id/archive', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    const id = Number(req.params.id);
    const r = await pool.query(
      "UPDATE classes SET status = 'archived' WHERE id = $1 RETURNING id, status",
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: '班级不存在' });
    res.json({ ok: true, id, status: r.rows[0].status });
  } catch (err) { next(err); }
});

// POST /api/classes/:id/unarchive —— 取消归档（恢复为活跃）
router.post('/classes/:id/unarchive', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    const id = Number(req.params.id);
    const r = await pool.query(
      "UPDATE classes SET status = 'active' WHERE id = $1 RETURNING id, status",
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: '班级不存在' });
    res.json({ ok: true, id, status: r.rows[0].status });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------
// DELETE /api/classes/:id —— 彻底删除班级（含该班全部学生与历史）
//   安全设计（P0 第 2 步）：
//     · 数据库层面学生/考勤/作业/点名/点赞/叫号/带班关系外键均为 ON DELETE RESTRICT，
//       任何一句裸 SQL `DELETE FROM classes` 都会被拒绝，不可能静默清空历史；
//     · 唯一硬删除入口 = 本接口 → 调用 purge_class()（按顺序显式清理）；
//     · 默认拦截"班内还有在读学生"（400 HAS_ACTIVE_STUDENTS），
//       建议改用「归档」（保留数据、签到页面不再出现）；
//     · force=1（query 或 body）→ 管理员显式确认后连同在读学生一起彻底删除，不可恢复。
// ------------------------------------------------------------
router.delete('/classes/:id', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的班级ID' });
    const force = req.query.force === '1' || req.query.force === 'true'
      || (req.body && (req.body.force === true || req.body.force === 'true' || req.body.force === 1));

    const cls = await pool.query('SELECT id, class_name, status FROM classes WHERE id = $1', [id]);
    if (cls.rowCount === 0) return res.status(404).json({ error: '班级不存在' });

    const cnt = await pool.query(
      `SELECT count(*) FILTER (WHERE is_active = true)::int AS active,
              count(*)::int AS total
         FROM students WHERE class_id = $1`,
      [id]
    );
    const { active, total } = cnt.rows[0];
    if (active > 0 && !force) {
      return res.status(400).json({
        error: `该班级下还有 ${active} 名在读学生，无法彻底删除（建议先「归档」以保留数据，或先转班）`,
        code: 'HAS_ACTIVE_STUDENTS',
        activeStudents: active,
        totalStudents: total,
        hint: '如确认要连同学生与全部历史一起删除，请以 force=1 重试（不可恢复）',
      });
    }

    const client = await pool.connect();
    let purged;
    try {
      await client.query('BEGIN');
      const r = await client.query('SELECT purge_class($1) AS result', [id]);
      purged = r.rows[0].result;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({
      deleted: true,
      forced: force && active > 0,
      classId: id,
      className: cls.rows[0].class_name,
      studentsRemoved: (purged && purged.studentsRemoved) || 0,
    });
  } catch (err) { next(err); }
});

// GET /api/classes/import-template —— 班级导入模板下载（含选科组合/选科科目示例）
//   模板列：班级名称 | 年级 | 学年(可空=当前学年) | 选科组合 | 选科科目 | 班主任
//   注：同时兼容旧模板列（所属年级名称 / 班主任账号），导入接口两种列名都认
router.get('/classes/import-template', (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    const header = ['班级名称', '年级', '学年', '选科组合', '选科科目', '班主任'];
    const rows = [
      header,
      ['高三1班', '高三年级', '2026-2027', '理科', '物理、化学、生物', '张老师'],
      ['高三2班', '高三年级', '2026-2027', '文科', '政治、历史、地理', '李老师'],
      ['高三3班', '高三年级', '2026-2027', '小理', '物理、化学、地理', '王老师'],
      ['高三4班', '高三年级', '2026-2027', '小文', '政治、历史、生物', ''],
      ['高三5班', '高三年级', '2026-2027', '综合', '', ''],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 22 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '班级导入');
    // 填写说明单独一页（Excel 里好看，也便于老师核对可选值）
    const notes = XLSX.utils.aoa_to_sheet([
      ['列名', '说明'],
      ['班级名称', '必填，如 高三1班；同一学年下不能重名'],
      ['年级', '必填，年级名称（如 高三年级）；也兼容旧列名「所属年级名称」'],
      ['学年', '可空；留空则用当前学年；也兼容旧模板的「学年」列'],
      ['选科组合', '可空，默认「综合」；可选：理科 / 文科 / 小理 / 小文 / 综合'],
      ['选科科目', '可空；可选：物理、化学、生物、政治、历史、地理（多个用逗号/顿号分隔）；语文、数学、英语 默认都有，不用填'],
      ['班主任', '可空；填教师姓名（如 张老师）或账号（如 18288756588）；也兼容旧列名「班主任账号」'],
      ['', ''],
      ['选科组合预设', '理科 → 物理/化学/生物；文科 → 政治/历史/地理；小理/小文/综合 → 按「选科科目」列填写'],
      ['该班开设学科', '语文 + 数学 + 英语 + 选科科目（班长端每日作业按此自动生成）'],
    ]);
    notes['!cols'] = [{ wch: 16 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(wb, notes, '填写说明');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fn = '班级信息导入模板.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="classes_template.xlsx"; filename*=UTF-8''${encodeURIComponent(fn)}`);
    res.send(buf);
  } catch (err) { next(err); }
});

// POST /api/classes/import —— Excel 导入班级（含选科组合/选科科目/班主任）
//   新模板列：班级名称 | 年级 | 学年(可空) | 选科组合 | 选科科目 | 班主任
//   兼容旧模板列：所属年级名称 / 班主任账号
router.post('/classes/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
    const rows = parseExcel(req.file.buffer);
    const currentYear = await getCurrentYear();
    // 中文列名 → 取值（新列名优先，兼容旧列名）
    const pick = (r, ...keys) => {
      for (const k of keys) {
        const v = r[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
      return '';
    };
    let inserted = 0, skipped = 0;
    const errors = [];
    const createdClassIds = [];
    for (const r of rows) {
      const name = pick(r, '班级名称', '班级');
      const gradeName = pick(r, '年级', '所属年级名称', '所属年级', '年级名称');
      const year = pick(r, '学年', '学年度') || String(currentYear || '');
      const streamRaw = pick(r, '选科组合', '组合');
      const electivesRaw = pick(r, '选科科目', '选科');
      const teacherRaw = pick(r, '班主任', '班主任账号', '班主任姓名');
      if (!name || !gradeName || !year) { skipped += 1; errors.push({ name: name || '(空)', reason: '缺少 班级名称/年级/学年' }); continue; }

      // 选科组合 / 选科科目
      const ns = classSubjects.normalizeStream(streamRaw);
      if (ns.error) { skipped += 1; errors.push({ name, reason: ns.error }); continue; }
      if (electivesRaw) {
        const ne = classSubjects.normalizeElectives(electivesRaw);
        if (ne.error) { skipped += 1; errors.push({ name, reason: ne.error }); continue; }
      }
      const ne = electivesRaw ? classSubjects.normalizeElectives(electivesRaw) : { subjects: [] };
      const electives = ne.subjects.length ? ne.subjects : classSubjects.streamPreset(ns.stream);

      // 年级匹配
      const g = await pool.query(
        'SELECT id, grade_name FROM grades WHERE grade_name = $1 AND academic_year = $2',
        [gradeName, year]
      );
      if (g.rowCount === 0) { skipped += 1; errors.push({ name, reason: `年级不存在：${gradeName}（${year}）` }); continue; }

      // 班主任匹配（可选）：先按账号，再按真实姓名/显示名（要求唯一）
      let tid = null, tidErr = null;
      if (teacherRaw) {
        let u = await pool.query("SELECT id FROM users WHERE username = $1 AND role = 'teacher'", [teacherRaw]);
        if (u.rowCount === 0) {
          u = await pool.query(
            `SELECT id FROM users
              WHERE role = 'teacher' AND (real_name = $1 OR display_name = $1)`,
            [teacherRaw]
          );
        }
        if (u.rowCount === 0) tidErr = `找不到教师：${teacherRaw}`;
        else if (u.rowCount > 1) tidErr = `教师姓名不唯一（有 ${u.rowCount} 人）：${teacherRaw}，请改用账号`;
        else tid = u.rows[0].id;
      }
      if (tidErr) { skipped += 1; errors.push({ name, reason: tidErr }); continue; }

      try {
        // 权威字段是 head_teacher_id；teacher_id 为遗留兼容列，两处写同值保持一致
        const rr = await pool.query(
          `INSERT INTO classes (class_name, grade, grade_id, academic_year, head_teacher_id, teacher_id, status, stream, elective_subjects)
           VALUES ($1, $2, $3, $4, $5, $5, 'active', $6, $7::jsonb)
           RETURNING id`,
          [name, gradeName, g.rows[0].id, year, tid, ns.stream, JSON.stringify(electives)]
        );
        if (tid) await syncTeacherClass(tid, rr.rows[0].id);
        createdClassIds.push(rr.rows[0].id);
        inserted += 1;
      } catch (e) {
        if (e.code === '23505') { skipped += 1; errors.push({ name, reason: '该学年下已存在同名班级' }); continue; }
        throw e;
      }
    }
    if (inserted > 0) {
      await logOperation(req, 'class_import', { inserted, skipped, total: rows.length, classIds: createdClassIds });
    }
    res.json({ inserted, skipped, total: rows.length, errors: errors.slice(0, 20) });
  } catch (err) { next(err); }
});

// ============================================================
// 学年管理
// ============================================================

// GET /api/settings —— 当前学年 + 可选学年列表
router.get('/settings', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    const current = await getCurrentYear();
    const years = (
      await pool.query(
        `SELECT DISTINCT academic_year FROM grades
         UNION SELECT DISTINCT academic_year FROM classes
         UNION SELECT DISTINCT academic_year FROM students
         ORDER BY 1 DESC`
      )
    ).rows.map((r) => r.academic_year);
    if (!years.includes(current)) years.unshift(current);
    res.json({
      currentAcademicYear: current,
      years: [...new Set(years)],
      // 学期设置：已配置值 + 内置默认值（前端「使用默认值」按钮用）
      term: await termLib.getTermSettings(),
      termDefaults: termLib.defaultTermSettings(),
      termResolved: await termLib.resolveTermRange(),
    });
  } catch (err) { next(err); }
});

// GET /api/term —— 当前「本学期」口径（登录即可读：考勤分析/课堂表现/巡查面板都要用）
// 返回：{ configured, source, currentTerm, currentTermLabel, startDate, endDate, label, 四项日期 }
router.get('/term', async (req, res, next) => {
  try {
    res.json(await termLib.resolveTermRange());
  } catch (err) { next(err); }
});

// PUT /api/settings/term —— 保存学期设置（仅管理员）
// body: { firstStart, firstEnd, secondStart, secondEnd, currentTerm }
//   起止成对填写；全空 = 未配置（回退默认口径）；currentTerm: first|second
router.put('/settings/term', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    const r = await termLib.saveTermSettings(req.body || {});
    if (r.error) return res.status(r.status || 400).json({ error: r.error });
    res.json({ term: r.term, termResolved: r.resolved });
  } catch (err) { next(err); }
});

// PUT /api/settings/current-year —— 切换当前学年
router.put('/settings/current-year', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    const year = String(req.body.academicYear ?? '').trim();
    if (!/^\d{4}-\d{4}$/.test(year)) return res.status(400).json({ error: '学年格式应为 YYYY-YYYY' });
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('current_academic_year', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [year]
    );
    res.json({ currentAcademicYear: year });
  } catch (err) { next(err); }
});

// POST /api/academic-year/upgrade —— 一键升级（一年级→二年级...六年级→毕业）
// body: { targetYear, durationMinutes? }
router.post('/academic-year/upgrade', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    const current = await getCurrentYear();
    const targetYear = String(req.body.targetYear ?? '').trim();
    if (!targetYear) return res.status(400).json({ error: '缺少目标学年' });

    // 升级映射（一年级→二年级 ... 五年级→六年级，六年级→毕业）
    const LEVELS = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'];
    const nextOf = {};
    for (let i = 0; i < LEVELS.length - 1; i++) nextOf[LEVELS[i]] = LEVELS[i + 1];

    // 当前学年的年级
    const grades = (
      await pool.query('SELECT id, grade_name FROM grades WHERE academic_year = $1', [current])
    ).rows;
    // 目标学年的年级（已存在则复用，否则创建）
    const targetGradeName2Id = {};
    for (const g of grades) {
      const nextName = nextOf[g.grade_name] || null;
      if (!nextName) continue;
      // 六年级 → 毕业：学生直接标记毕业
      if (g.grade_name === '六年级') {
        await pool.query(
          `UPDATE students SET status='毕业', status_updated_at=now()
            WHERE class_id IN (SELECT id FROM classes WHERE grade_id = $1)`,
          [g.id]
        );
        continue;
      }
      // 确保目标学年存在该年级
      const t = await pool.query(
        'SELECT id FROM grades WHERE grade_name = $1 AND academic_year = $2',
        [nextName, targetYear]
      );
      let tgid;
      if (t.rowCount > 0) {
        tgid = t.rows[0].id;
      } else {
        const ins = await pool.query(
          `INSERT INTO grades (grade_name, grade_code, academic_year, sort_order)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [nextName, '', targetYear, 0]
        );
        tgid = ins.rows[0].id;
      }
      targetGradeName2Id[nextName] = tgid;
      // 当前学年班级 → 复制到目标学年（新班级记录）
      // 班主任以 head_teacher_id 为准（teacher_id 为遗留列，仅作兜底读取），两处写同值
      const cls = await pool.query(
        `SELECT id, class_name, COALESCE(head_teacher_id, teacher_id) AS head_id
           FROM classes WHERE grade_id = $1 AND academic_year = $2`,
        [g.id, current]
      );
      for (const c of cls.rows) {
        await pool.query(
          `INSERT INTO classes (class_name, grade, grade_id, academic_year, head_teacher_id, teacher_id, status)
           VALUES ($1, $2, $3, $4, $5, $5, 'active')
           ON CONFLICT (class_name, grade_id, academic_year) DO NOTHING`,
          [c.class_name, nextName, tgid, targetYear, c.head_id]
        );
      }
      // 学生迁移到新班级
      const newClass = await pool.query(
        'SELECT id FROM classes WHERE grade_id = $1 AND academic_year = $2',
        [tgid, targetYear]
      );
      if (newClass.rowCount > 0) {
        const oldClassIds = (await pool.query(
          'SELECT id FROM classes WHERE grade_id = $1 AND academic_year = $2',
          [g.id, current]
        )).rows.map((r) => r.id);
        // 学生按班级一一对应升级（一班→一班）
        const oldClasses = (await pool.query(
          'SELECT id, class_name FROM classes WHERE grade_id = $1 AND academic_year = $2 ORDER BY id',
          [g.id, current]
        )).rows;
        for (const oc of oldClasses) {
          const nc = (await pool.query(
            'SELECT id FROM classes WHERE grade_id = $1 AND academic_year = $2 AND class_name = $3',
            [tgid, targetYear, oc.class_name]
          )).rows[0];
          if (!nc) continue;
          await pool.query(
            `UPDATE students SET class_id = $2, academic_year = $3, status = '在读', status_updated_at = now()
              WHERE class_id = $1 AND is_active = true`,
            [oc.id, nc.id, targetYear]
          );
        }
        void oldClassIds;
      }
    }
    // 更新当前学年
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('current_academic_year', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [targetYear]
    );
    res.json({ ok: true, currentAcademicYear: targetYear });
  } catch (err) { next(err); }
});

// POST /api/academic-year/import —— 组合导入（Excel 多 Sheet）
// Sheet1 年级 / Sheet2 班级 / Sheet3 学生 / Sheet4 教师带班
router.post('/academic-year/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员' });
    if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = (name) => {
      const ws = wb.Sheets[name];
      return ws ? XLSX.utils.sheet_to_json(ws, { defval: '' }) : [];
    };
    const gradeRows = sheet('年级');
    const classRows = sheet('班级');
    const studentRows = sheet('学生');
    const teacherRows = sheet('教师带班');
    let grades = 0, classes = 0, students = 0, teachers = 0;

    // 1. 年级
    for (const r of gradeRows) {
      const name = String(r['年级名称'] ?? '').trim();
      const code = String(r['年级代码'] ?? '').trim();
      const year = String(r['学年'] ?? '').trim();
      if (!name || !year) continue;
      try {
        await pool.query(
          `INSERT INTO grades (grade_name, grade_code, academic_year) VALUES ($1,$2,$3)
           ON CONFLICT (grade_name, academic_year) DO UPDATE SET grade_code = EXCLUDED.grade_code`,
          [name, code, year]
        );
        grades += 1;
      } catch (e) { /* ignore */ }
    }
    // 2. 班级（按 班级名称+所属年级名称+学年 匹配）
    const classIdMap = {}; // key: name|gradeName|year -> id
    for (const r of classRows) {
      const name = String(r['班级名称'] ?? '').trim();
      const gradeName = String(r['所属年级名称'] ?? '').trim();
      const year = String(r['学年'] ?? '').trim();
      const teacherAccount = String(r['班主任账号'] ?? '').trim();
      if (!name || !gradeName || !year) continue;
      const g = await pool.query(
        'SELECT id FROM grades WHERE grade_name = $1 AND academic_year = $2',
        [gradeName, year]
      );
      if (g.rowCount === 0) continue;
      let tid = null;
      if (teacherAccount) {
        const u = await pool.query(
          "SELECT id FROM users WHERE username = $1 AND role = 'teacher'",
          [teacherAccount]
        );
        if (u.rowCount > 0) tid = u.rows[0].id;
      }
      try {
        // 班主任写入 head_teacher_id（主源），teacher_id 同步同值（遗留列，兼容读取）
        const ins = await pool.query(
          `INSERT INTO classes (class_name, grade, grade_id, academic_year, head_teacher_id, teacher_id, status)
           VALUES ($1, $2, $3, $4, $5, $5, 'active')
           ON CONFLICT (class_name, grade_id, academic_year) DO UPDATE
             SET head_teacher_id = EXCLUDED.head_teacher_id,
                 teacher_id      = EXCLUDED.head_teacher_id
           RETURNING id`,
          [name, gradeName, g.rows[0].id, year, tid]
        );
        classIdMap[`${name}|${gradeName}|${year}`] = ins.rows[0].id;
        classes += 1;
      } catch (e) { /* ignore */ }
    }
    // 3. 学生（学号、姓名、所属班级名称、学年）
    for (const r of studentRows) {
      const no = String(r['学号'] ?? '').trim();
      const name = String(r['姓名'] ?? '').trim();
      const className = String(r['所属班级名称'] ?? '').trim();
      const year = String(r['学年'] ?? '').trim();
      if (!no || !name) continue;
      // 找班级：需要所属年级 —— 遍历班级行缓存
      let cid = null;
      for (const key of Object.keys(classIdMap)) {
        if (key.startsWith(className + '|') && key.endsWith('|' + year)) {
          cid = classIdMap[key];
          break;
        }
      }
      if (!cid) continue;
      try {
        await pool.query(
          `INSERT INTO students (student_no, name, class_id, academic_year, status, is_active)
           VALUES ($1, $2, $3, $4, '在读', true)
           ON CONFLICT (student_no) DO UPDATE
             SET class_id = EXCLUDED.class_id, academic_year = EXCLUDED.academic_year,
                 name = EXCLUDED.name,
                 status = '在读', is_active = true, deleted_at = NULL`,
          [no, name, cid, year]
        );
        students += 1;
      } catch (e) { /* ignore */ }
    }
    // 4. 教师带班（教师账号、班级名称、学年）
    for (const r of teacherRows) {
      const account = String(r['教师账号'] ?? '').trim();
      const className = String(r['班级名称'] ?? '').trim();
      const year = String(r['学年'] ?? '').trim();
      if (!account || !className || !year) continue;
      const u = await pool.query(
        "SELECT id FROM users WHERE username = $1 AND role = 'teacher'",
        [account]
      );
      if (u.rowCount === 0) continue;
      const c = await pool.query(
        `SELECT c.id FROM classes c JOIN grades g ON g.id = c.grade_id
          WHERE c.class_name = $1 AND c.academic_year = $2`,
        [className, year]
      );
      if (c.rowCount === 0) continue;
      await pool.query('UPDATE users SET class_id = $2, academic_year = $3 WHERE id = $1', [u.rows[0].id, c.rows[0].id, year]);
      await syncTeacherClass(u.rows[0].id, c.rows[0].id);
      teachers += 1;
    }

    res.json({ grades, classes, students, teachers });
  } catch (err) { next(err); }
});

// ============================================================
// 学生异动
// ============================================================

// 异动类型 → 目标状态
const TRANSFER_STATUS = {
  '转班': '在读',
  '休学': '休学',
  '复学': '在读',
  '转学': '转学',
  '退学': '退学',
};

// POST /api/transfers —— 执行学生异动
// body: { studentId, transferType, toClassId?, reason?, effectiveDate? }
router.post('/transfers', async (req, res, next) => {
  try {
    if (!isAdminOrTeacher(req)) return res.status(403).json({ error: '无权限：仅管理员或教师' });
    const { studentId, transferType, toClassId, reason, effectiveDate } = req.body || {};
    const sid = Number(studentId);
    const type = String(transferType || '');
    if (!Number.isInteger(sid)) return res.status(400).json({ error: '请选择学生' });
    if (!TRANSFER_STATUS[type]) return res.status(400).json({ error: '异动类型无效' });
    const toStatus = TRANSFER_STATUS[type];
    const effDate = effectiveDate || new Date().toISOString().slice(0, 10);

    const stu = await pool.query(
      'SELECT id, student_no, name, class_id, status FROM students WHERE id = $1',
      [sid]
    );
    if (stu.rowCount === 0) return res.status(404).json({ error: '学生不存在' });
    const s = stu.rows[0];
    const fromClassId = s.class_id;
    const fromStatus = s.status;

    // 权限：教师只能操作本班学生
    if (req.session.user.role === 'teacher') {
      const myClasses = await teacherClassIds(req);
      if (!myClasses.length || !myClasses.includes(s.class_id)) {
        return res.status(403).json({ error: '无权操作其他班级的学生（仅限本班）' });
      }
    }

    let newClassId = fromClassId;
    if (type === '转班') {
      const tcid = Number(toClassId);
      if (!Number.isInteger(tcid)) return res.status(400).json({ error: '转班必须选择目标班级' });
      const c = await pool.query('SELECT id FROM classes WHERE id = $1', [tcid]);
      if (c.rowCount === 0) return res.status(400).json({ error: '目标班级不存在' });
      newClassId = tcid;
    } else if (type === '复学') {
      const tcid = Number(toClassId);
      if (!Number.isInteger(tcid)) return res.status(400).json({ error: '复学必须选择返校班级' });
      const c = await pool.query('SELECT id FROM classes WHERE id = $1', [tcid]);
      if (c.rowCount === 0) return res.status(400).json({ error: '返校班级不存在' });
      newClassId = tcid;
    }

    // 更新学生（异动后清空座位：座位与班级绑定，转入新班级后重新排座）
    await pool.query(
      'UPDATE students SET class_id = $2, status = $3, status_updated_at = now(), seat_row = 0, seat_col = 0 WHERE id = $1',
      [sid, newClassId, toStatus]
    );

    // 记录异动
    await pool.query(
      `INSERT INTO student_transfers
         (student_id, from_class_id, to_class_id, from_status, to_status, transfer_type, reason, effective_date, operator_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [sid, fromClassId, newClassId, fromStatus, toStatus, type, String(reason || '').slice(0, 200), effDate, req.session.user.id]
    );

    res.json({ ok: true, student: { id: sid, status: toStatus, classId: newClassId } });
  } catch (err) { next(err); }
});

// GET /api/transfers —— 异动历史（可按学生/班级/时间筛选）
router.get('/transfers', async (req, res, next) => {
  try {
    if (!isAdminOrTeacher(req)) return res.status(403).json({ error: '无权限：仅管理员或教师' });
    const studentId = req.query.studentId ? Number(req.query.studentId) : null;
    const classId = req.query.classId ? Number(req.query.classId) : null;
    const startDate = String(req.query.startDate || '');
    const endDate = String(req.query.endDate || '');
    // 教师：强制只看本班学生的异动记录（忽略班级筛选参数）
    const teacherCls = req.session.user.role === 'teacher' ? await teacherClassIds(req) : null;
    if (req.session.user.role === 'teacher' && !teacherCls.length) {
      return res.status(200).json({ transfers: [] });
    }
    const p = [];
    let where = 'WHERE 1=1';
    if (studentId) { p.push(studentId); where += ` AND t.student_id = $${p.length}`; }
    if (classId && !teacherCls) { p.push(classId); where += ` AND (t.from_class_id = $${p.length} OR t.to_class_id = $${p.length})`; }
    if (teacherCls) { p.push(teacherCls); where += ` AND s.class_id = ANY($${p.length})`; }
    if (startDate) { p.push(startDate); where += ` AND t.effective_date >= $${p.length}::date`; }
    if (endDate) { p.push(endDate); where += ` AND t.effective_date <= $${p.length}::date`; }
    const { rows } = await pool.query(
      `SELECT t.id, t.student_id, t.from_class_id, t.to_class_id, t.from_status, t.to_status,
              t.transfer_type, t.reason, t.effective_date, t.created_at, t.operator_id,
              s.student_no, s.name AS student_name,
              fc.class_name AS from_class, tc.class_name AS to_class,
              COALESCE(u.real_name, u.display_name, u.username) AS operator_name
         FROM student_transfers t
         JOIN students s ON s.id = t.student_id
         LEFT JOIN classes fc ON fc.id = t.from_class_id
         LEFT JOIN classes tc ON tc.id = t.to_class_id
         LEFT JOIN users u ON u.id = t.operator_id
         ${where}
        ORDER BY t.effective_date DESC, t.id DESC`,
      p
    );
    res.json({
      transfers: rows.map((r) => ({
        id: r.id,
        studentId: r.student_id,
        studentNo: r.student_no,
        studentName: r.student_name,
        fromClass: r.from_class || null,
        toClass: r.to_class || null,
        fromStatus: r.from_status,
        toStatus: r.to_status,
        transferType: r.transfer_type,
        reason: r.reason,
        effectiveDate: r.effective_date,
        createdAt: r.created_at,
        operatorName: r.operator_name || '—',
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/transfers/export —— 导出异动历史 Excel（与 /transfers 相同筛选）
router.get('/transfers/export', async (req, res, next) => {
  try {
    if (!isAdminOrTeacher(req)) return res.status(403).json({ error: '无权限：仅管理员或教师' });
    const classId = req.query.classId ? Number(req.query.classId) : null;
    const startDate = String(req.query.startDate || '');
    const endDate = String(req.query.endDate || '');
    // 教师：强制只导出本班学生异动
    const teacherCls = req.session.user.role === 'teacher' ? await teacherClassIds(req) : null;
    const p = [];
    let where = 'WHERE 1=1';
    if (classId && !teacherCls) { p.push(classId); where += ` AND (t.from_class_id = $${p.length} OR t.to_class_id = $${p.length})`; }
    if (teacherCls) { p.push(teacherCls); where += ` AND s.class_id = ANY($${p.length})`; }
    if (startDate) { p.push(startDate); where += ` AND t.effective_date >= $${p.length}::date`; }
    if (endDate) { p.push(endDate); where += ` AND t.effective_date <= $${p.length}::date`; }
    const { rows } = await pool.query(
      `SELECT t.effective_date, t.transfer_type, t.reason,
              s.student_no, s.name AS student_name,
              fc.class_name AS from_class, tc.class_name AS to_class,
              COALESCE(u.real_name, u.display_name, u.username) AS operator_name
         FROM student_transfers t
         JOIN students s ON s.id = t.student_id
         LEFT JOIN classes fc ON fc.id = t.from_class_id
         LEFT JOIN classes tc ON tc.id = t.to_class_id
         LEFT JOIN users u ON u.id = t.operator_id
         ${where}
        ORDER BY t.effective_date DESC, t.id DESC`,
      p
    );
    const data = rows.map((r) => ({
      日期: r.effective_date ? String(r.effective_date).slice(0, 10) : '',
      学生姓名: r.student_name,
      学号: r.student_no,
      异动类型: r.transfer_type,
      '原班级→新班级': `${r.from_class || '—'} → ${r.to_class || '—'}`,
      事由: r.reason || '',
      操作人: r.operator_name || '—',
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 24 }, { wch: 20 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, '异动历史');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fn = `异动历史_${startDate || '全部'}_至_${endDate || '全部'}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fn)}`);
    res.send(buf);
  } catch (err) { next(err); }
});

// DELETE /api/transfers/:id —— 删除异动记录（仅管理员）
router.delete('/transfers/:id', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: '无权限：仅管理员可删除异动记录' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的记录ID' });
    const r = await pool.query('DELETE FROM student_transfers WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: '异动记录不存在' });
    res.json({ deleted: true, id });
  } catch (err) { next(err); }
});

// 统一错误处理
router.use((err, req, res, next) => {
  console.error('[后台管理错误]', err);
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

module.exports = router;
