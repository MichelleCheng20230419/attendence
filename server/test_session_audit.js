// ============================================================
// 发起签到 / 计划的「发起人追溯」测试（迁移 v25）
//   验证：
//     1) POST /api/attendance/start → attendance_sessions 记录 created_by/created_by_name/
//        created_by_role/start_source='manual'/deadline_minutes，并写 operation_logs('session_start')
//     2) 班长发起 → 403（且不产生场次/日志）
//     3) GET /api/attendance/status 返回 createdByName / startSource / deadlineMinutes
//     4) 计划触发场次 → start_source='plan'，created_by = 计划创建人；建计划写 operation_logs('plan_create')
//     5) 历史场次（本次迁移前的）start_source 回填正确、created_by 为 NULL（不猜测）
//   夹具：临时年级/班级/学生/老师/班长；测完清理（自愈式），且不动真实场次
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
  return { status: res.status, data, setc: res.headers.get('set-cookie') || '' };
}
async function login(u, p) {
  // admin 的密码可能被管理员改过 → 用环境变量 DSH_ADMIN_PW（默认 123456）；夹具账号固定 123456
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('login ' + u + ' failed: ' + r.status);
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}
async function tryLogin(u, p = '123456') { try { return await login(u, p); } catch (_) { return null; } }

const TAG = String(Date.now()).slice(-6);
const GRADE = '追溯年级' + TAG;
const CLASS = '追溯班' + TAG;
const PRE = 'audit_' + TAG + '_';
const created = { gradeId: null, classId: null, userIds: [], studentIds: [], sessionIds: [], planIds: [] };

async function cleanup() {
  const uids = (await pg.query('SELECT id FROM users WHERE username LIKE $1', [PRE + '%'])).rows.map((r) => r.id);
  const cids = (await pg.query('SELECT id FROM classes WHERE class_name = $1', [CLASS])).rows.map((r) => r.id);
  const sids = (await pg.query("SELECT id FROM students WHERE student_no LIKE 'AUD%'")).rows.map((r) => r.id);
  const allCids = [...new Set([...created.classIds || [], ...cids])];
  const allSids = [...new Set([...created.studentIds, ...sids])];
  // 只删除本测试自己创建的场次（由夹具计划关联或已登记 id）
  const planSessionIds = allCids.length
    ? (await pg.query('SELECT session_id FROM attendance_plans WHERE class_id = ANY($1::int[]) AND session_id IS NOT NULL', [allCids])).rows.map((r) => r.session_id)
    : [];
  const sessIds = [...new Set([...created.sessionIds, ...planSessionIds])];
  if (allCids.length) await pg.query('DELETE FROM attendance_plans WHERE class_id = ANY($1::int[])', [allCids]).catch(() => {});
  // 操作日志：删掉本测试产生的 session_start / plan_create（含管理员账号产生的，按 sessionId/classId 定位）
  if (sessIds.length) {
    await pg.query(
      "DELETE FROM operation_logs WHERE action = 'session_start' AND (detail->>'sessionId')::int = ANY($1::int[])",
      [sessIds]
    ).catch(() => {});
  }
  if (allCids.length) {
    await pg.query(
      "DELETE FROM operation_logs WHERE action = 'plan_create' AND (detail->>'classId')::int = ANY($1::int[])",
      [allCids]
    ).catch(() => {});
  }
  if (sessIds.length) {
    await pg.query('DELETE FROM attendance_records WHERE session_id = ANY($1::int[])', [sessIds]).catch(() => {});
    await pg.query('DELETE FROM attendance_sessions WHERE id = ANY($1::int[])', [sessIds]).catch(() => {});
  }
  if (allSids.length) {
    await pg.query('DELETE FROM attendance_records WHERE student_id = ANY($1::int[])', [allSids]).catch(() => {});
    await pg.query('DELETE FROM students WHERE id = ANY($1::int[])', [allSids]).catch((e) => console.log('  · 清理学生失败：', e.message));
  }
  if (uids.length) {
    await pg.query('DELETE FROM operation_logs WHERE user_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL WHERE head_teacher_id = ANY($1::int[]) OR teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM teacher_classes WHERE teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM users WHERE id = ANY($1::int[])', [uids]).catch((e) => console.log('  · 清理账号失败：', e.message));
  }
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name = $1', [CLASS]).catch((e) => console.log('  · 清理班级失败：', e.message));
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(() => {});
}

