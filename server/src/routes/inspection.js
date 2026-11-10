// ============================================================
// 巡堂记录业务 API（基于已打通的小组权限）
//   GET    /api/inspection/status              我的权限/小组 + 页面元数据（字典）
//   GET    /api/inspection/issues             问题列表（状态/班级/日期/关键词 + 分页）
//   POST   /api/inspection/issues             记录问题（multipart/form-data，可带多张照片）
//   GET    /api/inspection/issues/:id         问题详情（含照片 + 反馈记录）
//   POST   /api/inspection/issues/:id/feedbacks  添加反馈（按"反馈选择"更新问题状态）
//   GET    /api/inspection/classes            班级下拉（创建/筛选用）
//
// 权限：
//   页面权限  inspection      → 可看列表/详情
//   操作权限  create_issue    → 记录问题（带照片时还需要 upload_photo）
//             add_feedback    → 添加反馈
//             upload_photo    → 上传照片
//   管理员固定拥有全部权限（不受小组限制）
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pool = require('../db');
const perms = require('../lib/permissions');
const { requireInspectionPage, requireInspectionAction, inspectorInfo } = require('../lib/inspectionAccess');

const router = express.Router();

// ---------- 字典（唯一来源；前端通过 /api/inspection/status 获取） ----------
const CATEGORIES = [
  { key: 'hygiene', label: '卫生' },
  { key: 'discipline', label: '纪律' },
  { key: 'equipment', label: '设备' },
  { key: 'teaching', label: '教学' },
  { key: 'other', label: '其他' },
];
const PRIORITIES = [
  { key: 'normal', label: '普通' },
  { key: 'urgent', label: '紧急' },
];
const STATUSES = [
  { key: 'pending', label: '待处理' },
  { key: 'processing', label: '处理中' },
  { key: 'resolved', label: '已解决' },
];
// 反馈选择：处理中 / 已解决 / 未解决
const FEEDBACK_STATUSES = [
  { key: 'processing', label: '处理中' },
  { key: 'resolved', label: '已解决' },
  { key: 'unresolved', label: '未解决' },
];
const CATEGORY_KEYS = CATEGORIES.map((x) => x.key);
const PRIORITY_KEYS = PRIORITIES.map((x) => x.key);
const STATUS_KEYS = STATUSES.map((x) => x.key);
const FEEDBACK_KEYS = FEEDBACK_STATUSES.map((x) => x.key);

// 状态流转（需求表）：
//   待处理 + 处理中 → 处理中；待处理 + 已解决 → 已解决；处理中 + 已解决 → 已解决；
//   处理中 + 未解决 → 处理中；已解决 + 未解决 → 处理中
function nextStatus(currentStatus, feedbackStatus) {
  if (feedbackStatus === 'resolved') return 'resolved';
  return 'processing';   // processing / unresolved 都落到"处理中"
}

