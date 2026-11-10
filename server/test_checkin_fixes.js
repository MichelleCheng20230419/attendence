// ============================================================
// 签到台 4 个问题的修复验证（问题1~4）
//   问题2：先标记请假，再「全员到齐」→ 请假学生不被覆盖（只补齐未标记）
//   问题3：同一场次同一学生只有一条记录，重复签到不累加（404/409 + 行数不变）
//   问题4：截止后只把【未签到】的学生标为缺勤；已签到/已请假状态保持不变
//   问题1：卡片颜色（前端）——服务端侧先锁定"截止后已签到仍是 present、未签到是 absent"，
//          页面颜色由 tests/ui_checkin_fixes.html 断言（绿色/红色/灰色）
//   另覆盖：场次钉住（/api/attendance/status?sessionId=）避免被新场次顶掉后"已签到全部消失"；
//           计划触发不再抢占进行中的场次（triggerDuePlans 定向触发）
//   夹具：1 年级 + 1 班 + 3 学生 + 教师账号；测完清理并核对真实基线
// ============================================================
'use strict';
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });
const attendanceRouter = require('./src/routes/attendance');   // 用于定向触发计划（triggerDuePlans）

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
const recOf = (status, sid) => (status.records || {})[sid] || null;

const TAG = String(Date.now()).slice(-6);
const GRADE = '签到修复年级' + TAG, CLASS = '签到修复班' + TAG, TEA = 'cf_tea_' + TAG;
const created = { gradeId: null, classId: null, userIds: [], studentIds: [], sessionIds: [], planIds: [] };
let realBefore = null;
let admin = null, tea = null;
const S = {};
const TODAY = new Date().toISOString().slice(0, 10);

async function snapshotReal() {
  return {
    users: await n1('SELECT count(*)::int n FROM users'),
    grades: await n1('SELECT count(*)::int n FROM grades'),
    classes: await n1('SELECT count(*)::int n FROM classes'),
    students: await n1('SELECT count(*)::int n FROM students'),
    sessions: await n1('SELECT count(*)::int n FROM attendance_sessions'),
    records: await n1('SELECT count(*)::int n FROM attendance_records'),
    plans: await n1('SELECT count(*)::int n FROM attendance_plans'),
  };
}
// 只清理本用例自己创建的场次/计划（绝不触碰真实数据）
async function cleanup() {
  if (created.sessionIds.length === 0 && created.planIds.length === 0) return;
  const ids = created.sessionIds.length ? created.sessionIds : [-1];
  await pg.query('DELETE FROM attendance_records WHERE session_id = ANY($1::int[])', [ids]).catch(() => {});
  await pg.query('DELETE FROM attendance_plans WHERE session_id = ANY($1::int[])', [ids]).catch(() => {});
  await pg.query('UPDATE attendance_plans SET session_id = NULL WHERE id = ANY($1::int[])', [created.planIds.length ? created.planIds : [-1]]).catch(() => {});
  await pg.query("SELECT purge_class(id) FROM classes WHERE class_name LIKE $1", [CLASS + '%']).catch(() => {});
  await pg.query('DELETE FROM attendance_plans WHERE id = ANY($1::int[])', [created.planIds.length ? created.planIds : [-1]]).catch(() => {});
  await pg.query('DELETE FROM attendance_sessions WHERE id = ANY($1::int[])', [ids]).catch(() => {});
  await pg.query("DELETE FROM users WHERE username LIKE 'cf\\_%'").catch(() => {});
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(() => {});
}

async function newSession(minutes, cookie) {
  const r = await api('/api/attendance/start', { method: 'POST', cookie, body: { deadlineMinutes: minutes } });
  if (r.status !== 201) throw new Error('发起签到失败：' + JSON.stringify(r.data));
  // 方案 A（v33）：管理员发起 = 校级发起，按班拆成多场（每班一条）→ 全部登记以便清理，
  // 并把"夹具班级那场"作为本用例的操作对象（教师发起时只有一场）
  const list = Array.isArray(r.data.sessions) && r.data.sessions.length ? r.data.sessions : [r.data.session];
  for (const s of list) created.sessionIds.push(s.id);
  return list.find((s) => Number(s.classId) === Number(created.classId)) || r.data.session;
}
async function expireSession(sid) {
  // 把截止时间推到过去，模拟"签到窗口已到点"
  await pg.query(`UPDATE attendance_sessions SET deadline = now() - interval '1 minute' WHERE id = $1`, [sid]);
}

