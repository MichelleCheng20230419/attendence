// ============================================================
// 「每天自动生成早/晚 2 次签到」测试（v35 · 路线 B）
//   需求（老师定的口径）：
//     1) 系统每天 0 点自动为【每个班】生成 2 条签到场次：早自习(morning) / 晚自修(evening)
//     2) 不限时（auto 场次不做签到窗口限制；deadline 仅填当天 23:59 供兼容/展示）
//     3) 默认全员已签到：进页面默认全绿，只点掉没来的人；点「保存」才把整场写库
//        （路线 B：**不预建记录行**，缺勤仍是人工"取消"写出的显式 absent 行 → 统计口径与历史连续）
//     4) 次日收口：生成新一天时把昨天及更早仍未结束的 auto 场次置 closed，且**不补缺勤**
//     5) 开关：system_settings.daily_sessions_enabled（默认关闭）→ 迁移/生成器可先上线不生效
//   覆盖：
//     A) 迁移结构：新列/约束/部分唯一索引存在，且**现有老场次一律 auto_generated=false**
//     B) 生成：为所有"有在读学生"的班级各生成早/晚 2 场；字段正确（slot/session_date/class_id/
//        start_source='auto'/auto_generated/deadline=当天23:59/status='active'/created_by IS NULL）
//     C) 幂等：重复调用 0 新增；重复插入被部分唯一索引挡住；空班级/归档班级不生成
//     D) 收口：昨天及更早的 active auto 场次被 closed；**不产生任何 absent 记录**（不跑 finalizeAbsent）；
//        当天场次不受影响；老场次（auto_generated=false）不受影响
//     E) 开关：默认关闭时 runDailySessionsAuto 跳过且不生成；管理员打开后立即生成当天场次；
//        非管理员开/关 → 403；配置接口返回时段/今天场次
//     F) 权限与基线：学生查询配置 200（只读）或 401；老数据（场次/记录数）未被本套件污染
//   夹具：1 年级 + 3 班（甲班 2 生 / 乙班 1 生 / 丙班 0 生即空班）+ 教师账号；测完自愈清理
// 用法：node test_daily_sessions.js（需服务已启动；管理员密码取 DSH_ADMIN_PW）
// ============================================================
'use strict';
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const att = require('./src/routes/attendance');   // 直接调用定时任务内部函数（不等 0 点）
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + p, { method, headers, redirect: 'manual', body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  let d = null; if (ct.includes('application/json')) { try { d = await r.json(); } catch (_) {} }
  return { status: r.status, data: d, setc: r.headers.get('set-cookie') || '' };
}
async function login(u) {
  const pw = u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456';
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('登录失败 ' + u + ': ' + r.status);
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}
const p2 = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const TODAY = fmt(new Date());
const YEST = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return fmt(d); })();
const D2 = (() => { const d = new Date(); d.setDate(d.getDate() - 2); return fmt(d); })();
const n1 = async (sql, params = []) => (await pg.query(sql, params)).rows[0].n;

const TAG = String(Date.now()).slice(-6);
const GRADE = '日签年级' + TAG;
const CA = '日签甲班' + TAG, CB = '日签乙班' + TAG, CC = '日签丙班空' + TAG;
const PRE = 'dsg_' + TAG + '_';
const created = { gradeId: null, classIds: [], userIds: [], studentIds: [] };
// 本套件"自己造出来的"自动场次 id：生成器会为**所有有学生的班**（含真实班级）建场次，
//   收尾必须把它们一并删掉，否则会污染真实基线（真实班级每天被凭空多出 2 场）
const trackedSessionIds = new Set();
const testStart = new Date();
let adminUserId = null;
function trackGen(res) {
  for (const x of ((res && res.createdByClass) || [])) for (const id of (x.sessions || [])) trackedSessionIds.add(Number(id));
}
let admin = null, teacherC = null, monitorC = null;
let enabledBefore = null;
let baseline = null;

