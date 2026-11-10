// ============================================================
// 年级 → 班级 联动筛选（作业统计 / 课堂表现）
//   背景：两页新增「先选年级再选班级」联动筛选，数据来源
//         GET /api/grades?academic_year=当前学年
//         GET /api/classes?grade_id=xxx&academic_year=当前学年
//   本套件验证后端配套能力（前端以班级列表客户端联动，故必须保证）：
//     ① /api/grades 按学年返回年级；/api/classes 支持 grade_id 过滤且带 gradeId
//     ② /api/performance/options 的班级列表带 gradeId（前端据此联动，不越权）
//     ③ 新增多班级参数 classIds=1,2,3：作业统计（列表/导出）与课堂表现（记录/点赞/导出）
//        —— 选了年级但班级=全部班级时使用，保证年级筛选对结果真实生效
//     ④ 权限不因新参数放宽：班级不在范围内 → 403；班主任/任课老师的"按班角色"规则不变
//   夹具：2 个年级 + 3 个班（甲1/甲2/乙1）+ 班主任(甲1班主任兼甲2语文) + 乙1班长
//          + 作业（管理员发布 3 条 + 该老师自发布 1 条）+ 点名记录；测完自愈清理
// 用法：node test_grade_class_filter.js（需服务已启动；管理员密码取 DSH_ADMIN_PW）
// ============================================================
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function api(path, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ctype = res.headers.get('content-type') || '';
  let data = null;
  if (ctype.includes('application/json')) { try { data = await res.json(); } catch (_) {} }
  else { try { data = { bufLen: (await res.arrayBuffer()).byteLength }; } catch (_) {} }
  return { status: res.status, data, ctype, setc: res.headers.get('set-cookie') || '' };
}
async function login(u, p) {
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('login ' + u + ' failed: ' + r.status);
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}

const TAG = String(Date.now()).slice(-6);
const G1 = '联动甲年级' + TAG, G2 = '联动乙年级' + TAG;
const CA1 = '联动甲1班' + TAG, CA2 = '联动甲2班' + TAG, CB1 = '联动乙1班' + TAG;
const PRE = 'gcf_' + TAG + '_';
const TITLE = '【联动】' + TAG + ' ';
const fmtD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DDL = `${fmtD(new Date())} 23:59`;
const created = { gradeIds: [], classIds: [], userIds: [], studentIds: [], taskIds: [] };

async function cleanup() {
  const cids = (await pg.query('SELECT id FROM classes WHERE class_name = ANY($1::text[])', [[CA1, CA2, CB1]])).rows.map((r) => r.id);
  const allCids = [...new Set([...created.classIds, ...cids])];
  const uids = (await pg.query('SELECT id FROM users WHERE username LIKE $1', [PRE + '%'])).rows.map((r) => r.id);
  if (allCids.length) {
    await pg.query("DELETE FROM homework_tasks WHERE class_id = ANY($1::int[]) OR title LIKE '【联动】%'", [allCids]).catch(() => {});
    await pg.query('DELETE FROM rollcall_records WHERE class_id = ANY($1::int[])', [allCids]).catch(() => {});
    await pg.query('DELETE FROM student_likes WHERE class_id = ANY($1::int[])', [allCids]).catch(() => {});
  }
  await pg.query("DELETE FROM homework_tasks WHERE title LIKE '【联动】%'").catch(() => {});
  await pg.query("DELETE FROM students WHERE student_no LIKE 'GCF%'").catch(() => {});
  if (uids.length) {
    await pg.query('DELETE FROM rollcall_records WHERE picked_by = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL WHERE head_teacher_id = ANY($1::int[]) OR teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM teacher_classes WHERE teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM users WHERE id = ANY($1::int[])', [uids]).catch(() => {});
  }
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name = ANY($1::text[])', [[CA1, CA2, CB1]]).catch(() => {});
  await pg.query('DELETE FROM grades WHERE grade_name = ANY($1::text[])', [[G1, G2]]).catch(() => {});
}

