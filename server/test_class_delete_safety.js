// ============================================================
// P0 第 2 步：删除安全网测试（migration_v30_delete_safety.sql）
//   覆盖：
//     1) 数据库层 RESTRICT：裸 SQL 删学生（有历史）/ 删班级 一律被拒（23503），历史不可能被静默清空
//     2) 接口层前置检查：班内还有在读学生 → 400 HAS_ACTIVE_STUDENTS（班级与学生完好无损）
//     3) 归档（软删除）：status=archived → 签到班级列表/随机点名单不含；班级管理仍可见；
//        学生与历史全部保留；取消归档后恢复
//     4) 彻底删除（purge）：无在读学生时直接删；有在读学生必须 force=1；
//        删除后目标班的学生 + 考勤 + 作业提交 + 点名 + 点赞 + 叫号 + 计划 + 带班关系全部清理，
//        教师账号保留（users.class_id 置空），其它班级数据完全不受影响
//     5) 权限：非管理员 403；不存在 404；无效 id 400
//   夹具：1 年级 + 3 班 + 4 学生 + 1 教师 + 各类历史记录；测完清理并核对真实基线
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
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('登录失败 ' + u + ': ' + r.status);
  const m = r.setc.match(/connect\.sid=([^;]+)/);
  return 'connect.sid=' + m[1];
}
const n1 = async (sql, params = []) => (await pg.query(sql, params)).rows[0].n;
const listOf = (d, k) => (d && (d[k] || d.rows || d.classes || d.students || d.data)) || [];

const TAG = String(Date.now()).slice(-6);
const GRADE = '删除安全年级' + TAG;
const CA = '删除甲班' + TAG, CB = '删除乙班' + TAG, CC = '删除丙班' + TAG;
const TEA = 'ds_tea_' + TAG;
const created = { gradeId: null, classes: [], userIds: [], studentIds: [], sessionIds: [], taskIds: [] };
let realBefore = null, admin = null, tea = null;
const S = { a: {}, b: {}, c: {} };   // 各班夹具 id

async function snapshotReal() {
  return {
    users: await n1('SELECT count(*)::int n FROM users'),
    grades: await n1('SELECT count(*)::int n FROM grades'),
    classes: await n1('SELECT count(*)::int n FROM classes'),
    students: await n1('SELECT count(*)::int n FROM students'),
    sessions: await n1('SELECT count(*)::int n FROM attendance_sessions'),
    records: await n1('SELECT count(*)::int n FROM attendance_records'),
    plans: await n1('SELECT count(*)::int n FROM attendance_plans'),
    tasks: await n1('SELECT count(*)::int n FROM homework_tasks'),
    subs: await n1('SELECT count(*)::int n FROM homework_submissions'),
    rollcall: await n1('SELECT count(*)::int n FROM rollcall_records'),
    likes: await n1('SELECT count(*)::int n FROM student_likes'),
    ann: await n1('SELECT count(*)::int n FROM announcements'),
    teacherClasses: await n1('SELECT count(*)::int n FROM teacher_classes'),
  };
}
const classStillThere = async (id) => (await n1('SELECT count(*)::int n FROM classes WHERE id = $1', [id])) === 1;
const studentsOf = async (id) => n1('SELECT count(*)::int n FROM students WHERE class_id = $1', [id]);
const stuHist = async (ids) => ({
  records: await n1('SELECT count(*)::int n FROM attendance_records WHERE student_id = ANY($1::int[])', [ids]),
  subs: await n1('SELECT count(*)::int n FROM homework_submissions WHERE student_id = ANY($1::int[])', [ids]),
  rollcall: await n1('SELECT count(*)::int n FROM rollcall_records WHERE student_id = ANY($1::int[])', [ids]),
  likes: await n1('SELECT count(*)::int n FROM student_likes WHERE student_id = ANY($1::int[])', [ids]),
  ann: await n1('SELECT count(*)::int n FROM announcements WHERE student_id = ANY($1::int[])', [ids]),
});