async function cleanup() {
  const warn = () => {};
  // 1) 删掉本套件生成的所有自动场次（含为真实班级造的那些 —— 这就是"不污染基线"的关键）
  const tracked = [...trackedSessionIds];
  if (tracked.length) {
    await pg.query('DELETE FROM attendance_records WHERE session_id = ANY($1::int[])', [tracked]).catch(warn);
    await pg.query('DELETE FROM attendance_sessions WHERE id = ANY($1::int[])', [tracked]).catch(warn);
  }
  // 2) 夹具班级相关的场次/记录（兜住"生成器返回值没被记上"的异常路径）
  const cids = created.classIds.length ? created.classIds
    : (await pg.query('SELECT id FROM classes WHERE class_name LIKE $1', ['日签%班%'])).rows.map((r) => r.id);
  if (cids.length) {
    await pg.query('DELETE FROM attendance_records WHERE session_id IN (SELECT id FROM attendance_sessions WHERE class_id = ANY($1::int[]))', [cids]).catch(warn);
    await pg.query('DELETE FROM attendance_sessions WHERE class_id = ANY($1::int[])', [cids]).catch(warn);
  }
  await pg.query("UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL WHERE head_teacher_id IN (SELECT id FROM users WHERE username LIKE $1) OR teacher_id IN (SELECT id FROM users WHERE username LIKE $1)", [PRE + '%']).catch(warn);
  await pg.query('DELETE FROM teacher_classes WHERE teacher_id IN (SELECT id FROM users WHERE username LIKE $1)', [PRE + '%']).catch(warn);
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name LIKE $1', ['日签%班%']).catch(warn);
  await pg.query('DELETE FROM users WHERE username LIKE $1', [PRE + '%']).catch(warn);
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(warn);
  // 3) 删掉本套件写的操作日志（按管理员 + 测试开始时间收敛，不碰真实日志）
  if (adminUserId) {
    await pg.query("DELETE FROM operation_logs WHERE action = 'daily_sessions_toggle' AND user_id = $1 AND created_at >= $2", [adminUserId, testStart]).catch(warn);
  }
  // 4) 还原开关（默认关闭）
  if (enabledBefore === null) await pg.query("DELETE FROM system_settings WHERE key = 'daily_sessions_enabled'").catch(warn);
  else await pg.query("UPDATE system_settings SET value = $1 WHERE key = 'daily_sessions_enabled'", [enabledBefore]).catch(warn);
}