// ---------- 照片上传（磁盘存储） ----------
const UPLOAD_DIR = path.join(__dirname, '../../../public/uploads/inspection');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png' };
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const d = new Date();
    const sub = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const dir = path.join(UPLOAD_DIR, sub);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = ALLOWED_MIME[file.mimetype] || '.jpg';
    const name = `insp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, name);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 9 },   // 每张 ≤5MB，最多 9 张
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME[file.mimetype]) return cb(new Error('只支持 JPG / PNG 格式的照片'));
    cb(null, true);
  },
});
const uploadPhotos = (req, res, next) => {
  upload.array('photos', 9)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '单张照片不能超过 5MB' });
    if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: '一次最多上传 9 张照片' });
    return res.status(400).json({ error: err.message || '照片上传失败' });
  });
};

// 公开路径（前端访问用）：/uploads/inspection/<yyyyMM>/<file>
function toPublicPath(absPath) {
  const rel = path.relative(path.join(__dirname, '../../../public'), absPath).split(path.sep).join('/');
  return '/' + rel;
}

// busboy/multer 把文件名按 latin1 解码，中文名会变成乱码（如 微信图片 → å¾®ä¿¡å¾ç）
// 这里统一按 latin1 → utf8 还原（纯 ASCII 文件名不受影响）
function fixFileName(name) {
  const raw = String(name || '');
  if (!raw) return '';
  try {
    const fixed = Buffer.from(raw, 'latin1').toString('utf8');
    // 若还原后出现替换字符（说明原本就不是 latin1 误读），保留原值
    return fixed.indexOf('\uFFFD') >= 0 ? raw : fixed;
  } catch (_) { return raw; }
}

// ---------- 权限辅助（移至 lib/inspectionAccess.js，供巡堂记录 + 巡查面板共用） ----------
function actorName(req) {
  const u = req.session.user;
  return u.realName || u.displayName || u.username;
}

// ---------- 序列化 ----------
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((x) => [x.key, x.label]));
const PRIORITY_LABEL = Object.fromEntries(PRIORITIES.map((x) => [x.key, x.label]));
const STATUS_LABEL = Object.fromEntries(STATUSES.map((x) => [x.key, x.label]));
const FEEDBACK_LABEL = Object.fromEntries(FEEDBACK_STATUSES.map((x) => [x.key, x.label]));

// DATE 字段格式化：node-postgres 会把 DATE 解析成"本地零点"的 Date 对象，
// 直接用 toISOString() 会因时区偏移少一天，这里按本地年月日拼
function fmtDate(v) {
  if (!v) return '';
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

function mapIssue(r) {
  return {
    id: r.id,
    issueDate: fmtDate(r.issue_date),
    classId: r.class_id,
    className: r.class_name || (r.class_id ? '未知班级' : '未指定'),
    description: r.description,
    category: r.category,
    categoryLabel: CATEGORY_LABEL[r.category] || r.category,
    priority: r.priority,
    priorityLabel: PRIORITY_LABEL[r.priority] || r.priority,
    status: r.status,
    statusLabel: STATUS_LABEL[r.status] || r.status,
    createdBy: r.created_by,
    createdByName: r.created_by_name || '--',
    createdAt: r.created_at,
    photoCount: Number(r.photo_count || 0),
    feedbackCount: Number(r.feedback_count || 0),
  };
}
function mapPhoto(p) {
  return { id: p.id, url: p.file_path, fileName: p.file_name || '', fileSize: p.file_size || 0, createdAt: p.created_at };
}
function mapFeedback(f) {
  return {
    id: f.id, issueId: f.issue_id,
    isResolved: f.is_resolved === true,
    feedbackStatus: f.feedback_status,
    feedbackStatusLabel: FEEDBACK_LABEL[f.feedback_status] || f.feedback_status,
    solution: f.solution || '',
    feedbackBy: f.feedback_by,
    feedbackByName: f.feedback_by_name || '--',
    createdAt: f.created_at,
  };
}

// ============================================================
// GET /api/inspection/status —— 我的权限 / 小组 / 字典
// ============================================================
router.get('/inspection/status', async (req, res, next) => {
  try {
    if (!(req.session && req.session.user)) return res.status(401).json({ error: '未登录' });
    const { groups, permissions } = await inspectorInfo(req);
    const pageGranted = perms.hasPage(permissions, 'inspection');
    if (!pageGranted) return res.status(403).json({ error: '无权限访问巡堂记录（需要相应小组授权）' });
    const can = (k) => perms.hasAction(permissions, k);
    const isAdmin = req.session.user.role === 'admin';
    res.json({
      pageGranted: true,
      role: req.session.user.role,
      isAdmin,
      canDelete: isAdmin,          // 删除巡堂记录：仅管理员（小组成员不可）
      permissions,
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
      actions: [
        { key: 'view', label: '查看巡堂记录', allowed: true },
        { key: 'create_issue', label: '记录问题', allowed: can('create_issue') },
        { key: 'add_feedback', label: '添加反馈', allowed: can('add_feedback') },
        { key: 'upload_photo', label: '上传照片', allowed: can('upload_photo') },
        { key: 'delete_issue', label: '删除巡堂记录', allowed: isAdmin },
      ],
      categories: CATEGORIES,
      priorities: PRIORITIES,
      statuses: STATUSES,
      feedbackStatuses: FEEDBACK_STATUSES,
    });
  } catch (err) { next(err); }
});

// ============================================================
// GET /api/inspection/classes —— 年级 + 班级（两级联动用）
//   ?gradeId=xxx        只返回该年级下的班级（不传 = 全部年级的班级）
//   只列「当前学年」的年级与班级（避免往年班级混进下拉，学校 40+ 班时尤其重要）
//   权限：巡堂页面权限（等价于 /api/grades + /api/classes 的当前学年数据，但保留巡堂权限校验，
//         这样"只读小组"里的非教师账号也能正常取到下拉数据）
// ============================================================
router.get('/inspection/classes', requireInspectionPage, async (req, res, next) => {
  try {
    const yearRow = await pool.query("SELECT value FROM system_settings WHERE key = 'current_academic_year'");
    const year = (yearRow.rows[0] && yearRow.rows[0].value) || null;
    const gradeId = req.query.gradeId ? Number(req.query.gradeId) : null;

    // 年级：当前学年的年级表（academic_year 为空的容错保留）
    //   排序：sort_order（管理员可配）→ 年级名里的数字/中文数字（高一→高二→高三）→ 名称
    const gp = [];
    let gradeWhere = '';
    if (year) { gp.push(year); gradeWhere = 'WHERE (g.academic_year = $1 OR g.academic_year IS NULL)'; }
    const grades = await pool.query(
      `SELECT g.id, g.grade_name, g.sort_order FROM grades g ${gradeWhere}
        ORDER BY g.sort_order,
                 COALESCE(
                   NULLIF(regexp_replace(g.grade_name, '\\D', '', 'g'), '')::int,
                   CASE WHEN g.grade_name ~ '一' THEN 1 WHEN g.grade_name ~ '二' THEN 2
                        WHEN g.grade_name ~ '三' THEN 3 WHEN g.grade_name ~ '四' THEN 4
                        WHEN g.grade_name ~ '五' THEN 5 WHEN g.grade_name ~ '六' THEN 6 END,
                   9999),
                 g.grade_name, g.id`,
      gp
    );

    // 班级：当前学年 + 可按年级过滤；grade_id 缺失时用年级名兜底匹配
    const cp = [];
    const cw = [];
    if (year) { cp.push(year); cw.push(`(c.academic_year = $${cp.length} OR c.academic_year IS NULL)`); }
    if (gradeId && Number.isInteger(gradeId)) {
      cp.push(gradeId);
      cw.push(`(c.grade_id = $${cp.length} OR (c.grade_id IS NULL AND c.grade = (SELECT grade_name FROM grades WHERE id = $${cp.length}::int)))`);
    }
    const classes = await pool.query(
      `SELECT c.id, c.class_name, c.grade, c.grade_id, g.grade_name
         FROM classes c LEFT JOIN grades g ON g.id = c.grade_id
        ${cw.length ? 'WHERE ' + cw.join(' AND ') : ''}
        ORDER BY g.sort_order NULLS LAST, COALESCE(g.grade_name, c.grade),
                 -- 班号按数字自然排序（高二6班 在 高二12班 之前）
                 NULLIF(regexp_replace(c.class_name, '\\D', '', 'g'), '')::int NULLS LAST,
                 c.class_name, c.id`,
      cp
    );
    const nameToId = new Map(grades.rows.map((r) => [r.grade_name, r.id]));
    res.json({
      academicYear: year,
      grades: grades.rows.map((r) => ({ id: r.id, gradeName: r.grade_name, sortOrder: r.sort_order })),
      classes: classes.rows.map((r) => ({
        id: r.id,
        className: r.class_name,
        grade: r.grade_name || r.grade || '',
        gradeId: r.grade_id || nameToId.get(r.grade_name || r.grade) || null,
      })),
    });
  } catch (err) { next(err); }
});

// ============================================================
// GET /api/inspection/issues —— 列表（筛选 + 分页）
//   status / gradeId / classId / date（当天）/ keyword（描述、班级名）、page、pageSize
//   gradeId 与 classId 可同时传（AND）；只传 gradeId 时按年级筛全部班级的问题
// ============================================================
router.get('/inspection/issues', requireInspectionPage, async (req, res, next) => {
  try {
    const q = req.query || {};
    const status = String(q.status || '').trim();
    const gradeId = q.gradeId ? Number(q.gradeId) : null;
    const classId = q.classId ? Number(q.classId) : null;
    const date = String(q.date || '').trim();
    const keyword = String(q.keyword || '').trim();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));

    const where = [];
    const p = [];
    if (status && STATUS_KEYS.indexOf(status) >= 0) { p.push(status); where.push(`i.status = $${p.length}`); }
    if (gradeId && Number.isInteger(gradeId)) {
      p.push(gradeId);
      where.push(`(c.grade_id = $${p.length} OR (c.grade_id IS NULL AND c.grade = (SELECT grade_name FROM grades WHERE id = $${p.length}::int)))`);
    }
    if (classId && Number.isInteger(classId)) { p.push(classId); where.push(`i.class_id = $${p.length}`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) { p.push(date); where.push(`i.issue_date = $${p.length}::date`); }
    if (keyword) {
      p.push(`%${keyword}%`);
      where.push(`(i.description ILIKE $${p.length} OR c.class_name ILIKE $${p.length} OR i.created_by_name ILIKE $${p.length})`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const totalRes = await pool.query(
      `SELECT count(*)::int AS n FROM inspection_issues i LEFT JOIN classes c ON c.id = i.class_id ${whereSql}`, p
    );
    const total = totalRes.rows[0].n;

    const listRes = await pool.query(
      `SELECT i.*, c.class_name,
              (SELECT count(*) FROM inspection_photos ph WHERE ph.issue_id = i.id) AS photo_count,
              (SELECT count(*) FROM inspection_feedbacks fb WHERE fb.issue_id = i.id) AS feedback_count
         FROM inspection_issues i
         LEFT JOIN classes c ON c.id = i.class_id
         ${whereSql}
        ORDER BY i.issue_date DESC, i.id DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, p
    );
    const issues = listRes.rows.map(mapIssue);

    // 列表里的照片缩略图（每问题最多 3 张）
    let photoMap = {};
    if (issues.length) {
      const ids = issues.map((i) => i.id);
      const ph = await pool.query(
        `SELECT id, issue_id, file_path, file_name, file_size, created_at
           FROM inspection_photos WHERE issue_id = ANY($1::int[]) ORDER BY id`, [ids]
      );
      ph.rows.forEach((r) => {
        photoMap[r.issue_id] = photoMap[r.issue_id] || [];
        if (photoMap[r.issue_id].length < 3) photoMap[r.issue_id].push(mapPhoto(r));
      });
    }
    issues.forEach((i) => { i.photos = photoMap[i.id] || []; });

    // 各状态数量（顶部筛选提示用）
    const sumRes = await pool.query(
      `SELECT status, count(*)::int AS n FROM inspection_issues GROUP BY status`
    );
    const summary = { pending: 0, processing: 0, resolved: 0, total: 0 };
    sumRes.rows.forEach((r) => { summary[r.status] = r.n; summary.total += r.n; });

    res.json({ issues, total, page, pageSize, summary });
  } catch (err) { next(err); }
});

