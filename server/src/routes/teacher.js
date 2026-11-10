// ============================================================
// 教师教学设置 API（个人中心 → 教学设置）
//   GET  /api/teacher/settings  教学设置（学科 + 所带班级 + 锁定状态）—— 个人中心主入口
//   GET  /api/teacher/subject   获取所教学科
//   GET  /api/teacher/classes   获取所带班级
//   PUT  /api/teacher/subject   设置所教学科（仅未锁定时可写）
//   PUT  /api/teacher/classes   设置所带班级（仅未锁定时可写；可同时提交 subject 与 lock=1 完成"确认并锁定"）
// 权限规则：
//   - 仅教师账号可用（其他角色 403）
//   - profile_locked = false（首次登录，未确认）→ 教师可自行设置
//   - profile_locked = true （已确认/管理员已配置）→ 只读，403「如需修改请联系管理员」
//     仅管理员可在「账号管理」中修改（PUT /api/users/:id、POST /api/users/teacher-classes），
//     管理员可将 profile_locked 重置为 false，让教师重新确认。
// 其他规则：
//   - 班主任班级自动保留在绑定列表中，避免误取消导致班主任权限失效
//   - 写带班记录后同步 users.roles（有班主任班级 → head_teacher，否则 subject_teacher）
// ============================================================
const express = require('express');
const pool = require('../db');

const router = express.Router();

// 可选学科（与作业模块下拉一致）
const TEACH_SUBJECTS = [
  '语文', '数学', '英语', '物理', '化学', '生物',
  '历史', '政治', '地理', '其他',
];
const SUBJECT_SET = new Set(TEACH_SUBJECTS);

const LOCK_HINT = '教学设置已锁定，如需修改请联系管理员';

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

// 仅教师
function requireTeacher(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'teacher') return next();
  return res.status(403).json({ error: '无权限：仅教师账号可查看教学信息' });
}

// 教学设置是否已锁定 + 未锁定时放行写操作
async function loadLockState(teacherId) {
  const r = await pool.query('SELECT subject, profile_locked FROM users WHERE id = $1', [teacherId]);
  const row = r.rows[0] || {};
  return { subject: row.subject || null, profileLocked: row.profile_locked === true };
}

async function requireUnlocked(req, res) {
  const st = await loadLockState(req.session.user.id);
  if (st.profileLocked) {
    res.status(403).json({ error: `无权限：${LOCK_HINT}`, profileLocked: true, readOnly: true });
    return null;
  }
  return st;
}

// 该教师担任（正/副）班主任的班级 id（兼容 classes 表关联）
async function headClassIdsOf(teacherId) {
  const r = await pool.query(
    `SELECT id FROM classes
      WHERE teacher_id = $1 OR head_teacher_id = $1 OR deputy_teacher_id = $1`,
    [teacherId]
  );
  return r.rows.map((x) => x.id);
}

// 教师带班记录（班级 + 在该班角色 + 该班学科）
async function listTeachingClasses(teacherId) {
  const r = await pool.query(
    `SELECT tc.class_id, tc.subject,
            COALESCE(tc.role_in_class, CASE WHEN tc.is_head_teacher THEN 'head_teacher' ELSE 'subject_teacher' END) AS role_in_class,
            c.class_name, c.grade
       FROM teacher_classes tc
       LEFT JOIN classes c ON c.id = tc.class_id
      WHERE tc.teacher_id = $1
      ORDER BY c.class_name NULLS LAST, tc.class_id`,
    [teacherId]
  );
  return r.rows.map((x) => ({
    classId: x.class_id,
    className: x.class_name || `班级 #${x.class_id}`,
    grade: x.grade || null,
    roleInClass: x.role_in_class,
    isHeadTeacher: x.role_in_class === 'head_teacher',
    subject: x.subject || null,
  }));
}

