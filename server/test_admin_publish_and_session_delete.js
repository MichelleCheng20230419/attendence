// ============================================================
// 管理员发布作业 + 删除已结束签到 —— 服务端测试
//   一、管理员发布作业
//     · 管理员（access to any class/subject）可发布；created_by = 管理员 id
//     · 列表/详情返回 publisherIsAdmin=true（前端据此标注「管理员发布」）
//     · 教师仍只能发布自己所带班级 + 所教学科；班长/学生 403
//     · 管理员发布到不存在的班级 → 400
//   三、删除已结束签到
//     · 仅管理员；进行中的场次 → 409；不存在的场次 → 404；非法 id → 400
//     · 删除后：场次消失、签到记录一并删除（计数核对）、关联计划保留但 session_id 置空
//     · 教师/班长 403；删除已完成场次后该场次不再出现在"当天回看"
//   夹具：1 年级 + 3 班 + 3 学生 + 教师/班长账号 + 管理员会话；测完清理并核对真实基线
// ============================================================
'use strict';
const { Pool } = require('pg');
const attendanceRouter = require('./src/routes/attendance');   // 用于定向跑补偿/触发（不新增场次）
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
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}
const n1 = async (sql, params = []) => (await pg.query(sql, params)).rows[0].n;

const TAG = String(Date.now()).slice(-6);
const GRADE = '管理测试年级' + TAG;
const CA = '管理测试甲班' + TAG, CB = '管理测试乙班' + TAG, CC = '管理测试丙班' + TAG;
const TEA = 'adm_tea_' + TAG, MON = 'adm_mon_' + TAG;
const D = '2026-10-15';   // 夹具作业日期（未来，避免与真实作业冲突）
const created = { gradeId: null, classes: [], users: [], students: [], sessions: [], planIds: [], taskIds: [] };
let admin = null, tea = null, mon = null;
const S = {};

// 发起签到：方案 A（v33）后管理员发起 = 校级发起 → 每个班一条场次；
// 这里把响应里的全部场次都登记下来，确保清理时不留"别的班的进行中场次"
async function startSession(cookie, deadlineMinutes, preferClassId) {
  const r = await api('/api/attendance/start', { method: 'POST', cookie, body: { deadlineMinutes } });
  if (r.status !== 201) throw new Error('发起签到失败：' + JSON.stringify(r.data));
  const list = Array.isArray(r.data.sessions) && r.data.sessions.length ? r.data.sessions : [r.data.session];
  for (const s of list) created.sessions.push(s.id);
  const pick = preferClassId
    ? (list.find((s) => Number(s.classId) === Number(preferClassId)) || r.data.session)
    : r.data.session;
  return { session: pick, all: list };
}

async function snapshotReal() {
  return {
    users: await n1('SELECT count(*)::int n FROM users'),
    grades: await n1('SELECT count(*)::int n FROM grades'),
    classes: await n1('SELECT count(*)::int n FROM classes'),
    students: await n1('SELECT count(*)::int n FROM students'),
    tasks: await n1('SELECT count(*)::int n FROM homework_tasks'),
    subs: await n1('SELECT count(*)::int n FROM homework_submissions'),
    sessions: await n1('SELECT count(*)::int n FROM attendance_sessions'),
    records: await n1('SELECT count(*)::int n FROM attendance_records'),
    plans: await n1('SELECT count(*)::int n FROM attendance_plans'),
  };
}
async function cleanup() {
  await pg.query("DELETE FROM homework_submissions WHERE task_id IN (SELECT id FROM homework_tasks WHERE title LIKE '【管理测试】%')").catch(() => {});
  await pg.query("DELETE FROM homework_tasks WHERE title LIKE '【管理测试】%'").catch(() => {});
  const ids = created.sessions.length ? created.sessions : [-1];
  await pg.query('DELETE FROM attendance_records WHERE session_id = ANY($1::int[])', [ids]).catch(() => {});
  await pg.query('UPDATE attendance_plans SET session_id = NULL WHERE id = ANY($1::int[])', [created.planIds.length ? created.planIds : [-1]]).catch(() => {});
  await pg.query('DELETE FROM attendance_plans WHERE id = ANY($1::int[])', [created.planIds.length ? created.planIds : [-1]]).catch(() => {});
  await pg.query('DELETE FROM attendance_sessions WHERE id = ANY($1::int[])', [ids]).catch(() => {});
  await pg.query("SELECT purge_class(id) FROM classes WHERE class_name LIKE '管理测试%班%'").catch(() => {});
  await pg.query("DELETE FROM users WHERE username LIKE 'adm\\_%'").catch(() => {});
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(() => {});
}

