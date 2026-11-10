// ============================================================
// 小组权限：目录（catalog）+ 解析（resolve）+ 校验中间件
// ------------------------------------------------------------
// 设计要点
//   · pages   —— 页面/菜单权限（决定导航栏能看到哪些菜单、能否打开对应页面）
//   · actions —— 操作权限（页面下的细分动作，如巡堂记录的"创建问题/添加反馈/上传照片"）
//   · 目录是【唯一来源】：前端"小组管理"表单的勾选项由 GET /api/permissions/catalog 下发，
//     后端校验用同一份常量，新增页面/操作只改这里。
//   · 与现有角色的关系：小组权限是【叠加】的 —— 老角色菜单不变，小组成员额外获得授权菜单；
//     没有小组的用户与现在完全一致（兼容策略）。
//   · 管理员固定拥有全部权限，不受小组限制。
// ============================================================
const pool = require('../db');

// 页面/菜单权限目录
const PAGES = [
  {
    key: 'dashboard',
    label: '签到操作',
    desc: '签到操作台（所有角色默认可见，无需授权）',
    default: true,
  },
  {
    key: 'attendance_management',
    label: '考勤管理',
    desc: '计划管理、学生管理',
    actions: [
      { key: 'plan_manage', label: '计划管理' },
      { key: 'student_manage', label: '学生管理' },
      { key: 'session_start', label: '发起签到' },
      { key: 'batch_checkin', label: '批量签到' },
      { key: 'makeup', label: '补签' },
    ],
  },
  {
    key: 'teaching_tools',
    label: '教学工具',
    desc: '叫号管理、随机点名、作业管理',
    actions: [
      { key: 'announce_publish', label: '发布叫号' },
      { key: 'random_call', label: '随机点名' },
      { key: 'homework_publish', label: '发布作业' },
    ],
  },
  {
    key: 'data_stats',
    label: '数据统计',
    desc: '作业统计、课堂表现、考勤分析',
    actions: [
      { key: 'homework_report', label: '作业统计' },
      { key: 'performance', label: '课堂表现' },
      { key: 'analysis', label: '考勤分析' },
      { key: 'export', label: '导出数据' },
    ],
  },
  {
    key: 'inspection',
    label: '巡堂记录',
    desc: '巡堂问题记录与处理（列表 / 记录问题 / 详情反馈）',
    actions: [
      { key: 'view', label: '查看巡堂记录' },
      { key: 'create_issue', label: '创建问题' },
      { key: 'add_feedback', label: '添加反馈' },
      { key: 'upload_photo', label: '上传照片' },
    ],
  },
  {
    key: 'system_management',
    label: '系统管理',
    desc: '账号/年级/班级/学年/小组管理',
    adminOnly: true,
  },
];

const PAGE_KEYS = PAGES.map((p) => p.key);
const ACTION_KEYS = {};
PAGES.forEach((p) => { ACTION_KEYS[p.key] = (p.actions || []).map((a) => a.key); });

function isKnownPage(key) { return PAGE_KEYS.indexOf(key) >= 0; }
function isKnownAction(pageKey, actionKey) {
  return (ACTION_KEYS[pageKey] || []).indexOf(actionKey) >= 0;
}

// 规整前端传来的权限对象：
//   { pages: [...], actions: [...] } → 去重、只保留已知 key、按目录顺序排序
// 返回 { pages, actions }；pages 里的未知 key 直接丢弃（不报错，保持宽容）
function normalizePermissions(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const rawPages = Array.isArray(src.pages) ? src.pages : [];
  const rawActions = Array.isArray(src.actions) ? src.actions : [];

  const pages = PAGE_KEYS.filter((k) => rawPages.indexOf(k) >= 0 && k !== 'system_management');
  // 'dashboard' 是默认权限，不写进库（人人都有），保持数据干净
  const pagesStored = pages.filter((k) => k !== 'dashboard');

  const actions = [];
  PAGES.forEach((p) => {
    (ACTION_KEYS[p.key] || []).forEach((ak) => {
      if (rawActions.indexOf(ak) < 0) return;
      // 操作权限前提：所属页面也被授权（前端勾选时同步，这里再兜一层）
      if (pagesStored.indexOf(p.key) < 0) return;
      if (actions.indexOf(ak) < 0) actions.push(ak);
    });
  });

  return { pages: pagesStored, actions };
}

