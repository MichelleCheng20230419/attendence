// 武汉一中管理平台 - 后端入口
require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const attendanceRouter = require('./routes/attendance');
const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const analysisRouter = require('./routes/analysis');
const adminRouter = require('./routes/admin');
const homeworkRouter = require('./routes/homework');
const teacherRouter = require('./routes/teacher');
const rollcallRouter = require('./routes/rollcall');
const performanceRouter = require('./routes/performance');
const announcementsRouter = require('./routes/announcements');
const groupsRouter = require('./routes/groups');
const inspectionRouter = require('./routes/inspection');
const inspectionStatsRouter = require('./routes/inspectionStats');
const teachersRouter = require('./routes/teachers');   // 教师账号批量导入（模板下载 + 导入）

const app = express();

app.use(express.json());

// 会话（Cookie）：7 天有效，关闭浏览器后重新打开仍保持登录
app.use(
  session({
    name: 'connect.sid',
    secret: process.env.SESSION_SECRET || 'attendance-session-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 天
      sameSite: 'lax',
    },
  })
);

// ============================================================
// API 响应禁用缓存（必须放在 API 路由之前）
//   签到台/点名等接口按"当前场次 + 当前班级"返回数据，若被浏览器缓存（尤其
//   Chrome/Edge 的启发式缓存或返回 304），切换班级后仍会显示上一个班的数据 ——
//   表现为"班级隔离失效"。这里统一禁止 /api 响应被缓存。
// ============================================================
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// 认证 API（登录/登出/会话查询，公开访问）
app.use('/api', authRouter);

// ============================================================
// 路由保护：/api 下除认证接口外，全部要求登录
//  - 页面跳转类请求（Accept: text/html）→ 302 跳登录页
//  - 接口请求 → 401 JSON
// ============================================================
app.use('/api', (req, res, next) => {
  if (req.session && req.session.user) return next();
  const accept = req.headers.accept || '';
  if (accept.includes('text/html')) {
    return res.redirect('/login');
  }
  res.status(401).json({ error: '未登录，请先登录' });
});

// 业务 API
app.use('/api', attendanceRouter);

// 账号管理 API（仅挂载 /api/users 前缀，管理员校验在路由内部）
app.use('/api/users', usersRouter);
// 教师批量导入（管理员）：GET /api/teachers/template、POST /api/teachers/import
// 只挂到 /api/teachers 前缀，避免其管理员守卫影响其它 /api 模块
app.use('/api/teachers', teachersRouter);

// 考勤分析 API（内部按角色控制数据范围）
app.use('/api', analysisRouter);

// 后台管理 API（年级/班级/学年/异动，内部做管理员校验）
app.use('/api', adminRouter);

// 作业统计 API（内部做角色/班级校验）
app.use('/api', homeworkRouter);

// 教师教学设置 API（个人中心"教学设置"：所教学科 / 所带班级）
app.use('/api', teacherRouter);

// 随机点名 API（班长端签到操作台；内部按角色控制班级范围）
app.use('/api', rollcallRouter);

// 课堂表现 API（点名记录 + 点赞数据；内部按角色控制班级/学科范围）
app.use('/api', performanceRouter);

// 叫号系统 API（教师发布 → 班长接收/播报/标记已处理；内部按角色控制班级范围）
app.use('/api', announcementsRouter);

// 小组管理 API（小组 CRUD / 成员 / 权限目录；管理员校验在路由内部）
app.use('/api', groupsRouter);

// 巡堂记录 API（小组权限链路；问题/照片/反馈）
app.use('/api', inspectionRouter);

// 巡查面板 API（巡堂数据统计：卡片/班级排行/趋势/类型分布/导出，权限与巡堂记录一致）
app.use('/api', inspectionStatsRouter);

// ============================================================
// 页面路由
// ============================================================

// 禁用页面缓存（必须放在页面路由之前，否则 sendFile 的 HTML 会被浏览器缓存，
// 出现"新 HTML + 旧 JS"或"旧 HTML + 新 JS"的错配 → 按钮点击无反应等问题）
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// 登录页（公开）
app.get('/login', (req, res) => {
  // 已登录用户访问登录页 → 直接进签到页
  if (req.session && req.session.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, '../../public/login.html'));
});

