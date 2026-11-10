// ============================================================
// 小组管理 API（仅管理员）
//   GET    /api/permissions/catalog       权限目录（登录即可读，供前端表单渲染勾选项）
//   GET    /api/groups                    小组列表（含成员数）
//   GET    /api/groups/:id                小组详情（含成员）
//   POST   /api/groups                    新建小组
//   PUT    /api/groups/:id                编辑小组
//   DELETE /api/groups/:id                删除小组
//   GET    /api/groups/:id/members        小组成员
//   PUT    /api/groups/:id/members        设置成员（整体替换）body: { userIds: [] }
//   GET    /api/my/permissions            当前用户的小组与权限（也可从 /api/auth/me 拿）
// ============================================================
const express = require('express');
const pool = require('../db');
const perms = require('../lib/permissions');

const router = express.Router();

function adminOnly(req, res, next) {
  if (!(req.session && req.session.user)) return res.status(401).json({ error: '未登录' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: '无权限：仅管理员可管理小组' });
  next();
}

function validateName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return { error: '小组名称不能为空' };
  if (n.length > 50) return { error: '小组名称不能超过 50 个字符' };
  return { name: n };
}

function validateDesc(desc) {
  const d = String(desc == null ? '' : desc).trim();
  if (d.length > 200) return { error: '小组描述不能超过 200 个字符' };
  return { desc: d };
}

// GET /api/permissions/catalog —— 权限目录（页面 + 页面下的操作）
router.get('/permissions/catalog', async (req, res) => {
  if (!(req.session && req.session.user)) return res.status(401).json({ error: '未登录' });
  res.json({ pages: perms.PAGES });
});

// GET /api/my/permissions —— 当前用户所属小组与权限并集
router.get('/my/permissions', async (req, res, next) => {
  try {
    if (!(req.session && req.session.user)) return res.status(401).json({ error: '未登录' });
    const u = req.session.user;
    const { groups, permissions } = await perms.loadUserPermissions(pool, u.id, u.role);
    res.json({ groups, permissions });
  } catch (err) { next(err); }
});

// GET /api/groups —— 小组列表
router.get('/groups', adminOnly, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.id, g.name, g.description, g.permissions, g.created_at,
              (SELECT count(*)::int FROM user_groups ug WHERE ug.group_id = g.id) AS member_count
         FROM groups g
        ORDER BY g.id`
    );
    res.json({
      groups: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description || '',
        permissions: perms.normalizePermissions(perms.safeParse(r.permissions)),
        memberCount: r.member_count,
        createdAt: r.created_at,
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/groups/:id —— 小组详情（含成员）
router.get('/groups/:id', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const g = await pool.query(
      `SELECT g.id, g.name, g.description, g.permissions, g.created_at,
              (SELECT count(*)::int FROM user_groups ug WHERE ug.group_id = g.id) AS member_count
         FROM groups g WHERE g.id = $1`, [id]
    );
    if (g.rowCount === 0) return res.status(404).json({ error: '小组不存在' });
    const rows = g.rows[0];
    const members = await loadMembers(id);
    res.json({
      group: {
        id: rows.id,
        name: rows.name,
        description: rows.description || '',
        permissions: perms.normalizePermissions(perms.safeParse(rows.permissions)),
        memberCount: rows.member_count,
        createdAt: rows.created_at,
        members,
      },
    });
  } catch (err) { next(err); }
});

async function loadMembers(groupId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.role, COALESCE(u.real_name, u.display_name, u.username) AS name,
            u.class_id, c.class_name
       FROM user_groups ug
       JOIN users u ON u.id = ug.user_id
       LEFT JOIN classes c ON c.id = u.class_id
      WHERE ug.group_id = $1
      ORDER BY u.id`, [groupId]
  );
  return rows.map((r) => ({ id: r.id, username: r.username, role: r.role, name: r.name, classId: r.class_id, className: r.class_name }));
}

// POST /api/groups —— 新建
router.post('/groups', adminOnly, async (req, res, next) => {
  try {
    const body = req.body || {};
    const nameV = validateName(body.name);
    if (nameV.error) return res.status(400).json({ error: nameV.error });
    const descV = validateDesc(body.description);
    if (descV.error) return res.status(400).json({ error: descV.error });
    const permissions = perms.normalizePermissions(body.permissions);

    const dup = await pool.query('SELECT id FROM groups WHERE lower(btrim(name)) = lower(btrim($1))', [nameV.name]);
    if (dup.rowCount > 0) return res.status(409).json({ error: '已存在同名小组' });

    const { rows } = await pool.query(
      `INSERT INTO groups (name, description, permissions) VALUES ($1, $2, $3::jsonb)
       RETURNING id, name, description, permissions, created_at`,
      [nameV.name, descV.desc, JSON.stringify(permissions)]
    );
    const g = rows[0];
    // 可选：建组时直接指定成员
    if (Array.isArray(body.userIds) && body.userIds.length) {
      await setMembers(g.id, body.userIds);
    }
    res.status(201).json({
      group: {
        id: g.id, name: g.name, description: g.description || '',
        permissions: perms.normalizePermissions(perms.safeParse(g.permissions)),
        memberCount: Array.isArray(body.userIds) ? body.userIds.length : 0,
        createdAt: g.created_at,
      },
    });
  } catch (err) { next(err); }
});

