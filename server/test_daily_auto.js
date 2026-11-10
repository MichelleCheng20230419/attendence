// ============================================================
// 「每日作业」自动发布 + 作业管理页可见性 测试
//   需求（本轮）：
//     1) 系统每天 0 点自动为【每个班】发布当天各科「每日作业」条目（不再依赖"打开页面才生成"）
//     2) 条目内容：学科=该班开设学科、标题「今日作业」、发布日期=当天、截止=当天配置的 HH:MM（默认 23:59）、
//        发布人=系统（created_by IS NULL + is_daily=true）、状态=待提交（班长未录入）
//     3) 班主任在「作业管理」页能看到当天各科作业（自动 + 手动并存），列表含 已交/未交/提交率，
//        点某科可看未交名单；班长录入后班主任端同步更新
//   覆盖：
//     A) 配置：每日作业截止时间可配置（默认 23:59；非法 400）+ 自动发布时间说明
//     B) 定时任务：generateDailyForAllClasses 为所有有在读学生的在读班级生成；幂等；科目随班级选科；
//        条目字段正确（title/created_by/is_daily/date/deadline=配置时间）；runDailyAutoPublish 写操作日志；
//        msUntilNextMidnight 计算正确（23:59 → 约 1 分钟；00:00 → 约 24 小时）
//     C) includeDaily 范围：班主任（自己发布 + 本班每日作业）/ 纯任课老师（只看自己学科）/ 班长（本班）/ 别班不可见
//     D) 自动 + 手动并存：同一天同一学科两条（一条每日作业、一条老师发布）
//     E) 班长录入后，班主任端查询即同步（recorded/submitted/未交名单）
//     F) 权限（学生/非管理员改配置 403）与基线核对
//   夹具：1 年级 + 2 班（理科 6 科 / 小理 2 选科 5 科）+ 学生 + 班主任/任课老师/班长账号；测完自愈清理
// 用法：node test_daily_auto.js（需服务已启动；管理员密码取 DSH_ADMIN_PW）
// ============================================================
'use strict';
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const hw = require('./src/routes/homework');   // 直接调用定时任务内部函数（不等 0 点）
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
async function login(u, p) {
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('登录失败 ' + u + ': ' + r.status);
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}
const n1 = async (sql, params = []) => (await pg.query(sql, params)).rows[0].n;
const today = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

const TAG = String(Date.now()).slice(-6);
const GRADE = '自动作业年级' + TAG;
const CA = '自动作业理科班' + TAG, CB = '自动作业小理班' + TAG;
const PRE = 'da_' + TAG + '_';
const created = { gradeId: null, classIds: [], userIds: [], studentIds: [] };
let admin = null, headT = null, subjT = null, mon = null, stu = null;
let deadlineBefore = null, subjectsBefore = null;

async function cleanup() {
  const warn = () => {};
  const cids = created.classIds.length ? created.classIds
    : (await pg.query('SELECT id FROM classes WHERE class_name LIKE $1', ['自动作业%班%'])).rows.map((r) => r.id);
  if (cids.length) {
    await pg.query('DELETE FROM homework_submissions WHERE task_id IN (SELECT id FROM homework_tasks WHERE class_id = ANY($1::int[]))', [cids]).catch(warn);
    await pg.query('DELETE FROM homework_tasks WHERE class_id = ANY($1::int[])', [cids]).catch(warn);
  }
  await pg.query("UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL WHERE head_teacher_id IN (SELECT id FROM users WHERE username LIKE $1) OR teacher_id IN (SELECT id FROM users WHERE username LIKE $1)", [PRE + '%']).catch(warn);
  await pg.query('DELETE FROM teacher_classes WHERE teacher_id IN (SELECT id FROM users WHERE username LIKE $1)', [PRE + '%']).catch(warn);
  await pg.query("SELECT purge_class(id) FROM classes WHERE class_name LIKE $1", ['自动作业%班%']).catch(warn);
  await pg.query('DELETE FROM users WHERE username LIKE $1', [PRE + '%']).catch(warn);
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(warn);
}
async function snapshot() {
  return {
    users: await n1('SELECT count(*)::int n FROM users'),
    grades: await n1('SELECT count(*)::int n FROM grades'),
    classes: await n1('SELECT count(*)::int n FROM classes'),
    students: await n1('SELECT count(*)::int n FROM students'),
    tasks: await n1('SELECT count(*)::int n FROM homework_tasks'),
    subs: await n1('SELECT count(*)::int n FROM homework_submissions'),
    settings: await n1('SELECT count(*)::int n FROM system_settings'),
  };
}