(async () => {
  try {
    await cleanup();
    const base = {
      sessions: (await pg.query('SELECT count(*)::int n FROM attendance_sessions')).rows[0].n,
      records: (await pg.query('SELECT count(*)::int n FROM attendance_records')).rows[0].n,
      plans: (await pg.query('SELECT count(*)::int n FROM attendance_plans')).rows[0].n,
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
      students: (await pg.query('SELECT count(*)::int n FROM students')).rows[0].n,
      logs: (await pg.query('SELECT count(*)::int n FROM operation_logs')).rows[0].n,
      activeSessions: (await pg.query("SELECT count(*)::int n FROM attendance_sessions WHERE status = 'active'")).rows[0].n,
    };
    check('0) 前置：确有历史场次且发起人为 NULL（迁移前数据不猜测）',
      (await pg.query("SELECT count(*)::int n FROM attendance_sessions WHERE start_source = 'manual' AND created_by IS NULL")).rows[0].n > 0);

    const cAdmin = await login('admin');
    const year = (await api('/api/settings', { cookie: cAdmin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: cAdmin, body: { gradeName: GRADE, gradeCode: 'AUD', academicYear: year } })).data.id;
    created.classId = (await api('/api/classes', { method: 'POST', cookie: cAdmin, body: { className: CLASS, gradeName: GRADE, academicYear: year } })).data.id;
    let r = await api('/api/users', { method: 'POST', cookie: cAdmin, body: { username: PRE + 'tea', password: '123456', role: 'teacher', realName: '追溯老师', subject: '物理', classId: created.classId, profileLocked: true, teachingClasses: [{ classId: created.classId, roleInClass: 'head_teacher' }] } });
    const teaId = r.data.user.id;
    created.userIds.push(teaId);
    r = await api('/api/users', { method: 'POST', cookie: cAdmin, body: { username: PRE + 'mon', password: '123456', role: 'monitor', realName: '追溯班长', classId: created.classId, mustChangePassword: false } });
    const monId = r.data.user.id;
    created.userIds.push(monId);
    for (let i = 1; i <= 3; i += 1) {
      const rr = await api('/api/students', { method: 'POST', cookie: cAdmin, body: { studentNo: 'AUD' + TAG + '0' + i, name: '追溯同学' + i, classId: created.classId, status: '在读' } });
      created.studentIds.push(rr.data.student.id);
    }
    const cTea = await login(PRE + 'tea');
    const cMon = await tryLogin(PRE + 'mon');
    check('0) 夹具就绪（1 班 3 学生 + 老师/班长）', created.studentIds.length === 3 && !!cTea && !!cMon);

    // ---------- 1) 手动发起签到记录发起人 ----------
    r = await api('/api/attendance/start', { method: 'POST', cookie: cTea, body: { deadlineMinutes: 20 } });
    check('1) 老师发起签到 → 201', r.status === 201, r.data);
    const sid = r.data.session.id;
    created.sessionIds.push(sid);
    check('1) 响应含发起人与来源',
      r.data.session.createdBy === teaId && r.data.session.createdByName === '追溯老师' &&
      r.data.session.createdByRole === 'teacher' && r.data.session.startSource === 'manual' &&
      r.data.session.deadlineMinutes === 20, r.data.session);
    const row = (await pg.query(
      'SELECT created_by, created_by_name, created_by_role, start_source, deadline_minutes, start_time, deadline FROM attendance_sessions WHERE id = $1',
      [sid]
    )).rows[0];
    check('1) 库中写入发起人字段',
      row.created_by === teaId && row.created_by_name === '追溯老师' && row.created_by_role === 'teacher' &&
      row.start_source === 'manual' && row.deadline_minutes === 20, row);
    check('1) 库中截止时长与 deadline 一致（20 分钟）',
      Math.round((new Date(row.deadline) - new Date(row.start_time)) / 60000) === 20,
      Math.round((new Date(row.deadline) - new Date(row.start_time)) / 60000));
    const log = (await pg.query(
      "SELECT user_id, user_name, role, action, detail FROM operation_logs WHERE action = 'session_start' AND detail->>'sessionId' = $1 ORDER BY id DESC LIMIT 1",
      [String(sid)]
    )).rows[0];
    check('1) 写入操作日志 session_start（含发起人/时长/来源）',
      !!log && log.user_id === teaId && log.user_name === '追溯老师' && log.role === 'teacher' &&
      log.detail.startSource === 'manual' && Number(log.detail.deadlineMinutes) === 20, log);

    // ---------- 2) 状态接口返回发起人（前端展示用） ----------
    r = await api('/api/attendance/status', { cookie: cTea });
    check('2) /attendance/status 返回 createdByName / startSource / deadlineMinutes',
      r.status === 200 && r.data.session && r.data.session.createdByName === '追溯老师' &&
      r.data.session.startSource === 'manual' && r.data.session.deadlineMinutes === 20, r.data.session);
    r = await api('/api/attendance/session-records?sessionId=' + sid, { cookie: cTea });
    check('2) /attendance/session-records 也带发起人信息',
      r.status === 200 && r.data.session.createdByName === '追溯老师', r.data.session);

    // ---------- 3) 班长发起 → 403 且不留痕 ----------
    const beforeCnt = (await pg.query('SELECT count(*)::int n FROM attendance_sessions')).rows[0].n;
    r = await api('/api/attendance/start', { method: 'POST', cookie: cMon, body: { deadlineMinutes: 10 } });
    check('3) 班长发起签到 → 403', r.status === 403, r.data);
    check('3) 未新增场次（原场次仍为进行中）',
      (await pg.query('SELECT count(*)::int n FROM attendance_sessions')).rows[0].n === beforeCnt &&
      (await pg.query("SELECT count(*)::int n FROM attendance_sessions WHERE id = $1 AND status = 'active'", [sid])).rows[0].n === 1);
    check('3) 未写入 session_start 日志（班长）',
      (await pg.query("SELECT count(*)::int n FROM operation_logs WHERE user_id = $1 AND action = 'session_start'", [monId])).rows[0].n === 0);

    // ---------- 4) 再次发起：关闭上一场并记录 closedPreviousSessionId ----------
    //    注意（方案 A / v33）：管理员发起 = 校级发起 → 每个班各一场（session + sessions[]），
    //    要全部登记并在后续统一收尾，否则会留下别的班的进行中场次
    r = await api('/api/attendance/start', { method: 'POST', cookie: cAdmin, body: { deadlineMinutes: 15 } });
    check('4) 管理员发起新签到 → 201 且发起人=程老师(admin)',
      r.status === 201 && r.data.session.createdByName === '程老师' && r.data.session.createdByRole === 'admin', r.data.session);
    const adminSessions = Array.isArray(r.data.sessions) && r.data.sessions.length ? r.data.sessions : [r.data.session];
    for (const s of adminSessions) created.sessionIds.push(s.id);
    const sid2 = (adminSessions.find((s) => Number(s.classId) === Number(created.classId)) || r.data.session).id;
    check('4) 校级发起按班拆场（每班一条，本夹具班级也有自己的一场）',
      adminSessions.length >= 1 && adminSessions.some((s) => Number(s.classId) === Number(created.classId)),
      adminSessions.map((s) => ({ id: s.id, classId: s.classId })));
    check('4) 上一场次已被关闭',
      (await pg.query('SELECT status FROM attendance_sessions WHERE id = $1', [sid])).rows[0].status === 'closed');
    const log2 = (await pg.query(
      `SELECT detail FROM operation_logs
        WHERE action = 'session_start' AND (detail->'sessionIds') @> to_jsonb(ARRAY[$1::int])
        ORDER BY id DESC LIMIT 1`,
      [sid2]
    )).rows[0];
    check('4) 日志记录了被关闭的上一场次（closedPreviousSessionId）',
      !!log2 && Number(log2.detail.closedPreviousSessionId) === sid, log2);

    // ---------- 5) 计划：创建人 + 触发场次来源=plan ----------
    const today = new Date();
    const hhmm = String(today.getHours()).padStart(2, '0') + ':' + String(today.getMinutes()).padStart(2, '0');
    r = await api('/api/plans', { method: 'POST', cookie: cTea, body: { planDate: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`, startTime: hhmm, durationMinutes: 10 } });
    check('5) 老师创建当日计划 → 201', r.status === 201 && r.data.inserted === 1, r.data);
    const plan = (await pg.query('SELECT id, class_id, created_by, created_by_name, created_by_role FROM attendance_plans WHERE class_id = $1 ORDER BY id DESC LIMIT 1', [created.classId])).rows[0];
    check('5) 计划记录创建人（教师强制绑定本班）',
      plan.created_by === teaId && plan.created_by_name === '追溯老师' && plan.created_by_role === 'teacher' && plan.class_id === created.classId, plan);
    check('5) 创建计划写入操作日志 plan_create',
      (await pg.query("SELECT count(*)::int n FROM operation_logs WHERE user_id = $1 AND action = 'plan_create'", [teaId])).rows[0].n >= 1);
    // 触发调度（服务器 60 秒轮询 → 直接调用导出函数，避免等待）
    // 先结束本用例自己的全部进行中场次：修"场次抖动/全体缺勤"后，有进行中的（人工发起）场次时
    // 计划不再抢占（否则会把老师正在登记的场次顶掉），因此这里先收尾自己的场次
    // （管理员发起会产生"每班一场"，必须全部关闭，否则本班那场仍在进行中 → 计划保持 pending）
    await pg.query(`UPDATE attendance_sessions SET status = 'closed' WHERE id = ANY($1::int[])`, [created.sessionIds]);
    const att = require('./src/routes/attendance');
    await att.triggerDuePlans({ onlyPlanId: plan.id });
    const pl2 = (await pg.query('SELECT status, session_id FROM attendance_plans WHERE id = $1', [plan.id])).rows[0];
    check('5) 计划被触发并生成场次', pl2.status !== 'pending' && !!pl2.session_id, pl2);
    if (pl2.session_id) {
      created.sessionIds.push(pl2.session_id);
      const s2 = (await pg.query('SELECT start_source, created_by, created_by_name, created_by_role, deadline_minutes FROM attendance_sessions WHERE id = $1', [pl2.session_id])).rows[0];
      check('5) 计划场次标记 start_source=plan 且发起人=计划创建人',
        s2.start_source === 'plan' && s2.created_by === teaId && s2.created_by_name === '追溯老师' && s2.created_by_role === 'teacher', s2);
      check('5) 计划场次 deadline_minutes = 计划时长', s2.deadline_minutes === 10, s2.deadline_minutes);
    }

    // ---------- 6) 历史数据回填正确性 ----------
    const hist = (await pg.query(
      `SELECT count(*)::int n FROM attendance_sessions s JOIN attendance_plans p ON p.session_id = s.id WHERE s.start_source <> 'plan'`
    )).rows[0].n;
    check('6) 有计划关联的历史场次均为 start_source=plan', hist === 0, hist);
    check('6) 历史手动场次发起人为 NULL 但来源=manual',
      (await pg.query("SELECT count(*)::int n FROM attendance_sessions WHERE start_source = 'manual' AND created_by IS NULL")).rows[0].n >= 0);
    check('6) 新场次不再出现「来源未知」：本次创建的场次均有 created_by',
      (await pg.query('SELECT count(*)::int n FROM attendance_sessions WHERE id = ANY($1::int[]) AND created_by IS NULL', [created.sessionIds])).rows[0].n === 0);

    // ---------- 7) 清理并核对真实数据 ----------
    // 先把测试场次设为 closed，避免留下进行中的场次影响其它测试
    await pg.query("UPDATE attendance_sessions SET status = 'closed' WHERE id = ANY($1::int[])", [created.sessionIds]);
    await cleanup();
    const after = {
      sessions: (await pg.query('SELECT count(*)::int n FROM attendance_sessions')).rows[0].n,
      records: (await pg.query('SELECT count(*)::int n FROM attendance_records')).rows[0].n,
      plans: (await pg.query('SELECT count(*)::int n FROM attendance_plans')).rows[0].n,
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
      students: (await pg.query('SELECT count(*)::int n FROM students')).rows[0].n,
      logs: (await pg.query('SELECT count(*)::int n FROM operation_logs')).rows[0].n,
      activeSessions: (await pg.query("SELECT count(*)::int n FROM attendance_sessions WHERE status = 'active'")).rows[0].n,
    };
    check('7) 真实数据未变（场次/记录/计划/账号/学生/日志）',
      base.sessions === after.sessions && base.records === after.records && base.plans === after.plans &&
      base.users === after.users && base.students === after.students && base.logs === after.logs,
      { base, after });
    check('7) 进行中场次数量与测试前一致', base.activeSessions === after.activeSessions, { base: base.activeSessions, after: after.activeSessions });
    check('7) 夹具已清理',
      (await pg.query('SELECT count(*)::int n FROM users WHERE username LIKE $1', [PRE + '%'])).rows[0].n === 0 &&
      (await pg.query('SELECT count(*)::int n FROM classes WHERE class_name = $1', [CLASS])).rows[0].n === 0);
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：', e.message);
    try { await pg.query("UPDATE attendance_sessions SET status = 'closed' WHERE id = ANY($1::int[])", [created.sessionIds]); } catch (_) {}
    try { await cleanup(); } catch (_) {}
  } finally {
    await pg.end().catch(() => {});
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  }
  process.exitCode = fail ? 1 : 0;
})();