(async () => {
  try {
    console.log('0) 夹具准备…');
    realBefore = await snapshotReal();
    admin = await login('admin');
    tea = await login(TEA).catch(() => null);   // 账号还没建，稍后创建
    const YEAR = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'CF', academicYear: YEAR } })).data.id;
    created.classId = (await api('/api/classes', { method: 'POST', cookie: admin, body: { className: CLASS, gradeName: GRADE, academicYear: YEAR } })).data.id;
    const mkUser = async (u, classId) => {
      const r = await api('/api/users', {
        method: 'POST', cookie: admin,
        body: { username: u, password: '123456', role: 'teacher', realName: u, classId, mustChangePassword: false, profileLocked: true, force: true },
      });
      if (r.status !== 201) throw new Error('创建账号失败 ' + u + ' ' + JSON.stringify(r.data));
      created.userIds.push(r.data.user.id);
      return r.data.user.id;
    };
    await mkUser(TEA, created.classId);
    tea = await login(TEA);
    const mkStudent = async (no, name) => {
      const r = await api('/api/students', { method: 'POST', cookie: admin, body: { studentNo: no, name, classId: created.classId } });
      const id = r.data && (r.data.id || (r.data.student && r.data.student.id));
      created.studentIds.push(id);
      return id;
    };
    S.s1 = await mkStudent('CF' + TAG + '01', '修复生一');
    S.s2 = await mkStudent('CF' + TAG + '02', '修复生二');
    S.s3 = await mkStudent('CF' + TAG + '03', '修复生三');
    check('0) 夹具就绪（1 年级 + 1 班 + 3 学生 + 1 教师账号）',
      !!created.gradeId && !!created.classId && created.studentIds.length === 3, created);

    // ---------- 问题2：先请假，再全员到齐 ----------
    console.log('1) 问题2：请假学生不被「全员到齐」覆盖:');
    const ses1 = await newSession(30, tea);
    check('1) 发起签到成功（session #' + ses1.id + '）', !!ses1.id);
    let r = await api('/api/attendance/checkin', {
      method: 'POST', cookie: tea,
      body: { studentId: S.s1, action: 'leave', leaveReason: 'sick' },
    });
    check('1) 先标记「请假」成功', (r.status === 200 || r.status === 201) && r.data.record.status === 'leave', r.data);
    r = await api('/api/attendance/checkin', { method: 'POST', cookie: tea, body: { studentId: S.s2, action: 'present' } });
    check('1) 再单独签到一人（应保持已签到）', (r.status === 200 || r.status === 201) && r.data.record.status === 'present', r.data);
    r = await api('/api/attendance/batch-checkin', { method: 'POST', cookie: tea, body: { mode: 'all', classId: created.classId } });
    check('1) 「全员到齐」只补齐未标记：updated=1 / skipped=2',
      r.status === 200 && r.data.updated === 1 && r.data.skipped === 2, r.data);
    const leaveRec = await pg.query('SELECT status, leave_reason FROM attendance_records WHERE session_id = $1 AND student_id = $2', [ses1.id, S.s1]);
    check('1) 请假学生仍是 leave（事由 sick，未被覆盖成 present）',
      leaveRec.rows[0].status === 'leave' && leaveRec.rows[0].leave_reason === 'sick', leaveRec.rows[0]);
    const p2 = await pg.query('SELECT status FROM attendance_records WHERE session_id = $1 AND student_id = $2', [ses1.id, S.s2]);
    check('1) 已签到学生仍是 present', p2.rows[0].status === 'present', p2.rows[0]);
    const p3 = await pg.query('SELECT status FROM attendance_records WHERE session_id = $1 AND student_id = $2', [ses1.id, S.s3]);
    check('1) 未标记学生被补成 present', p3.rows[0].status === 'present', p3.rows[0]);

    // ---------- 问题3：重复签到不累加 ----------
    console.log('2) 问题3：一次签到只算一次:');
    const cntBefore = await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = ANY($2::int[])', [ses1.id, [S.s1, S.s2, S.s3]]);
    r = await api('/api/attendance/checkin', { method: 'POST', cookie: tea, body: { studentId: S.s2, action: 'present' } });
    check('2) 已签到学生再点一次 → 409「不能重复操作」', r.status === 409 && /不能重复操作/.test(r.data.error), { status: r.status, data: r.data });
    r = await api('/api/attendance/batch-checkin', { method: 'POST', cookie: tea, body: { mode: 'all', classId: created.classId } });
    check('2) 再点「全员到齐」→ updated=0（全部已标记）', r.status === 200 && r.data.updated === 0, r.data);
    const cntAfter = await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = ANY($2::int[])', [ses1.id, [S.s1, S.s2, S.s3]]);
    check('2) 本班场次记录数不变（3 人 = 3 条，没有累加）', cntBefore === 3 && cntAfter === 3, { before: cntBefore, after: cntAfter });
    const dup = await n1('SELECT count(*)::int n FROM (SELECT student_id FROM attendance_records WHERE session_id = $1 AND student_id = ANY($2::int[]) GROUP BY 1 HAVING count(*) > 1) x', [ses1.id, [S.s1, S.s2, S.s3]]);
    check('2) 无任何学生在本场次出现多条记录', dup === 0, dup);

    // ---------- 问题4：截止后只补未签到 ----------
    console.log('3) 问题4：截止后已签到/已请假保持不变:');
    await api('/api/attendance/checkin', { method: 'POST', cookie: tea, body: { studentId: S.s3, action: 'cancel' } }).then(() => {}, () => {});
    // 让 s3 回到"未签到"：先取消，再确认
    const s3state = await pg.query('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = $2', [ses1.id, S.s3]);
    check('3) 取消后 s3 无记录（未签到）', s3state.rows[0].n === 0, s3state.rows[0]);
    await expireSession(ses1.id);
    const st = await api('/api/attendance/status', { cookie: tea });
    const st1 = await api(`/api/attendance/status?sessionId=${ses1.id}`, { cookie: tea });
    check('3) 截止后 s1 仍为 leave / s2 仍为 present（未被改成缺勤）',
      recOf(st1.data, S.s1).status === 'leave' && recOf(st1.data, S.s2).status === 'present',
      { s1: recOf(st1.data, S.s1), s2: recOf(st1.data, S.s2) });
    check('3) 只有未签到的 s3 被补成 absent', recOf(st1.data, S.s3).status === 'absent', recOf(st1.data, S.s3));
    check('3) 场次已自动结束（status=closed）', st1.data.session.status === 'closed', st1.data.session);
    const afterFin = await pg.query(
      'SELECT student_id, status FROM attendance_records WHERE session_id = $1 AND student_id = ANY($2::int[]) ORDER BY student_id',
      [ses1.id, created.studentIds]
    );
    // 说明：场次是全校场次，截止补缺勤会给全校在读学生各写一条 absent（既有行为）；
    // 这里只断言本用例 3 名学生：leave / present / absent，且每人恰好一条（没有重复写行）
    check('3) 本班 3 名学生各只有一条记录（leave/present/absent，未重复写行）',
      afterFin.rowCount === 3 && afterFin.rows.map((x) => x.status).sort().join(',') === 'absent,leave,present',
      afterFin.rows);
    const dupFin = await n1(
      'SELECT count(*)::int n FROM (SELECT student_id FROM attendance_records WHERE session_id = $1 GROUP BY 1 HAVING count(*) > 1) x',
      [ses1.id]
    );
    check('3) 全场次无任何学生出现重复记录', dupFin === 0, dupFin);
    const again = await api('/api/attendance/status', { cookie: tea });
    const stillOk = await pg.query('SELECT status FROM attendance_records WHERE session_id = $1 AND student_id = $2', [ses1.id, S.s2]);
    check('3) 再次轮询状态不会把已签到改成缺勤', stillOk.rows[0].status === 'present', stillOk.rows[0]);

    // ---------- 问题1 的服务端侧：颜色依据（present 保持） ----------
    console.log('4) 问题1 服务端依据（页面颜色由 UI 驱动断言）:');
    check('4) 状态接口返回 present 记录 → 前端渲染绿色（records 键存在且状态为 present）',
      !!recOf(st1.data, S.s2) && recOf(st1.data, S.s2).status === 'present');
    check('4) 未签到学生返回 absent（红色）而非"无记录灰"', recOf(st1.data, S.s3).status === 'absent');

    // ---------- 场次钉住：不被新场次顶掉 ----------
    console.log('5) 场次钉住（避免"已签到全部消失/变成缺勤"）:');
    const ses2 = await newSession(30, admin);   // 新场次（模拟计划自动触发/别人发起）
    const pinned = await api(`/api/attendance/status?sessionId=${ses1.id}`, { cookie: tea });
    check('5) 指定 sessionId → 返回指定场次（pinned=true）且记录保留',
      pinned.status === 200 && pinned.data.pinned === true && pinned.data.session.id === ses1.id && recOf(pinned.data, S.s2).status === 'present',
      { pinned: pinned.data.pinned, sid: pinned.data.session.id, rec: recOf(pinned.data, S.s2) });
    const unpinned = await api('/api/attendance/status', { cookie: tea });
    check('5) 不带 sessionId → 返回当前最新进行中的场次（默认行为不变）',
      unpinned.data.session.id === ses2.id && unpinned.data.pinned === false, { sid: unpinned.data.session.id, pinned: unpinned.data.pinned });
    const tooOld = await api('/api/attendance/status?sessionId=1', { cookie: tea });
    check('5) 指定过老的场次（>1 天）→ 忽略并回落到当前场次', tooOld.data.session.id === ses2.id && tooOld.data.pinned === false,
      { sid: tooOld.data.session.id, pinned: tooOld.data.pinned });

    // ---------- 6) 计划触发不抢占进行中的场次 ----------
    console.log('6) 计划触发不抢占进行中的场次:');
    const plan = await pg.query(
      `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, status, class_id, created_by_name)
       VALUES (CURRENT_DATE, (now() - interval '1 minute')::time, 5, 'pending', $1, 'cffix') RETURNING id`,
      [created.classId]
    );
    created.planIds.push(plan.rows[0].id);
    const before = await n1('SELECT count(*)::int n FROM attendance_sessions');
    await attendanceRouter.triggerDuePlans({ onlyPlanId: plan.rows[0].id });
    const ses2After = await pg.query('SELECT status FROM attendance_sessions WHERE id = $1', [ses2.id]);
    const planAfter = await pg.query('SELECT status, session_id FROM attendance_plans WHERE id = $1', [plan.rows[0].id]);
    check('6) 进行中的场次不被关闭（老师正在登记的场次不会被抢）', ses2After.rows[0].status === 'active', ses2After.rows[0]);
    check('6) 计划保持 pending（不新建场次、不补缺勤）',
      planAfter.rows[0].status === 'pending' && planAfter.rows[0].session_id === null, planAfter.rows[0]);
    check('6) 没有新建场次', (await n1('SELECT count(*)::int n FROM attendance_sessions')) === before, before);
    // 场次结束后再触发 → 正常创建
    await pg.query(`UPDATE attendance_sessions SET status='closed', deadline = now() - interval '1 minute' WHERE id = $1`, [ses2.id]);
    await attendanceRouter.triggerDuePlans({ onlyPlanId: plan.rows[0].id });
    const planAfter2 = await pg.query('SELECT status, session_id FROM attendance_plans WHERE id = $1', [plan.rows[0].id]);
    check('6) 场次结束后计划可正常触发（status=active + 关联场次）',
      planAfter2.rows[0].status === 'active' && Number.isInteger(planAfter2.rows[0].session_id), planAfter2.rows[0]);
    if (Number.isInteger(planAfter2.rows[0].session_id)) created.sessionIds.push(planAfter2.rows[0].session_id);
    await pg.query(`UPDATE attendance_sessions SET status='closed' WHERE id = $1`, [planAfter2.rows[0].session_id]);
    await pg.query(`UPDATE attendance_plans SET status='ended', session_id = NULL WHERE id = $1`, [plan.rows[0].id]);

    // ---------- 7) 同点双计划：不再"每分钟互相顶掉"（场次抖动） ----------
    // 复现真实事故：两个班同一时刻各有计划 → 旧逻辑每轮互相关闭对方场次并新建，
    // 07:15~07:34 每分钟产生一个"全员缺勤"幽灵场次，把老师已签到的场次切走。
    console.log('7) 同点双计划不再抖动:');
    const mkPlan = async (classId, name) => {
      const r = await pg.query(
        `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, status, class_id, created_by_name)
         VALUES (CURRENT_DATE, (now() - interval '1 minute')::time, 30, 'pending', $1, $2) RETURNING id`,
        [classId, name]
      );
      created.planIds.push(r.rows[0].id);
      return r.rows[0].id;
    };
    const pA = await mkPlan(created.classId, 'cffixA');
    const pB = await mkPlan(created.classId, 'cffixB');
    const sessionsBefore = await n1('SELECT count(*)::int n FROM attendance_sessions');
    await attendanceRouter.triggerDuePlans({ onlyPlanId: pA });
    const afterA = await pg.query('SELECT status, session_id FROM attendance_plans WHERE id = $1', [pA]);
    const sharedSessionId = afterA.rows[0].session_id;
    if (Number.isInteger(sharedSessionId)) created.sessionIds.push(sharedSessionId);
    check('7) 第一个计划正常触发（active + 关联场次）',
      afterA.rows[0].status === 'active' && Number.isInteger(sharedSessionId), afterA.rows[0]);
    await attendanceRouter.triggerDuePlans({ onlyPlanId: pB });
    const afterB = await pg.query('SELECT status, session_id FROM attendance_plans WHERE id = $1', [pB]);
    check('7) 第二个同点计划与第一场【共用】，不新建场次',
      afterB.rows[0].status === 'active' && afterB.rows[0].session_id === sharedSessionId, afterB.rows[0]);
    check('7) 场次总数只 +1（未产生第二场）',
      (await n1('SELECT count(*)::int n FROM attendance_sessions')) === sessionsBefore + 1,
      { before: sessionsBefore, after: await n1('SELECT count(*)::int n FROM attendance_sessions') });
    // 连续多轮触发 + 修复（模拟 scheduler 每分钟一次）→ 不得再产生新场次
    for (let i = 0; i < 3; i++) {
      await attendanceRouter.triggerDuePlans({ onlyPlanId: pA });
      await attendanceRouter.triggerDuePlans({ onlyPlanId: pB });
      await attendanceRouter.repairActivePlans({ onlyPlanId: pA });
      await attendanceRouter.repairActivePlans({ onlyPlanId: pB });
    }
    const sessAfter3 = await n1('SELECT count(*)::int n FROM attendance_sessions');
    check('7) 连跑 3 轮触发+修复 → 场次总数不变（抖动被彻底消除）',
      sessAfter3 === sessionsBefore + 1, { before: sessionsBefore, expect: sessionsBefore + 1, after: sessAfter3 });
    const stillActive = await pg.query('SELECT status FROM attendance_sessions WHERE id = $1', [sharedSessionId]);
    check('7) 进行中的场次始终没有被关闭（老师正在登记的场次不会被抢）',
      stillActive.rows[0].status === 'active', stillActive.rows[0]);
    const links = await pg.query('SELECT id, status, session_id FROM attendance_plans WHERE id IN ($1, $2) ORDER BY id', [pA, pB]);
    check('7) 两个计划都仍然指向同一场次',
      links.rows.every((x) => x.status === 'active' && x.session_id === sharedSessionId), links.rows);
    // 该共用场次也不应被写入任何缺勤记录（未到截止时间）
    //   注意：只统计【本用例夹具学生】——真实库里可能有"当天全天请假"登记（批量请假），
    //   那份登记会被自动同步进新场次（check_in_method='batch_leave'），与本用例无关。
    check('7) 进行中的共用场次没有产生"全体缺勤"记录（本班学生 0 条记录）',
      (await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = ANY($2::int[])', [sharedSessionId, [S.s1, S.s2, S.s3]])) === 0,
      await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = ANY($2::int[])', [sharedSessionId, [S.s1, S.s2, S.s3]]));
    await pg.query(`UPDATE attendance_sessions SET status='closed' WHERE id = $1`, [sharedSessionId]);
    await pg.query(`UPDATE attendance_plans SET status='ended', session_id = NULL WHERE id IN ($1, $2)`, [pA, pB]);
    // ---------- 8) 结束回看按班级收敛（别的班专属场次不再让本班显示"全体缺勤"） ----------
    console.log('8) 结束回看按班级收敛:');
    // 夹具2：另一个班 + 1 名学生（模拟"别的班的计划场次"）
    const clsB = (await api('/api/classes', {
      method: 'POST', cookie: admin,
      body: { className: CLASS + 'B', gradeName: GRADE, academicYear: YEAR },
    }));
    const classBId = clsB.data && clsB.data.id;
    created.classIds = created.classIds || [];
    if (classBId) created.classIds.push(classBId);
    const stuB = await api('/api/students', { method: 'POST', cookie: admin, body: { studentNo: 'CF' + TAG + '09', name: '修复生乙班', classId: classBId } });
    const stuBId = stuB.data && (stuB.data.student ? stuB.data.student.id : stuB.data.id);
    // 用计划触发一场"乙班专属"场次（计划 start=当前分钟，窗口 30 分钟 → 立即触发为 active）
    const nowD = new Date();
    const hm = `${String(nowD.getHours()).padStart(2, '0')}:${String(nowD.getMinutes()).padStart(2, '0')}`;
    const planB = await pg.query(
      `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, status, class_id, created_by_name)
       VALUES (CURRENT_DATE, $1::time, 30, 'pending', $2, 'cffix') RETURNING id`, [hm, classBId]
    );
    created.planIds.push(planB.rows[0].id);
    await attendanceRouter.triggerDuePlans({ onlyPlanId: planB.rows[0].id });
    const pb = await pg.query('SELECT status, session_id FROM attendance_plans WHERE id = $1', [planB.rows[0].id]);
    const bSessionId = pb.rows[0].session_id;
    if (Number.isInteger(bSessionId)) created.sessionIds.push(bSessionId);
    check('8) 乙班计划已触发并生成场次', pb.rows[0].status === 'active' && Number.isInteger(bSessionId), pb.rows[0]);
    // 把它结束（模拟"这场已截止"）
    await pg.query(`UPDATE attendance_sessions SET status = 'closed', deadline = now() - interval '1 minute' WHERE id = $1`, [bSessionId]);
    // 甲班老师（本用例教师账号绑甲班）回看 → 不应回退到乙班专属场次
    const viewA = await api('/api/attendance/status', { cookie: tea });
    check('8) 甲班老师回看：不回退到乙班专属场次（避免"全体缺勤"假象）',
      !viewA.data.session || viewA.data.session.id !== bSessionId,
      { got: viewA.data.session && viewA.data.session.id, other: bSessionId });
    // 乙班（管理员视同全校；这里用班级维度直接校验 SQL 口径）
    const viewAdmin = await api('/api/attendance/status', { cookie: admin });
    check('8) 管理员（无班级限制）仍可回看当天场次（口径不受影响）',
      !!viewAdmin.data.session, viewAdmin.data.session && viewAdmin.data.session.id);
    if (stuBId) created.studentIds.push(stuBId);

  } catch (e) {
    fail++;
    console.log('  ✘ 异常：' + (e && e.stack ? e.stack : e));
  } finally {
    console.log('7) 清理与基线核对…');
    try { await cleanup(); } catch (e) { console.log('  · 清理异常：' + e.message); }
    const after = await snapshotReal();
    check('7) 真实数据行数回到用例前（users/grades/classes/students/sessions/records/plans/register）',
      JSON.stringify(after) === JSON.stringify(realBefore), { before: realBefore, after });
    check('7) 无夹具残留（班级/账号/年级/学生/场次/计划）',
      (await n1("SELECT count(*)::int n FROM classes WHERE class_name LIKE $1", [CLASS + '%'])) === 0
      && (await n1("SELECT count(*)::int n FROM users WHERE username LIKE 'cf\\_%'")) === 0
      && (await n1('SELECT count(*)::int n FROM grades WHERE grade_name = $1', [GRADE])) === 0
      && (await n1("SELECT count(*)::int n FROM students WHERE student_no LIKE 'CF%'")) === 0
      && (await n1("SELECT count(*)::int n FROM attendance_plans WHERE created_by_name = 'cffix'")) === 0);
    console.log(`\n结果：✔ ${pass}  ✘ ${fail}`);
    await pg.end();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
