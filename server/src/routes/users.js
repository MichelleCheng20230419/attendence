// 账号管理 API（仅管理员）
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const pool = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const VALID_ROLES = ['admin', 'teacher', 'student', 'monitor'];

// 校验班级是否已有班长账号（每班限 1 个）；excludeUserId 用于编辑时排除自己
async function checkMonitorExists(classId, excludeUserId) {
  const p = [classId];
  let sql = "SELECT id FROM users WHERE role = 'monitor' AND is_active = true AND class_id = $1";
  if (excludeUserId) { p.push(excludeUserId); sql += ' AND id <> $2'; }
  const r = await pool.query(sql, p);
  return r.rowCount > 0;
}

// 管理员校验（路由级中间件）
router.use((req, res, next) => {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  res.status(403).json({ error: '无权限：仅管理员可操作账号管理' });
});

// 校验班级存在
async function checkClass(classId) {
  if (!Number.isInteger(classId)) return false;
  const r = await pool.query('SELECT id FROM classes WHERE id = $1', [classId]);
  return r.rowCount > 0;
}

// 班主任冲突检查：班级已有其他正班主任时返回冲突信息（需前端确认覆盖）
// 返回 null 表示无冲突
async function checkClassTeacherConflict(classId, teacherId, force) {
  if (!classId || !teacherId) return null;
  const c = await pool.query('SELECT head_teacher_id FROM classes WHERE id = $1', [classId]);
  const existing = c.rows[0] && c.rows[0].head_teacher_id;
  if (existing && existing !== teacherId && !force) {
    const t = await pool.query(
      'SELECT COALESCE(NULLIF(real_name, \'\'), display_name, username) AS name FROM users WHERE id = $1',
      [existing]
    );
    return {
      needConfirm: true,
      existingTeacher: { id: existing, name: (t.rows[0] && t.rows[0].name) || '未知' },
    };
  }
  return null;
}

// ============================================================
// 班主任唯一写入源（P0 收敛）：三处入口统一调用本函数
//   入口：① 账号管理/班级管理（管理员）② 教师端保存带班记录 ③ 教师个人资料改班级
//   写入：classes.head_teacher_id（权威）+ classes.teacher_id（遗留兼容，同值）
//         users.class_id、users.roles、teacher_classes（带班关系权威表）
//   唯一性：该教师原任班主任的其他班级一并解除（classes 与 teacher_classes 同步降级）
// ============================================================
async function syncTeacherClass(teacherId, classId) {
  if (!teacherId || !classId) return;
  await pool.query(
    "UPDATE users SET class_id = $2 WHERE id = $1 AND role = 'teacher'",
    [teacherId, classId]
  );
  // 1) 解除该教师在其他班级的班主任（head_teacher_id 权威 + teacher_id 同值兜底）
  await pool.query(
    `UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL
      WHERE (head_teacher_id = $1 OR teacher_id = $1) AND id <> $2`,
    [teacherId, classId]
  );
  // 2) 目标班级写入正班主任
  await pool.query(
    'UPDATE classes SET head_teacher_id = $2, teacher_id = $2 WHERE id = $1',
    [classId, teacherId]
  );
  // 3) 已不再是班主任的班级 → 带班记录同步降级（保持 classes 与 teacher_classes 一致）
  await pool.query(
    `UPDATE teacher_classes tc SET role_in_class = 'subject_teacher', is_head_teacher = false
      WHERE tc.teacher_id = $1 AND tc.class_id <> $2 AND tc.role_in_class = 'head_teacher'
        AND NOT EXISTS (SELECT 1 FROM classes c WHERE c.id = tc.class_id AND c.head_teacher_id = $1)`,
    [teacherId, classId]
  );
  // 4) 目标班级的带班记录（teacher_classes 为带班关系权威来源）
  await pool.query(
    `INSERT INTO teacher_classes (teacher_id, class_id, role_in_class, is_head_teacher, subject)
     VALUES ($1, $2, 'head_teacher', true, NULL)
     ON CONFLICT (teacher_id, class_id)
     DO UPDATE SET role_in_class = 'head_teacher', is_head_teacher = true`,
    [teacherId, classId]
  );
  // 5) 同步 users.roles（仍有班主任班级 → head_teacher，否则 subject_teacher）
  await pool.query(
    `UPDATE users SET roles = CASE
       WHEN EXISTS (SELECT 1 FROM teacher_classes tc WHERE tc.teacher_id = $1 AND tc.role_in_class = 'head_teacher')
       THEN '["head_teacher"]'::json ELSE '["subject_teacher"]'::json END
     WHERE id = $1 AND role = 'teacher'`,
    [teacherId]
  );
}