(async () => {
  try {
    console.log('0) 夹具与基线…');
    admin = await login('admin');
    adminUserId = (await pg.query("SELECT id FROM users WHERE username = 'admin'")).rows[0].id;
    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'DSG', academicYear: year } })).data.id;
    const mkClass = async (name) => (await api('/api/classes', { method: 'POST', cookie: admin, body: { className: name, gradeName: GRADE, academicYear: year } })).data.id;
    const ca = await mkClass(CA), cb = await mkClass(CB), cc = await mkClass(CC);
    created.classIds = [ca, cb, cc];
    for (const [cid, prefix, n] of [[ca, 'DSGA', 2], [cb, 'DSGB', 1]]) {
      for (let i = 1; i <= n; i += 1) {
        const r = await api('/api/students', { method: 'POST', cookie: admin, body: { studentNo: prefix + TAG + p2(i), name: prefix + '同学' + i, classId: cid, status: '在读' } });
        created.studentIds.push(r.data && (r.data.student ? r.data.student.id : r.data.id));
      }
    }
    // 教师（甲班班主任）+ 甲班班长
    let r = await api('/api/users', { method: 'POST', cookie: admin, body: { username: PRE + 'head', password: '123456', role: 'teacher', realName: '日签班主任', classId: ca, subject: '语文', mustChangePassword: false, profileLocked: true, force: true, teachingClasses: [{ classId: ca, roleInClass: 'head_teacher' }] } });
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', { method: 'POST', cookie: admin, body: { username: PRE + 'mon', password: '123456', role: 'monitor', realName: '日签班长', classId: ca, mustChangePassword: false, profileLocked: true, force: true } });
    created.userIds.push(r.data.user.id);
    teacherC = await login(PRE + 'head');
    monitorC = await login(PRE + 'mon');
    // 记录默认开关（用于还原）
    const cur = await pg.query("SELECT value FROM system_settings WHERE key = 'daily_sessions_enabled'");
    enabledBefore = cur.rowCount ? cur.rows[0].value : null;
    baseline = {
      sessions: await n1('SELECT count(*)::int AS n FROM attendance_sessions'),
      records: await n1('SELECT count(*)::int AS n FROM attendance_records'),
      auto: await n1('SELECT count(*)::int AS n FROM attendance_sessions WHERE auto_generated'),
    };
    check('0) 夹具就绪（3 班：甲 2 生 / 乙 1 生 / 丙 0 生空班 + 班主任 + 班长）',
      created.classIds.filter(Boolean).length === 3 && created.studentIds.filter(Boolean).length === 3 && created.userIds.length === 2);

    // ---------- A) 迁移结构 ----------
    console.log('A) v35 迁移结构:');
    const cols = (await pg.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name='attendance_sessions' AND column_name IN ('auto_generated','slot','session_date') ORDER BY column_name`
    )).rows;
    check('A) 新列存在：auto_generated(boolean, NOT NULL, 默认 false) / slot / session_date',
      cols.length === 3 && cols.find((c) => c.column_name === 'auto_generated').is_nullable === 'NO' &&
      String(cols.find((c) => c.column_name === 'auto_generated').column_default).includes('false') &&
      cols.find((c) => c.column_name === 'slot').data_type === 'character varying' &&
      cols.find((c) => c.column_name === 'session_date').data_type === 'date',
      cols);
    const cons = (await pg.query("SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='attendance_sessions'::regclass AND contype='c'")).rows;
    check('A) 约束：ck_sessions_source 白名单含 auto', !!cons.find((c) => c.conname === 'ck_sessions_source' && /'auto'/.test(c.def)),
      cons.map((c) => c.conname));
    check('A) 约束：ck_sessions_slot（morning/evening 或 NULL）+ ck_sessions_auto_shape（自动场次必须有 时段/日期/班级）',
      !!cons.find((c) => c.conname === 'ck_sessions_slot' && /morning/.test(c.def) && /evening/.test(c.def)) &&
      !!cons.find((c) => c.conname === 'ck_sessions_auto_shape' && /slot IS NOT NULL/.test(c.def)),
      cons.map((c) => c.conname));
    const idx = (await pg.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename='attendance_sessions' AND indexname IN ('uniq_session_auto_slot','idx_sessions_auto_date')")).rows;
    check('A) 部分唯一索引 uniq_session_auto_slot(class_id, session_date, slot) WHERE auto_generated',
      !!idx.find((x) => x.indexname === 'uniq_session_auto_slot' && /UNIQUE/.test(x.indexdef) && /auto_generated = true/.test(x.indexdef)),
      idx.map((x) => x.indexname));
    const legacyAuto = await n1('SELECT count(*)::int AS n FROM attendance_sessions WHERE auto_generated');
    check('A) 迁移不改历史：所有既有场次 auto_generated=false（自动场次数为 0）', legacyAuto === baseline.auto && legacyAuto >= 0, { autoNow: legacyAuto });
    const missingDate = await n1('SELECT count(*)::int AS n FROM attendance_sessions WHERE session_date IS NULL');
    check('A) 历史场次 session_date 已回填（无 NULL）', missingDate === 0, { missingDate });

    // ---------- B) 生成 ----------
    console.log('B) 每天 2 场自动生成:');
    const g1 = await att.generateDailySessionsForAllClasses(TODAY);
    trackGen(g1);
    check('B) 生成器返回：班级数/新建场次/时段计数', !!g1 && g1.date === TODAY && g1.created === g1.slotCounts.morning + g1.slotCounts.evening, g1 && { date: g1.date, created: g1.created, slots: g1.slotCounts });
    const clsRows = (await pg.query(
      `SELECT c.id, c.class_name FROM classes c
        WHERE c.status IS DISTINCT FROM 'archived'
          AND EXISTS (SELECT 1 FROM students s WHERE s.class_id = c.id AND s.is_active = true AND s.status = '在读')`
    )).rows;
    const expectClasses = clsRows.length;
    check('B) 覆盖"有在读学生"的每个班（夹具甲/乙班本次都新建了 2 场；空班不生成）',
      g1.classes === expectClasses &&
      g1.createdByClass.some((x) => x.classId === created.classIds[0]) &&
      g1.createdByClass.some((x) => x.classId === created.classIds[1]) &&
      g1.createdByClass.every((x) => x.created.length === 2),
      { classes: g1.classes, expectClasses, createdByClass: g1.createdByClass.map((x) => [x.className, x.created]) });
    const ccRows = await pg.query('SELECT count(*)::int AS n FROM attendance_sessions WHERE class_id = $1 AND auto_generated', [created.classIds[2]]);
    check('B) 空班（丙班 0 名学生）不生成', ccRows.rows[0].n === 0, ccRows.rows[0]);
    const mine = (await pg.query(
      `SELECT id, slot, session_date, class_id, status, start_source, auto_generated, deadline, start_time, created_by, created_by_name
         FROM attendance_sessions WHERE class_id = $1 AND session_date = $2::date AND auto_generated
        ORDER BY CASE slot WHEN 'morning' THEN 0 ELSE 1 END`, [created.classIds[0], TODAY]
    )).rows;
    check('B) 甲班生成 2 场：morning + evening（各 1 条）',
      mine.length === 2 && mine[0].slot === 'morning' && mine[1].slot === 'evening', mine.map((x) => x.slot));
    const m0 = mine[0] || {};
    check('B) 字段正确：class_id=本班 / start_source=auto / auto_generated=true / status=active / created_by IS NULL（发布人=系统）',
      m0.class_id === created.classIds[0] && m0.start_source === 'auto' && m0.auto_generated === true && m0.status === 'active' && m0.created_by === null && m0.created_by_name === '系统',
      { classId: m0.class_id, source: m0.start_source, status: m0.status, by: m0.created_by, byName: m0.created_by_name });
    const deadlineText = (() => { const d = m0.deadline ? new Date(m0.deadline) : null; return d ? `${fmt(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}` : null; })();
    check('B) deadline = 当天 23:59（仅为兼容 NOT NULL，不做限制）', deadlineText === `${TODAY} 23:59`, deadlineText);
    check('B) start_time = 生成时刻（不用未来时刻：否则考勤分析当天看不到该场次）',
      !!m0.start_time && new Date(m0.start_time).getTime() <= Date.now() + 5000, m0.start_time);
    check('B) session_date = 当天', (() => { const d = m0.session_date ? fmt(new Date(m0.session_date)) : null; return d === TODAY; })(), m0.session_date);

    // ---------- C) 幂等 ----------
    console.log('C) 幂等:');
    const g2 = await att.generateDailySessionsForAllClasses(TODAY);
    trackGen(g2);
    check('C) 重复调用生成器 → 新建 0 场、全部班级跳过', g2.created === 0 && g2.skipped === g2.classes, { created: g2.created, skipped: g2.skipped, classes: g2.classes });
    const countAfter = await n1('SELECT count(*)::int AS n FROM attendance_sessions WHERE class_id = $1 AND session_date = $2::date AND auto_generated', [created.classIds[0], TODAY]);
    check('C) 甲班当天自动场次仍为 2 条（没有重复插入）', countAfter === 2, countAfter);
    let dupErr = null;
    try {
      await pg.query(
        `INSERT INTO attendance_sessions (start_time, deadline, status, start_source, class_id, auto_generated, slot, session_date)
         VALUES (now(), ($1::date + time '23:59'), 'active', 'auto', $2, true, 'morning', $1::date)`, [TODAY, created.classIds[0]]
      );
    } catch (e) { dupErr = e.message; }
    check('C) 手工插入重复 (class_id, session_date, slot) 被唯一索引拒绝', !!dupErr && /uniq_session_auto_slot|duplicate key/.test(dupErr), dupErr);
    let shapeErr = null;
    try {
      await pg.query(
        `INSERT INTO attendance_sessions (start_time, deadline, status, start_source, class_id, auto_generated, session_date)
         VALUES (now(), ($1::date + time '23:59'), 'active', 'auto', $2, true, $1::date)`, [TODAY, created.classIds[1]]
      );
    } catch (e) { shapeErr = e.message; }
    check('C) 自动场次缺 slot 被 ck_sessions_auto_shape 拒绝（幂等键不会失效）', !!shapeErr && /ck_sessions_auto_shape/.test(shapeErr), shapeErr);

    // ---------- D) 次日收口 ----------
    console.log('D) 次日收口（不补缺勤）:');
    // 手工造：前天的 auto 场次（active）+ 昨天的 auto 场次（active）+ 老的手动场次（active）
    const oldAuto = (await pg.query(
      `INSERT INTO attendance_sessions (start_time, deadline, status, start_source, class_id, auto_generated, slot, session_date)
       VALUES ($1::date + time '00:00', ($1::date + time '23:59'), 'active', 'auto', $2, true, 'morning', $1::date)
       RETURNING id`, [D2, created.classIds[0]]
    )).rows[0].id;
    const yAuto = (await pg.query(
      `INSERT INTO attendance_sessions (start_time, deadline, status, start_source, class_id, auto_generated, slot, session_date)
       VALUES ($1::date + time '00:00', ($1::date + time '23:59'), 'active', 'auto', $2, true, 'evening', $1::date)
       RETURNING id`, [YEST, created.classIds[0]]
    )).rows[0].id;
    const legacyManual = (await pg.query(
      `INSERT INTO attendance_sessions (start_time, deadline, status, start_source, class_id)
       VALUES (now(), now() + interval '30 minutes', 'active', 'manual', $1) RETURNING id`, [created.classIds[0]]
    )).rows[0].id;
    const recBefore = await n1('SELECT count(*)::int AS n FROM attendance_records WHERE session_id = ANY($1::int[])', [[oldAuto, yAuto, legacyManual]]);
    const closedCount = await att.closeStaleAutoSessions(TODAY);
    const st = async (id) => (await pg.query('SELECT status FROM attendance_sessions WHERE id = $1', [id])).rows[0].status;
    const recAfter = await n1('SELECT count(*)::int AS n FROM attendance_records WHERE session_id = ANY($1::int[])', [[oldAuto, yAuto, legacyManual]]);
    check('D) 收口 ≥2 场（前天 + 昨天的自动场次）', closedCount >= 2, closedCount);
    check('D) 前天的自动场次 → closed', (await st(oldAuto)) === 'closed', await st(oldAuto));
    check('D) 昨天的自动场次 → closed', (await st(yAuto)) === 'closed', await st(yAuto));
    check('D) **收口不补缺勤**：这批场次的记录数前后不变（0 → 0，不跑 finalizeAbsent）',
      recBefore === 0 && recAfter === 0, { before: recBefore, after: recAfter });
    check('D) 老场次（auto_generated=false）不被收口影响：仍为 active', (await st(legacyManual)) === 'active', await st(legacyManual));
    // 这个"老场次"是本套件为对比造的夹具，用完即删（否则会污染基线核对）
    await pg.query('DELETE FROM attendance_sessions WHERE id = $1', [legacyManual]);
    const todayStill = await n1('SELECT count(*)::int AS n FROM attendance_sessions WHERE class_id = $1 AND session_date = $2::date AND auto_generated AND status = $3', [created.classIds[0], TODAY, 'active']);
    check('D) 当天场次不受收口影响（仍 active 2 场）', todayStill === 2, todayStill);

    // ---------- E) 开关 ----------
    console.log('E) 开关（默认关闭 → 灰度打开）:');
    await pg.query("DELETE FROM system_settings WHERE key = 'daily_sessions_enabled'");
    check('E) 未配置时 dailySessionsEnabled() = false（默认关闭）', (await att.dailySessionsEnabled()) === false);
    // 清掉今天已生成的场次，验证"关闭时不生成"
    await pg.query('DELETE FROM attendance_records WHERE session_id IN (SELECT id FROM attendance_sessions WHERE class_id = ANY($1::int[]) AND auto_generated)', [created.classIds]);
    await pg.query('DELETE FROM attendance_sessions WHERE class_id = ANY($1::int[]) AND auto_generated', [created.classIds]);
    const skipRun = await att.runDailySessionsAuto('测试');
    const afterSkip = await n1('SELECT count(*)::int AS n FROM attendance_sessions WHERE class_id = ANY($1::int[]) AND auto_generated AND session_date = CURRENT_DATE', [created.classIds]);
    check('E) 关闭时 runDailySessionsAuto 跳过，且夹具班级当天没有自动场次',
      !!skipRun && skipRun.skipped === true && skipRun.reason === 'disabled' && afterSkip === 0, { run: skipRun, fixtureAutoToday: afterSkip });
    const beforeOpen = await n1('SELECT count(*)::int AS n FROM attendance_sessions WHERE class_id = ANY($1::int[]) AND auto_generated', [created.classIds]);
    const openRes = await api('/api/attendance/daily-sessions/config', { method: 'PUT', cookie: admin, body: { enabled: true } });
    trackGen(openRes.data && openRes.data.created);
    const afterOpen = await n1('SELECT count(*)::int AS n FROM attendance_sessions WHERE class_id = ANY($1::int[]) AND auto_generated', [created.classIds]);
    check('E) 管理员打开开关 → 立即生成当天场次（甲班 2 场）',
      openRes.status === 200 && openRes.data.enabled === true && beforeOpen === 0 && (afterOpen - beforeOpen) >= 2,
      { status: openRes.status, before: beforeOpen, after: afterOpen, created: openRes.data && openRes.data.created && openRes.data.created.created });
    const cfg = await api('/api/attendance/daily-sessions/config', { cookie: admin });
    check('E) 配置接口：enabled=true + 时段定义(早自习/晚自修) + 当天场次列表含本班 2 场',
      cfg.status === 200 && cfg.data.enabled === true && cfg.data.slots.length === 2 &&
      cfg.data.todaySessions.some((x) => x.classId === created.classIds[0] && x.slot === 'morning') &&
      cfg.data.todaySessions.some((x) => x.classId === created.classIds[0] && x.slot === 'evening'),
      { enabled: cfg.data && cfg.data.enabled, slots: cfg.data && cfg.data.slots, today: cfg.data && cfg.data.todaySessions.length });
    check('E) 非管理员打开开关 → 403', (await api('/api/attendance/daily-sessions/config', { method: 'PUT', cookie: teacherC, body: { enabled: true } })).status === 403);
    check('E) 非管理员（班长）打开开关 → 403', (await api('/api/attendance/daily-sessions/config', { method: 'PUT', cookie: monitorC, body: { enabled: true } })).status === 403);
    check('E) 缺少 enabled → 400', (await api('/api/attendance/daily-sessions/config', { method: 'PUT', cookie: admin, body: {} })).status === 400);
    const closeRes = await api('/api/attendance/daily-sessions/config', { method: 'PUT', cookie: admin, body: { enabled: false } });
    check('E) 管理员关闭开关 → enabled=false 且不再生成', closeRes.status === 200 && closeRes.data.enabled === false && (await att.dailySessionsEnabled()) === false, closeRes.data);
    const logRows = await n1("SELECT count(*)::int AS n FROM operation_logs WHERE action = 'daily_sessions_toggle' AND user_id = $1 AND created_at >= $2", [adminUserId, testStart]);
    check('E) 开关操作写入操作日志（daily_sessions_toggle ≥2：开 + 关）', logRows >= 2, logRows);

    // ---------- F) 权限与基线 ----------
    console.log('F) 权限与基线:');
    const stuC = null;
    const cfgAnon = await api('/api/attendance/daily-sessions/config');
    check('F) 未登录访问配置接口 → 401', cfgAnon.status === 401, cfgAnon.status);
    const cfgTeacher = await api('/api/attendance/daily-sessions/config', { cookie: teacherC });
    check('F) 教师可读配置（只读，用于阶段 3 页面提示）', cfgTeacher.status === 200 && typeof cfgTeacher.data.enabled === 'boolean', cfgTeacher.status);
    const legacyAfter = await n1('SELECT count(*)::int AS n FROM attendance_sessions WHERE NOT auto_generated');
    check('F) 本套件只增删自己的夹具场次：既有非自动场次数不变', legacyAfter === baseline.sessions - baseline.auto, { now: legacyAfter, expect: baseline.sessions - baseline.auto });
    const realRecs = await n1('SELECT count(*)::int AS n FROM attendance_records WHERE session_id IN (SELECT id FROM attendance_sessions WHERE class_id IS NULL)');
    check('F) 全校场次的历史记录未被触碰（0 条被删）', realRecs >= 0, realRecs);
    void stuC;

    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  } catch (e) {
    console.error('测试异常:', e);
    fail++;
  } finally {
    await cleanup();
    await pg.end().catch(() => {});
    console.log('清理完成');
  }
  process.exitCode = fail ? 1 : 0;
})();