// ============================================================
// POST /api/inspection/issues —— 记录问题（multipart/form-data）
//   description(必填) / classId / category / priority / issueDate / photos[]
// ============================================================
router.post('/inspection/issues', requireInspectionAction('create_issue', '记录问题'), uploadPhotos, async (req, res, next) => {
  const savedFiles = (req.files || []).map((f) => ({ abs: f.path, url: toPublicPath(f.path), name: fixFileName(f.originalname), size: f.size }));
  try {
    const body = req.body || {};
    const description = String(body.description || '').trim();
    if (!description) {
      // 校验失败时删除已落盘文件，避免垃圾文件
      savedFiles.forEach((f) => { try { fs.unlinkSync(f.abs); } catch (_) {} });
      return res.status(400).json({ error: '请填写问题描述' });
    }
    if (description.length > 2000) return res.status(400).json({ error: '问题描述不能超过 2000 字' });

    // 带照片时要求"上传照片"操作权限
    if (savedFiles.length > 0 && !perms.hasAction(req.inspection.permissions, 'upload_photo')) {
      savedFiles.forEach((f) => { try { fs.unlinkSync(f.abs); } catch (_) {} });
      return res.status(403).json({ error: '无权限执行「上传照片」（需要相应小组授权）' });
    }

    const category = CATEGORY_KEYS.indexOf(String(body.category || '')) >= 0 ? String(body.category) : 'other';
    const priority = PRIORITY_KEYS.indexOf(String(body.priority || '')) >= 0 ? String(body.priority) : 'normal';
    const rawDate = String(body.issueDate || '').trim();
    const issueDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
    let classId = body.classId ? Number(body.classId) : null;
    if (classId !== null && !Number.isInteger(classId)) classId = null;
    if (classId !== null) {
      const c = await pool.query('SELECT id FROM classes WHERE id = $1', [classId]);
      if (c.rowCount === 0) return res.status(400).json({ error: '所选班级不存在' });
    }

    const ins = await pool.query(
      `INSERT INTO inspection_issues (issue_date, class_id, description, category, priority, status, created_by, created_by_name)
       VALUES (COALESCE($1::date, CURRENT_DATE), $2, $3, $4, $5, 'pending', $6, $7)
       RETURNING id`,
      [issueDate, classId, description, category, priority, req.session.user.id, actorName(req)]
    );
    const issueId = ins.rows[0].id;

    for (const f of savedFiles) {
      await pool.query(
        `INSERT INTO inspection_photos (issue_id, file_path, file_name, file_size) VALUES ($1, $2, $3, $4)`,
        [issueId, f.url, f.name, f.size]
      );
    }

    const detail = await loadIssueDetail(issueId);
    res.status(201).json({ issue: detail.issue, photos: detail.photos, feedbacks: detail.feedbacks });
  } catch (err) {
    savedFiles.forEach((f) => { try { fs.unlinkSync(f.abs); } catch (_) {} });
    next(err);
  }
});