async function fixtureClass(name, headTeacherId) {
  const r = await api('/api/classes', {
    method: 'POST', cookie: admin,
    body: { className: name, gradeName: GRADE, academicYear: YEAR, headTeacherId },
  });
  if (r.status !== 201) throw new Error('创建班级失败 ' + name + ' ' + JSON.stringify(r.data));
  created.classes.push(r.data.id);
  return r.data.id;
}
let YEAR = null;

(async () => {
  try {
    console.log('0) 夹具准备…');
    realBefore = await snapshotReal();
    admin = await login('admin');
    YEAR = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'DS', academicYear: YEAR } })).data.id;

    const clsA = await fixtureClass(CA, null);
    const clsB = await fixtureClass(CB, null);
    const clsC = await fixtureClass(CC, null);
    S.a.id = clsA; S.b.id = clsB; S.c.id = clsC;

    const mkUser = async (u, classId) => {
      const r = await api('/api/users', {
        method: 'POST', cookie: admin,
        body: { username: u, password: '123456', role: 'teacher', realName: u, classId, mustChangePassword: false, profileLocked: true, force: true },
      });
      if (r.status !== 201) throw new Error('创建账号失败 ' + u + ' ' + JSON.stringify(r.data));
      created.userIds.push(r.data.user.id);
      return r.data.user.id;
    };
    tea = { id: await mkUser(TEA, clsA), cookie: await login(TEA) };

    const mkStudent = async (no, name, classId) => {
      const r = await api('/api/students', { method: 'POST', cookie: admin, body: { studentNo: no, name, classId } });
      const id = (r.data && (r.data.id || (r.data.student && r.data.student.id))) || null;
      if (!id) throw new Error('创建学生失败 ' + no + ' ' + JSON.stringify(r.data));
      created.studentIds.push(id);
      return id;
    };
    S.a.s1 = await mkStudent('DS' + TAG + '01', '删除甲一', clsA);
    S.a.s2 = await mkStudent('DS' + TAG + '02', '删除甲二', clsA);
    S.a.s3 = await mkStudent('DS' + TAG + '03', '删除甲三', clsA);   // 稍后软删除
    S.b.s1 = await mkStudent('DS' + TAG + '04', '删除乙一', clsB);
    S.c.s1 = await mkStudent('DS' + TAG + '05', '删除丙一', clsC);

    // 甲班：各类历史
    const ses = await pg.query(
      `INSERT INTO attendance_sessions (start_time, deadline, status, start_source, deadline_minutes, created_by_name)
       VALUES (now() - interval '2 hours', now() - interval '1 hour', 'closed', 'manual', 30, 'dsfix') RETURNING id`
    );
    created.sessionIds.push(ses.rows[0].id);
    await pg.query(
      `INSERT INTO attendance_records (session_id, student_id, status, checkin_time, check_in_method)
       VALUES ($1, $2, 'present', now() - interval '90 minutes', 'manual'), ($1, $3, 'absent', NULL, 'manual')`,
      [ses.rows[0].id, S.a.s1, S.a.s2]
    );
    const task = await pg.query(
      `INSERT INTO homework_tasks (class_id, subject, date, created_by, title, deadline)
       VALUES ($1, '数学', CURRENT_DATE, $2, '删除安全作业', now() + interval '1 day') RETURNING id`, [clsA, tea.id]
    );
    created.taskIds.push(task.rows[0].id);
    await pg.query('INSERT INTO homework_submissions (task_id, student_id, is_submitted) VALUES ($1, $2, true)', [task.rows[0].id, S.a.s1]);
    await pg.query(
      `INSERT INTO rollcall_records (class_id, student_id, session_id, scope, picked_by, picked_by_name)
       VALUES ($1, $2, $3, 'class', $4, 'dsfix')`, [clsA, S.a.s1, ses.rows[0].id, tea.id]
    );
    await pg.query(
      `INSERT INTO student_likes (student_id, class_id, subject, operator_id, operator_name, like_count)
       VALUES ($1, $2, '数学', $3, 'dsfix', 2)`, [S.a.s1, clsA, tea.id]
    );
    await pg.query(
      `INSERT INTO announcements (class_id, student_id, teacher_id, teacher_name, location, scheduled_time, note)
       VALUES ($1, $2, $3, 'dsfix', '办公室', now() + interval '1 hour', '删除安全用例')`, [clsA, S.a.s1, tea.id]
    );
    const plan = await pg.query(
      `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, status, class_id, created_by, created_by_name)
       VALUES (CURRENT_DATE, '23:30:00', 10, 'pending', $1, $2, 'dsfix') RETURNING id`, [clsA, tea.id]
    );
    S.a.planId = plan.rows[0].id;

    // 丙班：1 名学生（稍后软删除 → 验证"无在读学生即可直接彻底删除"）
    const sesC = await pg.query(
      `INSERT INTO attendance_sessions (start_time, deadline, status, start_source, deadline_minutes, created_by_name)
       VALUES (now() - interval '3 hours', now() - interval '2 hours', 'closed', 'manual', 30, 'dsfix') RETURNING id`
    );
    created.sessionIds.push(sesC.rows[0].id);
    await pg.query(
      `INSERT INTO attendance_records (session_id, student_id, status, check_in_method) VALUES ($1, $2, 'absent', 'manual')`,
      [sesC.rows[0].id, S.c.s1]
    );

    check('0) 夹具就绪（1 年级 + 3 班 + 5 学生 + 1 教师 + 各类历史）',
      !!created.gradeId && created.classes.length === 3 && created.studentIds.length === 5, { classes: created.classes, students: created.studentIds });

    // ---------- 1) 数据库层 RESTRICT ----------
    console.log('1) 数据库层：裸 SQL 删除被拒绝（RESTRICT）:');
    let rawErr = null;
    try { await pg.query('DELETE FROM students WHERE id = $1', [S.a.s1]); } catch (e) { rawErr = e; }
    check('1) 裸 SQL 删除【有考勤历史】的学生 → 23503 外键拒绝',
      !!rawErr && rawErr.code === '23503', rawErr && { code: rawErr.code, msg: String(rawErr.message).slice(0, 120) });
    rawErr = null;
    try { await pg.query('DELETE FROM classes WHERE id = $1', [S.a.id]); } catch (e) { rawErr = e; }
    check('1) 裸 SQL 删除【有学生】的班级 → 23503 外键拒绝（不再静默级联清空历史）',
      !!rawErr && rawErr.code === '23503', rawErr && { code: rawErr.code });
    check('1) 班级与学生完好无损（班级在 / 甲班 3 名学生都在）',
      (await classStillThere(S.a.id)) && (await studentsOf(S.a.id)) === 3, { students: await studentsOf(S.a.id) });
    const histBefore = await stuHist([S.a.s1, S.a.s2]);
    check('1) 历史记录未被删除（考勤 2 / 作业 1 / 点名 1 / 点赞 1 / 叫号 1）',
      histBefore.records === 2 && histBefore.subs === 1 && histBefore.rollcall === 1 && histBefore.likes === 1 && histBefore.ann === 1, histBefore);

    // ---------- 2) 接口前置检查 ----------
    console.log('2) 接口层：在读学生拦截:');
    check('2) （前置）把甲班 1 名学生软删除', (await api(`/api/students/${S.a.s3}`, { method: 'DELETE', cookie: admin })).status === 200);
    let r = await api(`/api/classes/${S.a.id}`, { method: 'DELETE', cookie: admin });
    check('2) 仍有 2 名在读学生 → 400 + code=HAS_ACTIVE_STUDENTS',
      r.status === 400 && r.data && r.data.code === 'HAS_ACTIVE_STUDENTS' && r.data.activeStudents === 2,
      { status: r.status, data: r.data });
    check('2) 提示包含 force 用法与归档建议',
      !!(r.data && /force=1/.test(r.data.hint || '') && /归档/.test(r.data.error || '')), r.data);
    check('2) 被拦后班级仍在、学生数不变（含软删除行共 3）',
      (await classStillThere(S.a.id)) && (await studentsOf(S.a.id)) === 3);

    // ---------- 3) 归档（软删除）----------
    console.log('3) 归档（软删除，数据保留）:');
    r = await api(`/api/classes/${S.a.id}/archive`, { method: 'POST', cookie: admin });
    check('3) 归档 → 200 且 status=archived', r.status === 200 && r.data.status === 'archived', r.data);
    let list = await api('/api/classes', { cookie: admin });
    check('3) 签到班级列表不含已归档班级（前端下拉/签到台不再出现）',
      !listOf(list.data, 'classes').some((c) => c.id === S.a.id), listOf(list.data, 'classes').map((c) => c.id));
    list = await api('/api/classes?includeArchived=1', { cookie: admin });
    const archRow = listOf(list.data, 'classes').find((c) => c.id === S.a.id);
    check('3) includeArchived=1 时可见且 status=archived', !!archRow && archRow.status === 'archived', archRow);
    list = await api('/api/rollcall/classes', { cookie: admin });
    check('3) 随机点名的班级列表不含已归档班级',
      !listOf(list.data, 'classes').some((c) => c.id === S.a.id), listOf(list.data, 'classes').map((c) => c.id));
    list = await api('/api/classes/manage', { cookie: admin });
    const manageRow = listOf(list.data, 'classes').find((c) => c.id === S.a.id);
    check('3) 班级管理列表仍可见（带归档标记），在读学生统计仍为 2（软删除行不计）',
      !!manageRow && manageRow.status === 'archived' && manageRow.student_count === 2, manageRow);
    check('3) 归档不改学生数据（在读 2 / 物理行 3 / 历史记录不变）',
      (await n1('SELECT count(*)::int n FROM students WHERE class_id = $1 AND is_active = true', [S.a.id])) === 2
      && (await studentsOf(S.a.id)) === 3
      && JSON.stringify(await stuHist([S.a.s1, S.a.s2])) === JSON.stringify(histBefore));
    r = await api(`/api/classes/${S.a.id}/unarchive`, { method: 'POST', cookie: admin });
    check('3) 取消归档 → 200 且 status=active', r.status === 200 && r.data.status === 'active', r.data);
    list = await api('/api/classes', { cookie: admin });
    check('3) 取消归档后重新出现在签到班级列表', listOf(list.data, 'classes').some((c) => c.id === S.a.id));

    // ---------- 4) 彻底删除 ----------
    console.log('4) 彻底删除（purge）:');
    // 4.1 无在读学生（丙班学生已软删除）→ 直接删除
    check('4) （前置）丙班学生软删除', (await api(`/api/students/${S.c.s1}`, { method: 'DELETE', cookie: admin })).status === 200);
    r = await api(`/api/classes/${S.c.id}`, { method: 'DELETE', cookie: admin });
    check('4) 无在读学生 → 直接彻底删除成功（studentsRemoved=1，含软删除行）',
      r.status === 200 && r.data.deleted === true && r.data.studentsRemoved === 1, r.data);
    check('4) 丙班班级/学生/考勤记录全部物理清除',
      !(await classStillThere(S.c.id))
      && (await studentsOf(S.c.id)) === 0
      && (await n1('SELECT count(*)::int n FROM attendance_records WHERE student_id = $1', [S.c.s1])) === 0);

    // 4.2 有在读学生 → 必须 force=1
    check('4) 甲班仍有 2 名在读学生 → 非 force 再次被拦',
      (await api(`/api/classes/${S.a.id}`, { method: 'DELETE', cookie: admin })).status === 400);
    r = await api(`/api/classes/${S.a.id}?force=1`, { method: 'DELETE', cookie: admin });
    check('4) force=1 → 彻底删除成功（forced=true / studentsRemoved=3）',
      r.status === 200 && r.data.forced === true && r.data.studentsRemoved === 3, r.data);
    check('4) 甲班班级与全部学生（含软删除行）物理清除',
      !(await classStillThere(S.a.id)) && (await studentsOf(S.a.id)) === 0);
    const histAfter = await stuHist([S.a.s1, S.a.s2]);
    check('4) 该班学生历史全部清理（考勤/作业/点名/点赞/叫号 归零）',
      histAfter.records === 0 && histAfter.subs === 0 && histAfter.rollcall === 0 && histAfter.likes === 0 && histAfter.ann === 0, histAfter);
    check('4) 班级级数据清理（作业任务 / 计划 / 带班关系）',
      (await n1('SELECT count(*)::int n FROM homework_tasks WHERE class_id = $1', [S.a.id])) === 0
      && (await n1('SELECT count(*)::int n FROM attendance_plans WHERE class_id = $1', [S.a.id])) === 0
      && (await n1('SELECT count(*)::int n FROM teacher_classes WHERE class_id = $1', [S.a.id])) === 0);
    check('4) 教师账号保留（users.class_id 置空，不再引用已删班级）',
      (await n1('SELECT count(*)::int n FROM users WHERE id = $1', [tea.id])) === 1
      && (await n1('SELECT count(*)::int n FROM users WHERE id = $1 AND class_id IS NULL', [tea.id])) === 1);
    check('4) 其它班级完全不受影响（乙班班级 + 学生 + 头教师字段都在）',
      (await classStillThere(S.b.id)) && (await studentsOf(S.b.id)) === 1);

    // ---------- 5) 权限与错误码 ----------
    console.log('5) 权限与错误码:');
    r = await api(`/api/classes/${S.b.id}`, { method: 'DELETE', cookie: tea.cookie });
    check('5) 教师删除班级 → 403', r.status === 403, { status: r.status, data: r.data });
    r = await api(`/api/classes/${S.b.id}/archive`, { method: 'POST', cookie: tea.cookie });
    check('5) 教师归档班级 → 403', r.status === 403, r.status);
    r = await api('/api/classes/99999999', { method: 'DELETE', cookie: admin });
    check('5) 不存在的班级 → 404', r.status === 404, { status: r.status, data: r.data });
    r = await api('/api/classes/abc', { method: 'DELETE', cookie: admin });
    check('5) 非法班级 ID → 400', r.status === 400, r.status);
    r = await api('/api/classes/99999999/archive', { method: 'POST', cookie: admin });
    check('5) 归档不存在的班级 → 404', r.status === 404, r.status);
    r = await api(`/api/classes/${S.b.id}`, { method: 'DELETE' });
    check('5) 未登录删除班级 → 401', r.status === 401, r.status);
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：' + (e && e.stack ? e.stack : e));
  } finally {
    console.log('6) 清理与基线核对…');
    try {
      await pg.query("SELECT purge_class(id) FROM classes WHERE class_name LIKE '删除_班%' OR class_name LIKE '删除%班%'");
    } catch (e) { console.log('  · purge 夹具班级失败：' + e.message); }
    try {
      await pg.query('DELETE FROM attendance_sessions WHERE created_by_name = $1', ['dsfix']);
      await pg.query('DELETE FROM attendance_records WHERE session_id = ANY($1::int[])', [created.sessionIds.length ? created.sessionIds : [-1]]);
      await pg.query('DELETE FROM attendance_sessions WHERE id = ANY($1::int[])', [created.sessionIds.length ? created.sessionIds : [-1]]);
      await pg.query("DELETE FROM homework_tasks WHERE title = '删除安全作业'");
      await pg.query('DELETE FROM users WHERE username LIKE $1', ['ds\\_%']);
      await pg.query('DELETE FROM grades WHERE grade_name LIKE $1', ['删除安全年级%']);
    } catch (e) { console.log('  · 清理异常：' + e.message); }
    const after = await snapshotReal();
    check('6) 真实数据行数回到用例前',
      JSON.stringify(after) === JSON.stringify(realBefore), { before: realBefore, after });
    check('6) 无夹具残留（班级/账号/年级/学生/场次）',
      (await n1("SELECT count(*)::int n FROM classes WHERE class_name LIKE '删除%班%'")) === 0
      && (await n1("SELECT count(*)::int n FROM users WHERE username LIKE 'ds\\_%'")) === 0
      && (await n1("SELECT count(*)::int n FROM grades WHERE grade_name LIKE '删除安全年级%'")) === 0
      && (await n1("SELECT count(*)::int n FROM students WHERE student_no LIKE 'DS%'")) === 0
      && (await n1("SELECT count(*)::int n FROM attendance_sessions WHERE created_by_name = 'dsfix'")) === 0);
    console.log(`\n结果：✔ ${pass}  ✘ ${fail}`);
    await pg.end();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
