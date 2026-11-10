// ============================================================
// 签到操作台「班级隔离」—— 服务端测试（方案 A / v33：场次归属唯一真源 = attendance_sessions.class_id）
//   历史 BUG：教师打开签到操作台，看到的是【别的班老师/计划发起】的签到；
//             班长端看到"发起：陈璐"；本班学生被别的班场次记成全体缺勤。
//   根因：attendance_sessions 没有 class_id —— 系统同时只保留一个"全校场次"，
//         班级归属靠"计划 / 发起人 / 记录"猜，任一环节猜错就泄漏。
//   修复（v33）：
//     · attendance_sessions.class_id：NULL = 全校场次；非空 = 该班专属场次
//     · 「全部班级」的发起/计划 → 按班拆场（每个班一条，绝不共用一场）
//     · 所有读/写场次的接口统一走 viewerScope / sessionScopeOf / assertSessionVisible / activeSessionFor
//   本用例验证点（对应需求验收清单）：
//     ① 场次归属真源 = class_id（计划触发的场次也带 class_id，并写入 attendance_plan_sessions）
//     ② 「全部班级」计划 → 每班一条场次（甲/乙各一场，互不可见）
//     ③ 班长只看到本班签到；教师只看到所带班级签到
//     ④ 管理员：?classId= 收敛到该班；不带参数 = 全校视角（切换班级后数据随之变化）
//     ⑤ 写入路径（签到/批量签到/补签/补缺勤/全天请假）都按班级收敛，跨班一律 403/不写入
//     ⑥ 其他班已结束场次不回看；本班自己的已结束场次仍可回看（结束回看/补签）
//     ⑦ 新建场次 class_id 均非空（历史 NULL 仅用于"全校场次"语义）
//   夹具：1 年级 + 2 班（甲/乙各 2 人）+ 甲乙班主任 + 跨两班老师 + 甲班班长；测完自愈清理
// 用法：node test_session_class_scope.js（需服务已启动；管理员密码取 DSH_ADMIN_PW）
// ============================================================
'use strict';
const { Pool } = require('pg');
const attendanceRouter = require('./src/routes/attendance');   // 定向触发计划（不依赖 60 秒调度）
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

let pass = 0, fail = 0, skipped = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
function skip(name, why) { skipped++; console.log('  · 跳过', name, '（' + why + '）'); }
async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + p, { method, headers, redirect: 'manual', body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('application/json')) { try { data = await res.json(); } catch (_) {} }
  return { status: res.status, data, setc: res.headers.get('set-cookie') || '', cache: res.headers.get('cache-control') || '' };
}
async function login(u, p) {
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('登录失败 ' + u + ': ' + r.status);
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}
const n1 = async (sql, params = []) => (await pg.query(sql, params)).rows[0].n;

const TAG = String(Date.now()).slice(-6);
const GRADE = '隔离年级' + TAG;
const CA = '隔离甲班' + TAG, CB = '隔离乙班' + TAG;
const PRE = 'scp_' + TAG + '_';
const created = { gradeId: null, classIds: [], userIds: [], studentIds: [], planIds: [], sessionIds: [] };
let admin = null, ta = null, tb = null, tc = null, mon = null;
let ca = null, cb = null, A = [], B = [], nameA = '', nameB = '';

async function cleanup() {
  // 场次（attendance_plan_sessions 的 session_id 为 ON DELETE CASCADE → 关联行自动清理）
  const sessIds = [...new Set(created.sessionIds.filter((x) => Number.isInteger(x)))];
  if (sessIds.length) {
    await pg.query('DELETE FROM attendance_records WHERE session_id = ANY($1::int[])', [sessIds]).catch(() => {});
    await pg.query('DELETE FROM attendance_sessions WHERE id = ANY($1::int[])', [sessIds]).catch(() => {});
  }
  const sids = (await pg.query("SELECT id FROM students WHERE student_no LIKE 'SCP%'")).rows.map((r) => r.id);
  const allS = [...new Set([...created.studentIds, ...sids])];
  if (allS.length) {
    await pg.query('DELETE FROM attendance_records WHERE student_id = ANY($1::int[])', [allS]).catch(() => {});
    await pg.query('DELETE FROM student_day_leaves WHERE student_id = ANY($1::int[])', [allS]).catch(() => {});
  }
  const uids = (await pg.query('SELECT id FROM users WHERE username LIKE $1', [PRE + '%'])).rows.map((r) => r.id);
  if (uids.length) {
    await pg.query('UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL WHERE head_teacher_id = ANY($1::int[]) OR teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM teacher_classes WHERE teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM users WHERE id = ANY($1::int[])', [uids]).catch(() => {});
  }
  await pg.query('DELETE FROM attendance_plans WHERE id = ANY($1::int[])', [created.planIds.length ? created.planIds : [-1]]).catch(() => {});
  await pg.query("DELETE FROM attendance_plans WHERE class_id IN (SELECT id FROM classes WHERE class_name = ANY($1::text[]))", [[CA, CB]]).catch(() => {});
  await pg.query("DELETE FROM students WHERE student_no LIKE 'SCP%'").catch(() => {});
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name = ANY($1::text[])', [[CA, CB]]).catch(() => {});
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(() => {});
}