// ============================================================
// 页面守卫（统一入口）：角色放行 或 小组授权
//   allowRoles：沿用原角色名单（保证现有功能不受影响）
//   pageKey   ：小组权限里的页面 key（不传 = 仅按角色）
//   注意：小组权限只决定"能不能打开页面/看到菜单"，数据范围仍由各 API 按角色/班级控制
//         （小组不会放大任何数据权限，越权请求照旧 403）
// ============================================================
const pool = require('./db');
const permsLib = require('./lib/permissions');
function pageGuard(allowRoles, pageKey) {
  return async (req, res, next) => {
    try {
      if (!(req.session && req.session.user)) return res.redirect('/login');
      if (allowRoles.indexOf(req.session.user.role) >= 0) return next();
      if (!pageKey) return res.redirect('/dashboard');
      const ok = await permsLib.canOpenPage(pool, req.session.user, pageKey);
      if (!ok) return res.redirect('/dashboard');
      next();
    } catch (err) { next(err); }
  };
}

// 首页 → 已登录进签到页，未登录跳登录页
app.get('/', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

// 签到操作页（受保护）
app.get('/dashboard', (req, res) => {
  if (!(req.session && req.session.user)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, '../../public/index.html'));
});

// 签到计划页（受保护）：与签到操作台是同一个页面（?view=plans 是页面内的"计划管理"视图），
//   这里给一个独立、直观、可收藏的路径 /plans —— 刷新时页面脚本按 URL 加载"计划管理"视图，
//   不会因为 URL 残留而跳错页面。教师/管理员可用（与导航栏「📅 计划管理」的可见范围一致）。
app.get('/plans', (req, res) => {
  const u = req.session && req.session.user;
  if (!u) return res.redirect('/login');
  if (u.role !== 'admin' && u.role !== 'teacher') return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, '../../public/index.html'));
});

// 个人中心页（受保护）
app.get('/profile', (req, res) => {
  if (!(req.session && req.session.user)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, '../../public/profile.html'));
});

// 后台管理（仅管理员）：5 个页面各自独立成页（导航"系统管理▾"里的 5 个入口）
//   /admin/account-management        账号管理
//   /admin/grade-management          年级管理
//   /admin/class-management          班级管理
//   /admin/academic-year-management  学年管理
//   /admin/group-management          小组管理（小组权限配置；在"学年管理"之后）
// （学生异动页是学生管理子页，见下方独立路由：管理员 + 教师）
const ADMIN_PAGES = {
  'account-management': 'admin-account-management.html',
  'grade-management': 'admin-grade-management.html',
  'class-management': 'admin-class-management.html',
  'academic-year-management': 'admin-academic-year-management.html',
  'group-management': 'admin-group-management.html',
};
app.get('/admin', (req, res) => {
  if (!(req.session && req.session.user)) return res.redirect('/login');
  if (req.session.user.role !== 'admin') return res.redirect('/dashboard');
  res.redirect('/admin/account-management');
});
for (const [page, file] of Object.entries(ADMIN_PAGES)) {
  app.get('/admin/' + page, (req, res) => {
    if (!(req.session && req.session.user)) return res.redirect('/login');
    if (req.session.user.role !== 'admin') return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, '../../public/' + file));
  });
}

// 学生异动页（学生管理子页：管理员 + 教师；班长与学生仅限签到台）
app.get('/admin/student-transfer', (req, res) => {
  if (!(req.session && req.session.user)) return res.redirect('/login');
  const role = req.session.user.role;
  if (role !== 'admin' && role !== 'teacher') return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, '../../public/student-transfer.html'));
});

// 学生管理页（考勤管理：管理员 + 教师；班长/学生仅限签到台）
app.get('/students', pageGuard(['admin', 'teacher'], 'attendance_management'), (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/students.html'));
});

// 考勤分析页（数据统计：管理员 + 教师；班长/学生仅限签到台）
app.get('/attendance-analysis', pageGuard(['admin', 'teacher'], 'data_stats'), (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/attendance-analysis.html'));
});

// 独立补签页（管理员/教师；学生与班长仅限签到台，不可访问）
app.get('/attendance/makeup', (req, res) => {
  if (!(req.session && req.session.user)) return res.redirect('/login');
  if (req.session.user.role === 'student' || req.session.user.role === 'monitor') {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, '../../public/makeup-attendance.html'));
});

// 作业统计页（班主任 + 任课老师 + 管理员：看**统计汇总**）
//   2026-09-30（老师反馈）：**班长**要的是**录入页**（当天 6 科 + 「录入/修改」→ 座位表默认全交 → 点卡片取消 → 保存），
//   而不是统计汇总（总作业数/平均提交率/按学科提交率图表是班主任/管理员看的）→ 班长访问 /homework 直接送到录入台
app.get('/homework', pageGuard(['admin', 'teacher', 'monitor'], 'data_stats'), (req, res) => {
  if (req.session.user.role === 'monitor') return res.redirect('/dashboard?view=homework');
  res.sendFile(path.join(__dirname, '../../public/homework-report.html'));
});

