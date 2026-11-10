// ============================================================
// 巡堂记录：页面/操作权限中间件（巡堂记录与巡查面板共用）
//   页面权限 inspection  → 可看列表/详情/统计面板
//   操作权限 create_issue / add_feedback / upload_photo
//   管理员固定拥有全部权限（不受小组限制）
// ============================================================
const pool = require('../db');
const perms = require('./permissions');

async function inspectorInfo(req) {
  const u = req.session.user;
  return perms.loadUserPermissions(pool, u.id, u.role);
}

// 页面权限（列表 / 详情 / 巡查面板）
async function requireInspectionPage(req, res, next) {
  try {
    if (!(req.session && req.session.user)) return res.status(401).json({ error: '未登录' });
    const { groups, permissions } = await inspectorInfo(req);
    if (!perms.hasPage(permissions, 'inspection')) {
      return res.status(403).json({ error: '无权限访问巡堂记录（需要相应小组授权）' });
    }
    req.inspection = { groups, permissions };
    next();
  } catch (err) { next(err); }
}

// 操作权限
function requireInspectionAction(actionKey, label) {
  return async (req, res, next) => {
    try {
      if (!(req.session && req.session.user)) return res.status(401).json({ error: '未登录' });
      const { groups, permissions } = await inspectorInfo(req);
      if (!perms.hasPage(permissions, 'inspection')) {
        return res.status(403).json({ error: '无权限访问巡堂记录（需要相应小组授权）' });
      }
      if (!perms.hasAction(permissions, actionKey)) {
        return res.status(403).json({ error: `无权限执行「${label}」（需要相应小组授权）` });
      }
      req.inspection = { groups, permissions };
      next();
    } catch (err) { next(err); }
  };
}

module.exports = { requireInspectionPage, requireInspectionAction, inspectorInfo };
