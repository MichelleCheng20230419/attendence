// ============================================================
// 批量请假（当天全天请假）—— 服务端测试
//   需求：签到操作台「📋 批量请假」→ 多选学生 + 逐个选病假/事假 → 当天全天请假
//   验证点：
//     ① GET /api/attendance/leave/batch 返回学生列表（按账号班级收敛）+ 当天已登记事由
//     ② POST 登记：student_day_leaves 写/改（幂等，唯一键 (student_id, leave_date)）
//     ③ 同步当天所有场次：attendance_records.status=leave + leave_reason + check_in_method=batch_leave
//     ④ 已签到/迟到的学生不被覆盖（返回 skippedSignedIn）
//     ⑤ 当天后续新建的场次自动带请假（"三档全请假"）；finalizeAbsent 不会把请假改成缺勤
//     ⑥ 取消请假：进行中场次删记录（回到待签）、已结束场次还原为缺勤
//     ⑦ 权限：班长/教师限本班（越界 403）、学生 403、管理员不限；只能登记当天（非今天 400）
//     ⑧ 考勤分析：请假人次计入 leave 且 leaveByReason 按事由细分
//   夹具：1 年级 + 2 班（甲班 3 人 / 乙班 1 人）+ 教师(绑甲班)/班长/学生账号；测完自愈清理
// 用法：node test_batch_leave.js（需服务已启动；管理员密码取 DSH_ADMIN_PW）
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
const GRADE = '批假年级' + TAG;
const CA = '批假甲班' + TAG, CB = '批假乙班' + TAG;
const PRE = 'blv_' + TAG + '_';
const created = { gradeId: null, classIds: [], userIds: [], studentIds: [], ownedSessions: [] };

async function cleanup() {
  const sids = (await pg.query("SELECT id FROM students WHERE student_no LIKE $1", ['BLV%'])).rows.map((r) => r.id);
  const allS = [...new Set([...created.studentIds, ...sids])];
  const uids = (await pg.query('SELECT id FROM users WHERE username LIKE $1', [PRE + '%'])).rows.map((r) => r.id);
  if (allS.length) {
    await pg.query('DELETE FROM attendance_records WHERE student_id = ANY($1::int[])', [allS]).catch(() => {});
    await pg.query('DELETE FROM student_day_leaves WHERE student_id = ANY($1::int[])', [allS]).catch(() => {});
  }
  // 用例自己发起的场次：连同记录一并删除（不影响真实场次与真实签到）
  for (const osid of created.ownedSessions) {
    await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [osid]).catch(() => {});
    await pg.query('DELETE FROM attendance_sessions WHERE id = $1', [osid]).catch(() => {});
  }
  if (uids.length) {
    await pg.query('UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL WHERE head_teacher_id = ANY($1::int[]) OR teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM teacher_classes WHERE teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM users WHERE id = ANY($1::int[])', [uids]).catch(() => {});
  }
  await pg.query("DELETE FROM students WHERE student_no LIKE 'BLV%'").catch(() => {});
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name = ANY($1::text[])', [[CA, CB]]).catch(() => {});
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(() => {});
}

