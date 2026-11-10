// ============================================================
// 教师账号批量导入 API（仅管理员）
//   GET  /api/teachers/template   下载标准 Excel 模板（含填写说明 Sheet）
//   POST /api/teachers/import     批量导入（multipart: file；?dryRun=1 只校验不写库）
//   注意：本路由挂载在 /api/teachers，管理员守卫用 router.use 无路径前缀只作用于本前缀，
//        绝不能把守卫挂到 /api 上（会拦掉其它模块的请求）
//   导入解析/校验/自动建班逻辑见 server/src/lib/teacherImport.js
// ============================================================
const express = require('express');
const multer = require('multer');
const lib = require('../lib/teacherImport');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// 仅管理员
router.use((req, res, next) => {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).json({ error: '无权限：仅管理员可导入教师账号' });
});

// GET /api/teachers/template —— 下载导入模板
router.get('/template', (req, res, next) => {
  try {
    const buf = lib.buildTemplateBuffer();
    const fn = '教师账号导入模板.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="teachers_template.xlsx"; filename*=UTF-8''${encodeURIComponent(fn)}`);
    res.send(buf);
  } catch (err) { next(err); }
});

// POST /api/teachers/import —— 批量导入教师账号
//   ?dryRun=1（或 body.dryRun=1）：只做校验与"将自动创建"预览，不写库（供导入弹窗预览）
router.post('/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件（.xlsx/.xls，也支持 .csv）' });
    const dryRun = String(req.query.dryRun || (req.body && req.body.dryRun) || '') === '1';
    let result;
    try {
      result = await lib.importTeachers(req.file.buffer, { dryRun });
    } catch (e) {
      // 解析失败（文件损坏/不是表格）→ 400，前端直接提示
      return res.status(400).json({ error: '文件解析失败：' + (e.message || '请确认是 Excel/CSV 模板文件') });
    }
    res.json({ ...result, columns: lib.COLUMNS });
  } catch (err) { next(err); }
});

// 统一错误处理
router.use((err, req, res, next) => {
  console.error('[教师导入错误]', err);
  res.status(500).json({ error: '服务器内部错误', detail: err && err.message });
});

module.exports = router;