// ------------------------------------------------------------
// GET /api/teacher/settings —— 教学设置（学科 + 所带班级 + 锁定状态）
// ------------------------------------------------------------
router.get('/teacher/settings', requireTeacher, async (req, res, next) => {
  try {
    const st = await loadLockState(req.session.user.id);
    const classes = await listTeachingClasses(req.session.user.id);
    res.json({
      subject: st.subject,
      subjects: TEACH_SUBJECTS,
      classes,
      classIds: classes.map((c) => c.classId),
      headClassIds: classes.filter((c) => c.isHeadTeacher).map((c) => c.classId),
      profileLocked: st.profileLocked,
      canEdit: !st.profileLocked,
      hint: st.profileLocked ? LOCK_HINT : '首次登录，请确认您的所教学科和所带班级',
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// GET /api/teacher/subject —— 获取所教学科
// ------------------------------------------------------------
router.get('/teacher/subject', requireTeacher, async (req, res, next) => {
  try {
    const st = await loadLockState(req.session.user.id);
    res.json({
      subject: st.subject,
      subjects: TEACH_SUBJECTS,
      profileLocked: st.profileLocked,
      canEdit: !st.profileLocked,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// PUT /api/teacher/subject —— 设置所教学科（仅未锁定时）
// ------------------------------------------------------------
router.put('/teacher/subject', requireTeacher, async (req, res, next) => {
  try {
    const st = await requireUnlocked(req, res);
    if (!st) return;
    const raw = req.body && req.body.subject !== undefined ? String(req.body.subject).trim() : '';
    if (raw && !SUBJECT_SET.has(raw)) {
      return res.status(400).json({ error: '学科不在可选范围内' });
    }
    const subject = raw || null;
    await pool.query('UPDATE users SET subject = $2 WHERE id = $1', [req.session.user.id, subject]);
    await logOperation(req, 'teacher_subject_update', { subject, selfService: true });
    res.json({ subject, profileLocked: false });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// GET /api/teacher/classes —— 获取所带班级
// ------------------------------------------------------------
router.get('/teacher/classes', requireTeacher, async (req, res, next) => {
  try {
    const st = await loadLockState(req.session.user.id);
    const classes = await listTeachingClasses(req.session.user.id);
    res.json({
      classes,
      classIds: classes.map((c) => c.classId),
      headClassIds: classes.filter((c) => c.isHeadTeacher).map((c) => c.classId),
      profileLocked: st.profileLocked,
      canEdit: !st.profileLocked,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// PUT /api/teacher/classes —— 设置所带班级（仅未锁定时）
//   body: { classIds: [..], subject?: '物理', lock?: true }
//   lock=true → 保存后置 profile_locked=true（"确认并锁定"）
// ------------------------------------------------------------
router.put('/teacher/classes', requireTeacher, async (req, res, next) => {
  try {
    const st = await requireUnlocked(req, res);
    if (!st) return;
    const teacherId = req.session.user.id;
    const raw = Array.isArray(req.body && req.body.classIds) ? req.body.classIds : [];
    const classIds = [...new Set(raw.map(Number).filter((x) => Number.isInteger(x) && x > 0))];

    // 可同时提交学科（首次确认时一次性保存）
    let subject = st.subject;
    let subjectGiven = false;
    if (req.body && req.body.subject !== undefined) {
      const s = String(req.body.subject || '').trim();
      if (s && !SUBJECT_SET.has(s)) return res.status(400).json({ error: '学科不在可选范围内' });
      subject = s || null;
      subjectGiven = true;
    }
    const wantLock = req.body && (req.body.lock === true || req.body.lock === 'true' || req.body.lock === 1);
    if (wantLock && !subject) {
      return res.status(400).json({ error: '请先选择所教学科，再确认锁定' });
    }

    // 校验班级存在
    if (classIds.length > 0) {
      const c = await pool.query('SELECT id FROM classes WHERE id = ANY($1::int[])', [classIds]);
      const valid = new Set(c.rows.map((x) => x.id));
      const bad = classIds.filter((x) => !valid.has(x));
      if (bad.length > 0) return res.status(400).json({ error: `班级不存在：${bad.join(', ')}` });
    }

    // 班主任班级自动保留（避免误取消导致班主任权限失效）
    const headIds = await headClassIdsOf(teacherId);
    const finalIds = [...new Set([...classIds, ...headIds])];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (subjectGiven) {
        await client.query('UPDATE users SET subject = $2 WHERE id = $1', [teacherId, subject]);
      }
      if (finalIds.length === 0) {
        await client.query('DELETE FROM teacher_classes WHERE teacher_id = $1', [teacherId]);
      } else {
        await client.query(
          'DELETE FROM teacher_classes WHERE teacher_id = $1 AND class_id <> ALL($2::int[])',
          [teacherId, finalIds]
        );
        // 班主任班级 → head_teacher；其余 → subject_teacher（逐班学科用账号学科，保持简单）
        await client.query(
          `INSERT INTO teacher_classes (teacher_id, class_id, role_in_class, is_head_teacher, subject)
           SELECT $1, cid,
                  CASE WHEN cid = ANY($3::int[]) THEN 'head_teacher' ELSE 'subject_teacher' END,
                  (cid = ANY($3::int[])),
                  NULL
             FROM unnest($2::int[]) AS cid
           ON CONFLICT (teacher_id, class_id)
           DO UPDATE SET role_in_class = EXCLUDED.role_in_class,
                         is_head_teacher = EXCLUDED.is_head_teacher`,
          [teacherId, finalIds, headIds]
        );
      }
      const isHead = finalIds.some((cid) => headIds.includes(cid));
      const roles = isHead ? ['head_teacher'] : ['subject_teacher'];
      await client.query('UPDATE users SET roles = $2::json WHERE id = $1', [teacherId, JSON.stringify(roles)]);
      if (wantLock) {
        await client.query('UPDATE users SET profile_locked = true WHERE id = $1', [teacherId]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const classes = await listTeachingClasses(teacherId);
    await logOperation(req, wantLock ? 'teacher_settings_confirm_lock' : 'teacher_classes_update', {
      classIds: finalIds, headClassIds: headIds, subject, locked: !!wantLock,
    });
    res.json({
      classes,
      classIds: classes.map((c) => c.classId),
      headClassIds: classes.filter((c) => c.isHeadTeacher).map((c) => c.classId),
      subject,
      profileLocked: !!wantLock,
      canEdit: !wantLock,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
