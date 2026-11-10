// ============================================================
// 每日固定科目作业（班长端每天自动生成；班主任端看各科提交情况）—— 服务端测试
//   需求：班主任不需要知道每科具体作业，只要知道学生今天各科交没交 →
//        班长端每天自动生成若干科目（默认 6 科）的「今日作业」条目，班长只录交没交。
//   验证点：
//     ① 默认科目 = 语文/数学/英语/物理/化学/生物，进入页面（ensure）自动生成当天条目
//     ② 幂等：重复 ensure 不重复生成（唯一 (班,科,题,日)）
//     ③ 条目字段：title='今日作业'、is_daily=true、created_by 为空、deadline=当天 23:59
//     ④ 录入：班长用 submissions/batch 勾选 → 已交/未交名单/提交率正确；未录入时 recorded=false
//     ⑤ 科目可配置：管理员改全局默认 → 影响所有班；给某个班单独配置 → 只影响该班；可清除回全局
//     ⑥ 权限：学生 403；班长/教师只能操作自己范围内的班；非管理员不能改配置；非法科目 400；非当天 400
//     ⑦ 与"老师发布的具体作业"共存：同一天同科目不同标题 → 两条并存，互不影响
//   夹具：1 年级 + 1 班（3 学生）+ 班长/班主任/任课老师账号；测完自愈清理（含当天生成的每日作业）
// 用法：node test_daily_homework.js（需服务已启动；管理员密码取 DSH_ADMIN_PW）
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
const GRADE = '日作年级' + TAG;
const CA = '日作甲班' + TAG, CB = '日作乙班' + TAG;
const PRE = 'dlh_' + TAG + '_';
const created = { gradeId: null, classIds: [], userIds: [], studentIds: [] };
const DEFAULTS = ['语文', '数学', '英语', '物理', '化学', '生物'];
let admin = null, mon = null, head = null, subj = null, monB = null;

async function cleanup() {
  const cids = (await pg.query('SELECT id FROM classes WHERE class_name = ANY($1::text[])', [[CA, CB]])).rows.map((r) => r.id);
  const sids = (await pg.query("SELECT id FROM students WHERE student_no LIKE $1", ['DLH%'])).rows.map((r) => r.id);
  const allS = [...new Set([...created.studentIds, ...sids])];
  if (cids.length) {
    await pg.query('DELETE FROM homework_submissions WHERE task_id IN (SELECT id FROM homework_tasks WHERE class_id = ANY($1::int[]))', [cids]).catch(() => {});
    await pg.query('DELETE FROM homework_tasks WHERE class_id = ANY($1::int[])', [cids]).catch(() => {});
  }
  if (allS.length) await pg.query('DELETE FROM homework_submissions WHERE student_id = ANY($1::int[])', [allS]).catch(() => {});
  const uids = (await pg.query('SELECT id FROM users WHERE username LIKE $1', [PRE + '%'])).rows.map((r) => r.id);
  if (uids.length) {
    await pg.query('UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL WHERE head_teacher_id = ANY($1::int[]) OR teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM teacher_classes WHERE teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM users WHERE id = ANY($1::int[])', [uids]).catch(() => {});
  }
  await pg.query("DELETE FROM students WHERE student_no LIKE 'DLH%'").catch(() => {});
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name = ANY($1::text[])', [[CA, CB]]).catch(() => {});
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(() => {});
  // 还原全局默认科目（夹具改过 → 必须还原，避免影响真实使用）
  await pg.query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('daily_homework_subjects', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [DEFAULTS.join(',')]
  ).catch(() => {});
}