// 显示名兜底：真实姓名 → 显示名 → 账号名
function teacherDisplayName(u) {
  return u.real_name || u.display_name || u.username;
}

// 当前活跃管理员数量
async function countActiveAdmins() {
  const r = await pool.query(
    "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active = true"
  );
  return r.rows[0].n;
}

// 账号角色标签（列表展示用）：管理员/班主任/任课老师/班长/学生
function roleLabelOf(u, teachingClasses) {
  if (u.role === 'admin') return '管理员';
  if (u.role === 'monitor') return '班长';
  if (u.role === 'student') return '学生';
  if (u.role === 'teacher') {
    const list = teachingClasses || [];
    if (list.some((c) => c.roleInClass === 'head_teacher')) return '班主任';
    if (list.some((c) => c.roleInClass === 'subject_teacher')) return '任课老师';
    return '教师（未带班）';
  }
  return u.role;
}

function mapUser(u) {
  let roles = u.roles;
  if (typeof roles === 'string') { try { roles = JSON.parse(roles); } catch (_) { roles = []; } }
  if (!Array.isArray(roles)) roles = [];
  const teachingClasses = u.teaching_classes || [];
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    roles,
    roleLabel: roleLabelOf(u, teachingClasses),
    subject: u.subject || null,
    profileLocked: u.profile_locked === true,   // 教师教学设置是否已锁定（false=待教师首次确认）
    isActive: u.is_active,
    classId: u.class_id,
    className: u.class_name || null,
    displayName: u.display_name,
    realName: u.real_name || null,
    createdAt: u.created_at,
    teachingClasses,
  };
}

// 单个账号详情（含带班记录：班级 + 在该班角色 + 学科）——新增/编辑接口返回用
async function loadUserDetail(id) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.role, u.roles, u.subject, u.profile_locked, u.is_active, u.class_id, u.display_name, u.real_name, u.created_at,
            c.class_name
       FROM users u
       LEFT JOIN classes c ON c.id = u.class_id
      WHERE u.id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  const tc = await pool.query(
    `SELECT tc.class_id, tc.subject,
            COALESCE(tc.role_in_class, CASE WHEN tc.is_head_teacher THEN 'head_teacher' ELSE 'subject_teacher' END) AS role_in_class,
            c.class_name, c.grade
       FROM teacher_classes tc LEFT JOIN classes c ON c.id = tc.class_id
      WHERE tc.teacher_id = $1
      ORDER BY c.class_name NULLS LAST, tc.class_id`,
    [id]
  );
  rows[0].teaching_classes = tc.rows.map((r) => ({
    classId: r.class_id,
    className: r.class_name || null,
    grade: r.grade || null,
    roleInClass: r.role_in_class,
    isHeadTeacher: r.role_in_class === 'head_teacher',
    subject: r.subject || null,
  }));
  return mapUser(rows[0]);
}

// 依据"班级级角色"同步账号级 roles（有任何班主任班级 → head_teacher，否则 subject_teacher）
async function syncRolesFromClasses(teacherId, client) {
  const q = client ? client.query.bind(client) : pool.query.bind(pool);
  const r = await q(
    `SELECT count(*) FILTER (WHERE role_in_class = 'head_teacher') AS head_cnt FROM teacher_classes WHERE teacher_id = $1`,
    [teacherId]
  );
  const isHead = Number(r.rows[0].head_cnt) > 0;
  const roles = isHead ? ['head_teacher'] : ['subject_teacher'];
  await q('UPDATE users SET roles = $2::json WHERE id = $1', [teacherId, JSON.stringify(roles)]);
  return roles;
}