// PUT /api/groups/:id —— 编辑
router.put('/groups/:id', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const cur = await pool.query('SELECT id FROM groups WHERE id = $1', [id]);
    if (cur.rowCount === 0) return res.status(404).json({ error: '小组不存在' });

    const nameV = validateName(body.name);
    if (nameV.error) return res.status(400).json({ error: nameV.error });
    const descV = validateDesc(body.description);
    if (descV.error) return res.status(400).json({ error: descV.error });
    const permissions = perms.normalizePermissions(body.permissions);

    const dup = await pool.query(
      'SELECT id FROM groups WHERE lower(btrim(name)) = lower(btrim($1)) AND id <> $2', [nameV.name, id]
    );
    if (dup.rowCount > 0) return res.status(409).json({ error: '已存在同名小组' });

    const { rows } = await pool.query(
      `UPDATE groups SET name = $2, description = $3, permissions = $4::jsonb
        WHERE id = $1
        RETURNING id, name, description, permissions, created_at`,
      [id, nameV.name, descV.desc, JSON.stringify(permissions)]
    );
    const g = rows[0];
    const cnt = await pool.query('SELECT count(*)::int AS n FROM user_groups WHERE group_id = $1', [id]);
    res.json({
      group: {
        id: g.id, name: g.name, description: g.description || '',
        permissions: perms.normalizePermissions(perms.safeParse(g.permissions)),
        memberCount: cnt.rows[0].n, createdAt: g.created_at,
      },
    });
  } catch (err) { next(err); }
});

// DELETE /api/groups/:id —— 删除（成员关联随之删除）
router.delete('/groups/:id', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query('DELETE FROM groups WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: '小组不存在' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/groups/:id/members
router.get('/groups/:id/members', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const g = await pool.query('SELECT id FROM groups WHERE id = $1', [id]);
    if (g.rowCount === 0) return res.status(404).json({ error: '小组不存在' });
    res.json({ members: await loadMembers(id) });
  } catch (err) { next(err); }
});

async function setMembers(groupId, userIds) {
  const ids = [...new Set((userIds || []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))];
  // 只保留真实存在的用户
  let valid = [];
  if (ids.length) {
    const u = await pool.query('SELECT id FROM users WHERE id = ANY($1::int[])', [ids]);
    valid = u.rows.map((r) => r.id);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_groups WHERE group_id = $1', [groupId]);
    for (const uid of valid) {
      await client.query(
        'INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT (user_id, group_id) DO NOTHING',
        [uid, groupId]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return valid;
}

// PUT /api/groups/:id/members —— 设置成员（整体替换）
router.put('/groups/:id/members', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const g = await pool.query('SELECT id FROM groups WHERE id = $1', [id]);
    if (g.rowCount === 0) return res.status(404).json({ error: '小组不存在' });
    const userIds = (req.body && req.body.userIds) || [];
    const valid = await setMembers(id, userIds);
    res.json({ ok: true, count: valid.length, members: await loadMembers(id) });
  } catch (err) { next(err); }
});

// POST /api/groups/:id/members —— 追加单个成员（不改动其它成员）
router.post('/groups/:id/members', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const userId = Number(req.body && req.body.userId);
    const g = await pool.query('SELECT id FROM groups WHERE id = $1', [id]);
    if (g.rowCount === 0) return res.status(404).json({ error: '小组不存在' });
    if (!Number.isInteger(userId)) return res.status(400).json({ error: '用户参数无效' });
    const u = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (u.rowCount === 0) return res.status(404).json({ error: '用户不存在' });
    await pool.query(
      'INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT (user_id, group_id) DO NOTHING',
      [userId, id]
    );
    res.json({ ok: true, members: await loadMembers(id) });
  } catch (err) { next(err); }
});

// DELETE /api/groups/:id/members/:userId —— 移出成员
router.delete('/groups/:id/members/:userId', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const userId = Number(req.params.userId);
    const r = await pool.query('DELETE FROM user_groups WHERE group_id = $1 AND user_id = $2', [id, userId]);
    if (r.rowCount === 0) return res.status(404).json({ error: '该用户不在此小组中' });
    res.json({ ok: true, members: await loadMembers(id) });
  } catch (err) { next(err); }
});

// 统一错误处理（唯一约束冲突等给友好提示）
router.use((err, req, res, next) => {
  if (err && err.code === '23505') return res.status(409).json({ error: '数据冲突：名称重复' });
  console.error('[小组管理错误]', err);
  res.status(500).json({ error: '服务器内部错误', detail: err && err.message });
});

module.exports = router;
