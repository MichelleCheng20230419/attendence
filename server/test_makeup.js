// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 独立补签页 后端集成测试（自建夹具场次/计划，结束后自动清理）
// 覆盖：session-records 查询 / 批量补签(makeup) / 已签跳过 / 角色与班级范围权限 / 页面路由
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';

const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

let sessionId = null;
let planId = null;
let plan2Id = null;      // 已结束但从未生成场次的计划（自动补录场景）
let plan2SessionId = null;
let adminCookie = null;
const tmpUsers = [];

async function api(path, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  const setc = res.headers.get('set-cookie');
  return { status: res.status, data, setc };
}
async function login(username, password) {
  // admin 的密码可能被管理员改过 → 用环境变量 DSH_ADMIN_PW（默认 123456）；夹具账号固定 123456
  const pw = password || (username === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password: pw } });
  if (r.status !== 200) throw new Error('login ' + username + ' failed: ' + r.status);
  const m = r.setc && r.setc.match(/connect\.sid=([^;]+)/);
  return 'connect.sid=' + m[1];
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

(async () => {
  try {
    // ---------- 夹具：closed 场次（无记录）+ 绑定的 ended 计划（class1）----------
    // 注意：场次放在【昨天】，避免与在线使用冲突——签到台每 3 秒轮询 /attendance/status 时
    // 会把"今天最近一个已结束场次"自动补缺勤，会让"初始无记录"的断言失效
    const sess = await pg.query(
      `INSERT INTO attendance_sessions (start_time, deadline, status)
       VALUES ((CURRENT_DATE - 1) + time '10:00', (CURRENT_DATE - 1) + time '10:00' + interval '10 minutes', 'closed')
       RETURNING id`
    );
    sessionId = sess.rows[0].id;
    const plan = await pg.query(
      `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, class_id, status, session_id)
       VALUES (CURRENT_DATE - 1, '10:00', 10, 1, 'ended', $1) RETURNING id`,
      [sessionId]
    );
    planId = plan.rows[0].id;
    // 夹具2：已结束但从未生成场次的计划（class1，过去日期）→ 补签时自动补录
    const plan2 = await pg.query(
      `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, class_id, status, session_id)
       VALUES (CURRENT_DATE - 5, '10:30', 10, 1, 'ended', NULL) RETURNING id`
    );
    plan2Id = plan2.rows[0].id;
    console.log(`夹具：session=${sessionId} plan=${planId} plan2(无场次)=${plan2Id}`);

    const adminLogin = await login('admin');
    adminCookie = adminLogin;
    console.log('admin 登录 OK');

    // 1) session-records：closed 且空
    let r = await api(`/api/attendance/session-records?sessionId=${sessionId}`, { cookie: adminCookie });
    check('GET session-records 200', r.status === 200, r.data);
    check('session status=closed', r.data && r.data.session && r.data.session.status === 'closed');
    check('初始 records 为空', Array.isArray(r.data.records) && r.data.records.length === 0);

    // 2) 学生名单（class1 在读，按学号）
    r = await api('/api/students?status=' + encodeURIComponent('在读') + '&classId=1', { cookie: adminCookie });
    const class1 = (r.data.students || []).map((s) => s.id);
    check('class1 在读学生 > 0', class1.length > 0, class1.length);
    const nos = (r.data.students || []).map((s) => s.studentNo);
    check('按学号升序', nos.join(',') === [...nos].sort().join(','));

    // 3) 批量补签前 2 人（未签）
    const pick = class1.slice(0, 2);
    r = await api('/api/attendance/records/batch', { method: 'POST', body: { sessionId, studentIds: pick }, cookie: adminCookie });
    check('POST batch count=2', r.status === 200 && r.data.count === 2 && r.data.skipped === 0, r.data);
    check('method=makeup', r.data && r.data.method === 'makeup');

    // 4) 记录落库：present + makeup
    r = await api(`/api/attendance/session-records?sessionId=${sessionId}`, { cookie: adminCookie });
    const recs = (r.data.records || []).filter((x) => pick.includes(x.studentId));
    check('新增 2 条记录', recs.length === 2, recs);
    check('状态 present + checkInMethod=makeup',
      recs.length === 2 && recs.every((x) => x.status === 'present' && x.checkInMethod === 'makeup'), recs);

    // 5) 重复补签同一批 → 全部跳过（已签不可覆盖）
    r = await api('/api/attendance/records/batch', { method: 'POST', body: { sessionId, studentIds: pick }, cookie: adminCookie });
    check('重复补签 count=0 skipped=2', r.status === 200 && r.data.count === 0 && r.data.skipped === 2, r.data);

    // 6) 无效学生 → 403 + invalidIds
    r = await api('/api/attendance/records/batch', { method: 'POST', body: { sessionId, studentIds: [999999] }, cookie: adminCookie });
    check('无效学生 403', r.status === 403 && Array.isArray(r.data.invalidIds), r.data);

    // 7) 教师跨班：test1(class2) 补 class1 计划的场次 → 403
    const t1Cookie = await login('test1', '123456');
    r = await api('/api/attendance/records/batch', { method: 'POST', body: { sessionId, studentIds: pick }, cookie: t1Cookie });
    check('教师跨班场次 403', r.status === 403, r.data);

    // 8) 教师同班：tmp_teacher(class1) → 200（已签跳过 2）
    const t1c1 = await login('tmp_teacher', '123456');
    r = await api('/api/attendance/records/batch', { method: 'POST', body: { sessionId, studentIds: pick }, cookie: t1c1 });
    check('同班教师 200 跳过已签', r.status === 200 && r.data.count === 0 && r.data.skipped === 2, r.data);
    const pageT = await fetch(BASE + '/attendance/makeup?sessionId=' + sessionId, { headers: { Cookie: t1c1 }, redirect: 'manual' });
    check('教师访问补签页 → 200', pageT.status === 200, pageT.status);

    // 9) 角色 403：临时班长/学生 + 学生访问补签页 302
    //    预清理：若上次异常运行残留同名账号，先删掉再创建
    await pg.query(`DELETE FROM users WHERE username IN ('mk_monitor_t', 'mk_student_t')`).catch(() => {});
    // 班长"每班限 1 个"，动态挑一个还没有班长账号的班级（避免与真实/其他测试班长冲突）
    const freeClass = await pg.query(
      `SELECT c.id FROM classes c
        WHERE NOT EXISTS (SELECT 1 FROM users m WHERE m.role = 'monitor' AND m.class_id = c.id AND m.is_active = true)
        ORDER BY c.id LIMIT 1`
    );
    const freeClassId = freeClass.rowCount > 0 ? freeClass.rows[0].id : null;
    const stuClass = freeClassId || (await pg.query('SELECT id FROM classes ORDER BY id LIMIT 1')).rows[0].id;
    if (freeClassId) {
      const cr = await api('/api/users', {
        method: 'POST', cookie: adminCookie,
        body: { username: 'mk_monitor_t', password: '123456', role: 'monitor', classId: freeClassId },
      });
      if (cr.status === 201) tmpUsers.push({ id: cr.data.user.id, username: 'mk_monitor_t' });
      else console.log('  - 创建 mk_monitor_t 失败', cr.status, JSON.stringify(cr.data));
      const mkMonitor = await login('mk_monitor_t', '123456');
      r = await api('/api/attendance/records/batch', { method: 'POST', body: { sessionId, studentIds: pick }, cookie: mkMonitor });
      check('班长 403', r.status === 403, r.data);
    } else {
      console.log('  - 所有班级均已有班长账号，跳过班长 403 用例');
    }

    const crS = await api('/api/users', {
      method: 'POST', cookie: adminCookie,
      body: { username: 'mk_student_t', password: '123456', role: 'student', classId: stuClass },
    });
    if (crS.status === 201) tmpUsers.push({ id: crS.data.user.id, username: 'mk_student_t' });
    else console.log('  - 创建 mk_student_t 失败', crS.status, JSON.stringify(crS.data));
    const mkStudent = await login('mk_student_t', '123456');
    r = await api('/api/attendance/records/batch', { method: 'POST', body: { sessionId, studentIds: pick }, cookie: mkStudent });
    check('学生 403', r.status === 403, r.data);
    const pageS = await fetch(BASE + '/attendance/makeup?sessionId=' + sessionId, { headers: { Cookie: mkStudent }, redirect: 'manual' });
    check('学生访问补签页 → 302', pageS.status === 302, pageS.status);

    // 10) 计划未生成场次：教师跨班（test1 class2 vs plan2 class1）→ 403
    r = await api('/api/attendance/records/batch', { method: 'POST', body: { planId: plan2Id, studentIds: pick }, cookie: t1Cookie });
    check('无场次计划：教师跨班 403', r.status === 403, r.data);

    // 11) 管理员提交 planId（无 sessionId）→ 自动补录 closed 场次 + 补签
    const plan2Before = await pg.query('SELECT session_id FROM attendance_plans WHERE id = $1', [plan2Id]);
    check('提交前 plan2 无场次', plan2Before.rows[0].session_id === null);
    r = await api('/api/attendance/records/batch', { method: 'POST', body: { planId: plan2Id, studentIds: pick }, cookie: adminCookie });
    check('无场次计划：自动补录并补签 count=2', r.status === 200 && r.data.count === 2 && r.data.autoCreatedSession === true, r.data);
    check('返回新场次 id', r.data && Number.isInteger(r.data.sessionId));
    plan2SessionId = r.data.sessionId;
    const plan2After = await pg.query('SELECT session_id FROM attendance_plans WHERE id = $1', [plan2Id]);
    check('计划已关联新场次', plan2After.rows[0].session_id === plan2SessionId);
    const sess2 = await pg.query(
      `SELECT status, (start_time AT TIME ZONE 'Asia/Shanghai')::date = (CURRENT_DATE - 5) AS right_date
         FROM attendance_sessions WHERE id = $1`, [plan2SessionId]);
    check('补录场次 closed 且日期=计划日期',
      sess2.rows[0] && sess2.rows[0].status === 'closed' && sess2.rows[0].right_date === true, sess2.rows[0]);

    // 12) 再次提交同一 planId → 复用已补录场次，全部跳过
    r = await api('/api/attendance/records/batch', { method: 'POST', body: { planId: plan2Id, studentIds: pick }, cookie: adminCookie });
    check('二次提交：复用场次 count=0 skipped=2', r.status === 200 && r.data.count === 0 && r.data.skipped === 2 && r.data.autoCreatedSession === false, r.data);

    // 13) 记录落库检查（present + makeup）
    r = await api(`/api/attendance/session-records?sessionId=${plan2SessionId}`, { cookie: adminCookie });
    const recs2 = (r.data.records || []).filter((x) => pick.includes(x.studentId));
    check('补录场次记录 present+makeup',
      recs2.length === 2 && recs2.every((x) => x.status === 'present' && x.checkInMethod === 'makeup'), recs2);

    // 14) 同班教师（tmp_teacher class1）对无场次计划直接提交 → 200（本班计划）
    const plan3 = await pg.query(
      `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, class_id, status, session_id)
       VALUES (CURRENT_DATE - 4, '11:00', 10, 1, 'ended', NULL) RETURNING id`
    );
    const plan3Id = plan3.rows[0].id;
    r = await api('/api/attendance/records/batch', { method: 'POST', body: { planId: plan3Id, studentIds: pick }, cookie: t1c1 });
    check('同班教师无场次计划 200 autoCreated', r.status === 200 && r.data.count === 2 && r.data.autoCreatedSession === true, r.data);
    await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [r.data.sessionId]).catch(() => {});
    await pg.query('DELETE FROM attendance_sessions WHERE id = $1', [r.data.sessionId]).catch(() => {});
    await pg.query('DELETE FROM attendance_plans WHERE id = $1', [plan3Id]).catch(() => {});

    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  } finally {
    // ---------- 清理 ----------
    for (const u of tmpUsers) {
      if (u.id) await api('/api/users/' + u.id, { method: 'DELETE', cookie: adminCookie }).catch(() => {});
    }
    if (sessionId) {
      await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [sessionId]).catch(() => {});
      await pg.query('DELETE FROM attendance_sessions WHERE id = $1', [sessionId]).catch(() => {});
    }
    if (planId) {
      await pg.query('DELETE FROM attendance_plans WHERE id = $1', [planId]).catch(() => {});
    }
    if (plan2Id) {
      if (plan2SessionId) {
        await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [plan2SessionId]).catch(() => {});
        await pg.query('DELETE FROM attendance_sessions WHERE id = $1', [plan2SessionId]).catch(() => {});
      }
      await pg.query('DELETE FROM attendance_plans WHERE id = $1', [plan2Id]).catch(() => {});
    }
    await pg.end().catch(() => {});
    console.log('清理完成');
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