// 依据【班级级班主任记录】同步 classes.head_teacher_id
//   仅"班主任"记录会写入班级班主任；"任课老师"记录不影响班级班主任字段
//   不抢占：该班已有其他班主任时不动（班级管理页 / 既有数据优先）
//   该教师已不再是班主任的班级 → 清空，避免残留
async function syncHeadTeacherFromClasses(teacherId, client) {
  if (!teacherId) return;
  const q = client ? client.query.bind(client) : pool.query.bind(pool);
  const r = await q(
    `SELECT class_id FROM teacher_classes WHERE teacher_id = $1 AND role_in_class = 'head_teacher'`,
    [teacherId]
  );
  const ids = r.rows.map((x) => x.class_id);
  if (ids.length > 0) {
    await q(
      `UPDATE classes SET head_teacher_id = $1, teacher_id = $1
        WHERE id = ANY($2::int[]) AND (head_teacher_id IS NULL OR head_teacher_id = $1)`,
      [teacherId, ids]
    );
  }
  await q(
    `UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL
      WHERE head_teacher_id = $1 AND NOT (id = ANY($2::int[]))`,
    [teacherId, ids]
  );
}

// 写入教师带班记录（整体覆盖）；classes: [{ classId, roleInClass, subject? }]
async function saveTeacherClasses(teacherId, classes, client) {
  const q = client ? client.query.bind(client) : pool.query.bind(pool);
  const cleaned = [];
  for (const item of classes || []) {
    const cid = Number(item && item.classId);
    if (!Number.isInteger(cid) || cid <= 0) continue;
    if (!(await checkClass(cid))) return { error: `班级 #${cid} 不存在` };
    const role = String((item && (item.roleInClass || item.role)) || '').trim();
    const legacyHead = !!(item && (item.isHeadTeacher === true || item.isHeadTeacher === 'true')); // 兼容旧参数
    const roleInClass = (role === 'head_teacher' || legacyHead) ? 'head_teacher' : 'subject_teacher';
    const subject = item && item.subject ? String(item.subject).trim().slice(0, 20) : null;
    cleaned.push({ classId: cid, roleInClass, subject });
  }
  const uniq = [...new Map(cleaned.map((c) => [c.classId, c])).values()];
  await q('DELETE FROM teacher_classes WHERE teacher_id = $1', [teacherId]);
  for (const c of uniq) {
    await q(
      `INSERT INTO teacher_classes (teacher_id, class_id, role_in_class, is_head_teacher, subject)
       VALUES ($1, $2, $3, $4, $5)`,
      [teacherId, c.classId, c.roleInClass, c.roleInClass === 'head_teacher', c.subject]
    );
  }
  await syncRolesFromClasses(teacherId, client);
  return { classes: uniq };
}

