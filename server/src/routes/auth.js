// 认证与个人中心相关 API
const express = require('express');
const pool = require('../db');
const perms = require('../lib/permissions');
// 班主任唯一写入源（定义在 users.js）：个人资料改班级 → 同步班级班主任
const { syncTeacherClass } = require('./users');

const router = express.Router();

// POST /api/auth/login —— 登录（记录上次登录时间/IP）
// body: { username, password }
router.post('/auth/login', async (req, res, next) => {
  try {
    const username = String(req.body && req.body.username ? req.body.username : '').trim();
    const password = String(req.body && req.body.password ? req.body.password : '');
    if (!username || !password) {
      return res.status(400).json({ error: '请输入用户名和密码' });
    }

    const { rows } = await pool.query(
      'SELECT id, username, password, role, display_name, real_name, is_active, last_login_at, last_login_ip, must_change_password, roles, subject, profile_locked FROM users WHERE username = $1',
      [username]
    );
    if (rows.length === 0 || rows[0].password !== password) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const u = rows[0];
    if (!u.is_active) {
      return res.status(403).json({ error: '该账号已被禁用，请联系管理员' });
    }

    // “上次登录”= 本次登录前的记录值；然后更新为本次
    const lastLogin = {
      at: u.last_login_at,
      ip: u.last_login_ip,
    };
    const ip = String(
      req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''
    ).split(',')[0].trim();
    await pool.query(
      'UPDATE users SET last_login_at = now(), last_login_ip = $2 WHERE id = $1',
      [u.id, ip]
    );

    req.session.user = {
      id: u.id,
      username: u.username,
      role: u.role,
      displayName: u.display_name,
      realName: u.real_name || null,
      roles: Array.isArray(u.roles) ? u.roles : (() => { try { return JSON.parse(u.roles || '[]'); } catch (_) { return []; } })(),
      mustChangePassword: !!u.must_change_password,
      profileLocked: u.profile_locked === true,   // 教师教学设置是否已锁定
      subject: u.subject || null,
    };
    req.session.lastLogin = lastLogin;
    // 教师未确认教学设置 → 前端登录后强制跳转个人中心「教学设置」
    const needProfileSetup = u.role === 'teacher' && u.profile_locked !== true;
    res.json({ user: req.session.user, needProfileSetup });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/change-password —— 修改密码（含首次登录强制改密）
// body: { oldPassword, newPassword }
router.post('/auth/change-password', async (req, res, next) => {
  try {
    if (!(req.session && req.session.user)) {
      return res.status(401).json({ error: '未登录' });
    }
    const oldPassword = String(req.body && req.body.oldPassword ? req.body.oldPassword : '');
    const newPassword = String(req.body && req.body.newPassword ? req.body.newPassword : '');
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: '请输入原密码和新密码' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '新密码至少 6 位' });
    }
    if (newPassword === oldPassword) {
      return res.status(400).json({ error: '新密码不能与原密码相同' });
    }
    const { rows } = await pool.query(
      'SELECT password FROM users WHERE id = $1',
      [req.session.user.id]
    );
    if (rows.length === 0 || rows[0].password !== oldPassword) {
      return res.status(400).json({ error: '原密码错误' });
    }
    await pool.query(
      'UPDATE users SET password = $2, must_change_password = false WHERE id = $1',
      [req.session.user.id, newPassword]
    );
    req.session.user.mustChangePassword = false;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout —— 登出（清除会话）
router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// GET /api/auth/me —— 当前登录用户（含所带班级 + 角色 roles + 班主任班级 + 小组权限）
router.get('/auth/me', async (req, res, next) => {
  try {
    if (!(req.session && req.session.user)) {
      return res.status(401).json({ error: '未登录' });
    }
    // 实时读取所带班级/角色（后台修改后立即生效）
    const u = await pool.query(
      'SELECT class_id, role, roles, subject, profile_locked FROM users WHERE id = $1',
      [req.session.user.id]
    );
    const row = u.rows[0] || {};
    const classId = row.class_id || null;
    let roles = row.roles;
    if (typeof roles === 'string') { try { roles = JSON.parse(roles); } catch (_) { roles = []; } }
    if (!Array.isArray(roles)) roles = [];
    // 班主任班级 / 任课班级
    let headClassIds = [];
    let teachClassIds = [];
    if (row.role === 'teacher') {
      const tc = await pool.query(
        'SELECT class_id, is_head_teacher FROM teacher_classes WHERE teacher_id = $1',
        [req.session.user.id]
      );
      teachClassIds = tc.rows.map((x) => x.class_id);
      headClassIds = tc.rows.filter((x) => x.is_head_teacher).map((x) => x.class_id);
    }
    // 小组与小组权限并集（管理员 = 全部权限；无小组 = 空权限，不影响现有角色菜单）
    let groupInfo = { groups: [], permissions: { pages: [], actions: [], all: false } };
    try {
      groupInfo = await perms.loadUserPermissions(pool, req.session.user.id, row.role || req.session.user.role);
    } catch (e) {
      // 迁移未执行等异常不影响登录流程
      console.error('[小组权限读取失败]', e.message);
    }
    const user = {
      ...req.session.user,
      classId,
      roles,
      headClassIds,
      teachClassIds,
      subject: row.subject || null,
      profileLocked: row.profile_locked === true,
      groups: groupInfo.groups.map((g) => ({ id: g.id, name: g.name, description: g.description })),
      permissions: groupInfo.permissions,
      // 教师未确认教学设置 → 前端强制进入个人中心「教学设置」
      needProfileSetup: row.role === 'teacher' && row.profile_locked !== true,
    };
    req.session.user = { ...req.session.user, roles, profileLocked: user.profileLocked }; // 同步会话，避免过期
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// 个人中心
// ============================================================

// GET /api/user/profile —— 获取个人信息（含班级统计、上次登录）
router.get('/user/profile', async (req, res, next) => {
  try {
    if (!(req.session && req.session.user)) {
      return res.status(401).json({ error: '未登录' });
    }
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.role, u.display_name, u.real_name, u.employee_no,
              u.organization, u.phone, u.email, u.class_id, u.last_login_at, u.last_login_ip,
              u.subject, u.profile_locked,
              c.class_name, c.grade
         FROM users u
         LEFT JOIN classes c ON c.id = u.class_id
        WHERE u.id = $1`,
      [req.session.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    const u = rows[0];

    // 所带班级统计：学生人数 + 本周出勤率（本周一 0 点起）
    let classStats = null;
    if (u.class_id) {
      const cnt = await pool.query(
        'SELECT count(*)::int AS n FROM students WHERE class_id = $1 AND is_active = true',
        [u.class_id]
      );
      const wk = await pool.query(
        `SELECT COALESCE(SUM(CASE WHEN r.status IN ('present','late') THEN 1 ELSE 0 END), 0)::int AS attended,
                count(*)::int AS total
           FROM attendance_records r
           JOIN attendance_sessions s ON s.id = r.session_id
           JOIN students st ON st.id = r.student_id
          WHERE st.class_id = $1 AND st.is_active = true
            AND s.start_time >= date_trunc('week', now())`,
        [u.class_id]
      );
      classStats = {
        classId: u.class_id,
        className: u.class_name,
        grade: u.grade,
        studentCount: cnt.rows[0].n,
        weekAttended: wk.rows[0].attended,
        weekTotal: wk.rows[0].total,
        weekRate: wk.rows[0].total > 0 ? Math.round((wk.rows[0].attended / wk.rows[0].total) * 100) : null,
      };
    }

    res.json({
      user: {
        id: u.id,
        username: u.username,
        role: u.role,
        displayName: u.display_name,
        realName: u.real_name || null,
        employeeNo: u.employee_no,
        organization: u.organization,
        phone: u.phone,
        email: u.email,
        classId: u.class_id,
        className: u.class_name,
        grade: u.grade,
        subject: u.subject || null,
        profileLocked: u.profile_locked === true,
        needProfileSetup: u.role === 'teacher' && u.profile_locked !== true,
      },
      lastLogin:
        (req.session.lastLogin && req.session.lastLogin.at)
          ? req.session.lastLogin
          : (u.last_login_at ? { at: u.last_login_at, ip: u.last_login_ip } : null),
      classStats,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/user/profile —— 更新个人信息
// body: { displayName, organization?, phone?, email?, classId? }
router.put('/user/profile', async (req, res, next) => {
  try {
    if (!(req.session && req.session.user)) {
      return res.status(401).json({ error: '未登录' });
    }
    const userId = req.session.user.id;
    const { displayName, organization, phone, email, classId } = req.body || {};

    const name = String(displayName ?? '').trim();
    const org = String(organization ?? '').trim();
    const ph = String(phone ?? '').trim();
    const em = String(email ?? '').trim();

    // 校验
    if (!name) return res.status(400).json({ error: '姓名不能为空' });
    if (ph && !/^\d{11}$/.test(ph)) return res.status(400).json({ error: '手机号必须是 11 位数字' });
    if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ error: '邮箱格式不正确' });

    let cid = null;
    if (classId !== undefined && classId !== null && classId !== '') {
      cid = Number(classId);
      if (!Number.isInteger(cid)) return res.status(400).json({ error: '班级参数无效' });
      const c = await pool.query('SELECT id FROM classes WHERE id = $1', [cid]);
      if (c.rowCount === 0) return res.status(400).json({ error: '所选班级不存在' });
    }

    await pool.query(
      'UPDATE users SET display_name = $2, organization = $3, phone = $4, email = $5, class_id = $6 WHERE id = $1',
      [userId, name, org, ph, em, cid]
    );

    // 联动：教师修改所带班级 → 同步班级班主任（双向一致，唯一写入源）
    // 同时更新 classes.head_teacher_id（权威）+ teacher_id（遗留兼容）+ teacher_classes 记录
    if (req.session.user.role === 'teacher') {
      if (cid) {
        await syncTeacherClass(userId, cid);
      } else {
        // 未选班级：解除该教师担任的班主任（两列 + 带班记录一起清）
        await pool.query(
          `UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL
            WHERE head_teacher_id = $1 OR teacher_id = $1`,
          [userId]
        );
        await pool.query(
          `UPDATE teacher_classes SET role_in_class = 'subject_teacher', is_head_teacher = false
            WHERE teacher_id = $1 AND role_in_class = 'head_teacher'`,
          [userId]
        );
        await pool.query(
          `UPDATE users SET roles = CASE
             WHEN EXISTS (SELECT 1 FROM teacher_classes tc WHERE tc.teacher_id = $1 AND tc.role_in_class = 'head_teacher')
             THEN '["head_teacher"]'::json ELSE '["subject_teacher"]'::json END
           WHERE id = $1 AND role = 'teacher'`,
          [userId]
        );
      }
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.role, u.display_name, u.employee_no,
              u.organization, u.phone, u.email, u.class_id, c.class_name, c.grade
         FROM users u
         LEFT JOIN classes c ON c.id = u.class_id
        WHERE u.id = $1`,
      [userId]
    );
    const u = rows[0];
    req.session.user = { id: u.id, username: u.username, role: u.role, displayName: u.display_name };

    res.json({
      user: {
        id: u.id,
        username: u.username,
        role: u.role,
        displayName: u.display_name,
        employeeNo: u.employee_no,
        organization: u.organization,
        phone: u.phone,
        email: u.email,
        classId: u.class_id,
        className: u.class_name,
        grade: u.grade,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/user/change-password —— 修改密码
// body: { oldPassword, newPassword, confirmPassword }
router.post('/user/change-password', async (req, res, next) => {
  try {
    if (!(req.session && req.session.user)) {
      return res.status(401).json({ error: '未登录' });
    }
    const userId = req.session.user.id;
    const { oldPassword, newPassword, confirmPassword } = req.body || {};
    if (!oldPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: '请填写完整的密码信息' });
    }
    if (String(newPassword) !== String(confirmPassword)) {
      return res.status(400).json({ error: '两次输入的新密码不一致' });
    }
    if (String(newPassword).length < 4) {
      return res.status(400).json({ error: '新密码至少 4 位' });
    }
    const { rows } = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
    if (rows.length === 0) return res.status(404).json({ error: '用户不存在' });
    if (rows[0].password !== String(oldPassword)) {
      return res.status(400).json({ error: '原密码错误' });
    }
    await pool.query('UPDATE users SET password = $2 WHERE id = $1', [userId, String(newPassword)]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// 统一错误处理
router.use((err, req, res, next) => {
  console.error('[认证错误]', err);
  res.status(500).json({ error: '服务器内部错误', detail: err.message });
});

module.exports = router;
