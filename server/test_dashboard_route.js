// ============================================================
// 页面路由回归测试（BUG：签到操作台刷新后偶尔跳到「签到计划」页）
//   根因：签到操作台与「计划管理」是同一个页面（index.html）里的两个视图，
//         切换视图只改内存、不改 URL —— 于是从别处进入计划管理（URL 带 ?view=plans）
//         再点「← 返回签到」回到操作台时，URL 里仍留着 view=plans，
//         一刷新就被 URL 带回计划管理页。
//   修复：URL 作为当前视图的唯一真源（切换视图 = 同步改写 URL；刷新按 URL 加载），
//         并给「签到计划」一个独立、可收藏的路径 /plans。
//   本套件验证「页面路由」这一层（浏览器内的刷新/视图行为由 tests/ui_dashboard_route.html 断言）：
//     ① 未登录访问 / 、/dashboard 、/plans 、/index.html → 302 到 /login
//     ② 已登录：/ → /dashboard；/index.html → /dashboard；/login → /dashboard
//     ③ /dashboard 与 /plans 都返回同一个页面（含 viewAttendance / viewPlans 两个视图容器）
//     ④ /plans 的权限：管理员/教师 200；班长/学生 → 302 回 /dashboard
//     ⑤ 页面引用的脚本版本号已更新（app.js?v=3.26.0）—— 防止"旧 JS 被缓存"导致的假修复
//     ⑥ 只读页面请求不改动任何业务数据（基线核对）
// 用法：node test_dashboard_route.js（需服务已启动；管理员密码取 DSH_ADMIN_PW）
// ============================================================
'use strict';
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function req(p, { cookie, method = 'GET' } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + p, { method, headers, redirect: 'manual' });
  const ct = res.headers.get('content-type') || '';
  let html = '';
  if (ct.includes('text/html')) { try { html = await res.text(); } catch (_) {} }
  return { status: res.status, location: res.headers.get('location') || '', html, cache: res.headers.get('cache-control') || '' };
}
async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + p, { method, headers, redirect: 'manual', body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data, setc: res.headers.get('set-cookie') || '' };
}
async function login(u, p) {
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('登录失败 ' + u + ': ' + r.status);
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}
const n1 = async (sql, params = []) => (await pg.query(sql, params)).rows[0].n;

const TAG = String(Date.now()).slice(-6);
const GRADE = '路由年级' + TAG;
const CLASS = '路由班' + TAG;
const PRE = 'rt_' + TAG + '_';
const created = { gradeId: null, classId: null, userIds: [] };

async function cleanup() {
  const uids = (await pg.query('SELECT id FROM users WHERE username LIKE $1', [PRE + '%'])).rows.map((r) => r.id);
  if (uids.length) {
    await pg.query('UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL WHERE head_teacher_id = ANY($1::int[]) OR teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM teacher_classes WHERE teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM users WHERE id = ANY($1::int[])', [uids]).catch(() => {});
  }
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name = $1', [CLASS]).catch(() => {});
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(() => {});
}