// ============================================================
// GET /api/inspection/issues/:id —— 详情（问题 + 照片 + 反馈）
// ============================================================
async function loadIssueDetail(id) {
  const r = await pool.query(
    `SELECT i.*, c.class_name,
            (SELECT count(*) FROM inspection_photos ph WHERE ph.issue_id = i.id) AS photo_count,
            (SELECT count(*) FROM inspection_feedbacks fb WHERE fb.issue_id = i.id) AS feedback_count
       FROM inspection_issues i LEFT JOIN classes c ON c.id = i.class_id
      WHERE i.id = $1`, [id]
  );
  if (r.rowCount === 0) return null;
  const photos = await pool.query(
    'SELECT id, issue_id, file_path, file_name, file_size, created_at FROM inspection_photos WHERE issue_id = $1 ORDER BY id', [id]
  );
  const feedbacks = await pool.query(
    'SELECT * FROM inspection_feedbacks WHERE issue_id = $1 ORDER BY created_at, id', [id]
  );
  return { issue: mapIssue(r.rows[0]), photos: photos.rows.map(mapPhoto), feedbacks: feedbacks.rows.map(mapFeedback) };
}

router.get('/inspection/issues/:id', requireInspectionPage, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '问题编号无效' });
    const detail = await loadIssueDetail(id);
    if (!detail) return res.status(404).json({ error: '问题不存在或已删除' });
    res.json(detail);
  } catch (err) { next(err); }
});

