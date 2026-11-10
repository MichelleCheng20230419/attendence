// ============================================================
// 点赞排行榜（班长端）测试
//   覆盖：
//     1) 班长可读排行榜（/api/performance/likes）、范围锁定本班、按点赞数从高到低
//     2) 学科筛选（数学/语文）+ 时间筛选（本周/本月/本学期/全部）与 SQL 直算一致
//     3) 越权：班长不能查别的班级（403）、学生 403、未登录 401
//     4) 班长仍看不到「点名记录」（本次改动只放开点赞排行榜，未放开课堂表现）
//     5) 教师/管理员口径不变（管理员=全校，能看到别的班的学生）
//     6) 只读：不支持导出（/api/performance/export 对班长 403）
//   夹具：2 年级? → 1 年级 + 2 班 + 4 学生 + 2 班长 + 1 学生账号 + 若干点赞（含历史日期）
//   测完清理并核对真实基线（system_settings 不动）
// ============================================================
'use strict';
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); }
}

async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + p, { method, headers, redirect: 'manual', body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('application/json')) { try { data = await res.json(); } catch (_) {} }
  return { status: res.status, data, setc: res.headers.get('set-cookie') || '' };
}
async function login(u, p) {
  // admin 的密码可能被管理员改过 → 用环境变量 DSH_ADMIN_PW（默认 123456）；夹具账号固定 123456
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('登录失败 ' + u + ': ' + r.status);
  const m = r.setc.match(/connect\.sid=([^;]+)/);
  return 'connect.sid=' + m[1];
}
function pad(n) { return String(n).padStart(2, '0'); }
function dayStr(offsetDays = 0) {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
async function countSql(sql, params = []) { return (await pg.query(sql, params)).rows[0].n; }

const TAG = String(Date.now()).slice(-6);
const GRADE = '点赞年级' + TAG, CLASS_A = '点赞甲班' + TAG, CLASS_B = '点赞乙班' + TAG;
const MON_A = 'lr_mon_' + TAG, MON_B = 'lr_monb_' + TAG, STU = 'lr_stu_' + TAG, TEA = 'lr_tea_' + TAG;
const OPER = 'lrfix' + TAG;
const created = { gradeId: null, classA: null, classB: null, userIds: [], studentIds: [], likeIds: [] };
let realBefore = null;
let admin = null, monA = null, monB = null, stu = null, tea = null, term = null;

async function snapshotReal() {
  return {
    users: await countSql('SELECT count(*)::int n FROM users'),
    grades: await countSql('SELECT count(*)::int n FROM grades'),
    classes: await countSql('SELECT count(*)::int n FROM classes'),
    students: await countSql('SELECT count(*)::int n FROM students'),
    likes: await countSql('SELECT count(*)::int n FROM student_likes'),
  };
}

async function addLike(studentId, classId, subject, count, dateStr) {
  const r = await pg.query(
    `INSERT INTO student_likes (student_id, class_id, subject, operator_id, operator_name, like_count, created_at)
     VALUES ($1, $2, $3, NULL, $4, $5, $6::date + interval '10 hours') RETURNING id`,
    [studentId, classId, subject, OPER, count, dateStr]
  );
  created.likeIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function hardCleanup() {
  const warn = (l) => (e) => console.log('  · 清理失败（' + l + '）：' + e.message);
  await pg.query('DELETE FROM student_likes WHERE operator_name = $1', [OPER]).catch(warn('likes'));
  await pg.query('DELETE FROM rollcall_records WHERE picked_by_name LIKE $1', ['lrfix%']).catch(warn('rollcall'));
  // 顺序：夹具班级必须先删（教师账号会被写成 classes.head_teacher_id，否则外键挡住删账号）
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name LIKE $1', ['点赞%班%']).catch(warn('classes'));
  await pg.query('DELETE FROM users WHERE username LIKE $1', ['lr\\_%']).catch(warn('users'));
  await pg.query('DELETE FROM grades WHERE grade_name LIKE $1', ['点赞年级%']).catch(warn('grades'));
}

// 用 SQL 直算某个时间范围的期望值（按班级范围，独立于接口实现）
async function expectTotal(classId, { subject, from, to }) {
  const where = ['r.class_id = $1'];
  const p = [classId];
  if (subject) { p.push(subject); where.push(`r.subject = $${p.length}`); }
  if (from) { p.push(from); where.push(`r.created_at >= $${p.length}::date`); }
  if (to) { p.push(to); where.push(`r.created_at < ($${p.length}::date + interval '1 day')`); }
  return countSql(`SELECT COALESCE(SUM(r.like_count),0)::int n FROM student_likes r WHERE ${where.join(' AND ')}`, p);
}
async function expectStudentLikes(studentId, { subject, from, to }) {
  const where = ['r.student_id = $1'];
  const p = [studentId];
  if (subject) { p.push(subject); where.push(`r.subject = $${p.length}`); }
  if (from) { p.push(from); where.push(`r.created_at >= $${p.length}::date`); }
  if (to) { p.push(to); where.push(`r.created_at < ($${p.length}::date + interval '1 day')`); }
  return countSql(`SELECT COALESCE(SUM(r.like_count),0)::int n FROM student_likes r WHERE ${where.join(' AND ')}`, p);
}

(async () => {
  try {
    console.log('0) 夹具准备…');
    realBefore = await snapshotReal();
    admin = await login('admin');
    term = (await api('/api/term', { cookie: admin })).data;
    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'LK', academicYear: year } })).data.id;
    created.classA = (await api('/api/classes', { method: 'POST', cookie: admin, body: { className: CLASS_A, gradeName: GRADE, academicYear: year } })).data.id;
    created.classB = (await api('/api/classes', { method: 'POST', cookie: admin, body: { className: CLASS_B, gradeName: GRADE, academicYear: year } })).data.id;
    const mkStudent = async (no, name, classId) => {
      const r = await api('/api/students', { method: 'POST', cookie: admin, body: { studentNo: no, name, classId, status: '在读' } });
      const id = (r.data && (r.data.id || (r.data.student && r.data.student.id))) || null;
      if (id) created.studentIds.push(id);
      return id;
    };
    const A1 = await mkStudent('LK' + TAG + '01', '点赞甲一号', created.classA);
    const A2 = await mkStudent('LK' + TAG + '02', '点赞甲二号', created.classA);
    const A3 = await mkStudent('LK' + TAG + '03', '点赞甲三号', created.classA);
    const B1 = await mkStudent('LK' + TAG + '04', '点赞乙一号', created.classB);
    const mkUser = async (u, role, classId) => {
      const r = await api('/api/users', {
        method: 'POST', cookie: admin,
        body: { username: u, password: '123456', role, realName: u, classId, mustChangePassword: false, profileLocked: true },
      });
      if (r.status !== 201) throw new Error('创建账号失败 ' + u + ' ' + JSON.stringify(r.data));
      created.userIds.push(r.data.user.id);
      return r.data.user.id;
    };
    await mkUser(MON_A, 'monitor', created.classA);
    await mkUser(MON_B, 'monitor', created.classB);
    await mkUser(STU, 'student', created.classA);
    await mkUser(TEA, 'teacher', created.classA);   // 任课老师（验证老师端没有该页面/接口）
    monA = await login(MON_A); monB = await login(MON_B); stu = await login(STU); tea = await login(TEA);

    // 点赞数据（甲班 A1/A2/A3 + 乙班 B1），含历史日期用于时间筛选
    await addLike(A1, created.classA, '数学', 3, dayStr(0));
    await addLike(A1, created.classA, '语文', 1, dayStr(0));
    await addLike(A1, created.classA, '数学', 2, dayStr(-200));
    await addLike(A2, created.classA, '数学', 2, dayStr(0));
    await addLike(A2, created.classA, '数学', 1, dayStr(-3));
    await addLike(B1, created.classB, '数学', 9, dayStr(0));
    check('0) 夹具就绪（1 年级 + 2 班 + 4 学生 + 2 班长 + 1 学生 + 6 条点赞）',
      !!created.gradeId && created.studentIds.length === 4 && created.likeIds.length === 6, created);

    // ---------- 1) 班长可读 + 范围 = 本班 + 排序 ----------
    console.log('1) 班长读取排行榜:');
    let r = await api('/api/performance/likes?period=all', { cookie: monA });
    check('1) 班长读取排行榜 → 200', r.status === 200, { status: r.status, data: r.data });
    check('1) 标记为班长只读（isMonitor=true）且范围=本班', r.data.isMonitor === true && String(r.data.scopeLabel).indexOf(CLASS_A) >= 0, { isMonitor: r.data.isMonitor, scopeLabel: r.data.scopeLabel });
    const namesA = r.data.ranking.map((x) => x.name);
    check('1) 只返回本班学生（不含乙班「点赞乙一号」）',
      namesA.indexOf('点赞乙一号') < 0 && namesA.length === 2, namesA);
    check('1) 排名按点赞数从高到低（甲一号 6 = 数学3+语文1+旧数学2 → 甲二号 3）',
      r.data.ranking[0].name === '点赞甲一号' && r.data.ranking[0].likes === 6 &&
      r.data.ranking[1].name === '点赞甲二号' && r.data.ranking[1].likes === 3,
      r.data.ranking.map((x) => `${x.rank}.${x.name}=${x.likes}`));
    check('1) rank 从 1 连续递增且带学号', r.data.ranking.every((x, i) => x.rank === i + 1 && !!x.studentNo), r.data.ranking.map((x) => x.rank));
    const likesArr = r.data.ranking.map((x) => x.likes);
    check('1) likes 单调不增（排序稳定）', likesArr.every((v, i) => i === 0 || likesArr[i - 1] >= v), likesArr);

    // ---------- 2) 学科筛选 ----------
    console.log('2) 学科筛选:');
    r = await api('/api/performance/likes?period=all&subject=' + encodeURIComponent('数学'), { cookie: monA });
    check('2) 只看数学 → 甲一号 5（今天 3 + 旧 2）、甲二号 3（今天 2 + 三天前 1）',
      r.data.ranking.length === 2 && r.data.ranking.find((x) => x.name === '点赞甲一号').likes === 5 &&
      r.data.ranking.find((x) => x.name === '点赞甲二号').likes === 3,
      r.data.ranking.map((x) => `${x.name}=${x.likes}`));
    r = await api('/api/performance/likes?period=all&subject=' + encodeURIComponent('语文'), { cookie: monA });
    check('2) 只看语文 → 只有甲一号 1 次',
      r.data.ranking.length === 1 && r.data.ranking[0].name === '点赞甲一号' && r.data.ranking[0].likes === 1,
      r.data.ranking.map((x) => `${x.name}=${x.likes}`));
    r = await api('/api/performance/likes?period=all&subject=' + encodeURIComponent('不存在的学科'), { cookie: monA });
    check('2) 非法学科 → 400', r.status === 400, { status: r.status, data: r.data });

    // ---------- 3) 时间筛选（与 SQL 直算一致）----------
    console.log('3) 时间筛选:');
    const totalOf = (res) => (res.data.ranking || []).reduce((s, x) => s + x.likes, 0);
    for (const [period, from, to] of [
      ['week', null, null],
      ['month', null, null],
      ['term', term.startDate, term.endDate],
      ['all', null, null],
    ]) {
      const res = await api('/api/performance/likes?period=' + period, { cookie: monA });
      let expTotal;
      if (period === 'week') expTotal = await countSql(`SELECT COALESCE(SUM(like_count),0)::int n FROM student_likes WHERE class_id = $1 AND created_at >= date_trunc('week', now())`, [created.classA]);
      else if (period === 'month') expTotal = await countSql(`SELECT COALESCE(SUM(like_count),0)::int n FROM student_likes WHERE class_id = $1 AND created_at >= date_trunc('month', now())`, [created.classA]);
      else if (period === 'term') expTotal = await expectTotal(created.classA, { from, to });
      else expTotal = await expectTotal(created.classA, {});
      check(`3) period=${period} → 合计与 SQL 直算一致（${expTotal}）`, res.status === 200 && totalOf(res) === expTotal, { got: totalOf(res), expTotal });
    }
    const w = await api('/api/performance/likes?period=week', { cookie: monA });
    const m = await api('/api/performance/likes?period=month', { cookie: monA });
    const t = await api('/api/performance/likes?period=term', { cookie: monA });
    const a = await api('/api/performance/likes?period=all', { cookie: monA });
    check('3) 本周 ⊆ 本月 ⊆ 全部（周 <= 月 <= 全部）',
      totalOf(w) <= totalOf(m) && totalOf(m) <= totalOf(a), { w: totalOf(w), m: totalOf(m), a: totalOf(a) });
    // 本周/本月合计与 SQL 直算一致即可；不再写死数字（周一当天"昨天"不在本周内，写死会随星期几漂移）
    const weekSql = await countSql(`SELECT COALESCE(SUM(like_count),0)::int n FROM student_likes WHERE class_id = $1 AND created_at >= date_trunc('week', now())`, [created.classA]);
    const allSql = await countSql('SELECT COALESCE(SUM(like_count),0)::int n FROM student_likes WHERE class_id = $1', [created.classA]);
    check('3) 本周合计 = SQL 直算（date_trunc week）；全部 = SQL 直算（含 200 天前旧记录）',
      totalOf(w) === weekSql && totalOf(a) === allSql && allSql > weekSql,
      { w: totalOf(w), weekSql, a: totalOf(a), allSql });
    check('3) 「本学期」返回口径字段（termConfigured/termStart/termEnd 用于提示）',
      t.data.termStart === term.startDate && t.data.termEnd === term.endDate, { start: t.data.termStart, end: t.data.termEnd, termConfigured: t.data.termConfigured });
    check('3) 单学生点赞数与 SQL 一致（甲一号·本周）',
      w.data.ranking.find((x) => x.name === '点赞甲一号').likes === (await expectStudentLikes(created.studentIds[0], { from: dayStr(0) })),
      w.data.ranking.map((x) => `${x.name}=${x.likes}`));

    // ---------- 4) 越权与只读 ----------
    console.log('4) 越权与只读:');
    r = await api('/api/performance/likes?classId=' + created.classB, { cookie: monA });
    check('4) 班长指定别的班级 → 403', r.status === 403, { status: r.status, data: r.data });
    r = await api('/api/performance/likes?classId=' + created.classA, { cookie: monA });
    check('4) 班长指定本班 → 200 且仍是本班数据', r.status === 200 && r.data.ranking.every((x) => x.name.indexOf('甲') >= 0), r.status);
    r = await api('/api/performance/likes', { cookie: stu });
    check('4) 学生 → 403', r.status === 403, r.status);
    r = await api('/api/performance/likes');
    check('4) 未登录 → 401', r.status === 401, r.status);
    r = await api('/api/performance/records?period=all', { cookie: monA });
    check('4) 班长仍看不到「点名记录」（只放开了点赞排行榜）→ 403', r.status === 403, r.status);
    r = await api('/api/performance/export?type=likes', { cookie: monA });
    check('4) 班长不可导出 → 403', r.status === 403, r.status);

    // ---------- 5) 教师/管理员口径不变 ----------
    console.log('5) 管理员口径不变:');
    r = await api('/api/performance/likes?period=all', { cookie: admin });
    check('5) 管理员 = 全校范围（含乙班）且乙班 9 次排第一',
      r.status === 200 && r.data.scopeLabel === '全校' && r.data.ranking[0].name === '点赞乙一号' && r.data.ranking[0].likes === 9,
      { scope: r.data.scopeLabel, top: r.data.ranking[0] });
    r = await api('/api/performance/options', { cookie: monA });
    check('5) 班长访问课堂表现选项接口仍 403（未放开）', r.status === 403, r.status);

    // ---------- 6) 筛选项接口 ----------
    console.log('6) 点赞排行榜筛选项:');
    r = await api('/api/likes/options', { cookie: monA });
    check('6) 班长可读筛选项（学科字典 + 本班范围）',
      r.status === 200 && Array.isArray(r.data.subjects) && r.data.subjects.indexOf('数学') >= 0 && r.data.isMonitor === true &&
      String(r.data.scopeLabel).indexOf(CLASS_A) >= 0,
      { subjects: r.data && r.data.subjects, scope: r.data && r.data.scopeLabel });
    r = await api('/api/likes/options', { cookie: stu });
    check('6) 学生读筛选项 → 403', r.status === 403, r.status);
    r = await api('/api/likes/options', { cookie: admin });
    check('6) 管理员读筛选项 → 403（该页面仅班长端）', r.status === 403, r.status);
    r = await api('/api/likes/options', { cookie: tea });
    check('6) 任课老师读筛选项 → 403（老师用「课堂表现」）', r.status === 403, r.status);

    // ---------- 6b) 页面权限：/likes-ranking 仅班长 ----------
    console.log('6b) 点赞排行榜页面权限:');
    const pageOf = async (cookie) => {
      const res = await fetch(BASE + '/likes-ranking', { headers: { Cookie: cookie }, redirect: 'manual' });
      return { status: res.status, loc: res.headers.get('location') || '' };
    };
    let pg = await pageOf(monA);
    check('6b) 班长打开 /likes-ranking → 200', pg.status === 200, pg);
    pg = await pageOf(admin);
    check('6b) 管理员打开 /likes-ranking → 302 回签到台（菜单不再提供）', pg.status === 302 && pg.loc === '/dashboard', pg);
    pg = await pageOf(tea);
    check('6b) 任课老师打开 /likes-ranking → 302 回签到台', pg.status === 302 && pg.loc === '/dashboard', pg);
    pg = await pageOf(stu);
    check('6b) 学生打开 /likes-ranking → 302 回签到台', pg.status === 302 && pg.loc === '/dashboard', pg);

    // 其它班的班长：同样只能看自己班
    r = await api('/api/performance/likes?period=all', { cookie: monB });
    check('6) 乙班班长只看到乙班（点赞乙一号 9）',
      r.status === 200 && r.data.ranking.length === 1 && r.data.ranking[0].name === '点赞乙一号' && r.data.ranking[0].likes === 9,
      r.data.ranking);
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：' + (e && e.stack ? e.stack : e));
  } finally {
    console.log('7) 清理与基线核对…');
    try { await hardCleanup(); } catch (e) { console.log('  · 清理异常：' + e.message); }
    const after = await snapshotReal();
    check('7) 真实数据行数回到用例前（users/grades/classes/students/likes）',
      JSON.stringify(after) === JSON.stringify(realBefore), { before: realBefore, after });
    const leftLikes = await countSql('SELECT count(*)::int n FROM student_likes WHERE operator_name = $1', [OPER]);
    check('7) 无夹具点赞残留', leftLikes === 0, leftLikes);
    console.log(`\n结果：✔ ${pass}  ✘ ${fail}`);
    await pg.end();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