// GET /api/users/teacher-classes?teacherId= —— 教师带班记录（班级 + 在该班角色 + 学科）
router.get('/teacher-classes', async (req, res, next) => {
  try {
    const tid = Number(req.query.teacherId);
    if (!Number.isInteger(tid)) return res.status(400).json({ error: '缺少有效的 teacherId' });
    const r = await pool.query(
      `SELECT tc.class_id,
              COALESCE(tc.role_in_class, CASE WHEN tc.is_head_teacher THEN 'head_teacher' ELSE 'subject_teacher' END) AS role_in_class,
              tc.subject, c.class_name, c.grade
         FROM teacher_classes tc LEFT JOIN classes c ON c.id = tc.class_id
        WHERE tc.teacher_id = $1 ORDER BY c.class_name NULLS LAST, tc.class_id`,
      [tid]
    );
    res.json({
      teacherClasses: r.rows.map((x) => ({
        classId: x.class_id,
        className: x.class_name || null,
        grade: x.grade || null,
        roleInClass: x.role_in_class,
        isHeadTeacher: x.role_in_class === 'head_teacher',
        subject: x.subject || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/teacher-classes —— 设置教师带班记录（班级 + 在该班角色）
// body: { teacherId, classes: [{ classId, roleInClass('head_teacher'|'subject_teacher'), subject? }] }（整体覆盖）
// 兼容旧参数 isHeadTeacher；设置后同步 users.roles（有班主任班级 → head_teacher，否则 subject_teacher）
router.post('/teacher-classes', async (req, res, next) => {
  try {
    const teacherId = Number(req.body.teacherId);
    if (!Number.isInteger(teacherId)) return res.status(400).json({ error: '缺少有效的 teacherId' });
    const list = Array.isArray(req.body.classes) ? req.body.classes : [];

    const u = await pool.query('SELECT id, role FROM users WHERE id = $1', [teacherId]);
    if (u.rowCount === 0) return res.status(404).json({ error: '账号不存在' });
    if (u.rows[0].role !== 'teacher') {
      return res.status(400).json({ error: '只有教师账号可以设置带班班级' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const saved = await saveTeacherClasses(teacherId, list, client);
      if (saved.error) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: saved.error });
      }
      await syncHeadTeacherFromClasses(teacherId, client);
      await client.query('COMMIT');
      res.json({ ok: true, teacherId, classes: saved.classes });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/users —— 账号列表（教师附带带班记录：班级 + 在该班角色 + 学科）
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.role, u.roles, u.subject, u.profile_locked, u.is_active, u.class_id, u.display_name, u.real_name, u.created_at,
              c.class_name
         FROM users u
         LEFT JOIN classes c ON c.id = u.class_id
        ORDER BY u.id`
    );
    const tc = await pool.query(
      `SELECT tc.teacher_id, tc.class_id, tc.subject,
              COALESCE(tc.role_in_class, CASE WHEN tc.is_head_teacher THEN 'head_teacher' ELSE 'subject_teacher' END) AS role_in_class,
              c.class_name, c.grade
         FROM teacher_classes tc LEFT JOIN classes c ON c.id = tc.class_id
        ORDER BY c.class_name NULLS LAST, tc.class_id`
    );
    const byTeacher = new Map();
    for (const r of tc.rows) {
      if (!byTeacher.has(r.teacher_id)) byTeacher.set(r.teacher_id, []);
      byTeacher.get(r.teacher_id).push({
        classId: r.class_id,
        className: r.class_name || null,
        grade: r.grade || null,
        roleInClass: r.role_in_class,
        isHeadTeacher: r.role_in_class === 'head_teacher',
        subject: r.subject || null,
      });
    }
    res.json({
      users: rows.map((u) => mapUser({ ...u, teaching_classes: byTeacher.get(u.id) || [] })),
    });
  } catch (err) {
    next(err);
  }
});

// 角色 → roles(JSON) 初始值：admin | head_teacher | subject_teacher | monitor（学生为空）
function initialRoles(role) {
  if (role === 'admin') return ['admin'];
  if (role === 'monitor') return ['monitor'];
  if (role === 'student') return [];
  return ['subject_teacher']; // 教师：任课老师（若为班主任，后续设置班级时自动升级为 head_teacher）
}

// POST /api/users —— 添加账号
// body: { username, password, role, classId?, realName?, isActive?, subject?, teachingClasses? }
//   teachingClasses: [{ classId, roleInClass: 'head_teacher'|'subject_teacher', subject? }]
//   （教师：带班角色按【班级】设置，可多条；不传时按 classId 建一条班主任记录，兼容旧用法）
router.post('/', async (req, res, next) => {
  try {
    const { username, password, role, classId, realName, isActive, subject, teachingClasses } = req.body || {};
    const name = String(username ?? '').trim();
    const pwd = String(password ?? '');
    const rl = String(role ?? '');
    const rName = String(realName ?? '').trim();
    const subj = subject ? String(subject).trim().slice(0, 20) : null;

    // 显式传了 teachingClasses（哪怕空数组）→ 走【班级级带班记录】模式
    const listGiven = rl === 'teacher' && Array.isArray(teachingClasses);

    if (!name) return res.status(400).json({ error: '用户名不能为空' });
    if (name.length > 50) return res.status(400).json({ error: '用户名过长' });
    if (pwd.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (!VALID_ROLES.includes(rl)) return res.status(400).json({ error: '角色必须是 admin/teacher/student/monitor' });
    if (rl === 'teacher' && !rName) return res.status(400).json({ error: '教师账号必须填写真实姓名' });

    let cid = null;
    let conflict = null;
    if (rl !== 'admin') {
      // 教师使用【带班记录】时可不必填单一班级（class_id 仅作账号归属，可空）
      if (listGiven) {
        cid = Number(classId) || null;
        if (cid && !(await checkClass(cid))) cid = null;
      } else {
        cid = Number(classId);
        if (!(await checkClass(cid))) {
          return res.status(400).json({ error: '教师/学生/班长账号必须选择有效班级' });
        }
      }
      // 班长：每班限 1 个
      if (rl === 'monitor') {
        if (await checkMonitorExists(cid)) {
          return res.status(409).json({ error: '该班级已有班长账号，每班只能创建 1 个班长' });
        }
      }
      // 教师分配班级：若班级已有其他班主任 → 需确认覆盖（force=1 跳过）
      if (rl === 'teacher' && !listGiven && cid) {
        const force = req.body.force === true || req.body.force === 'true';
        const c = await pool.query(
          'SELECT COALESCE(head_teacher_id, teacher_id) AS head_id FROM classes WHERE id = $1',
          [cid]
        );
        const existing = c.rows[0] && c.rows[0].head_id;
        if (existing && !force) {
          const t = await pool.query(
            'SELECT COALESCE(real_name, display_name, username) AS name FROM users WHERE id = $1',
            [existing]
          );
          return res.status(409).json({
            needConfirm: true,
            error: `该班级已有班主任 ${(t.rows[0] && t.rows[0].name) || '未知'}，是否覆盖？`,
            existingTeacher: { id: existing, name: (t.rows[0] && t.rows[0].name) || '未知' },
          });
        }
      }
    }

    const active = isActive === undefined ? true : !!isActive;
    const mustChange = rl === 'monitor'; // 班长默认密码 123456，首次登录强制修改
    const insertRealName = rl === 'teacher' ? rName : (rName || null);
    // 教学设置锁定：新建教师默认 false（由教师首次登录时确认，避免管理员配错）；
    // 管理员也可显式传 profileLocked=true 直接锁定
    const profileLocked = rl === 'teacher' ? (req.body.profileLocked === true) : false;
    let insertRes;
    try {
      insertRes = await pool.query(
        `INSERT INTO users (username, password, role, class_id, is_active, display_name, real_name, must_change_password, roles, subject, profile_locked)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::json, $10, $11)
         RETURNING id`,
        [name, pwd, rl, cid, active, insertRealName || name, insertRealName, mustChange, JSON.stringify(initialRoles(rl)), subj, profileLocked]
      );
    } catch (e) {
      if (e.code === '23505') {
        return res.status(409).json({ error: `用户名 ${name} 已存在` });
      }
      throw e;
    }

    if (rl === 'teacher' && listGiven) {
      // 按【班级级带班记录】写入（可多条，每条单独指定班主任/任课老师）
      const saved = await saveTeacherClasses(insertRes.rows[0].id, teachingClasses);
      if (saved.error) {
        await pool.query('DELETE FROM users WHERE id = $1', [insertRes.rows[0].id]).catch(() => {});
        return res.status(400).json({ error: saved.error });
      }
      await syncHeadTeacherFromClasses(insertRes.rows[0].id);
    } else if (rl === 'teacher' && cid) {
      // 联动：兼容旧用法（单班级 → 该班班主任）
      await syncTeacherClass(insertRes.rows[0].id, cid);
    }

    const created = await loadUserDetail(insertRes.rows[0].id);
    res.status(201).json({ user: created });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id —— 编辑账号（用户名不可修改；可改角色/班级/状态）
router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的用户ID' });

    const { role, classId, isActive, realName, subject, teachingClasses, profileLocked, resetProfileLock } = req.body || {};
    const rl = String(role ?? '');
    const rName = String(realName ?? '').trim();
    const subj = subject !== undefined ? (subject ? String(subject).trim().slice(0, 20) : null) : null;
    if (!VALID_ROLES.includes(rl)) return res.status(400).json({ error: '角色必须是 admin/teacher/student/monitor' });
    if (rl === 'teacher' && !rName) return res.status(400).json({ error: '教师账号必须填写真实姓名' });

    const { rows } = await pool.query(
      'SELECT id, username, role, is_active FROM users WHERE id = $1',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '账号不存在' });
    const target = rows[0];

    // 不能把自己降级或禁用（防止锁死）
    if (id === req.session.user.id) {
      if (rl !== 'admin' || isActive === false) {
        return res.status(400).json({ error: '不能修改自己的角色或禁用自己' });
      }
    }

    // 不能把最后一个启用管理员降级/禁用
    if (target.role === 'admin' && target.is_active && (rl !== 'admin' || isActive === false)) {
      const n = await countActiveAdmins();
      if (n <= 1) {
        return res.status(400).json({ error: '系统至少需要保留一个启用的管理员' });
      }
    }

    let cid = null;
    const list = Array.isArray(teachingClasses) ? teachingClasses : null;
    // 显式传了 teachingClasses（哪怕空数组=清空带班）→ 走【班级级带班记录】模式
    const listGiven = rl === 'teacher' && Array.isArray(list);
    if (rl !== 'admin') {
      if (listGiven) {
        cid = Number(classId) || null;
        if (cid && !(await checkClass(cid))) cid = null;
      } else {
        cid = Number(classId);
        if (!(await checkClass(cid))) {
          return res.status(400).json({ error: '教师/学生/班长账号必须选择有效班级' });
        }
      }
      // 班长：每班限 1 个（编辑时排除自己）
      if (rl === 'monitor') {
        if (await checkMonitorExists(cid, id)) {
          return res.status(409).json({ error: '该班级已有班长账号，每班只能创建 1 个班长' });
        }
      }
    }

    // 教师分配班级：若班级已有其他班主任 → 需确认覆盖（force=1 跳过）
    if (rl === 'teacher' && !listGiven && cid) {
      const force = req.body.force === true || req.body.force === 'true';
      const conflict = await checkClassTeacherConflict(cid, id, force);
      if (conflict) return res.status(409).json(conflict);
    }

    const active = isActive === undefined ? target.is_active : !!isActive;
    // 角色被改为班长时：标记首次登录强制改密
    const mustChange = target.role !== 'monitor' && rl === 'monitor';
    // 教学设置锁定：
    //   profileLocked 显式传布尔 → 按传入值设置；resetProfileLock=true → 置 false（教师下次登录重新确认）
    //   均未传 → 保持原值（管理员修改学科/班级不会解除锁定）
    let lockValue = null;
    if (typeof profileLocked === 'boolean') lockValue = profileLocked;
    else if (resetProfileLock === true || resetProfileLock === 'true') lockValue = false;
    await pool.query(
      `UPDATE users SET role = $2::varchar, class_id = $3, is_active = $4,
              real_name = CASE WHEN $5 THEN $6 ELSE real_name END,
              must_change_password = CASE WHEN $7 THEN TRUE ELSE must_change_password END,
              subject = CASE WHEN $2::varchar = 'teacher' THEN $8 ELSE subject END,
              profile_locked = CASE
                                 WHEN $2::varchar <> 'teacher' THEN profile_locked
                                 WHEN $9::boolean IS NULL THEN profile_locked
                                 ELSE $9::boolean
                               END,
              roles = CASE
                        WHEN $2::varchar = 'admin'   THEN '["admin"]'::json
                        WHEN $2::varchar = 'monitor' THEN '["monitor"]'::json
                        WHEN $2::varchar = 'student' THEN '[]'::json
                        WHEN $2::varchar = 'teacher' AND EXISTS (SELECT 1 FROM teacher_classes tc WHERE tc.teacher_id = $1 AND tc.role_in_class = 'head_teacher')
                             THEN '["head_teacher"]'::json
                        WHEN $2::varchar = 'teacher' THEN '["subject_teacher"]'::json
                        ELSE roles
                      END
        WHERE id = $1`,
      [id, rl, cid, active, rl === 'teacher', rName, mustChange, subj, lockValue]
    );

    // 教师带班记录（按班级级角色整体覆盖；空数组=清空带班）
    if (listGiven) {
      const saved = await saveTeacherClasses(id, list);
      if (saved.error) return res.status(400).json({ error: saved.error });
      await syncHeadTeacherFromClasses(id);
    }

    // 联动：兼容旧用法（单班级 → 该班班主任）
    if (rl === 'teacher' && !listGiven && cid) await syncTeacherClass(id, cid);

    const updated = await loadUserDetail(id);
    res.json({ user: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/users/:id —— 删除账号（历史签到记录不受影响）
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的用户ID' });

    if (id === req.session.user.id) {
      return res.status(400).json({ error: '不能删除自己的账号' });
    }
    const { rows } = await pool.query(
      'SELECT id, role, is_active FROM users WHERE id = $1',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '账号不存在' });
    if (rows[0].role === 'admin' && rows[0].is_active) {
      const n = await countActiveAdmins();
      if (n <= 1) {
        return res.status(400).json({ error: '系统至少需要保留一个启用的管理员' });
      }
    }
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ deleted: true, id });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ error: '该账号已被班级引用（正/副班主任），请先在班级管理中解除后再删除' });
    }
    next(err);
  }
});

// POST /api/users/:id/reset-password —— 重置密码为 123456
router.post('/:id/reset-password', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的用户ID' });
    const r = await pool.query(
      "UPDATE users SET password = '123456' WHERE id = $1",
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: '账号不存在' });
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/import —— Excel 导入账号
// 模板：用户名、密码、角色、真实姓名、所属班级名称、学年
// 教师/学生账号的班级按名称+学年匹配，不存在计入 notFound
router.post('/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    let inserted = 0, skipped = 0, notFound = 0;
    for (const r of rows) {
      const username = String(r['用户名'] ?? '').trim();
      const password = String(r['密码'] ?? '').trim();
      const role = String(r['角色'] ?? '').trim();
      const realName = String(r['真实姓名'] ?? '').trim();
      const className = String(r['所属班级名称'] ?? '').trim();
      const year = String(r['学年'] ?? '').trim();
      if (!username || !password || !VALID_ROLES.includes(role)) { skipped += 1; continue; }
      if (password.length < 6) { skipped += 1; continue; }
      let cid = null;
      if (role !== 'admin') {
        if (!className || !year) { skipped += 1; continue; }
        const c = await pool.query(
          `SELECT c.id FROM classes c JOIN grades g ON g.id = c.grade_id
            WHERE c.class_name = $1 AND c.academic_year = $2`,
          [className, year]
        );
        if (c.rowCount === 0) { notFound += 1; continue; }
        cid = c.rows[0].id;
      }
      try {
        const rr = await pool.query(
          `INSERT INTO users (username, password, role, class_id, academic_year, real_name, display_name, is_active, must_change_password)
           VALUES ($1, $2, $3, $4, $5, $6, $6, true, $7)
           ON CONFLICT (username) DO UPDATE
             SET role = EXCLUDED.role, class_id = EXCLUDED.class_id,
                 academic_year = EXCLUDED.academic_year, real_name = EXCLUDED.real_name,
                 display_name = EXCLUDED.display_name, is_active = true,
                 must_change_password = CASE WHEN EXCLUDED.role = 'monitor' THEN TRUE ELSE users.must_change_password END`,
          [username, password, role, cid, year || '2026-2027', realName || username, role === 'monitor']
        );
        inserted += rr.rowCount;
      } catch (e) {
        if (e.code === '23505') { skipped += 1; continue; }
        throw e;
      }
    }
    res.json({ inserted, skipped, notFound, total: rows.length });
  } catch (err) { next(err); }
});

// 统一错误处理
router.use((err, req, res, next) => {
  console.error('[账号管理错误]', err);
  res.status(500).json({ error: '服务器内部错误', detail: err.message });
});

module.exports = router;
// 供「教师账号批量导入」（server/src/lib/teacherImport.js）复用带班记录写入逻辑
module.exports.saveTeacherClasses = saveTeacherClasses;
module.exports.syncHeadTeacherFromClasses = syncHeadTeacherFromClasses;
// 班主任唯一写入源：供 admin.js（班级管理）与 auth.js（个人资料改班级）复用
module.exports.syncTeacherClass = syncTeacherClass;