(async () => {
  try {
    await cleanup();
    const base = {
      classes: (await pg.query('SELECT count(*)::int n FROM classes')).rows[0].n,
      tasks: (await pg.query('SELECT count(*)::int n FROM homework_tasks')).rows[0].n,
      rollcall: (await pg.query('SELECT count(*)::int n FROM rollcall_records')).rows[0].n,
      students: (await pg.query('SELECT count(*)::int n FROM students')).rows[0].n,
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
    };
    const cAdmin = await login('admin');

    // ---------- 夹具 ----------
    const year = (await api('/api/settings', { cookie: cAdmin })).data.currentAcademicYear;
    const g1 = (await api('/api/grades', { method: 'POST', cookie: cAdmin, body: { gradeName: G1, gradeCode: 'GCF1', academicYear: year } })).data.id;
    const g2 = (await api('/api/grades', { method: 'POST', cookie: cAdmin, body: { gradeName: G2, gradeCode: 'GCF2', academicYear: year } })).data.id;
    created.gradeIds = [g1, g2];
    const mkClass = async (name, gradeName) => (await api('/api/classes', { method: 'POST', cookie: cAdmin, body: { className: name, gradeName, academicYear: year } })).data.id;
    const ca1 = await mkClass(CA1, G1);
    const ca2 = await mkClass(CA2, G1);
    const cb1 = await mkClass(CB1, G2);
    created.classIds = [ca1, ca2, cb1];
    const mkStudents = async (classId, n, prefix) => {
      for (let i = 1; i <= n; i += 1) {
        const rr = await api('/api/students', { method: 'POST', cookie: cAdmin, body: { studentNo: prefix + TAG + String(i).padStart(2, '0'), name: prefix + '同学' + i, classId, status: '在读' } });
        if (rr.data && rr.data.student) created.studentIds.push(rr.data.student.id);
      }
      return (await api('/api/students?classId=' + classId + '&status=' + encodeURIComponent('在读'), { cookie: cAdmin })).data.students || [];
    };
    const sA1 = await mkStudents(ca1, 2, 'GCFA');
    const sA2 = await mkStudents(ca2, 2, 'GCFB');
    const sB1 = await mkStudents(cb1, 2, 'GCFC');

    // 老师：甲1 班主任（语文）+ 甲2 任课（语文）；乙1 班长
    let r = await api('/api/users', {
      method: 'POST', cookie: cAdmin,
      body: {
        username: PRE + 'head', password: '123456', role: 'teacher', realName: '联动语文老师', subject: '语文', profileLocked: true,
        teachingClasses: [{ classId: ca1, roleInClass: 'head_teacher' }, { classId: ca2, roleInClass: 'subject_teacher' }],
      },
    });
    if (r.status !== 201) throw new Error('创建老师失败：' + JSON.stringify(r.data));
    created.userIds.push(r.data.user.id);
    const cHead = await login(PRE + 'head');
    r = await api('/api/users', { method: 'POST', cookie: cAdmin, body: { username: PRE + 'mon', password: '123456', role: 'monitor', realName: '乙1班长', classId: cb1, mustChangePassword: false, profileLocked: true } });
    created.userIds.push(r.data.user.id);
    const cMon = await login(PRE + 'mon');
    check('0) 夹具：2 年级 / 3 班 / 6 名学生 / 老师+班长可登录',
      !!g1 && !!g2 && !!ca1 && !!ca2 && !!cb1 && sA1.length === 2 && sA2.length === 2 && sB1.length === 2 && !!cHead && !!cMon,
      { classes: [ca1, ca2, cb1], a1: sA1.length, a2: sA2.length, b1: sB1.length });

    // ---------- 1) 数据来源：年级 / 班级接口 ----------
    r = await api('/api/grades?academic_year=' + encodeURIComponent(year), { cookie: cAdmin });
    const gRow1 = (r.data.grades || []).find((x) => x.id === g1);
    const gRow2 = (r.data.grades || []).find((x) => x.id === g2);
    check('1) GET /api/grades?academic_year → 返回本学年两个夹具年级（含班级数）',
      r.status === 200 && !!gRow1 && !!gRow2 && Number(gRow1.class_count) === 2 && Number(gRow2.class_count) === 1,
      { g1: gRow1 && gRow1.class_count, g2: gRow2 && gRow2.class_count });

    r = await api(`/api/classes?grade_id=${g1}&academic_year=${encodeURIComponent(year)}`, { cookie: cAdmin });
    const gc1 = (r.data.classes || []).map((x) => x.className).sort();
    check('1) GET /api/classes?grade_id=甲年级 → 只返回甲年级的 2 个班',
      r.status === 200 && gc1.length === 2 && gc1[0] === CA1 && gc1[1] === CA2, gc1);
    r = await api(`/api/classes?grade_id=${g2}&academic_year=${encodeURIComponent(year)}`, { cookie: cAdmin });
    const gc2 = (r.data.classes || []).map((x) => x.className);
    check('1) GET /api/classes?grade_id=乙年级 → 只返回乙年级的 1 个班', r.status === 200 && gc2.length === 1 && gc2[0] === CB1, gc2);
    const allClasses = (await api(`/api/classes?academic_year=${encodeURIComponent(year)}`, { cookie: cAdmin })).data.classes || [];
    const rowA1 = allClasses.find((x) => x.id === ca1);
    check('1) 班级列表每行带 gradeId（前端据此做年级→班级联动）',
      !!rowA1 && Number(rowA1.gradeId) === g1 && rowA1.grade === G1, rowA1);

    // ---------- 2) 课堂表现：options 带 gradeId ----------
    r = await api('/api/performance/options', { cookie: cAdmin });
    const optA1 = (r.data.classes || []).find((x) => x.classId === ca1);
    const optB1 = (r.data.classes || []).find((x) => x.classId === cb1);
    check('2) 管理员 /api/performance/options 的班级项带 gradeId / grade',
      r.status === 200 && !!optA1 && Number(optA1.gradeId) === g1 && optA1.grade === G1 && Number(optB1.gradeId) === g2,
      { a1: optA1 && optA1.gradeId, b1: optB1 && optB1.gradeId });
    r = await api('/api/performance/options', { cookie: cHead });
    const headCls = (r.data.classes || []).map((x) => [x.classId, x.gradeId]);
    check('2) 老师 options 只含自己所带的 2 个班（甲1/甲2）且带 gradeId',
      r.status === 200 && headCls.length === 2 && JSON.stringify(headCls.sort()) === JSON.stringify([[ca1, g1], [ca2, g1]].sort()),
      headCls);

    // ---------- 3) 点名记录数据（甲1 语文 / 甲2 语文 / 甲2 数学 / 乙1 语文） ----------
    const pickAt = async (classId, studentId, subject, byId) => {
      await pg.query(
        'INSERT INTO rollcall_records (class_id, student_id, subject, scope, picked_by, picked_by_name) VALUES ($1,$2,$3,$4,$5,$6)',
        [classId, studentId, subject, 'all', byId, '联动夹具']
      );
    };
    const adminId = (await pg.query("SELECT id FROM users WHERE username = 'admin'")).rows[0].id;
    await pickAt(ca1, sA1[0].id, '数学', adminId);
    await pickAt(ca2, sA2[0].id, '语文', adminId);
    await pickAt(ca2, sA2[1].id, '数学', adminId);
    await pickAt(cb1, sB1[0].id, '语文', adminId);
    check('3) 夹具点名记录 4 条（甲1数学 / 甲2语文 / 甲2数学 / 乙1语文）',
      (await pg.query('SELECT count(*)::int n FROM rollcall_records WHERE class_id = ANY($1::int[])', [[ca1, ca2, cb1]])).rows[0].n === 4);

    // ---------- 4) 课堂表现：多班级 classIds ----------
    r = await api(`/api/performance/records?classIds=${ca1},${ca2}`, { cookie: cAdmin });
    const recs = (r.data.records || []).map((x) => x.className);
    check('4) 管理员 records?classIds=甲1,甲2 → 3 条且只含甲1/甲2（乙1 被排除）',
      r.status === 200 && recs.length === 3 && recs.every((n) => n === CA1 || n === CA2), recs);
    check('4) 对比：classIds=甲1,甲2,乙1 → 4 条；classIds=乙1 → 1 条（证明筛选真生效）',
      ((await api(`/api/performance/records?classIds=${ca1},${ca2},${cb1}`, { cookie: cAdmin })).data.records || []).length === 4 &&
      ((await api(`/api/performance/records?classIds=${cb1}`, { cookie: cAdmin })).data.records || []).length === 1);
    r = await api(`/api/performance/records?classIds=${ca2}`, { cookie: cAdmin });
    check('4) classIds 单值等价于 classId（甲2 → 2 条）',
      r.status === 200 && (r.data.records || []).length === 2, (r.data.records || []).length);

    r = await api(`/api/performance/records?classIds=${ca1},${ca2}`, { cookie: cHead });
    const headRecs = (r.data.records || []).map((x) => x.className + '/' + x.subject).sort();
    check('4) 老师（甲1班主任 + 甲2语文）records?classIds=甲1,甲2 → 甲1 全部学科 + 甲2 仅语文',
      r.status === 200 && JSON.stringify(headRecs) === JSON.stringify([CA1 + '/数学', CA2 + '/语文'].sort()), headRecs);
    r = await api(`/api/performance/records?classIds=${ca1},${cb1}`, { cookie: cHead });
    check('4) 老师 classIds 含不在范围内的班（乙1）→ 403（新参数不放宽权限）', r.status === 403, r.data);

    r = await api(`/api/performance/likes?classIds=${cb1}`, { cookie: cMon });
    check('4) 班长点赞排行榜 classIds=本班 → 200', r.status === 200, r.data);
    r = await api(`/api/performance/likes?classIds=${cb1},${ca1}`, { cookie: cMon });
    check('4) 班长 classIds 含别的班 → 403', r.status === 403, r.data);

    r = await api(`/api/performance/export?type=records&classIds=${ca1},${ca2}`, { cookie: cAdmin });
    check('4) 课堂表现导出支持 classIds（200 + xlsx 非空）',
      r.status === 200 && r.ctype.includes('spreadsheet') && r.data.bufLen > 500, { status: r.status, ctype: r.ctype, len: r.data && r.data.bufLen });

    // ---------- 5) 作业统计：多班级 classIds ----------
    const mkTask = async (classIds, subject, title, cookie) => {
      const rr = await api('/api/homework/tasks', { method: 'POST', cookie, body: { classIds, subject, title, deadline: DDL } });
      (rr.data.created || []).forEach((t) => created.taskIds.push(t.id));
      return rr;
    };
    const tA1 = await mkTask([ca1], '语文', TITLE + '甲1语文', cAdmin);
    const tA2 = await mkTask([ca2], '语文', TITLE + '甲2语文(管理员)', cAdmin);
    const tA2m = await mkTask([ca2], '数学', TITLE + '甲2数学(管理员)', cAdmin);
    const tB1 = await mkTask([cb1], '语文', TITLE + '乙1语文', cAdmin);
    const tOwn = await mkTask([ca2], '语文', TITLE + '甲2语文(老师自发布)', cHead);
    check('5) 夹具作业 5 条已发布', [tA1, tA2, tA2m, tB1, tOwn].every((x) => x.status === 201),
      [tA1.status, tA2.status, tA2m.status, tB1.status, tOwn.status]);

    r = await api(`/api/homework/tasks?classIds=${ca1},${ca2}&from=2020-01-01&to=2099-12-31`, { cookie: cAdmin });
    const titles = (r.data.tasks || []).map((x) => x.title);
    check('5) 管理员 tasks?classIds=甲1,甲2 → 4 条，不含乙1',
      r.status === 200 && titles.length === 4 && !titles.includes(TITLE + '乙1语文') && !!r.data.stats && r.data.stats.taskCount === 4,
      { n: titles.length, stats: r.data.stats });
    r = await api(`/api/homework/tasks?classIds=${ca2}&from=2020-01-01&to=2099-12-31`, { cookie: cAdmin });
    check('5) classIds 单值等价于 classId（甲2 → 3 条）',
      r.status === 200 && (r.data.tasks || []).length === 3, (r.data.tasks || []).length);

    r = await api(`/api/homework/tasks?classIds=${ca1},${ca2}&from=2020-01-01&to=2099-12-31`, { cookie: cHead });
    const headTitles = (r.data.tasks || []).map((x) => x.title).sort();
    check('5) 老师 tasks?classIds=甲1,甲2 → 甲1 全部 + 甲2 仅自己发布（按班角色规则不变）',
      r.status === 200 &&
      JSON.stringify(headTitles) === JSON.stringify([TITLE + '甲1语文', TITLE + '甲2语文(老师自发布)'].sort()),
      headTitles);
    r = await api(`/api/homework/tasks?classIds=${ca1},${cb1}`, { cookie: cHead });
    check('5) 老师 classIds 含不在范围内的班 → 403（与单选一致）', r.status === 403, r.data);
    r = await api(`/api/homework/tasks?classIds=${ca1},${cb1}`, { cookie: cMon });
    check('5) 班长 classIds 含别的班 → 403', r.status === 403, r.data);

    r = await api(`/api/homework/export?classIds=${ca1},${ca2}&from=2020-01-01&to=2099-12-31`, { cookie: cAdmin });
    check('5) 作业导出支持 classIds（200 + xlsx 非空）',
      r.status === 200 && r.ctype.includes('spreadsheet') && r.data.bufLen > 500, { status: r.status, ctype: r.ctype, len: r.data && r.data.bufLen });
    r = await api(`/api/homework/export?classIds=${ca1},${cb1}&from=2020-01-01&to=2099-12-31`, { cookie: cHead });
    check('5) 老师导出 classIds 含不在范围内的班 → 403', r.status === 403, r.data);

    // ---------- 6) 前端页面已接入联动（静态核对） ----------
    const hr = await fetch(BASE + '/homework-report.js');
    const hrTxt = await hr.text();
    check('6) 作业统计页脚本：年级下拉 + 年级→班级联动 + classIds 兜底',
      hr.status === 200 && /fGrade/.test(hrTxt) && /function filteredClasses/.test(hrTxt) && /api\/grades/.test(hrTxt) && /classIds/.test(hrTxt));
    const pr = await fetch(BASE + '/performance.js');
    const prTxt = await pr.text();
    check('6) 课堂表现页脚本：年级下拉 + 年级→班级联动 + classIds 兜底',
      pr.status === 200 && /pfGrade/.test(prTxt) && /gradeScopedClasses/.test(prTxt) && /api\/grades/.test(prTxt) && /classIds/.test(prTxt));
    const hh = await fetch(BASE + '/homework-report.html');
    check('6) 作业统计页 HTML 含 #fGrade（默认「全部年级」）',
      hh.status === 200 && /id="fGrade"[\s\S]{0,80}全部年级/.test(await hh.text()));
    const ph = await fetch(BASE + '/performance.html');
    check('6) 课堂表现页 HTML 含 #pfGrade（默认「全部年级」）',
      ph.status === 200 && /id="pfGrade"[\s\S]{0,80}全部年级/.test(await ph.text()));

    // ---------- 7) 真实数据未变 ----------
    await cleanup();
    const after = {
      classes: (await pg.query('SELECT count(*)::int n FROM classes')).rows[0].n,
      tasks: (await pg.query('SELECT count(*)::int n FROM homework_tasks')).rows[0].n,
      rollcall: (await pg.query('SELECT count(*)::int n FROM rollcall_records')).rows[0].n,
      students: (await pg.query('SELECT count(*)::int n FROM students')).rows[0].n,
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
    };
    check('7) 真实数据未变（班级/作业/点名/学生/账号）',
      base.classes === after.classes && base.tasks === after.tasks && base.rollcall === after.rollcall &&
      base.students === after.students && base.users === after.users,
      { base, after });
    check('7) 夹具已清理',
      (await pg.query('SELECT count(*)::int n FROM users WHERE username LIKE $1', [PRE + '%'])).rows[0].n === 0 &&
      (await pg.query('SELECT count(*)::int n FROM classes WHERE class_name = ANY($1::text[])', [[CA1, CA2, CB1]])).rows[0].n === 0 &&
      (await pg.query("SELECT count(*)::int n FROM homework_tasks WHERE title LIKE '【联动】%'")).rows[0].n === 0);
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