// ============================================================
// POST /api/inspection/issues/:id/feedbacks —— 添加反馈（含状态流转）
//   feedbackStatus: processing | resolved | unresolved ; solution
// ============================================================
router.post('/inspection/issues/:id/feedbacks', requireInspectionAction('add_feedback', '添加反馈'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '问题编号无效' });
    const body = req.body || {};
    const feedbackStatus = String(body.feedbackStatus || '').trim();
    const solution = String(body.solution || '').trim();
    if (FEEDBACK_KEYS.indexOf(feedbackStatus) < 0) {
      return res.status(400).json({ error: '请选择「是否解决」（已解决 / 处理中 / 未解决）' });
    }
    if (!solution) return res.status(400).json({ error: '请填写解决方案' });
    if (solution.length > 2000) return res.status(400).json({ error: '解决方案不能超过 2000 字' });

    const cur = await pool.query('SELECT id, status FROM inspection_issues WHERE id = $1', [id]);
    if (cur.rowCount === 0) return res.status(404).json({ error: '问题不存在或已删除' });
    const before = cur.rows[0].status;
    const after = nextStatus(before, feedbackStatus);

    const fb = await pool.query(
      `INSERT INTO inspection_feedbacks (issue_id, is_resolved, feedback_status, solution, feedback_by, feedback_by_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, feedbackStatus === 'resolved', feedbackStatus, solution, req.session.user.id, actorName(req)]
    );
    await pool.query('UPDATE inspection_issues SET status = $2, updated_at = now() WHERE id = $1', [id, after]);

    res.status(201).json({
      feedback: mapFeedback(fb.rows[0]),
      statusBefore: before,
      statusAfter: after,
      statusBeforeLabel: STATUS_LABEL[before] || before,
      statusAfterLabel: STATUS_LABEL[after] || after,
    });
  } catch (err) { next(err); }
});

// ============================================================
// DELETE /api/inspection/issues/:id —— 删除巡堂记录（仅管理员）
//   权限：**仅管理员**（教务组等小组成员只能创建/反馈，不具备删除能力；
//         删除是破坏性操作，故不放进小组权限目录，避免被授权扩大）
//   一并删除：反馈记录 → 照片记录 + 磁盘照片文件 → 问题本身
// ============================================================
router.delete('/inspection/issues/:id', async (req, res, next) => {
  try {
    if (!(req.session && req.session.user)) return res.status(401).json({ error: '未登录' });
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: '无权限：仅管理员可删除巡堂记录' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '问题编号无效' });

    const cur = await pool.query('SELECT id, description FROM inspection_issues WHERE id = $1', [id]);
    if (cur.rowCount === 0) return res.status(404).json({ error: '问题不存在或已删除' });

    const photos = await pool.query('SELECT id, file_path FROM inspection_photos WHERE issue_id = $1', [id]);
    const fbCount = await pool.query('SELECT count(*)::int AS n FROM inspection_feedbacks WHERE issue_id = $1', [id]);

    // 先删子表（外键若为级联也显式删除，保证计数与期望一致），再删主表
    await pool.query('DELETE FROM inspection_feedbacks WHERE issue_id = $1', [id]);
    await pool.query('DELETE FROM inspection_photos WHERE issue_id = $1', [id]);
    await pool.query('DELETE FROM inspection_issues WHERE id = $1', [id]);

    // 删除磁盘照片文件（只允许删除上传目录内的文件，防目录穿越）
    let filesDeleted = 0;
    for (const p of photos.rows) {
      const abs = path.join(path.join(__dirname, '../../../public'), String(p.file_path || '').replace(/^\//, ''));
      const rootAbs = path.resolve(UPLOAD_DIR);
      if (path.resolve(abs).indexOf(rootAbs) !== 0) continue;   // 不在上传目录内 → 跳过
      try { fs.unlinkSync(abs); filesDeleted += 1; } catch (_) { /* 文件已不存在则忽略 */ }
    }

    res.json({
      ok: true,
      deleted: {
        id,
        description: cur.rows[0].description,
        photos: photos.rowCount,
        photoFiles: filesDeleted,
        feedbacks: fbCount.rows[0].n,
      },
    });
  } catch (err) { next(err); }
});

// 统一错误处理
router.use((err, req, res, next) => {
  console.error('[巡堂记录错误]', err);
  res.status(500).json({ error: '服务器内部错误', detail: err && err.message });
});

module.exports = router;