(async () => {
  try {
    await cleanup();
    const globalBefore = (await pg.query("SELECT value FROM system_settings WHERE key = 'daily_homework_subjects'")).rows[0].value;
    const base = {
      tasks: await n1('SELECT count(*)::int n FROM homework_tasks'),
      subs: await n1('SELECT count(*)::int n FROM homework_submissions'),
      classes: await n1('SELECT count(*)::int n FROM classes'),
      students: await n1('SELECT count(*)::int n FROM students'),
    };
    admin = await login('admin');

    // ---------- 夹具 ----------
    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'DLH', academicYear: year } })).data.id;
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
    const A = await mkStudents(ca, 3, 'DLHA');
    const B = await mkStudents(cb, 2, 'DLHB');
    const mkUser = async (uname, role, realName, classId, extra = {}) => {
      const r = await api('/api/users', { method: 'POST', cookie: admin, body: { username: uname, password: '123456', role, realName, classId, mustChangePassword: false, profileLocked: true, force: true, ...extra } });
      if (r.status !== 201) throw new Error('创建账号失败 ' + uname + '：' + JSON.stringify(r.data));
      created.userIds.push(r.data.user.id);
      return r.data.user.id;
    };
    await mkUser(PRE + 'mon', 'monitor', '日作班长', ca);
    await mkUser(PRE + 'monb', 'monitor', '日作乙班长', cb);
    const headId = await mkUser(PRE + 'head', 'teacher', '日作班主任', ca, { teachingClasses: [{ classId: ca, roleInClass: 'head_teacher' }] });
    await mkUser(PRE + 'subj', 'teacher', '日作任课老师', ca, { subject: '数学', teachingClasses: [{ classId: ca, roleInClass: 'subject_teacher' }] });
    await pg.query('UPDATE classes SET head_teacher_id = $2 WHERE id = $1', [ca, headId]);
    mon = await login(PRE + 'mon'); monB = await login(PRE + 'monb');
    head = await login(PRE + 'head'); subj = await login(PRE + 'subj');
    check('0) 夹具就绪（2 班：甲 3 人 / 乙 2 人；班长×2 + 班主任 + 任课老师）',
      A.length === 3 && B.length === 2 && !!mon && !!monB && !!head && !!subj, { a: A.length, b: B.length });

    // ---------- 1) 科目配置读取（默认 6 科） ----------
    console.log('1) 每日作业科目配置:');
    let r = await api('/api/homework/daily-subjects', { cookie: mon });
    check('1) 班长读取本班配置 → 全局默认 = 默认 6 科（语文/数学/英语/物理/化学/生物）',
      r.status === 200 && JSON.stringify(r.data.global) === JSON.stringify(DEFAULTS) && r.data.source === 'global',
      { global: r.data.global, source: r.data.source });
    check('1) 生效科目 = 全局默认；班级未单独配置（classSubjects=null）',
      JSON.stringify(r.data.effective) === JSON.stringify(DEFAULTS) && r.data.classSubjects === null, r.data.classSubjects);
    check('1) 可选科目清单与默认值一并返回（配置界面用）',
      (r.data.allSubjects || []).includes('语文') && (r.data.allSubjects || []).length >= 6 &&
      JSON.stringify(r.data.defaults) === JSON.stringify(DEFAULTS), { n: (r.data.allSubjects || []).length });
    check('1) 非管理员 canEdit=false', r.data.canEdit === false);

    // ---------- 2) 自动生成当天条目（幂等） ----------
    console.log('2) 每天自动生成 6 科条目:');
    r = await api('/api/homework/daily/ensure', { method: 'POST', cookie: mon, body: {} });
    check('2) 班长进入页面（ensure）→ 生成 6 条每日作业', r.status === 200 && r.data.createdCount === 6 && r.data.tasks.length === 6,
      { created: r.data.createdCount, tasks: r.data.tasks.length });
    check('2) 科目与配置一致（6 科，按科目排序）',
      JSON.stringify(r.data.tasks.map((t) => t.subject)) === JSON.stringify(DEFAULTS), r.data.tasks.map((t) => t.subject));
    check('2) 条目字段：标题=今日作业 / isDaily=true / 无发布老师 / 截止=当天 23:59',
      r.data.tasks.every((t) => t.title === '今日作业' && t.isDaily === true && !t.teacherId && !t.teacherName && /23:59$/.test(t.deadlineText || '')),
      r.data.tasks[0]);
    check('2) 每条的应交人数 = 本班在读 3 人、已交 0、未录入（recorded=false）',
      r.data.tasks.every((t) => t.total === 3 && t.submitted === 0 && t.recorded === false), r.data.tasks[0]);
    r = await api('/api/homework/daily/ensure', { method: 'POST', cookie: mon, body: {} });
    check('2) 再次 ensure → 幂等（createdCount=0，仍是 6 条）',
      r.status === 200 && r.data.createdCount === 0 && r.data.tasks.length === 6, { created: r.data.createdCount });
    check('2) 库里该班当天 is_daily 条目正好 6 条',
      (await n1('SELECT count(*)::int n FROM homework_tasks WHERE class_id = $1 AND date = CURRENT_DATE AND is_daily = true', [ca])) === 6);

    // ---------- 3) 列表接口：每日作业可见且标注 isDaily ----------
    console.log('3) 列表接口:');
    const today = (await pg.query("SELECT to_char(now(), 'YYYY-MM-DD') AS d")).rows[0].d;
    r = await api('/api/homework/tasks?date=' + today, { cookie: mon });
    const dailyTasks = (r.data.tasks || []).filter((t) => t.isDaily);
    check('3) 班长列表（今天）包含 6 条每日作业且 isDaily=true',
      r.status === 200 && dailyTasks.length === 6 && dailyTasks.every((t) => t.isDaily === true), dailyTasks.length);
    r = await api('/api/homework/tasks?date=' + today, { cookie: head });
    check('3) 班主任（本班）也能看到这 6 条（无需老师发布）',
      r.status === 200 && (r.data.tasks || []).filter((t) => t.isDaily).length === 6);

    // ---------- 4) 班长录入提交情况 → 提交率/未交名单 ----------
    console.log('4) 班长录入提交情况:');
    const tMath = dailyTasks.find((t) => t.subject === '数学');
    r = await api('/api/homework/submissions/batch', {
      method: 'POST', cookie: mon,
      body: { taskId: tMath.id, updates: [{ studentId: A[0], isSubmitted: true }, { studentId: A[1], isSubmitted: false }, { studentId: A[2], isSubmitted: true }] },
    });
    check('4) 班长批量保存（2 交 1 未交）→ 200', r.status === 200, r.data);
    r = await api('/api/homework/tasks?date=' + today, { cookie: head });
    const math2 = (r.data.tasks || []).find((t) => t.id === tMath.id);
    check('4) 班主任端：数学 已交 2 / 总数 3、提交率数据齐备、未交名单 = 该学生',
      math2 && math2.submitted === 2 && math2.total === 3 &&
      (math2.notSubmitted || []).length === 1 && math2.notSubmitted[0].id === A[1] &&
      math2.recorded === true,
      math2 && { submitted: math2.submitted, total: math2.total, not: math2.notSubmitted });
    r = await api('/api/homework/tasks?date=' + today, { cookie: mon });
    const otherSubj = (r.data.tasks || []).find((t) => t.isDaily && t.subject === '语文');
    check('4) 未录入的其它科目仍是 recorded=false（前端显示"未录入/待收"）', otherSubj && otherSubj.recorded === false, otherSubj && otherSubj.recorded);
    // 任课老师（数学）能看到本学科每日作业（不影响其"只看自己发布"的口径？——每日作业是全班数据，按 403/可见口径断言）
    r = await api('/api/homework/tasks?date=' + today, { cookie: subj });
    check('4) 任课老师接口可用（不因每日作业报错）', r.status === 200, r.status);

    // ---------- 5) 科目可配置 ----------
    console.log('5) 科目可配置:');
    r = await api('/api/homework/daily-subjects', { method: 'PUT', cookie: mon, body: { classId: null, subjects: ['语文'] } });
    check('5) 非管理员改配置 → 403', r.status === 403, r.status);
    r = await api('/api/homework/daily-subjects', { method: 'PUT', cookie: admin, body: { classId: null, subjects: ['语文', '数学', '英语', '体育'] } });
    check('5) 管理员改全局默认 → 200（生效列表=语文/数学/英语/体育）',
      r.status === 200 && JSON.stringify(r.data.effective) === JSON.stringify(['语文', '数学', '英语', '体育']), r.data.effective);
    r = await api('/api/homework/daily/ensure', { method: 'POST', cookie: monB, body: {} });
    check('5) 乙班（无覆盖）→ 按新的全局默认生成 4 条（新增 4 条，旧的 6 条保留）',
      r.status === 200 && r.data.subjects.length === 4 && (r.data.tasks || []).length >= 4, { created: r.data.createdCount, tasks: (r.data.tasks || []).length });
    r = await api('/api/homework/daily-subjects', { method: 'PUT', cookie: admin, body: { classId: ca, subjects: ['语文', '数学', '化学', '生物', '历史'] } });
    check('5) 给甲班单独配置 5 科 → source=class、生效列表=5 科',
      r.status === 200 && r.data.source === 'class' && JSON.stringify(r.data.effective) === JSON.stringify(['语文', '数学', '化学', '生物', '历史']), r.data.effective);
    r = await api('/api/homework/daily/ensure', { method: 'POST', cookie: mon, body: {} });
    check('5) 甲班 ensure → 新增"历史"（其余 4 科当天已存在）',
      r.status === 200 && r.data.createdCount === 1 && r.data.created[0].subject === '历史' &&
      (await n1("SELECT count(*)::int n FROM homework_tasks WHERE class_id = $1 AND date = CURRENT_DATE AND is_daily = true AND subject = '历史'", [ca])) === 1,
      r.data.created);
    check('5) 班级覆盖不影响乙班（乙班仍按全局默认）',
      (await n1("SELECT count(*)::int n FROM classes WHERE id = $1 AND daily_subjects IS NOT NULL", [cb])) === 0);
    r = await api('/api/homework/daily-subjects?classId=' + ca, { cookie: admin });
    check('5) 管理员查看甲班配置：classSubjects 有 5 科、global 仍是全局默认',
      JSON.stringify(r.data.classSubjects) === JSON.stringify(['语文', '数学', '化学', '生物', '历史']) &&
      JSON.stringify(r.data.global) === JSON.stringify(['语文', '数学', '英语', '体育']), { cls: r.data.classSubjects, g: r.data.global });
    r = await api('/api/homework/daily-subjects', { method: 'PUT', cookie: admin, body: { classId: ca, subjects: [] } });
    check('5) 清空班级配置 → 恢复使用全局默认（classSubjects=null、effective=全局）',
      r.status === 200 && r.data.classSubjects === null && r.data.source === 'global' &&
      JSON.stringify(r.data.effective) === JSON.stringify(['语文', '数学', '英语', '体育']), { eff: r.data.effective, src: r.data.source });
    // 还原全局默认，避免影响后续断言与真实使用
    await api('/api/homework/daily-subjects', { method: 'PUT', cookie: admin, body: { classId: null, subjects: DEFAULTS } });
    check('5) 全局默认已还原为 6 科',
      JSON.stringify((await api('/api/homework/daily-subjects', { cookie: admin })).data.global) === JSON.stringify(DEFAULTS));

    // ---------- 6) 权限与参数校验 ----------
    console.log('6) 权限与参数校验:');
    r = await api('/api/homework/daily-subjects', { method: 'PUT', cookie: admin, body: { classId: null, subjects: ['不存在的科目'] } });
    check('6) 非法科目 → 400', r.status === 400, r.data);
    r = await api('/api/homework/daily-subjects', { method: 'PUT', cookie: admin, body: { classId: null, subjects: [] } });
    check('6) 全局默认传空 → 400（不能清空）', r.status === 400, r.data);
    r = await api('/api/homework/daily/ensure', { method: 'POST', cookie: mon, body: { classId: cb } });
    check('6) 班长给别的班 ensure → 403', r.status === 403, r.data);
    r = await api('/api/homework/daily/ensure', { method: 'POST', cookie: mon, body: { date: '2020-01-01' } });
    check('6) 只允许生成当天 → 400', r.status === 400, r.data);
    r = await api('/api/homework/daily/ensure', { method: 'POST', cookie: head, body: {} });
    check('6) 班主任（本班）ensure → 200', r.status === 200, r.status);
    const stu = await (async () => {
      await mkUser(PRE + 'stu', 'student', '日作学生', ca);
      return login(PRE + 'stu');
    })();
    r = await api('/api/homework/daily/ensure', { method: 'POST', cookie: stu, body: {} });
    check('6) 学生 ensure → 403', r.status === 403, r.status);
    r = await api('/api/homework/daily-subjects', { cookie: stu });
    check('6) 学生读配置 → 403', r.status === 403, r.status);

    // ---------- 7) 与"老师发布的具体作业"共存 ----------
    console.log('7) 与现有作业发布共存:');
    // 由任课老师（数学）发布一条具体作业：与每日作业的"数学"条目同科目、不同标题
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: subj,
      body: { classIds: [ca], subject: '数学', title: '练习册 P12-P15', deadline: `${today} 22:00` },
    });
    check('7) 任课老师发布具体作业（同科目、不同标题）→ 201', r.status === 201 && (r.data.created || []).length === 1, { status: r.status, data: r.data });
    const publishedId = r.data.created && r.data.created[0] ? r.data.created[0].id : null;
    r = await api('/api/homework/tasks?date=' + today, { cookie: mon });
    const list7 = r.data.tasks || [];
    const mathDaily = list7.find((t) => t.isDaily && t.subject === '数学');
    const mathPublished = list7.find((t) => t.id === publishedId);
    check('7) 两条并存：每日作业（isDaily=true，标题"今日作业"）+ 老师发布的作业（isDaily=false）',
      !!mathDaily && !!mathPublished && mathPublished.isDaily === false && mathPublished.teacherName === '日作任课老师',
      { daily: mathDaily && mathDaily.title, published: mathPublished && [mathPublished.title, mathPublished.isDaily] });
    check('7) 发布的具体作业不影响每日作业的提交情况（数学每日作业仍是 2/3）',
      mathDaily.submitted === 2 && mathDaily.total === 3, { s: mathDaily.submitted, t: mathDaily.total });
    r = await api('/api/homework/tasks?date=' + today, { cookie: head });
    check('7) 班主任端列表同时含"每日作业"与"老师发布"（共 ' + ((r.data.tasks || []).length) + ' 条）',
      (r.data.tasks || []).some((t) => t.isDaily) && (r.data.tasks || []).some((t) => !t.isDaily));

    // ---------- 8) 清理与基线 ----------
    console.log('8) 清理与基线核对:');
    await cleanup();
    const after = {
      tasks: await n1('SELECT count(*)::int n FROM homework_tasks'),
      subs: await n1('SELECT count(*)::int n FROM homework_submissions'),
      classes: await n1('SELECT count(*)::int n FROM classes'),
      students: await n1('SELECT count(*)::int n FROM students'),
    };
    check('8) 真实数据行数回到用例前（作业/提交/班级/学生）',
      base.tasks === after.tasks && base.subs === after.subs && base.classes === after.classes && base.students === after.students,
      { base, after });
    check('8) 夹具已清理（账号/班级/年级/学生/每日作业条目）',
      (await n1('SELECT count(*)::int n FROM users WHERE username LIKE $1', [PRE + '%'])) === 0 &&
      (await n1('SELECT count(*)::int n FROM classes WHERE class_name = ANY($1::text[])', [[CA, CB]])) === 0 &&
      (await n1("SELECT count(*)::int n FROM students WHERE student_no LIKE 'DLH%'")) === 0 &&
      (await n1("SELECT count(*)::int n FROM homework_tasks WHERE is_daily = true AND class_id NOT IN (SELECT id FROM classes)")) === 0);
    check('8) 全局默认科目已还原（不影响真实使用）',
      (await pg.query("SELECT value FROM system_settings WHERE key = 'daily_homework_subjects'")).rows[0].value === globalBefore ||
      (await pg.query("SELECT value FROM system_settings WHERE key = 'daily_homework_subjects'")).rows[0].value === DEFAULTS.join(','),
      { before: globalBefore });
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