// 造一条"当前时段、窗口内"的计划（class_id=null 表示全部班级）
//   每次偏移 1 分钟，避免撞上唯一约束 uq_attendance_plans_date_time_class
let planSeq = 0;
async function mkPlan(classId) {
  planSeq += 1;
  const r = await pg.query(
    `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, status, class_id, created_by, created_by_name, created_by_role)
     VALUES (CURRENT_DATE, (to_char(now() - ($4 || ' minutes')::interval, 'HH24:MI'))::time, 30, 'pending', $1, $2, $3, 'teacher')
     RETURNING id`,
    [classId, created.userIds[0] || null, classId === ca ? nameA : (classId === cb ? nameB : '隔离计划发起人'), String(planSeq)]
  );
  created.planIds.push(r.rows[0].id);
  return r.rows[0].id;
}

// 结束并删除用例自己造出的场次（删除会把关联计划置为 ended，不会自动重建）
async function dropSession(sid) {
  if (!sid) return;
  await api('/api/attendance/sessions/' + sid + '/close', { method: 'POST', cookie: admin });
  await api('/api/attendance/sessions/' + sid, { method: 'DELETE', cookie: admin });
  created.sessionIds = created.sessionIds.filter((x) => x !== sid);
}

// 记录"某 id 之后新建的所有场次"（计划按班拆场 → 一次触发可能建出多场）
async function takeNewSessions(afterId) {
  const rows = (await pg.query(
    'SELECT id, class_id, status FROM attendance_sessions WHERE id > $1 ORDER BY id', [afterId]
  )).rows;
  for (const r of rows) created.sessionIds.push(r.id);
  return rows;
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
    admin = await login('admin');

    // ---------- 夹具 ----------
    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'SCP', academicYear: year } })).data.id;
    const mkClass = async (name) => (await api('/api/classes', { method: 'POST', cookie: admin, body: { className: name, gradeName: GRADE, academicYear: year } })).data.id;
    ca = await mkClass(CA); cb = await mkClass(CB);
    created.classIds = [ca, cb];
    const mkStudents = async (classId, prefix) => {
      const out = [];
      for (let i = 1; i <= 2; i += 1) {
        const r = await api('/api/students', { method: 'POST', cookie: admin, body: { studentNo: prefix + TAG + String(i).padStart(2, '0'), name: prefix + '同学' + i, classId, status: '在读' } });
        const id = r.data && (r.data.student ? r.data.student.id : r.data.id);
        if (id) { out.push(id); created.studentIds.push(id); }
      }
      return out;
    };
    A = await mkStudents(ca, 'SCPA');
    B = await mkStudents(cb, 'SCPB');
    // 老师：TA=甲班班主任、TB=乙班班主任、TC=甲班班主任 + 乙班任课（跨两班）、mon=甲班班长
    let r = await api('/api/users', { method: 'POST', cookie: admin, body: { username: PRE + 'ta', password: '123456', role: 'teacher', realName: '隔离甲老师', classId: ca, mustChangePassword: false, profileLocked: true, force: true } });
    created.userIds.push(r.data.user.id);
    const taId = r.data.user.id;
    r = await api('/api/users', { method: 'POST', cookie: admin, body: { username: PRE + 'tb', password: '123456', role: 'teacher', realName: '隔离乙老师', classId: cb, mustChangePassword: false, profileLocked: true, force: true } });
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', { method: 'POST', cookie: admin, body: { username: PRE + 'tc', password: '123456', role: 'teacher', realName: '隔离跨班老师', classId: ca, mustChangePassword: false, profileLocked: true, force: true, teachingClasses: [{ classId: ca, roleInClass: 'head_teacher' }, { classId: cb, roleInClass: 'subject_teacher' }] } });
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', { method: 'POST', cookie: admin, body: { username: PRE + 'mon', password: '123456', role: 'monitor', realName: '隔离班长', classId: ca, mustChangePassword: false, profileLocked: true, force: true } });
    created.userIds.push(r.data.user.id);
    await pg.query('UPDATE classes SET head_teacher_id = $2 WHERE id = $1', [ca, taId]);
    nameA = '隔离甲老师'; nameB = '隔离乙老师';
    ta = await login(PRE + 'ta'); tb = await login(PRE + 'tb'); tc = await login(PRE + 'tc'); mon = await login(PRE + 'mon');
    check('0) 夹具就绪（2 班各 2 人 + 甲/乙班主任 + 跨班老师 + 甲班班长）',
      A.length === 2 && B.length === 2 && !!ta && !!tb && !!tc && !!mon, { a: A.length, b: B.length });

    // 当前是否已有真实的进行中场次（有则不强推计划，避免影响真实签到）
    const preActive = (await api('/api/attendance/status', { cookie: admin })).data.session;
    const realActive = !!(preActive && preActive.status === 'active');
    if (realActive) console.log('  · 注意：当前已有进行中的场次 #' + preActive.id + '（发起人 ' + preActive.createdByName + '），触发类用例将跳过');

    // ---------- 1) 别的班（乙班）计划场次：按 class_id 严格隔离 ----------
    console.log('1) 别的班（乙班）计划场次的班级隔离:');
    let cbSession = null;
    if (realActive) {
      skip('1) 乙班计划场次隔离', '当前已有真实进行中的场次');
    } else {
      const maxBefore = Number((await pg.query('SELECT COALESCE(max(id), 0) AS m FROM attendance_sessions')).rows[0].m);
      const p1 = await mkPlan(cb);
      await attendanceRouter.triggerDuePlans({ onlyPlanId: p1 });
      const news = await takeNewSessions(maxBefore);
      cbSession = news.length ? news[news.length - 1].id : null;
      check('1) 乙班计划触发：【恰好 1 场】且 class_id = 乙班',
        news.length === 1 && news[0].class_id === cb, news);
      check('1) 计划与场次建立关联行（attendance_plan_sessions，class_id=乙班）',
        (await n1('SELECT count(*)::int n FROM attendance_plan_sessions WHERE plan_id = $1 AND session_id = $2 AND class_id = $3', [p1, cbSession, cb])) === 1);
      check('1) 计划的代表场次 = 该班场次',
        (await n1('SELECT count(*)::int n FROM attendance_plans WHERE id = $1 AND session_id = $2', [p1, cbSession])) === 1);
      let s = await api('/api/attendance/status', { cookie: tb });
      check('1) 乙班老师看得到该场次（发起人=自己班计划，classId=乙班）',
        s.status === 200 && s.data.session && s.data.session.id === cbSession &&
        s.data.session.startSource === 'plan' && s.data.session.classId === cb, { session: s.data.session });
      s = await api('/api/attendance/status', { cookie: ta });
      check('1) 甲班老师【看不到】：本班无进行中场次（session=null）',
        s.status === 200 && s.data.session === null, { session: s.data.session, hidden: s.data.hiddenSession });
      check('1) 甲班老师不会拿到"别班场次"的任何记录（records 为空）',
        !s.data.records || Object.keys(s.data.records).length === 0, s.data.records);
      check('1) 甲班老师的展示范围只有本班（total=2）', s.data.stats && s.data.stats.total === 2, s.data.stats);
      s = await api('/api/attendance/status', { cookie: mon });
      check('1) 甲班【班长】同样看不到（班长只应看到本班签到）', s.data.session === null, { session: s.data.session });
      s = await api('/api/attendance/status?classId=' + cb, { cookie: admin });
      check('1) 管理员指定 ?classId=乙班 → 看得到该场次（收敛到所选班级）',
        s.data.session && s.data.session.id === cbSession && s.data.session.classId === cb, s.data.session);
      // 隔离 = 只是不显示：场次/记录数不变
      const recCount = await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1', [cbSession]);
      const sessCount = await n1('SELECT count(*)::int n FROM attendance_sessions');
      await api('/api/attendance/status', { cookie: ta });
      await api('/api/attendance/status?sessionId=' + cbSession, { cookie: ta });
      check('1) 隔离不改动数据：别班场次的会话与记录数完全不变',
        (await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1', [cbSession])) === recCount &&
        (await n1('SELECT count(*)::int n FROM attendance_sessions')) === sessCount, { recCount, sessCount });
      // 钉住参数不能绕开班级隔离
      s = await api('/api/attendance/status?sessionId=' + cbSession, { cookie: ta });
      check('1) 即使带 ?sessionId=（钉住）也不能看到别班场次',
        (!s.data.session || s.data.session.id !== cbSession) && s.data.pinned === false, { session: s.data.session, pinned: s.data.pinned });
      s = await api('/api/attendance/status?sessionId=' + cbSession, { cookie: tb });
      check('1) 本班老师带 ?sessionId= 正常钉住', s.data.session && s.data.session.id === cbSession && s.data.pinned === true,
        { session: s.data.session, pinned: s.data.pinned });
    }

    // ---------- 2) 跨班老师：范围含两班，展示的场次必属所带班级 ----------
    console.log('2) 跨班老师:');
    if (realActive || !cbSession) {
      skip('2) 跨班老师可见性', '缺少乙班计划场次夹具');
    } else {
      const s = await api('/api/attendance/status', { cookie: tc });
      check('2) 甲班班主任 + 乙班任课的老师：scope 里包含其所带的两个班',
        s.data.scope && s.data.scope.classIds && s.data.scope.classIds.length === 2 &&
        s.data.scope.classIds.includes(ca) && s.data.scope.classIds.includes(cb), s.data.scope);
      check('2) 展示的场次（若有）必属其所带班级（不会显示与自己无关的班）',
        !s.data.session || s.data.session.classId === null || [ca, cb].includes(s.data.session.classId),
        { session: s.data.session, classes: [ca, cb] });
    }

    // ---------- 3) 严格隔离：本班学生在别班场次里"写不进去" ----------
    console.log('3) 严格隔离（写入路径也按班级收敛）:');
    if (realActive || !cbSession) {
      skip('3) 严格隔离', '缺少乙班计划场次夹具');
    } else {
      const r = await api('/api/attendance/checkin', { method: 'POST', cookie: ta, body: { studentId: A[0], action: 'present', forcePresent: true } });
      check('3) 甲班学生签到 → 400（本班没有进行中的场次，不会写进别班场次）',
        r.status === 400, { status: r.status, data: r.data });
      check('3) 别班场次里没有该学生的任何记录（数据未被污染）',
        (await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = $2', [cbSession, A[0]])) === 0);
      const r2 = await api('/api/attendance/checkin', { method: 'POST', cookie: ta, body: { studentId: B[0], action: 'present' } });
      check('3) 教师给别班学生签到 → 403（学生不在自己所带班级）', r2.status === 403, { status: r2.status, data: r2.data });
      const r3 = await api('/api/attendance/batch-checkin', { method: 'POST', cookie: ta, body: { mode: 'all', classId: cb } });
      check('3) 教师对别班「全员到齐」→ 403', r3.status === 403, { status: r3.status, data: r3.data });
    }

    // ---------- 4) 「全部班级」计划 → 按班拆场（每班一条） ----------
    console.log('4) 全部班级计划（按班拆场）:');
    if (cbSession) await dropSession(cbSession);
    if (realActive) {
      skip('4) 全部班级计划按班拆场', '当前已有真实进行中的场次');
    } else {
      const maxBefore = Number((await pg.query('SELECT COALESCE(max(id), 0) AS m FROM attendance_sessions')).rows[0].m);
      const p2 = await mkPlan(null);
      await attendanceRouter.triggerDuePlans({ onlyPlanId: p2 });
      const news = await takeNewSessions(maxBefore);
      const expectClasses = (await pg.query(
        `SELECT DISTINCT class_id AS id FROM students WHERE is_active = true AND status = '在读' AND class_id IS NOT NULL ORDER BY 1`
      )).rows.map((x) => x.id);
      check('4) 全部班级计划 → 每个有在读学生的班各一场（' + news.length + ' 场）',
        news.length === expectClasses.length && news.every((x) => x.class_id !== null), { news, expectClasses: expectClasses.length });
      check('4) 每场 class_id 唯一（没有"多班共用一场"）',
        new Set(news.map((x) => x.class_id)).size === news.length);
      check('4) 每场都有 attendance_plan_sessions 关联行（class_id 与场次一致）',
        (await n1('SELECT count(*)::int n FROM attendance_plan_sessions aps JOIN attendance_sessions s ON s.id = aps.session_id WHERE aps.plan_id = $1 AND aps.class_id = s.class_id', [p2])) === news.length);
      const myA = news.find((x) => x.class_id === ca);
      const myB = news.find((x) => x.class_id === cb);
      check('4) 甲乙两班各拿到自己那一场（id 不同）', !!myA && !!myB && myA.id !== myB.id, { a: myA && myA.id, b: myB && myB.id });
      const sA = await api('/api/attendance/status', { cookie: ta });
      const sB = await api('/api/attendance/status', { cookie: tb });
      check('4) 甲班老师看到的是甲班那场（classId=甲班）', sA.data.session && sA.data.session.id === myA.id && sA.data.session.classId === ca, sA.data.session);
      check('4) 乙班老师看到的是乙班那场（classId=乙班）', sB.data.session && sB.data.session.id === myB.id && sB.data.session.classId === cb, sB.data.session);
      check('4) 两位老师看到的是不同的场次（不再共用一个"全校场次"）', sA.data.session.id !== sB.data.session.id);
      // 管理员：不带参 / ?classId=all = 全校视角；?classId=<班> = 收敛到该班
      //   （管理员保留全校视角是刻意设计：场次审计/补签/计划管理页需要看全部）
      const allStu = Number((await pg.query("SELECT count(*)::int n FROM students WHERE is_active = true AND status = '在读'")).rows[0].n);
      const sAdmin = await api('/api/attendance/status', { cookie: admin });
      check('4) 管理员不带参 = 全校视角（学生 = 全部在读 ' + allStu + ' 人，不受绑定班级限制）',
        sAdmin.data.scope.schoolWideView === true && sAdmin.data.stats.total === allStu,
        { total: sAdmin.data.stats.total, allStu, scope: sAdmin.data.scope });
      const sAll = await api('/api/attendance/status?classId=all', { cookie: admin });
      check('4) 管理员 ?classId=all → 同样是全校视角',
        sAll.data.scope.schoolWideView === true && sAll.data.stats.total === allStu,
        { total: sAll.data.stats.total, scope: sAll.data.scope });
      const adm2 = await api('/api/users', { method: 'POST', cookie: admin, body: { username: PRE + 'adm', password: '123456', role: 'admin', realName: '隔离管理员', mustChangePassword: false, profileLocked: true, force: true } });
      created.userIds.push(adm2.data.user.id);
      const cAdm2 = await login(PRE + 'adm');
      const sAdm2 = await api('/api/attendance/status', { cookie: cAdm2 });
      check('4) 未绑定班级的管理员 → 默认全校视角（不收敛）',
        sAdm2.data.scope.schoolWideView === true && sAdm2.data.stats.total === allStu,
        { total: sAdm2.data.stats.total, scope: sAdm2.data.scope });
      const sAdmCa = await api('/api/attendance/status?classId=' + ca, { cookie: admin });
      const sAdmCb = await api('/api/attendance/status?classId=' + cb, { cookie: admin });
      check('4) 管理员 ?classId=甲班 → 只看到甲班（2 人 + 甲班场次）',
        sAdmCa.data.stats.total === 2 && sAdmCa.data.session && sAdmCa.data.session.classId === ca,
        { total: sAdmCa.data.stats.total, session: sAdmCa.data.session });
      check('4) 管理员切换到 ?classId=乙班 → 数据立即变为乙班（切换班级刷新）',
        sAdmCb.data.stats.total === 2 && sAdmCb.data.session && sAdmCb.data.session.classId === cb,
        { total: sAdmCb.data.stats.total, session: sAdmCb.data.session });
      check('4) 无效 classId → 400（不静默回落到全校）',
        (await api('/api/attendance/status?classId=99999999', { cookie: admin })).status === 400);
      // 收尾：删除本计划建出的所有场次
      for (const x of news) await dropSession(x.id);
      await pg.query('DELETE FROM attendance_plans WHERE id = $1', [p2]);
      created.planIds = created.planIds.filter((x) => x !== p2);
    }

    // ---------- 5) 统一鉴权层：补签 / 场次记录 / 批量接口 ----------
    console.log('5) 统一鉴权层（补签/记录/批量）:');
    if (realActive) {
      skip('5) 统一鉴权层', '当前已有真实进行中的场次');
    } else {
      const maxBefore = Number((await pg.query('SELECT COALESCE(max(id), 0) AS m FROM attendance_sessions')).rows[0].m);
      const p5 = await mkPlan(cb);
      await attendanceRouter.triggerDuePlans({ onlyPlanId: p5 });
      const news = await takeNewSessions(maxBefore);
      const s5 = news.length ? news[0].id : null;
      check('5) 乙班计划触发 1 场（class_id=乙班）', news.length === 1 && news[0].class_id === cb, news);
      // 补签：跨班场次 403
      let r = await api('/api/attendance/records', { method: 'POST', cookie: ta, body: { sessionId: s5, studentId: B[0], status: 'present' } });
      check('5) 教师对别班场次补签 → 403', r.status === 403, { status: r.status, data: r.data });
      r = await api('/api/attendance/records', { method: 'POST', cookie: tb, body: { sessionId: s5, studentId: B[0], status: 'present' } });
      check('5) 本班教师补签 → 200 且写入成功', r.status === 200 && r.data.record && r.data.record.status === 'present', { status: r.status, data: r.data });
      r = await api('/api/attendance/records', { method: 'POST', cookie: tb, body: { sessionId: s5, studentId: A[0], status: 'present' } });
      check('5) 本班教师给别班学生补签 → 403（学生不属于该场次班级）', r.status === 403, { status: r.status, data: r.data });
      // 场次记录接口
      r = await api('/api/attendance/session-records?sessionId=' + s5, { cookie: ta });
      check('5) 教师读取别班场次的记录 → 403', r.status === 403, { status: r.status, data: r.data });
      r = await api('/api/attendance/session-records?sessionId=' + s5, { cookie: tb });
      check('5) 本班教师读取场次记录 → 200', r.status === 200, { status: r.status });
      // 补缺勤只覆盖本场次班级
      const today = (await pg.query("SELECT to_char(now(), 'YYYY-MM-DD') AS d")).rows[0].d;
      await api('/api/attendance/leave/batch', { method: 'POST', cookie: ta, body: { date: today, items: [{ studentId: A[1], reason: 'sick' }], cancels: [] } });
      check('5) 甲班的"全天请假"没有被写进乙班场次（写入路径按场次班级收敛）',
        (await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = ANY($2::int[])', [s5, A])) === 0,
        await pg.query('SELECT student_id, status, check_in_method FROM attendance_records WHERE session_id = $1 AND student_id = ANY($2::int[])', [s5, A]).then((x) => x.rows));
      await api('/api/attendance/sessions/' + s5 + '/close', { method: 'POST', cookie: admin });
      check('5) 补缺勤只覆盖本场次的班级：甲班学生没有在该场次被写缺勤',
        (await n1("SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = ANY($2::int[]) AND status = 'absent'", [s5, A])) === 0);
      check('5) 乙班学生在该场次被补了缺勤（本场次范围内的班级仍正常收口）',
        (await n1("SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = ANY($2::int[]) AND status = 'absent'", [s5, B])) >= 1);
      // 甲班自己的请假仍同步在自己的场次：新发起一场本班签到 → 请假学生直接为 leave
      const stA = await api('/api/attendance/start', { method: 'POST', cookie: ta, body: { deadlineMinutes: 30, classId: ca } });
      const sidA = stA.data.session.id;
      created.sessionIds.push(...(stA.data.sessions || []).map((x) => x.id));
      check('5) 甲班老师发起 → 只有本班一场（class_id=甲班）',
        (stA.data.sessions || []).length === 1 && stA.data.sessions[0].classId === ca, stA.data.sessions);
      check('5) 当天登记的「全天请假」已同步到本班场次（status=leave，method=batch_leave）',
        (await n1("SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = $2 AND status = 'leave' AND check_in_method = 'batch_leave'", [sidA, A[1]])) === 1);
      await api('/api/attendance/leave/batch', { method: 'POST', cookie: ta, body: { date: today, items: [], cancels: [A[1]] } });
      await dropSession(sidA);
      await dropSession(s5);
      await pg.query('DELETE FROM attendance_plans WHERE id = $1', [p5]);
      created.planIds = created.planIds.filter((x) => x !== p5);
    }

    // ---------- 5b) 补签走「全部班级」计划：教师只能落到自己班的场次 ----------
    console.log('5b) 补签（planId 路径）按班级落场:');
    {
      // 一条"已结束但从未生成场次"的全部班级计划（模拟历史计划补签入口）
      const p6 = (await pg.query(
        `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, status, class_id, created_by, created_by_name, created_by_role)
         VALUES (CURRENT_DATE, (to_char(now() - interval '3 hours', 'HH24:MI'))::time, 10, 'ended', NULL, $1, $2, 'teacher')
         RETURNING id`,
        [created.userIds[0] || null, '隔离计划发起人']
      )).rows[0].id;
      created.planIds.push(p6);
      const rA = await api('/api/attendance/records/batch', { method: 'POST', cookie: ta, body: { planId: p6, studentIds: [A[0]] } });
      check('5b) 甲班老师对「全部班级」计划补签 → 200 且自动补录了场次', rA.status === 200 && rA.data.autoCreatedSession === true, { status: rA.status, data: rA.data });
      const sidA6 = rA.data && rA.data.sessionId;
      if (Number.isInteger(sidA6)) created.sessionIds.push(sidA6);
      const rowA = (await pg.query('SELECT class_id, status FROM attendance_sessions WHERE id = $1', [sidA6])).rows[0];
      check('5b) 补录出来的场次归属 = 甲班（不是 class_id IS NULL 的全校场次）',
        !!rowA && rowA.class_id === ca && rowA.status === 'closed', rowA);
      check('5b) 甲班学生记录写在本班场次里，且 plans.session_id 未被覆盖（全校计划的代表场次仍为空）',
        (await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = $2', [sidA6, A[0]])) === 1 &&
        (await n1('SELECT count(*)::int n FROM attendance_plans WHERE id = $1 AND session_id IS NULL', [p6])) === 1);
      check('5b) 计划与"甲班那一场"建立关联行（按班拆场后每班一条）',
        (await n1('SELECT count(*)::int n FROM attendance_plan_sessions WHERE plan_id = $1 AND session_id = $2 AND class_id = $3', [p6, sidA6, ca])) === 1);
      // 乙班老师对同一条"全部班级"计划补签 → 落到乙班自己那一场（不会写进甲班场次）
      const rB = await api('/api/attendance/records/batch', { method: 'POST', cookie: tb, body: { planId: p6, studentIds: [B[0]] } });
      const sidB6 = rB.data && rB.data.sessionId;
      if (Number.isInteger(sidB6)) created.sessionIds.push(sidB6);
      const rowB = (await pg.query('SELECT class_id FROM attendance_sessions WHERE id = $1', [sidB6])).rows[0];
      check('5b) 乙班老师补签同一计划 → 落到乙班自己的场次（class_id=乙班）',
        rB.status === 200 && !!rowB && rowB.class_id === cb && sidB6 !== sidA6, { status: rB.status, rowB, sidA6, sidB6 });
      check('5b) 甲班场次里不会出现乙班学生的记录（互不污染）',
        (await n1('SELECT count(*)::int n FROM attendance_records WHERE session_id = $1 AND student_id = ANY($2::int[])', [sidA6, B])) === 0);
      // 收尾：把 5b 补录出来的两场删掉（否则它们会作为"当天已结束场次"出现在后续段落/回看里）
      await dropSession(sidA6);
      await dropSession(sidB6);
      await pg.query('DELETE FROM attendance_plans WHERE id = $1', [p6]);
      created.planIds = created.planIds.filter((x) => x !== p6);
    }

    // ---------- 6) 手动发起：归属 = 发起人班级；结束回看只给本班 ----------
    console.log('6) 手动发起的场次按班级隔离:');
    if (realActive) {
      skip('6) 手动场次隔离', '当前已有真实进行中的场次');
    } else {
      const st = await api('/api/attendance/start', { method: 'POST', cookie: tb, body: { deadlineMinutes: 30 } });
      const manSid = st.data && st.data.session ? st.data.session.id : null;
      created.sessionIds.push(manSid);
      check('6) 乙班老师手动发起 → 201 且 class_id=乙班', st.status === 201 && !!manSid && st.data.session.classId === cb, st.data.session);
      const sb = await api('/api/attendance/status', { cookie: tb });
      check('6) 乙班老师看得到自己发起的场次', !!(sb.data.session && sb.data.session.id === manSid), sb.data.session);
      const sa = await api('/api/attendance/status', { cookie: ta });
      check('6) 甲班老师【看不到】：返回的绝不是乙班那场（本班没有进行中场次 / 只回看本班自己的）',
        !sa.data.session || sa.data.session.id !== manSid, { session: sa.data.session });
      const sm2 = await api('/api/attendance/status', { cookie: mon });
      check('6) 甲班班长同样看不到（用户反馈场景：班长看到"发起：别的老师"）',
        !sm2.data.session || sm2.data.session.id !== manSid, { session: sm2.data.session });
      const sadm = await api('/api/attendance/status?classId=' + cb, { cookie: admin });
      check('6) 管理员指定该班 → 看得到（便于管理）', !!(sadm.data.session && sadm.data.session.id === manSid), sadm.data.session);
      await api('/api/attendance/sessions/' + manSid + '/close', { method: 'POST', cookie: admin });
      const sa2 = await api('/api/attendance/status', { cookie: ta });
      check('6) 该场次结束后，甲班老师也回看不到（已截止的别班签到不显示）',
        !sa2.data.session || sa2.data.session.id !== manSid, sa2.data.session);
      const sb2 = await api('/api/attendance/status', { cookie: tb });
      check('6) 乙班老师仍可回看自己班刚结束的场次（同班回看保留）',
        !!(sb2.data.session && sb2.data.session.id === manSid), sb2.data.session);
      await dropSession(manSid);
    }

    // ---------- 7) 学生列表范围 ----------
    console.log('7) 学生列表范围:');
    let s = await api('/api/attendance/status', { cookie: ta });
    check('7) 绑定了班级的老师：只看本班 2 名学生', s.data.stats.total === 2, s.data.stats);
    s = await api('/api/attendance/status', { cookie: tc });
    check('7) 跨两班老师：相关性范围包含所带两个班（卡片仍只显示主绑定班级）',
      s.data.scope && s.data.scope.classIds && s.data.scope.classIds.length === 2 &&
      s.data.scope.classIds.includes(ca) && s.data.scope.classIds.includes(cb) && s.data.stats.total === 2,
      { total: s.data.stats.total, scope: s.data.scope });
    const noCls = await api('/api/users', { method: 'POST', cookie: admin, body: { username: PRE + 'nc', password: '123456', role: 'teacher', realName: '隔离无绑班老师', mustChangePassword: false, profileLocked: true, force: true, teachingClasses: [{ classId: ca, roleInClass: 'subject_teacher' }] } });
    created.userIds.push(noCls.data.user.id);
    const cNc = await login(PRE + 'nc');
    s = await api('/api/attendance/status', { cookie: cNc });
    check('7) 未绑定班级但有所带班级的老师：只看所带班级（2 人，不再看到全校）', s.data.stats.total === 2, { total: s.data.stats.total, scope: s.data.scope });
    s = await api('/api/attendance/status', { cookie: admin });
    check('7) 管理员不受影响：学生列表为全部在读学生（>2）', s.data.stats.total > 2, s.data.stats.total);

    // ---------- 8) 新建场次一律带 class_id ----------
    console.log('8) 新建场次的 class_id:');
    const newIds = [...new Set(created.sessionIds.filter((x) => Number.isInteger(x)))];
    check('8) 本用例触发的所有场次 class_id 均非空（NULL 只保留给历史"全校场次"）',
      newIds.length === 0 || (await n1('SELECT count(*)::int n FROM attendance_sessions WHERE id = ANY($1::int[]) AND class_id IS NULL', [newIds])) === 0,
      { ids: newIds.length, nulls: await n1('SELECT count(*)::int n FROM attendance_sessions WHERE id = ANY($1::int[]) AND class_id IS NULL', [newIds.length ? newIds : [-1]]) });

    // ---------- 9) 真实数据与清理 ----------
    console.log('9) 清理与基线核对:');
    await cleanup();
    const after = {
      users: await n1('SELECT count(*)::int n FROM users'),
      classes: await n1('SELECT count(*)::int n FROM classes'),
      students: await n1('SELECT count(*)::int n FROM students'),
      sessions: await n1('SELECT count(*)::int n FROM attendance_sessions'),
      records: await n1('SELECT count(*)::int n FROM attendance_records'),
      plans: await n1('SELECT count(*)::int n FROM attendance_plans'),
    };
    check('9) 真实数据行数回到用例前（users/classes/students/sessions/records/plans）',
      JSON.stringify(base) === JSON.stringify(after), { base, after });
    check('9) 夹具已清理（账号/班级/年级/学生/场次/计划）',
      (await n1('SELECT count(*)::int n FROM users WHERE username LIKE $1', [PRE + '%'])) === 0 &&
      (await n1('SELECT count(*)::int n FROM classes WHERE class_name = ANY($1::text[])', [[CA, CB]])) === 0 &&
      (await n1("SELECT count(*)::int n FROM students WHERE student_no LIKE 'SCP%'")) === 0);
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：', e.message);
    try { await cleanup(); } catch (_) {}
  } finally {
    await pg.end().catch(() => {});
    console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped ? ' / ' + skipped + ' 跳过' : ''}`);
  }
  process.exitCode = fail ? 1 : 0;
})();