// 读取某用户所属小组 + 权限并集（管理员返回全部权限）
async function loadUserPermissions(pool, userId, role) {
  const groupsRes = await pool.query(
    `SELECT g.id, g.name, g.description, g.permissions
       FROM user_groups ug
       JOIN groups g ON g.id = ug.group_id
      WHERE ug.user_id = $1
      ORDER BY g.id`,
    [userId]
  );
  const groups = groupsRes.rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description || '',
    permissions: safeParse(r.permissions),
  }));

  if (role === 'admin') {
    return {
      groups,
      permissions: { pages: PAGE_KEYS.slice(), actions: Object.keys(ACTION_KEYS).reduce((acc, k) => acc.concat(ACTION_KEYS[k]), []), all: true },
    };
  }

  const pageSet = [];
  const actionSet = [];
  groups.forEach((g) => {
    const n = normalizePermissions(g.permissions);
    n.pages.forEach((k) => { if (pageSet.indexOf(k) < 0) pageSet.push(k); });
    n.actions.forEach((k) => { if (actionSet.indexOf(k) < 0) actionSet.push(k); });
  });

  return { groups, permissions: { pages: pageSet, actions: actionSet, all: false } };
}

function safeParse(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || '{}'); } catch (_) { return {}; }
}

// 判断权限集合是否包含某页面（admin 恒真；dashboard 恒真）
function hasPage(perms, pageKey) {
  if (!perms) return false;
  if (perms.all) return true;
  if (pageKey === 'dashboard') return true;
  return (perms.pages || []).indexOf(pageKey) >= 0;
}

function hasAction(perms, actionKey) {
  if (!perms) return false;
  if (perms.all) return true;
  return (perms.actions || []).indexOf(actionKey) >= 0;
}

// Express 中间件：要求"角色允许 或 小组授权了该页面"
//   allowRoles：老角色的放行名单（保持现有功能不受影响）
//   pageKey   ：小组权限里的页面 key
function requirePageAccess(allowRoles, pageKey) {
  return async (req, res, next) => {
    try {
      if (!(req.session && req.session.user)) return res.status(401).json({ error: '未登录' });
      const role = req.session.user.role;
      if (Array.isArray(allowRoles) && allowRoles.indexOf(role) >= 0) return next();
      const { permissions } = await loadUserPermissions(pool, req.session.user.id, role);
      if (hasPage(permissions, pageKey)) {
        req.groupPermissions = permissions;
        return next();
      }
      return res.status(403).json({ error: '无权限访问该页面（需要相应小组授权）' });
    } catch (err) { next(err); }
  };
}

// Express 中间件：要求某个操作权限（管理员恒通过）
function requireAction(actionKey) {
  return async (req, res, next) => {
    try {
      if (!(req.session && req.session.user)) return res.status(401).json({ error: '未登录' });
      const role = req.session.user.role;
      if (role === 'admin') return next();
      const { permissions } = await loadUserPermissions(pool, req.session.user.id, role);
      if (hasAction(permissions, actionKey)) {
        req.groupPermissions = permissions;
        return next();
      }
      return res.status(403).json({ error: '无权限执行该操作（需要相应小组授权）' });
    } catch (err) { next(err); }
  };
}

function isAdmin(req) {
  return !!(req.session && req.session.user && req.session.user.role === 'admin');
}

// 页面路由守卫：管理员 或 小组授权该页面
async function canOpenPage(pool, sessionUser, pageKey) {
  if (!sessionUser) return false;
  if (sessionUser.role === 'admin') return true;
  const { permissions } = await loadUserPermissions(pool, sessionUser.id, sessionUser.role);
  return hasPage(permissions, pageKey);
}

module.exports = {
  PAGES,
  PAGE_KEYS,
  ACTION_KEYS,
  isKnownPage,
  isKnownAction,
  normalizePermissions,
  loadUserPermissions,
  hasPage,
  hasAction,
  requirePageAccess,
  requireAction,
  isAdmin,
  canOpenPage,
  safeParse,
};