// 作业管理页（任课老师 + 班主任：发布作业 / 我的作业 / 提交详情）
app.get('/homework-manage', pageGuard(['admin', 'teacher'], 'teaching_tools'), (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/homework-manage.html'));
});

// 🎲 随机点名页（班长 / 教师 / 管理员：课堂大屏独立页面）
app.get('/random-call', pageGuard(['admin', 'teacher', 'monitor'], 'teaching_tools'), (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/random-call.html'));
});

// 📋 课堂表现页（数据看板：管理员 / 班主任 / 任课老师；班长用"叫号提醒+随机点名"，学生回看板）
app.get('/performance', pageGuard(['admin', 'teacher'], 'data_stats'), (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/performance.html'));
});

// 👍 点赞排行榜（**仅班长端**：本班只读排行；导航栏一级菜单）
//   老师/班主任/管理员不开放此页面与菜单 —— 他们的点赞排名在「数据统计 → 课堂表现」里
app.get('/likes-ranking', pageGuard(['monitor'], null), (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/likes-ranking.html'));
});

// 📢 叫号管理页（教师/管理员：发布叫号 + 叫号列表）
app.get('/announcements', pageGuard(['admin', 'teacher'], 'teaching_tools'), (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/announcements.html'));
});

// 🧭 巡堂记录（小组权限：页面授权 inspection 即可访问；管理员固定拥有全部权限）
//   三个页面：列表 / 记录问题 / 问题详情；页面内再按操作权限控制按钮
app.get('/inspection', pageGuard(['admin'], 'inspection'), (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/inspection.html'));
});
app.get('/inspection/new', pageGuard(['admin'], 'inspection'), (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/inspection-new.html'));
});
app.get('/inspection/detail', pageGuard(['admin'], 'inspection'), (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/inspection-detail.html'));
});
// 巡查面板（数据统计 → 巡查面板；权限与巡堂记录一致）
app.get('/inspection/panel', pageGuard(['admin'], 'inspection'), (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/inspection-panel.html'));
});

// 帮助文档（受保护，展示 README）
app.get('/help', (req, res) => {
  if (!(req.session && req.session.user)) return res.redirect('/login');
  res.type('text/plain; charset=utf-8');
  res.sendFile(path.join(__dirname, '../../README.md'));
});

// 更新日志（展示 CHANGELOG.md；入口：右上角用户菜单 → 📝 更新日志）
//   可见范围：**仅管理员**（其他人连菜单都不显示）
//   未登录 → 登录页；已登录但非管理员 → 回签到操作台（与其它受保护页面一致，不暴露内容）
app.get('/changelog', (req, res) => {
  const u = req.session && req.session.user;
  if (!u) return res.redirect('/login');
  if (u.role !== 'admin') return res.redirect('/dashboard');
  res.type('text/plain; charset=utf-8');
  res.sendFile(path.join(__dirname, '../../CHANGELOG.md'));
});

// 防止直接访问 index.html 绕过登录：与 / 完全一致（已登录 → 签到操作台；未登录 → 登录页）
//   （此前的实现一律 302 到 /dashboard，未登录时会多一跳 /dashboard → /login）
app.get('/index.html', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

// 静态资源（登录页与样式等；index.html 不自动作为首页提供）
// 注：禁用缓存的中间件已提前到页面路由之前，此处无需重复设置
app.use(express.static(path.join(__dirname, '../../public'), { index: false }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`武汉一中管理平台服务已启动: http://localhost:${PORT}`);
  console.log(`登录地址: http://localhost:${PORT}/login （默认账号 admin / 123456）`);
  // 启动签到计划自动触发定时任务（每分钟检查）
  attendanceRouter.startPlanScheduler();
  // 每日作业自动发布（每天 0 点为每个班生成当天「每日作业」条目；启动时补发当天一次，幂等）
  if (homeworkRouter.startDailyHomeworkScheduler) homeworkRouter.startDailyHomeworkScheduler();
  // 每日自动签到（v35 · 路线 B）：每天 0 点为每个班生成早/晚 2 场签到场次 + 次日收口；
  //   受 system_settings.daily_sessions_enabled 控制（默认关闭 → 上线先不生效，灰度时再打开）
  if (attendanceRouter.startDailySessionScheduler) attendanceRouter.startDailySessionScheduler();
});