(async () => {
  try {
    await cleanup();
    const base = {
      users: await n1('SELECT count(*)::int n FROM users'),
      classes: await n1('SELECT count(*)::int n FROM classes'),
      students: await n1('SELECT count(*)::int n FROM students'),
      sessions: await n1('SELECT count(*)::int n FROM attendance_sessions'),
      records: await n1('SELECT count(*)::int n FROM attendance_records'),
      plans: await n1('SELECT count(*)::int n FROM attendance_plans'),
    };

    // ---------- 1) 未登录：一律回登录页 ----------
    console.log('1) 未登录访问受限页面:');
    for (const p of ['/', '/dashboard', '/plans', '/index.html']) {
      const r = await req(p);
      check(`1) 未登录 ${p} → 302 到 /login`, r.status === 302 && r.location === '/login', { status: r.status, loc: r.location });
    }

    // ---------- 2) 夹具（教师 / 班长 / 学生账号）----------
    const admin = await login('admin');
    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'RT', academicYear: year } })).data.id;
    created.classId = (await api('/api/classes', { method: 'POST', cookie: admin, body: { className: CLASS, gradeName: GRADE, academicYear: year } })).data.id;
    const mkUser = async (username, role) => {
      const r = await api('/api/users', {
        method: 'POST', cookie: admin,
        body: { username, password: '123456', role, realName: '路由' + role, classId: created.classId, mustChangePassword: false, profileLocked: true, force: true },
      });
      if (r.status !== 201) throw new Error('创建账号失败 ' + username + ' ' + JSON.stringify(r.data));
      created.userIds.push(r.data.user.id);
      return r.data.user.id;
    };
    await mkUser(PRE + 'tea', 'teacher');
    await mkUser(PRE + 'mon', 'monitor');
    await mkUser(PRE + 'stu', 'student');
    const cTea = await login(PRE + 'tea');
    const cMon = await login(PRE + 'mon');
    const cStu = await login(PRE + 'stu');
    check('2) 夹具就绪（1 班 + 教师/班长/学生账号）', !!created.classId && created.userIds.length === 3, created);

    // ---------- 3) 已登录：首页与旧路径都归一到签到操作台 ----------
    console.log('3) 已登录的默认页 = 签到操作台:');
    let r = await req('/', { cookie: admin });
    check('3) 已登录访问 / → 302 到 /dashboard（不是计划页）', r.status === 302 && r.location === '/dashboard', { status: r.status, loc: r.location });
    r = await req('/index.html', { cookie: admin });
    check('3) 已登录访问 /index.html → 302 到 /dashboard', r.status === 302 && r.location === '/dashboard', { status: r.status, loc: r.location });
    r = await req('/login', { cookie: admin });
    check('3) 已登录再访问 /login → 302 到 /dashboard', r.status === 302 && r.location === '/dashboard', { status: r.status, loc: r.location });

    // ---------- 4) 签到操作台 / 签到计划：同一页面、两个视图容器 ----------
    console.log('4) /dashboard 与 /plans 是同一个页面:');
    const d = await req('/dashboard', { cookie: admin });
    check('4) /dashboard → 200 HTML', d.status === 200 && d.html.includes('<!DOCTYPE html>'), d.status);
    check('4) 页面同时包含两个视图容器（viewAttendance / viewPlans）',
      d.html.includes('id="viewAttendance"') && d.html.includes('id="viewPlans"'));
    check('4) 默认只显示签到操作台（viewPlans 带 hidden）',
      /id="viewPlans"[^>]*class="[^"]*hidden/.test(d.html));
    // 脚本版本号：页面必须带 ?v=x.y.z（防旧 JS 被缓存）；且不得低于 3.26.0
    //   （3.26.0 = "刷新保持当前页面"的路由修复；以后升级版本号只需 ≥ 这个下限，不必改用例）
    const verMatch = d.html.match(/app\.js\?v=(\d+)\.(\d+)\.(\d+)/);
    const ver = verMatch ? [Number(verMatch[1]), Number(verMatch[2]), Number(verMatch[3])] : null;
    check('4) 页面引用了带版本号的脚本（app.js?v=x.y.z，避免旧 JS 被缓存）', !!ver, verMatch && verMatch[0]);
    check('4) 脚本版本 ≥ 3.26.0（含"刷新保持当前页面"的路由修复）',
      !!ver && (ver[0] > 3 || (ver[0] === 3 && ver[1] >= 26)), ver);
    const p = await req('/plans', { cookie: admin });
    check('4) /plans → 200 且与 /dashboard 是同一个页面（可直接收藏/刷新）',
      p.status === 200 && p.html.includes('id="viewPlans"') && p.html.includes('id="viewAttendance"'), p.status);

    // ---------- 5) /plans 权限：管理员/教师可用，班长/学生回签到操作台 ----------
    console.log('5) /plans 的访问范围:');
    r = await req('/plans', { cookie: cTea });
    check('5) 教师访问 /plans → 200（与导航栏「📅 计划管理」可见范围一致）', r.status === 200, r.status);
    r = await req('/plans', { cookie: cMon });
    check('5) 班长访问 /plans → 302 回 /dashboard（班长没有计划管理）', r.status === 302 && r.location === '/dashboard', { status: r.status, loc: r.location });
    r = await req('/plans', { cookie: cStu });
    check('5) 学生访问 /plans → 302 回 /dashboard', r.status === 302 && r.location === '/dashboard', { status: r.status, loc: r.location });
    r = await req('/dashboard', { cookie: cMon });
    check('5) 班长访问 /dashboard → 200（签到操作台本身可用）', r.status === 200, r.status);

    // ---------- 6) 页面响应禁用缓存（否则刷新可能拿到旧 HTML/JS） ----------
    console.log('6) 页面禁用缓存:');
    check('6) /dashboard 响应带 Cache-Control: no-store',
      /no-store/.test(d.cache), d.cache);

    // ---------- 7) 基线核对 ----------
    console.log('7) 数据基线:');
    await cleanup();
    const after = {
      users: await n1('SELECT count(*)::int n FROM users'),
      classes: await n1('SELECT count(*)::int n FROM classes'),
      students: await n1('SELECT count(*)::int n FROM students'),
      sessions: await n1('SELECT count(*)::int n FROM attendance_sessions'),
      records: await n1('SELECT count(*)::int n FROM attendance_records'),
      plans: await n1('SELECT count(*)::int n FROM attendance_plans'),
    };
    check('7) 只读页面请求：真实数据行数回到用例前（users/classes/students/sessions/records/plans）',
      JSON.stringify(base) === JSON.stringify(after), { base, after });
    check('7) 夹具已清理（账号/班级/年级）',
      (await n1('SELECT count(*)::int n FROM users WHERE username LIKE $1', [PRE + '%'])) === 0 &&
      (await n1('SELECT count(*)::int n FROM classes WHERE class_name = $1', [CLASS])) === 0);
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：', e.message);
    try { await cleanup(); } catch (_) {}
  } finally {
    await pg.end().catch(() => {});
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  }
  process.exitCode = fail ? 1 : 0;
})();