(async () => {
  try {
    await cleanup();
    const base = {
      users: await n1('SELECT count(*)::int n FROM users'),
      grades: await n1('SELECT count(*)::int n FROM grades'),
      classes: await n1('SELECT count(*)::int n FROM classes'),
      students: await n1('SELECT count(*)::int n FROM students'),
      sessions: await n1('SELECT count(*)::int n FROM attendance_sessions'),
      records: await n1('SELECT count(*)::int n FROM attendance_records'),
      dayLeaves: await n1('SELECT count(*)::int n FROM student_day_leaves'),
    };
    const admin = await login('admin');

    // ---------- 夹具 ----------
    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'BLV', academicYear: year } })).data.id;
    const mkClass = async (name) => (await api('/api/classes', { method: 'POST', cookie: admin, body: { className: name, gradeName: GRADE, academicYear: year } })).data.id;
    const ca = await mkClass(CA), cb = await mkClass(CB);
    created.classIds = [ca, cb];
    const mkStudents = async (classId, n, prefix) => {
      const out = [];
      for (let i = 1; i <= n; i += 1) {
        const r = await api('/api/students', { method: 'POST', cookie: admin, body: { studentNo: prefix + TAG + String(i).padStart(2, '0'), name: prefix + '同学' + i, classId, status: '在读' } });
        const id = r.data && (r.data.student ? r.data.student.id : r.data.id);
        if (id) { out.push(id); created.studentIds.push(id); }
      }
      return out;
    };
    const A = await mkStudents(ca, 3, 'BLVA');
    const B = await mkStudents(cb, 1, 'BLVB');
    let r = await api('/api/users', { method: 'POST', cookie: admin, body: { username: PRE + 'tea', password: '123456', role: 'teacher', realName: '批假老师', classId: ca, mustChangePassword: false, profileLocked: true, force: true } });
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', { method: 'POST', cookie: admin, body: { username: PRE + 'mon', password: '123456', role: 'monitor', realName: '批假班长', classId: ca, mustChangePassword: false, profileLocked: true, force: true } });
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', { method: 'POST', cookie: admin, body: { username: PRE + 'stu', password: '123456', role: 'student', realName: '批假学生', classId: ca, mustChangePassword: false, profileLocked: true, force: true } });
    created.userIds.push(r.data.user.id);
    const tea = await login(PRE + 'tea');
    const mon = await login(PRE + 'mon');
    const stu = await login(PRE + 'stu');
    check('0) 夹具就绪（1 年级 + 2 班：甲班 3 人 / 乙班 1 人 + 教师/班长/学生账号）',
      A.length === 3 && B.length === 1 && !!tea && !!mon && !!stu, { a: A.length, b: B.length });

    const today = (await pg.query("SELECT to_char(now(), 'YYYY-MM-DD') AS d")).rows[0].d;

    // ---------- 1) 弹窗数据接口 ----------
    console.log('1) 弹窗数据（学生列表 + 当天已登记事由）:');
    r = await api('/api/attendance/leave/batch', { cookie: tea });
    const teaStudents = (r.data.students || []).map((x) => x.id);
    check('1) 教师 GET → 只返回本班 3 名学生（按账号班级收敛）',
      r.status === 200 && teaStudents.length === 3 && A.every((id) => teaStudents.includes(id)) && !teaStudents.includes(B[0]),
      { status: r.status, n: teaStudents.length });
    check('1) 返回日期=今天 + isToday=true + 事由列表（病假/事假）',
      r.data.date === today && r.data.isToday === true &&
      JSON.stringify((r.data.reasons || []).map((x) => x.code)) === JSON.stringify(['sick', 'personal']),
      { date: r.data.date, today, reasons: r.data.reasons });
    check('1) 初始无人请假（dayLeaveCount=0，每个学生 reason=null）',
      r.data.dayLeaveCount === 0 && (r.data.students || []).every((x) => x.reason === null), r.data.dayLeaveCount);
    r = await api('/api/attendance/leave/batch', { cookie: mon });
    check('1) 班长 GET → 同样只返回本班 3 名学生', r.status === 200 && (r.data.students || []).length === 3, r.status);
    r = await api('/api/attendance/leave/batch', { cookie: stu });
    check('1) 学生 GET → 403（学生只读签到状态）', r.status === 403, r.status);
    r = await api('/api/attendance/leave/batch?date=2026-13-45', { cookie: tea });
    check('1) 非法日期 → 400', r.status === 400, r.data);

    // ---------- 2) 准备场次（有进行中的真实场次则复用，避免影响真实签到） ----------
    console.log('2) 准备场次:');
    let sid = (await api('/api/attendance/status', { cookie: tea })).data.session;
    let reused = false;
    if (sid && sid.status === 'active') {
      reused = true;
      sid = sid.id;
      console.log('  · 复用当前进行中的场次 #' + sid + '（不发起新场次，避免影响真实签到）');
    } else {
      const st = await api('/api/attendance/start', { method: 'POST', cookie: tea, body: { deadlineMinutes: 60 } });
      sid = st.data.session.id;
      created.ownedSessions.push(sid);
      console.log('  · 本用例发起场次 #' + sid);
    }
    check('2) 场次就绪 #' + sid, Number.isInteger(sid), sid);
    // S3 先签到（用于验证"已签到不被覆盖"）
    r = await api('/api/attendance/checkin', { method: 'POST', cookie: tea, body: { studentId: A[2], action: 'present', forcePresent: true } });
    check('2) 甲班第 3 名学生已签到（present）',
      (r.status === 200 || r.status === 201) && r.data.record && r.data.record.status === 'present',
      { status: r.status, record: r.data.record });

    // ---------- 3) 批量登记请假 ----------
    console.log('3) 批量登记（张=病假 / 李=事假）:');
    r = await api('/api/attendance/leave/batch', {
      method: 'POST', cookie: tea,
      body: { date: today, items: [{ studentId: A[0], reason: 'sick' }, { studentId: A[1], reason: 'personal' }], cancels: [] },
    });
    check('3) POST 登记 2 人 → 200（marked=2，返回同步的场次数）',
      r.status === 200 && r.data.marked === 2 && r.data.sessionCount >= 1,
      { status: r.status, data: r.data });
    check('3) student_day_leaves 写入 2 行（事由正确）',
      (await n1('SELECT count(*)::int n FROM student_day_leaves WHERE leave_date = $1::date AND student_id = ANY($2::int[])', [today, [A[0], A[1]]])) === 2 &&
      (await n1("SELECT count(*)::int n FROM student_day_leaves WHERE reason = 'sick' AND student_id = $1", [A[0]])) === 1 &&
      (await n1("SELECT count(*)::int n FROM student_day_leaves WHERE reason = 'personal' AND student_id = $1", [A[1]])) === 1);
    const recA1 = (await pg.query('SELECT status, leave_reason, check_in_method FROM attendance_records WHERE session_id = $1 AND student_id = $2', [sid, A[0]])).rows[0];
    check('3) 当前场次记录 = 请假（status=leave + 事由 + check_in_method=batch_leave）',
      !!recA1 && recA1.status === 'leave' && recA1.leave_reason === 'sick' && recA1.check_in_method === 'batch_leave', recA1);
    r = await api('/api/attendance/status?sessionId=' + sid, { cookie: tea });
    check('3) 签到状态接口返回这 2 人为请假（页面卡片橙色）',
      r.data.records && r.data.records[A[0]] && r.data.records[A[0]].status === 'leave' &&
      r.data.records[A[1]] && r.data.records[A[1]].status === 'leave' &&
      r.data.records[A[1]].leaveReason === 'personal' &&
      r.data.stats.leave === 2,
      { s1: r.data.records[A[0]], s2: r.data.records[A[1]], stats: r.data.stats });

    // ---------- 4) 已签到不被覆盖 ----------
    r = await api('/api/attendance/leave/batch', {
      method: 'POST', cookie: tea,
      body: { date: today, items: [{ studentId: A[2], reason: 'sick' }], cancels: [] },
    });
    check('4) 给已签到的学生登记请假 → 返回 skippedSignedIn（不抹掉签名）',
      r.status === 200 && r.data.marked === 1 && (r.data.skippedSignedIn || []).includes(A[2]),
      { status: r.status, skipped: r.data.skippedSignedIn });
    const recA3 = (await pg.query('SELECT status FROM attendance_records WHERE session_id = $1 AND student_id = $2', [sid, A[2]])).rows[0];
    check('4) 该学生当前场次记录仍是已签到（present）', recA3 && recA3.status === 'present', recA3);
    check('4) 但当天登记仍已写入（后续新建场次会记请假）',
      (await n1('SELECT count(*)::int n FROM student_day_leaves WHERE leave_date = $1::date AND student_id = $2', [today, A[2]])) === 1);

    // ---------- 5) 当天新场次自动带请假 + 关闭后不变成缺勤 ----------
    console.log('5) 当天后续场次（"三档全请假"）:');
    const st2 = await api('/api/attendance/start', { method: 'POST', cookie: tea, body: { deadlineMinutes: 60 } });
    const sid2 = st2.data.session.id;
    created.ownedSessions.push(sid2);
    check('5) 发起当天第二场（#' + sid2 + '）', st2.status === 201 && !!sid2, st2.status);
    const day2 = await pg.query(
      `SELECT r.student_id, r.status, r.leave_reason, r.check_in_method
         FROM attendance_records r WHERE r.session_id = $1 AND r.student_id = ANY($2::int[]) ORDER BY r.student_id`,
      [sid2, [A[0], A[1], A[2]]]
    );
    check('5) 新场次里 3 名登记过请假的学生都已自动记为请假（无需再签到）',
      day2.rows.length === 3 && day2.rows.every((x) => x.status === 'leave') &&
      day2.rows.find((x) => x.student_id === A[2]).leave_reason === 'sick',
      day2.rows);
    const cl = await api('/api/attendance/sessions/' + sid2 + '/close', { method: 'POST', cookie: admin });
    check('5) 结束该场次 → 200（补缺勤执行）', cl.status === 200, cl.data);
    // 注意：只统计本用例夹具学生 —— 真实库里也可能有"当天全天请假"登记，
    //       那份登记同样会被同步进新场次（这是预期行为，不该让本用例误报）
    check('5) 结束后请假记录未被改成缺勤（finalizeAbsent 不会覆盖请假）',
      (await n1("SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = ANY($2::int[]) AND status = 'leave'", [sid2, [A[0], A[1], A[2]]])) === 3 &&
      (await n1("SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = ANY($2::int[]) AND status = 'absent'", [sid2, [A[0], A[1], A[2]]])) === 0);
    // 班级隔离（2026-09-29 三次修复）：老师手动发起的场次只归属其班级 → 别的班学生不会被写缺勤
    check('5) 班级隔离：未登记请假的其它班学生不在该场次里（不会被写缺勤）',
      (await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = $2', [sid2, B[0]])) === 0,
      await pg.query('SELECT student_id, status FROM attendance_records WHERE session_id = $1 AND student_id = $2', [sid2, B[0]]).then((x) => x.rows));

    // ---------- 6) 修改事由 / 幂等 ----------
    console.log('6) 修改事由与幂等:');
    r = await api('/api/attendance/leave/batch', { method: 'POST', cookie: tea, body: { date: today, items: [{ studentId: A[0], reason: 'personal' }], cancels: [] } });
    check('6) 同一学生改事由（病假→事假）→ 200 且当天登记只有 1 行',
      r.status === 200 && r.data.dayLeaveCount >= 1 &&
      (await n1("SELECT count(*)::int n FROM student_day_leaves WHERE student_id = $1 AND reason = 'personal'", [A[0]])) === 1 &&
      (await n1('SELECT count(*)::int n FROM student_day_leaves WHERE student_id = $1', [A[0]])) === 1);
    check('6) 场次记录事由同步更新（sid2 = 事假）',
      (await n1("SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = $2 AND leave_reason = 'personal'", [sid2, A[0]])) === 1);
    const beforeDup = await n1('SELECT count(*)::int n FROM student_day_leaves WHERE leave_date = $1::date', [today]);
    r = await api('/api/attendance/leave/batch', { method: 'POST', cookie: tea, body: { date: today, items: [{ studentId: A[0], reason: 'personal' }], cancels: [] } });
    check('6) 重复提交同一登记 → 幂等（不新增行）',
      r.status === 200 && (await n1('SELECT count(*)::int n FROM student_day_leaves WHERE leave_date = $1::date', [today])) === beforeDup, beforeDup);

    // ---------- 7) 取消请假 ----------
    console.log('7) 取消请假:');
    r = await api('/api/attendance/leave/batch', { method: 'POST', cookie: tea, body: { date: today, items: [], cancels: [A[1]] } });
    check('7) 取消 1 人 → 200（cancelled=1，当天登记删除）',
      r.status === 200 && r.data.cancelled === 1 &&
      (await n1('SELECT count(*)::int n FROM student_day_leaves WHERE student_id = $1 AND leave_date = $2::date', [A[1], today])) === 0,
      r.data);
    check('7) 已结束场次里该学生的请假还原为缺勤',
      (await n1("SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = $2 AND status = 'absent'", [sid2, A[1]])) === 1);
    r = await api('/api/attendance/leave/batch', { cookie: tea });
    check('7) 重新打开弹窗：只剩 2 人处于请假（已取消的不再勾选）',
      r.status === 200 && r.data.dayLeaveCount === 2 &&
      (r.data.students || []).find((x) => x.id === A[1]).reason === null &&
      (r.data.students || []).find((x) => x.id === A[0]).reason === 'personal',
      { count: r.data.dayLeaveCount, students: (r.data.students || []).map((x) => [x.id, x.reason]) });

    // ---------- 8) 权限与参数校验 ----------
    console.log('8) 权限与参数校验:');
    r = await api('/api/attendance/leave/batch', { method: 'POST', cookie: tea, body: { date: today, items: [{ studentId: B[0], reason: 'sick' }], cancels: [] } });
    check('8) 教师给别班学生登记 → 403（越界拦截）', r.status === 403, { status: r.status, data: r.data });
    r = await api('/api/attendance/leave/batch', { method: 'POST', cookie: mon, body: { date: today, items: [{ studentId: B[0], reason: 'sick' }], cancels: [] } });
    check('8) 班长给别班学生登记 → 403', r.status === 403, r.status);
    r = await api('/api/attendance/leave/batch', { method: 'POST', cookie: stu, body: { date: today, items: [{ studentId: A[0], reason: 'sick' }], cancels: [] } });
    check('8) 学生登记 → 403', r.status === 403, r.status);
    r = await api('/api/attendance/leave/batch', { method: 'POST', cookie: tea, body: { date: today, items: [{ studentId: A[0], reason: 'holiday' }], cancels: [] } });
    check('8) 非法事由 → 400', r.status === 400, r.data);
    r = await api('/api/attendance/leave/batch', { method: 'POST', cookie: tea, body: { date: today, items: [], cancels: [] } });
    check('8) 空提交 → 400', r.status === 400, r.data);
    r = await api('/api/attendance/leave/batch', { method: 'POST', cookie: tea, body: { date: '2020-01-01', items: [{ studentId: A[0], reason: 'sick' }], cancels: [] } });
    check('8) 非当天日期 → 400（只允许登记当天）', r.status === 400, r.data);
    // 管理员权限（方案 A 口径）：
    //   · 不带 classId → 校级权限：可给任意班登记（管理页/全校场景需要）
    //   · 显式传 ?classId=<某班> → 收敛到该班：给别班学生登记一律 403
    r = await api('/api/attendance/leave/batch', { method: 'POST', cookie: admin, body: { date: today, items: [{ studentId: B[0], reason: 'sick' }], cancels: [] } });
    check('8) 管理员默认校级权限 → 可给任意班登记 200', r.status === 200 && r.data.marked === 1, { status: r.status, data: r.data });
    r = await api('/api/attendance/leave/batch', { method: 'POST', cookie: admin, body: { date: today, classId: ca, items: [{ studentId: B[0], reason: 'sick' }], cancels: [] } });
    check('8) 管理员显式 ?classId=甲班 → 给乙班学生登记 403（收敛后按班拦截）',
      r.status === 403, { status: r.status, data: r.data });
    r = await api('/api/attendance/leave/batch', { method: 'POST', cookie: admin, body: { date: today, items: [], cancels: [B[0]] } });
    check('8) 管理员取消该登记 → 200', r.status === 200 && r.data.cancelled === 1, r.data);

    // ---------- 9) 考勤分析：请假人次与事由 ----------
    console.log('9) 考勤分析口径:');
    const ov = await api(`/api/attendance/analysis/overview?classId=${ca}&startDate=${today}&endDate=${today}`, { cookie: admin });
    const lr = (ov.data && ov.data.leaveByReason) || {};
    check('9) overview 返回 leaveByReason（病假/事假/公假字段齐全）',
      ov.status === 200 && lr.sick !== undefined && lr.personal !== undefined && lr.official !== undefined, lr);
    check('9) 当天请假人次计入 leave（不计入缺勤）且事由=事假 ≥1',
      ov.data.leave >= 1 && lr.personal >= 1, { leave: ov.data.leave, byReason: lr, absent: ov.data.absent });
    check('9) 实际运用一致：请假人次 = 各事由之和',
      ov.data.leave === (lr.sick || 0) + (lr.personal || 0) + (lr.official || 0) + (lr.unknown || 0),
      { leave: ov.data.leave, byReason: lr });

    // ---------- 10) 班长端同步：没有进行中的场次时也要看到当天全天请假 ----------
    //   真实问题：教师批量请假后，班长端请假仍是 0、卡片不变橙 —— 因为班级隔离后，
    //   班长所在班常常"没有与本班相关的进行中场次"，全天请假没地方体现
    console.log('10) 班长端同步（无进行中场次）:');
    for (const osid of [...created.ownedSessions]) {
      await api('/api/attendance/sessions/' + osid + '/close', { method: 'POST', cookie: admin });
      await api('/api/attendance/sessions/' + osid, { method: 'DELETE', cookie: admin });
      created.ownedSessions = created.ownedSessions.filter((x) => x !== osid);
    }
    let sm = await api('/api/attendance/status', { cookie: mon });
    check('10) 班长端能看到当天全天请假：记录为 leave 且标记 dayLeave=true（卡片橙色）',
      sm.status === 200 && sm.data.records[A[0]] && sm.data.records[A[0]].status === 'leave' && sm.data.records[A[0]].dayLeave === true &&
      sm.data.records[A[2]] && sm.data.records[A[2]].status === 'leave' && sm.data.records[A[2]].dayLeave === true,
      { s1: sm.data.records[A[0]], s3: sm.data.records[A[2]], session: sm.data.session && sm.data.session.id });
    check('10) 班长端请假统计同步（这 2 人算请假，不算缺勤）',
      sm.data.stats.leave === 2 &&
      (!sm.data.records[A[0]] || sm.data.records[A[0]].status === 'leave') &&
      (!sm.data.records[A[2]] || sm.data.records[A[2]].status === 'leave'),
      sm.data.stats);
    check('10) 返回 dayLeaves 摘要（count=2，与 records 一致）',
      sm.data.dayLeaves && sm.data.dayLeaves.count === 2 &&
      sm.data.dayLeaves.studentIds.includes(A[0]) && sm.data.dayLeaves.studentIds.includes(A[2]),
      sm.data.dayLeaves);
    check('10) 事由随记录返回（班长端可显示"请假·事假/病假"）',
      sm.data.records[A[0]].leaveReason === 'personal' && sm.data.records[A[2]].leaveReason === 'sick',
      { a0: sm.data.records[A[0]].leaveReason, a2: sm.data.records[A[2]].leaveReason });
    const st10 = await api('/api/attendance/status', { cookie: tea });
    check('10) 教师端与班长端口径一致（同一天请假记录）',
      st10.data.stats.leave === 2 && st10.data.records[A[0]].dayLeave === true && st10.data.records[A[2]].dayLeave === true,
      st10.data.stats);
    check('10) 未登记请假的学生仍为未签到/缺勤（不会被误标请假）',
      !sm.data.records[A[1]] || sm.data.records[A[1]].status !== 'leave', sm.data.records[A[1]]);

    // ---------- 11) 真实数据与清理 ----------
    console.log('11) 清理与基线核对:');
    const sessionInfo = await pg.query('SELECT status FROM attendance_sessions WHERE id = $1', [sid]);
    if (reused && sessionInfo.rowCount > 0 && sessionInfo.rows[0].status === 'active') {
      // 复用的是真实进行中场次：只清理夹具学生的记录，不结束、不删除该场次
      console.log('  · 复用场次 #' + sid + ' 保持原状（仅清理夹具学生记录）');
    }
    await cleanup();
    const after = {
      users: await n1('SELECT count(*)::int n FROM users'),
      grades: await n1('SELECT count(*)::int n FROM grades'),
      classes: await n1('SELECT count(*)::int n FROM classes'),
      students: await n1('SELECT count(*)::int n FROM students'),
      sessions: await n1('SELECT count(*)::int n FROM attendance_sessions'),
      records: await n1('SELECT count(*)::int n FROM attendance_records'),
      dayLeaves: await n1('SELECT count(*)::int n FROM student_day_leaves'),
    };
    const ownSessionsGone = (await n1('SELECT count(*)::int n FROM attendance_sessions WHERE id = ANY($1::int[])',
      [created.ownedSessions.length ? created.ownedSessions : [-1]])) === 0;
    check('11) 真实数据行数回到用例前（users/grades/classes/students/sessions/请假登记）',
      // 注：**不再断言 records 总数完全不变** ——
      //   v35 起每天有自动签到场次，且"批量请假（全天请假）"会同步到当天所有场次
      //   （本用例以管理员身份跑时会顺带把**真实学生**已有的全天请假写入当天自动场次，
      //     那是正确数据、不是残留）。夹具自身的行数仍必须回到用例前。
      base.users === after.users && base.grades === after.grades && base.classes === after.classes &&
      base.students === after.students && base.sessions === after.sessions &&
      base.dayLeaves === after.dayLeaves && ownSessionsGone &&
      after.records >= base.records,
      { base, after, ownSessionsGone, recordsDelta: after.records - base.records });
    check('11) 夹具已清理（账号/班级/年级/学生/请假登记）',
      (await n1('SELECT count(*)::int n FROM users WHERE username LIKE $1', [PRE + '%'])) === 0 &&
      (await n1('SELECT count(*)::int n FROM classes WHERE class_name = ANY($1::text[])', [[CA, CB]])) === 0 &&
      (await n1("SELECT count(*)::int n FROM students WHERE student_no LIKE 'BLV%'")) === 0 &&
      (await n1("SELECT count(*)::int n FROM student_day_leaves dl JOIN students s ON s.id = dl.student_id WHERE s.student_no LIKE 'BLV%'")) === 0);
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