(async () => {
  let realBefore = null;
  try {
    console.log('0) 夹具准备…');
    realBefore = await snapshotReal();
    admin = await login('admin');
    const YEAR = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'ADM', academicYear: YEAR } })).data.id;
    for (const name of [CA, CB, CC]) {
      const r = await api('/api/classes', { method: 'POST', cookie: admin, body: { className: name, gradeName: GRADE, academicYear: YEAR } });
      created.classes.push(r.data.id);
    }
    const mkUser = async (u, role, classId) => {
      const r = await api('/api/users', {
        method: 'POST', cookie: admin,
        body: { username: u, password: '123456', role, realName: u, classId, mustChangePassword: false, profileLocked: true, force: true },
      });
      if (r.status !== 201) throw new Error('创建账号失败 ' + u + ' ' + JSON.stringify(r.data));
      created.users.push(r.data.user.id);
      return r.data.user.id;
    };
    await mkUser(TEA, 'teacher', created.classes[0]);
    await mkUser(MON, 'monitor', created.classes[0]);
    tea = await login(TEA); mon = await login(MON);
    for (const [no, nm, cid] of [['ADM' + TAG + '01', '管理甲一', created.classes[0]], ['ADM' + TAG + '02', '管理甲二', created.classes[0]], ['ADM' + TAG + '03', '管理乙一', created.classes[1]]]) {
      const r = await api('/api/students', { method: 'POST', cookie: admin, body: { studentNo: no, name: nm, classId: cid } });
      created.students.push(r.data && (r.data.student ? r.data.student.id : r.data.id));
    }
    check('0) 夹具就绪（1 年级 + 3 班 + 3 学生 + 教师/班长账号）',
      !!created.gradeId && created.classes.length === 3 && created.students.filter(Boolean).length === 3, created);

    // ---------- 一、管理员发布作业 ----------
    console.log('1) 管理员发布作业:');
    let r = await api('/api/homework/tasks', {
      method: 'POST', cookie: admin,
      body: { classIds: [created.classes[1], created.classes[2]], subject: '数学', title: '【管理测试】管理员跨班发布', deadline: `${D} 23:59` },
    });
    check('1) 管理员可发布到【任意班级 + 任意学科】→ 201 且两个班都创建成功',
      r.status === 201 && (r.data.created || []).length === 2 && (r.data.skipped || []).length === 0,
      { status: r.status, created: (r.data.created || []).length, skipped: r.data.skipped });
    const taskIds = (r.data.created || []).map((x) => x.id);
    created.taskIds.push(...taskIds);
    const byAdmin = await n1('SELECT count(*)::int n FROM homework_tasks WHERE id = ANY($1::int[]) AND created_by = $2', [taskIds, 1]);
    check('1) created_by 记录为管理员账号', byAdmin === 2, byAdmin);
    r = await api('/api/homework/tasks?mine=1', { cookie: admin });
    const mineTasks = (r.data.tasks || []).filter((t) => taskIds.includes(t.id));
    check('1) 管理员列表可见且标注 publisherIsAdmin=true（前端显示「管理员发布」）',
      mineTasks.length === 2 && mineTasks.every((t) => t.publisherIsAdmin === true),
      mineTasks.map((t) => ({ id: t.id, cls: t.className, subj: t.subject, admin: t.publisherIsAdmin })));
    check('1) 列表带发布老师名（管理员账号）', mineTasks.every((t) => !!t.teacherName), mineTasks.map((t) => t.teacherName));
    r = await api('/api/homework/tasks/' + taskIds[0], { cookie: admin });
    check('1) 详情接口同样带 publisherIsAdmin + teacherName',
      r.status === 200 && r.data.task.publisherIsAdmin === true && !!r.data.task.teacherName,
      r.data && r.data.task);
    // 班长端可见：管理员给「班长所在班级」也发一条 → 班长端应能看到
    const toMonClass = await api('/api/homework/tasks', {
      method: 'POST', cookie: admin,
      body: { classIds: [created.classes[0]], subject: '语文', title: '【管理测试】发给班长本班', deadline: `${D} 23:59` },
    });
    const monTaskId = ((toMonClass.data || {}).created || [])[0] && toMonClass.data.created[0].id;
    if (monTaskId) created.taskIds.push(monTaskId);
    r = await api('/api/homework/tasks', { cookie: mon });
    const monTasks = (r.data.tasks || []);
    const monSees = monTasks.find((t) => t.id === monTaskId);
    check('1) 班长端能看到管理员发到本班的作业（按班级下发正常）',
      r.status === 200 && !!monSees, { status: r.status, n: monTasks.length, titles: monTasks.map((t) => t.title).slice(0, 5) });
    check('1) 班长端同样能看到「管理员发布」标识', !!monSees && monSees.publisherIsAdmin === true,
      monSees && { title: monSees.title, admin: monSees.publisherIsAdmin });
    check('1) 班长端看不到未发给本班的作业（范围未放宽）',
      !monTasks.some((t) => taskIds.includes(t.id)), monTasks.map((t) => t.id));
    // 教师限制不变
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: tea,
      body: { classIds: [created.classes[1]], subject: '数学', title: '【管理测试】教师跨班应失败', deadline: `${D} 23:59` },
    });
    check('1) 教师发布到别班 → 403（权限没有被放宽）', r.status === 403, { status: r.status, data: r.data });
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: mon,
      body: { classIds: [created.classes[0]], subject: '数学', title: '【管理测试】班长应失败', deadline: `${D} 23:59` },
    });
    check('1) 班长发布 → 403', r.status === 403, r.status);
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: admin,
      body: { classIds: [99999999], subject: '数学', title: '【管理测试】不存在班级', deadline: `${D} 23:59` },
    });
    check('1) 管理员发布到不存在的班级 → 400', r.status === 400, { status: r.status, data: r.data });
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: admin,
      body: { classIds: [created.classes[0]], subject: '不存在的学科', title: '【管理测试】非法学科', deadline: `${D} 23:59` },
    });
    check('1) 非法学科 → 400', r.status === 400, r.status);

    // ---------- 三、删除已结束签到 ----------
    console.log('2) 删除已结束签到:');
    // 造一场已结束的签到（计划触发 → 关闭 → 补缺勤）
    const nowD = new Date(Date.now() - 5 * 60000);
    const hm = `${String(nowD.getHours()).padStart(2, '0')}:${String(nowD.getMinutes()).padStart(2, '0')}`;
    const plan = await pg.query(
      `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, status, class_id, created_by_name)
       VALUES (CURRENT_DATE, $1::time, 5, 'pending', $2, 'admfix') RETURNING id`,
      [hm, created.classes[0]]
    );
    created.planIds.push(plan.rows[0].id);
    // 取"夹具班级那一场"作为夹具场次：签到写入的是该班自己的场次（按班拆场后不再共用一场）
    const cr = await startSession(admin, 1, created.classes[0]);
    const sid = cr.session.id;
    await api('/api/attendance/checkin', { method: 'POST', cookie: tea, body: { studentId: S.a1 || created.students[0], action: 'present' } });
    // 关联到计划 + 置为已结束
    await pg.query('UPDATE attendance_plans SET session_id = $2, status = $3 WHERE id = $1', [plan.rows[0].id, sid, 'ended']);
    await pg.query(`UPDATE attendance_sessions SET status = 'closed', deadline = now() - interval '1 minute' WHERE id = $1`, [sid]);
    const recsBefore = await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1', [sid]);
    check('2) 夹具：已结束场次 #' + sid + '（含 ' + recsBefore + ' 条签到记录）+ 关联计划', recsBefore > 0, recsBefore);

    let d = await api(`/api/attendance/sessions/${sid}`, { method: 'DELETE', cookie: tea });
    check('2) 教师删除 → 403（普通教师不可删除）', d.status === 403, { status: d.status, data: d.data });
    d = await api(`/api/attendance/sessions/${sid}`, { method: 'DELETE', cookie: mon });
    check('2) 班长删除 → 403', d.status === 403, d.status);
    d = await api(`/api/attendance/sessions/${sid}`, { method: 'DELETE' });
    check('2) 未登录 → 401', d.status === 401, d.status);
    d = await api('/api/attendance/sessions/99999999', { method: 'DELETE', cookie: admin });
    check('2) 不存在的场次 → 404', d.status === 404, d.status);
    d = await api('/api/attendance/sessions/abc', { method: 'DELETE', cookie: admin });
    check('2) 非法 id → 400', d.status === 400, d.status);
    // 进行中的场次不能删
    const run = await startSession(admin, 30, created.classes[0]);
    const runSid = run.session.id;
    d = await api(`/api/attendance/sessions/${runSid}`, { method: 'DELETE', cookie: admin });
    check('2) 进行中的场次 → 409（不能删）', d.status === 409, { status: d.status, data: d.data });
    await pg.query(`UPDATE attendance_sessions SET status='closed', deadline = now() - interval '1 minute' WHERE id = $1`, [runSid]);
    // 正常删除
    d = await api(`/api/attendance/sessions/${sid}`, { method: 'DELETE', cookie: admin });
    check('2) 管理员删除已结束签到 → 200，并返回同时删除的记录数',
      d.status === 200 && d.data.deleted === true && d.data.recordsDeleted === recsBefore,
      { status: d.status, data: d.data, expectRecords: recsBefore });
    check('2) 场次已删除（场次表 0 行）', (await n1('SELECT count(*)::int n FROM attendance_sessions WHERE id = $1', [sid])) === 0);
    check('2) 关联签到记录一并删除（0 行）',
      (await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1', [sid])) === 0);
    const p2 = await pg.query('SELECT status, session_id FROM attendance_plans WHERE id = $1', [plan.rows[0].id]);
    check('2) 关联计划保留但 session_id 置空（可再次补签）',
      p2.rowCount === 1 && p2.rows[0].session_id === null && p2.rows[0].status === 'ended', p2.rows[0]);
    const aud = await n1("SELECT count(*)::int n FROM operation_logs WHERE action = 'session_delete' AND detail->>'sessionId' = $1", [String(sid)]);
    check('2) 写入操作日志 session_delete（可追溯）', aud >= 1, aud);
    // 管理员可删除他人发起的场次（同校场次无班级属性）+ 其它数据不受影响
    const otherRecs = await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1', [runSid]);
    d = await api(`/api/attendance/sessions/${runSid}`, { method: 'DELETE', cookie: admin });
    check('2) 连续删除另一场已结束签到同样成功（含 ' + otherRecs + ' 条记录）',
      d.status === 200 && d.data.recordsDeleted === otherRecs, { status: d.status, data: d.data });

    // ---------- 2b) 删除后不得被计划"自动重建"（真实缺陷：删了 0.3 秒后又出现） ----------
    //   根因：repairActivePlans() 对 status='active' 且窗口内的计划，会话缺失时会**重建场次**
    //        （删场次后计划的 session_id 被 FK 置空 → 下一轮补偿就把场次建回来）
    //   修复：删除场次时把该场次对应的「进行中」计划一并置为 ended
    console.log('2b) 删除后不会被计划重建:');
    const back2 = new Date(Date.now() - 60000);
    const hm2 = `${String(back2.getHours()).padStart(2, '0')}:${String(back2.getMinutes()).padStart(2, '0')}`;
    const plan2 = await pg.query(
      `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, status, class_id, created_by_name)
       VALUES (CURRENT_DATE, $1::time, 30, 'pending', $2, 'admfix') RETURNING id`,
      [hm2, created.classes[0]]
    );
    created.planIds.push(plan2.rows[0].id);
    const cr2 = await startSession(admin, 30, created.classes[0]);
    const sid3 = cr2.session.id;
    // 计划与本场绑定且仍处于「进行中」（窗口内）——正是"删了立刻被重建"的场景
    await pg.query('UPDATE attendance_plans SET session_id = $2, status = $3 WHERE id = $1', [plan2.rows[0].id, sid3, 'active']);
    await pg.query(`UPDATE attendance_sessions SET status='closed', deadline = now() - interval '1 minute' WHERE id = $1`, [sid3]);
    d = await api(`/api/attendance/sessions/${sid3}`, { method: 'DELETE', cookie: admin });
    check('2b) 删除「计划进行中」的场次 → 200 且 planEnded=1（计划被一并收尾）',
      d.status === 200 && d.data.planEnded === 1, { status: d.status, data: d.data });
    const p3 = await pg.query('SELECT status, session_id FROM attendance_plans WHERE id = $1', [plan2.rows[0].id]);
    check('2b) 该计划状态被置为 ended（不再是 active/pending）', p3.rows[0].status === 'ended', p3.rows[0]);
    const aud2 = await n1(
      "SELECT count(*)::int n FROM operation_logs WHERE action='session_delete' AND detail->>'sessionId'=$1 AND detail->>'planEnded'='1'",
      [String(sid3)]
    );
    check('2b) 操作日志记录 planEnded=1（可追溯）', aud2 >= 1, aud2);
    // 关键断言：跑一轮「补偿 + 到点触发」后既没有重建场次，也没有新场次
    const actBefore = await n1("SELECT count(*)::int n FROM attendance_sessions WHERE status = 'active'");
    await attendanceRouter.repairActivePlans({ onlyPlanId: plan2.rows[0].id });
    await attendanceRouter.triggerDuePlans({ onlyPlanId: plan2.rows[0].id });
    const p4 = await pg.query('SELECT status, session_id FROM attendance_plans WHERE id = $1', [plan2.rows[0].id]);
    const actAfter = await n1("SELECT count(*)::int n FROM attendance_sessions WHERE status = 'active'");
    check('2b) 跑一轮补偿/触发后：计划仍未绑定场次、也没有新场次被重建（删除是"钉住"的）',
      p4.rows[0].session_id === null && actAfter <= actBefore,
      { plan: p4.rows[0], before: actBefore, after: actAfter });
    check('2b) 该场次确实不存在（未被重建）',
      (await n1('SELECT count(*)::int n FROM attendance_sessions WHERE id = $1', [sid3])) === 0);
    // ---------- 四、管理员提前结束场次（删除的前置动作） ----------
    console.log('3) 管理员提前结束场次（close → delete 全流程）:');
    const run2 = await startSession(admin, 30, created.classes[0]);
    const sid2 = run2.session.id;
    let c = await api(`/api/attendance/sessions/${sid2}/close`, { method: 'POST', cookie: tea });
    check('3) 教师结束场次 → 403', c.status === 403, c.status);
    c = await api('/api/attendance/sessions/99999999/close', { method: 'POST', cookie: admin });
    check('3) 结束不存在的场次 → 404', c.status === 404, c.status);
    c = await api('/api/attendance/sessions/abc/close', { method: 'POST', cookie: admin });
    check('3) 非法 id → 400', c.status === 400, c.status);
    c = await api(`/api/attendance/sessions/${sid2}/close`, { method: 'POST', cookie: admin });
    check('3) 管理员结束进行中的场次 → 200（补缺勤 + 置 closed）',
      c.status === 200 && c.data.closed === true && c.data.records > 0, { status: c.status, data: c.data });
    const s2row = await pg.query('SELECT status, deadline FROM attendance_sessions WHERE id = $1', [sid2]);
    check('3) 场次状态 = closed 且 deadline 已收紧到当前时间',
      s2row.rows[0].status === 'closed' && new Date(s2row.rows[0].deadline) <= new Date(Date.now() + 1000), s2row.rows[0]);
    const absCount = await n1("SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND status = 'absent'", [sid2]);
    check('3) 未签到学生已补缺勤', absCount > 0, absCount);
    c = await api(`/api/attendance/sessions/${sid2}/close`, { method: 'POST', cookie: admin });
    check('3) 重复结束已结束的场次 → 200 幂等（alreadyClosed）', c.status === 200 && c.data.alreadyClosed === true, c.data);
    // 结束后的场次可以删除（管理员）
    const recs2 = await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1', [sid2]);
    const d2 = await api(`/api/attendance/sessions/${sid2}`, { method: 'DELETE', cookie: admin });
    check('3) 结束后的场次可被管理员删除（含 ' + recs2 + ' 条记录）',
      d2.status === 200 && d2.data.recordsDeleted === recs2, { status: d2.status, data: d2.data });
    check('3) 删除后场次与记录都不存在',
      (await n1('SELECT count(*)::int n FROM attendance_sessions WHERE id = $1', [sid2])) === 0
      && (await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1', [sid2])) === 0);
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：' + (e && e.stack ? e.stack : e));
  } finally {
    console.log('3) 清理与基线核对…');
    try { await cleanup(); } catch (e) { console.log('  · 清理异常：' + e.message); }
    const after = await snapshotReal();
    check('3) 真实数据行数回到用例前（users/grades/classes/students/tasks/subs/sessions/records/plans）',
      JSON.stringify(after) === JSON.stringify(realBefore), { before: realBefore, after });
    check('3) 无夹具残留（班级/账号/年级/学生/作业/场次/计划）',
      (await n1("SELECT count(*)::int n FROM classes WHERE class_name LIKE '管理测试%班%'")) === 0
      && (await n1("SELECT count(*)::int n FROM users WHERE username LIKE 'adm\\_%'")) === 0
      && (await n1('SELECT count(*)::int n FROM grades WHERE grade_name = $1', [GRADE])) === 0
      && (await n1("SELECT count(*)::int n FROM students WHERE student_no LIKE 'ADM%'")) === 0
      && (await n1("SELECT count(*)::int n FROM homework_tasks WHERE title LIKE '【管理测试】%'")) === 0
      && (await n1("SELECT count(*)::int n FROM attendance_plans WHERE created_by_name = 'admfix'")) === 0);
    console.log(`\n结果：✔ ${pass}  ✘ ${fail}`);
    await pg.end();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