(async () => {
  try {
    await cleanup();
    const base = await snapshot();
    console.log('0) 夹具准备…');
    admin = await login('admin');
    // 备份全局配置（测完恢复）
    const cfgBefore = (await api('/api/homework/daily-subjects', { cookie: admin })).data;
    deadlineBefore = cfgBefore.deadlineTime;
    subjectsBefore = (cfgBefore.global || []).join(',');

    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'DA', academicYear: year } })).data.id;
    const mkClass = async (name, stream, electives) => {
      const r = await api('/api/classes', { method: 'POST', cookie: admin, body: { className: name, gradeId: created.gradeId, academicYear: year, stream, electiveSubjects: electives } });
      created.classIds.push(r.data.id);
      return r.data;
    };
    const sci = await mkClass(CA, '理科', []);                 // 6 科：语数英物化生
    const small = await mkClass(CB, '小理', ['物理', '地理']);  // 5 科：语数英物地
    const mkStudents = async (classId, prefix) => {
      const out = [];
      for (let i = 1; i <= 2; i += 1) {
        const r = await api('/api/students', { method: 'POST', cookie: admin, body: { studentNo: prefix + TAG + '0' + i, name: prefix + '同学' + i, classId, status: '在读' } });
        const id = r.data && (r.data.student ? r.data.student.id : r.data.id);
        out.push(id); created.studentIds.push(id);
      }
      return out;
    };
    const sciStudents = await mkStudents(sci.id, 'DAX');
    await mkStudents(small.id, 'DAY');
    // 账号：headT=理科班班主任；subjT=理科班任课(语文，非班主任)；mon=理科班班长；stu=理科班学生
    const mkUser = async (u, role, body) => {
      const r = await api('/api/users', { method: 'POST', cookie: admin, body: { username: u, password: '123456', role, realName: u, classId: sci.id, mustChangePassword: false, profileLocked: true, force: true, ...body } });
      created.userIds.push(r.data.user.id);
      return r.data.user.id;
    };
    await mkUser(PRE + 'head', 'teacher', { subject: '语文', teachingClasses: [{ classId: sci.id, roleInClass: 'head_teacher' }] });
    await mkUser(PRE + 'subj', 'teacher', { subject: '语文', teachingClasses: [{ classId: sci.id, roleInClass: 'subject_teacher' }] });
    await mkUser(PRE + 'mon', 'monitor', {});
    await mkUser(PRE + 'stu', 'student', {});
    headT = await login(PRE + 'head'); subjT = await login(PRE + 'subj'); mon = await login(PRE + 'mon'); stu = await login(PRE + 'stu');
    check('0) 夹具就绪（理科班 6 科 / 小理班 5 科 + 班主任/任课/班长/学生）',
      created.classIds.length === 2 && created.studentIds.length === 4 && !!headT && !!subjT && !!mon && !!stu,
      { classes: created.classIds, students: created.studentIds.length });

    // ---------- A) 配置：截止时间可配置 ----------
    console.log('A) 每日作业配置（截止时间可配置）:');
    let cfg = (await api('/api/homework/daily-subjects', { cookie: admin })).data;
    check('A) 接口返回截止时间（HH:MM）与自动发布时间说明（每天 0 点）',
      /^\d{2}:\d{2}$/.test(String(cfg.deadlineTime)) && cfg.deadlineDefault === '23:59' && /00:00/.test(cfg.autoPublishAt || ''),
      { t: cfg.deadlineTime, def: cfg.deadlineDefault, at: cfg.autoPublishAt });
    let r = await api('/api/homework/daily-subjects', { method: 'PUT', cookie: admin, body: { classId: null, subjects: cfg.global, deadlineTime: '25:00' } });
    check('A) 非法截止时间（25:00）→ 400', r.status === 400 && /HH:MM/.test(r.data.error), r.data);
    r = await api('/api/homework/daily-subjects', { method: 'PUT', cookie: admin, body: { classId: null, subjects: cfg.global, deadlineTime: '22:30' } });
    check('A) 改成 22:30 → 200 且返回新值', r.status === 200 && r.data.deadlineTime === '22:30', r.data && r.data.deadlineTime);
    r = await api('/api/homework/daily-subjects', { method: 'PUT', cookie: admin, body: { deadlineTime: '23:59' } });
    check('A) 只改截止时间（不带 subjects）→ 200', r.status === 200 && r.data.deadlineTime === '23:59', r.data && r.data.deadlineTime);
    check('A) 学生读配置 → 403；教师改配置 → 403',
      (await api('/api/homework/daily-subjects', { cookie: stu })).status === 403 &&
      (await api('/api/homework/daily-subjects', { method: 'PUT', cookie: headT, body: { classId: null, subjects: ['语文'] } })).status === 403);

    // ---------- B) 定时任务：为每个班生成当天条目 ----------
    console.log('B) 每天 0 点自动发布（定时任务）:');
    // 先把夹具班今天的条目清掉，模拟"0 点还没跑"
    await pg.query('DELETE FROM homework_submissions WHERE task_id IN (SELECT id FROM homework_tasks WHERE class_id = ANY($1::int[]))', [created.classIds]);
    await pg.query('DELETE FROM homework_tasks WHERE class_id = ANY($1::int[]) AND date = CURRENT_DATE', [created.classIds]);
    // 用可配置的截止时间验证（设 22:30 → 生成条目 deadline 应为 22:30）
    await api('/api/homework/daily-subjects', { method: 'PUT', cookie: admin, body: { classId: null, subjects: subjectsBefore.split(',') , deadlineTime: '22:30' } });
    const gen = await hw.generateDailyForAllClasses(today());
    check('B) 定时任务为所有"有在读学生的在读班级"生成（≥2 个班，含 2 个夹具班）',
      gen.date === today() && gen.classes >= 2 && gen.subjectsByClass.length === gen.classes, gen);
    const sciGen = gen.subjectsByClass.find((x) => x.classId === sci.id);
    const smallGen = gen.subjectsByClass.find((x) => x.classId === small.id);
    check('B) 理科班生成 6 科（语数英物化生）', !!sciGen && sciGen.subjects.join(',') === '语文,数学,英语,物理,化学,生物', sciGen);
    check('B) 小理班生成 5 科（语数英物地）', !!smallGen && smallGen.subjects.join(',') === '语文,数学,英语,物理,地理', smallGen);
    const rows = (await pg.query(
      `SELECT subject, title, date, deadline, created_by, is_daily, to_char(deadline, 'HH24:MI') AS hm
         FROM homework_tasks WHERE class_id = $1 AND date = CURRENT_DATE ORDER BY id`, [sci.id]
    )).rows;
    check('B) 条目字段：标题「今日作业」、发布人=系统（created_by IS NULL）、is_daily=true、发布日期=当天',
      rows.length === 6 && rows.every((x) => x.title === '今日作业' && x.created_by === null && x.is_daily === true), rows[0]);
    check('B) 截止时间 = 当天 + 配置的 22:30', rows.every((x) => x.hm === '22:30'), rows.map((x) => x.hm));
    const gen2 = await hw.generateDailyForAllClasses(today());
    check('B) 重复执行幂等（同一批班级全部已存在 → created=0）', gen2.created === 0, gen2.createdByClass);
    // runDailyAutoPublish：写操作日志（含日期/班级数/新建数）
    await pg.query('DELETE FROM homework_tasks WHERE class_id = ANY($1::int[]) AND date = CURRENT_DATE', [created.classIds]);
    const logsBefore = await n1("SELECT count(*)::int n FROM operation_logs WHERE action = 'daily_homework_auto'");
    const run = await hw.runDailyAutoPublish('单测');
    check('B) runDailyAutoPublish 正常返回（新建 ≥ 夹具 11 条）', !!run && run.created >= 11, run && run.created);
    check('B) 写入操作日志 daily_homework_auto',
      (await n1("SELECT count(*)::int n FROM operation_logs WHERE action = 'daily_homework_auto'")) === logsBefore + 1);
    // msUntilNextMidnight
    const ms2359 = hw.msUntilNextMidnight(new Date(2026, 8, 29, 23, 59, 0));
    const ms0000 = hw.msUntilNextMidnight(new Date(2026, 8, 29, 0, 0, 0));
    check('B) msUntilNextMidnight(23:59) ≈ 1 分钟（60~70 秒）', ms2359 >= 60000 && ms2359 <= 70000, ms2359);
    check('B) msUntilNextMidnight(00:00) ≈ 24 小时（23.9~24.1h）',
      ms0000 >= 23.9 * 3600000 && ms0000 <= 24.1 * 3600000, ms0000);
    await api('/api/homework/daily-subjects', { method: 'PUT', cookie: admin, body: { classId: null, subjects: subjectsBefore.split(','), deadlineTime: deadlineBefore || '23:59' } });

    // ---------- C) 作业管理页可见性（includeDaily） ----------
    console.log('C) 班主任在「作业管理」页看到当天各科（自动+手动）:');
    let list = await api(`/api/homework/tasks?date=${today()}&includeDaily=1`, { cookie: headT });
    const dailies = (list.data.tasks || []).filter((t) => t.isDaily);
    check('C) 班主任 + includeDaily：看到本班当天 6 条「每日作业」',
      list.status === 200 && dailies.length === 6 && dailies.every((t) => t.classId === sci.id), dailies.map((t) => t.subject));
    check('C) 每条带 已交/未交/提交率 所需字段（total/submitted/notSubmitted/recorded）',
      dailies.every((t) => typeof t.total === 'number' && typeof t.submitted === 'number' && Array.isArray(t.notSubmitted) && typeof t.recorded === 'boolean'),
      dailies[0]);
    check('C) 未录入时 recorded=false（前端显示"待提交"）', dailies.every((t) => t.recorded === false));
    const mineOnly = await api(`/api/homework/tasks?date=${today()}&mine=1`, { cookie: headT });
    check('C) 班主任 + mine=1（不带 includeDaily）→ 只有他自己发布的（此时 0 条）',
      (mineOnly.data.tasks || []).length === 0, (mineOnly.data.tasks || []).map((t) => t.title));
    const mineDaily = await api(`/api/homework/tasks?date=${today()}&mine=1&includeDaily=1`, { cookie: headT });
    check('C) 班主任 + mine=1&includeDaily=1 → 自己的 + 本班每日作业',
      (mineDaily.data.tasks || []).filter((t) => t.isDaily).length === 6, (mineDaily.data.tasks || []).length);
    // 纯任课老师（语文）：只看自己 + 本科每日作业
    const subjList = await api(`/api/homework/tasks?date=${today()}&includeDaily=1`, { cookie: subjT });
    const subjSubs = (subjList.data.tasks || []).map((t) => t.subject);
    check('C) 纯任课老师（语文）+ includeDaily：看到本班「语文」每日作业，且不越权看其它科',
      subjList.status === 200 && subjSubs.length === 1 && subjSubs[0] === '语文', subjSubs);
    // 班长：本班每日作业可见（mine + includeDaily）
    const monList = await api(`/api/homework/tasks?date=${today()}&mine=1&includeDaily=1`, { cookie: mon });
    check('C) 班长 + mine&includeDaily：看到本班 6 条每日作业',
      (monList.data.tasks || []).filter((t) => t.isDaily).length === 6, (monList.data.tasks || []).length);
    // 小理班班主任（用管理员指定 classId 核对科目随班级不同）
    const smallList = await api(`/api/homework/tasks?date=${today()}&includeDaily=1&classId=${small.id}`, { cookie: admin });
    check('C) 小理班（物理+地理）当天 5 科，且不含化学/生物',
      (smallList.data.tasks || []).length === 5 &&
      !(smallList.data.tasks || []).some((t) => ['化学', '生物'].includes(t.subject)),
      (smallList.data.tasks || []).map((t) => t.subject));

    // ---------- D) 自动 + 手动并存 ----------
    console.log('D) 自动作业与手动作业并存:');
    const pub = await api('/api/homework/tasks', {
      method: 'POST', cookie: headT,
      body: { classIds: [sci.id], subject: '语文', title: '【自动并存】手动作业' + TAG, deadline: `${today()} 21:00` },
    });
    check('D) 班主任手动发布一条语文作业 → 201', pub.status === 201, pub.data);
    const both = await api(`/api/homework/tasks?date=${today()}&includeDaily=1`, { cookie: headT });
    const chinese = (both.data.tasks || []).filter((t) => t.subject === '语文');
    check('D) 同一天同一学科：自动「每日作业」+ 手动作业 两条并存',
      chinese.length === 2 && chinese.some((t) => t.isDaily) && chinese.some((t) => !t.isDaily),
      chinese.map((t) => ({ title: t.title, daily: t.isDaily })));

    // ---------- E) 班长录入 → 班主任端同步 ----------
    console.log('E) 班长录入后班主任端同步:');
    const mathTask = (both.data.tasks || []).find((t) => t.isDaily && t.subject === '数学');
    const put = await api('/api/homework/submissions/batch', {
      method: 'POST', cookie: mon,
      body: { taskId: mathTask.id, updates: [{ studentId: sciStudents[0], isSubmitted: true }] },
    });
    check('E) 班长录入数学（1/2 已交）→ 200', put.status === 200 && put.data.updated === 1, put.data);
    const after = await api(`/api/homework/tasks?date=${today()}&includeDaily=1`, { cookie: headT });
    const mathAfter = (after.data.tasks || []).find((t) => t.id === mathTask.id);
    check('E) 班主任再查即同步：数学 recorded=true、已交 1、未交 1、未交名单含另 1 人',
      !!mathAfter && mathAfter.recorded === true && mathAfter.submitted === 1 && mathAfter.total === 2 &&
      mathAfter.notSubmitted.length === 1 && mathAfter.notSubmitted[0].id === sciStudents[1],
      mathAfter && { rec: mathAfter.recorded, sub: mathAfter.submitted, total: mathAfter.total, miss: mathAfter.notSubmitted });
    check('E) 未录入的其它科仍为 recorded=false（不会被误判为已交）',
      (after.data.tasks || []).filter((t) => t.isDaily && t.subject !== '数学').every((t) => t.recorded === false));
    check('E) 教师不能替班长录入（班主任录入 → 403）',
      (await api('/api/homework/submissions/batch', { method: 'POST', cookie: headT, body: { taskId: mathTask.id, updates: [{ studentId: sciStudents[1], isSubmitted: true }] } })).status === 403);

    // ---------- F) 清理与基线 ----------
    console.log('F) 清理与基线:');
    await cleanup();
    await api('/api/homework/daily-subjects', { method: 'PUT', cookie: admin, body: { classId: null, subjects: subjectsBefore.split(','), deadlineTime: deadlineBefore || '23:59' } });
    const after2 = await snapshot();
    check('F) 真实数据行数回到用例前（users/grades/classes/students/tasks/subs/settings）',
      JSON.stringify(base) === JSON.stringify(after2), { base, after: after2 });
    check('F) 夹具已清理（班级/学生/账号/年级/作业）',
      (await n1('SELECT count(*)::int n FROM classes WHERE class_name LIKE $1', ['自动作业%班%'])) === 0 &&
      (await n1('SELECT count(*)::int n FROM users WHERE username LIKE $1', [PRE + '%'])) === 0 &&
      (await n1('SELECT count(*)::int n FROM grades WHERE grade_name = $1', [GRADE])) === 0);
    const cfgAfter = (await api('/api/homework/daily-subjects', { cookie: admin })).data;
    check('F) 全局配置已恢复（科目与截止时间）',
      cfgAfter.global.join(',') === subjectsBefore && cfgAfter.deadlineTime === (deadlineBefore || '23:59'),
      { subjects: cfgAfter.global.join(','), deadline: cfgAfter.deadlineTime });
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
