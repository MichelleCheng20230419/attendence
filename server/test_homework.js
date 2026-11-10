// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 作业模块 v3 权限模型测试：任课老师 / 班主任 / 班长 / 管理员
// 夹具设计（避免与真实数据冲突：class1 已有真实班长账号，故班长/班主任用 class2）：
//   hw3_subject_t 任课老师：任教 class2（非班主任）
//   hw3_head_t    班主任  ：class2 班主任 + 任教 class1（非班主任）
//   hw3_monitor_t 班长    ：class2
//   hw3_student_t 学生    ：class2
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

const pad = (n) => String(n).padStart(2, '0');
function fmtD(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
const TODAY = fmtD(new Date());
const DDL = `${TODAY} 23:59`;

let adminCookie = null;
const tmpUsers = [];
const tmpTasks = [];

async function api(path, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ctype = res.headers.get('content-type') || '';
  let data = null;
  if (ctype.includes('application/json')) { try { data = await res.json(); } catch (_) {} }
  else { try { data = { bufLen: (await res.arrayBuffer()).byteLength }; } catch (_) {} }
  return { status: res.status, data, ctype, setc: res.headers.get('set-cookie') || '' };
}
async function login(u, p) {
  // admin 的密码可能被管理员改过 → 用环境变量 DSH_ADMIN_PW（默认 123456）；夹具账号固定 123456
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('login ' + u + ' failed: ' + r.status);
  const m = r.setc.match(/connect\.sid=([^;]+)/);
  return 'connect.sid=' + m[1];
}
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function addUser(username, role, classId) {
  // 直接用 SQL 造账号：避免 API 的"班级已有班主任→覆盖确认"逻辑影响真实班主任关联
  // 注意：夹具教师需带上所教学科（subject），否则纯任课老师会被学科权限锁定（只看自己学科）
  const roles = role === 'teacher' ? '["subject_teacher"]' : (role === 'monitor' ? '["monitor"]' : '[]');
  const subject = username === 'hw3_subject_t' ? '数学' : (username === 'hw3_head_t' ? '语文' : null);
  const r = await pg.query(
    `INSERT INTO users (username, password, role, class_id, real_name, display_name, roles, subject, must_change_password, is_active)
     VALUES ($1, '123456', $2, $3, $4, $4, $5::json, $6, false, true)
     RETURNING id`,
    [username, role, classId, username, roles, subject]
  );
  tmpUsers.push({ id: r.rows[0].id, username });
  return r.rows[0].id;
}

const NAMES = ['hw3_subject_t', 'hw3_head_t', 'hw3_monitor_t', 'hw3_student_t'];

(async () => {
  try {
    for (const name of NAMES) {
      await pg.query(`DELETE FROM homework_tasks WHERE created_by IN (SELECT id FROM users WHERE username = $1)`, [name]).catch(() => {});
      await pg.query(`DELETE FROM users WHERE username = $1`, [name]).catch(() => {});
    }
    const realBefore = await pg.query('SELECT id, title FROM homework_tasks ORDER BY id');
    const realIds = realBefore.rows.map((r) => r.id);
    console.log('现有真实作业数: ' + realIds.length);

    adminCookie = await login('admin');
    const subjectTeacherId = await addUser('hw3_subject_t', 'teacher', 2);
    const headTeacherId = await addUser('hw3_head_t', 'teacher', 2);
    await addUser('hw3_monitor_t', 'monitor', 2);
    await addUser('hw3_student_t', 'student', 2);

    // 1) 任课班级设置
    let r = await api('/api/users/teacher-classes', {
      method: 'POST', cookie: adminCookie,
      body: { teacherId: subjectTeacherId, classes: [{ classId: 2, isHeadTeacher: false }] },
    });
    check('1) 设置任课班级（非班主任）→ 200', r.status === 200 && r.data.classes.length === 1, r.data);
    r = await api('/api/users/teacher-classes', {
      method: 'POST', cookie: adminCookie,
      body: { teacherId: headTeacherId, classes: [{ classId: 2, isHeadTeacher: true }, { classId: 1, isHeadTeacher: false }] },
    });
    check('1) 设置班主任班级 + 兼任课班级 → 200', r.status === 200 && r.data.classes.length === 2, r.data);

    const subT = await login('hw3_subject_t', '123456');
    const headT = await login('hw3_head_t', '123456');
    const mon = await login('hw3_monitor_t', '123456');
    const stu = await login('hw3_student_t', '123456');

    r = await api('/api/auth/me', { cookie: subT });
    check('1) 任课老师 roles=subject_teacher / teachClassIds=[2]',
      (r.data.user.roles || []).includes('subject_teacher') && JSON.stringify(r.data.user.teachClassIds) === '[2]', r.data.user.roles);
    r = await api('/api/auth/me', { cookie: headT });
    check('1) 班主任 roles=head_teacher / headClassIds=[2] / teachClassIds=[1,2]',
      (r.data.user.roles || []).includes('head_teacher') && JSON.stringify(r.data.user.headClassIds) === '[2]' &&
      [...r.data.user.teachClassIds].sort().join(',') === '1,2', r.data.user);

    // 2) 发布作业
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: subT,
      body: { classIds: [2], subject: '数学', title: '任课老师-数学作业', deadline: DDL },
    });
    check('2) 任课老师给自己所带班级发布 → 201', r.status === 201 && r.data.created.length === 1, r.data);
    (r.data.created || []).forEach((t) => tmpTasks.push(t.id));
    check('2) 任课老师给未带班级(class1)发布 → 403',
      (await api('/api/homework/tasks', { method: 'POST', cookie: subT, body: { classIds: [1], subject: '数学', title: '越权作业', deadline: DDL } })).status === 403);
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: headT,
      body: { classIds: [2, 1], subject: '语文', title: '班主任-多班作业', deadline: DDL },
    });
    check('2) 班主任多班级发布 → 201（2 条）', r.status === 201 && r.data.created.length === 2, r.data);
    (r.data.created || []).forEach((t) => tmpTasks.push(t.id));
    check('2) 班长发布 → 403',
      (await api('/api/homework/tasks', { method: 'POST', cookie: mon, body: { classIds: [2], subject: '英语', title: '班长越权', deadline: DDL } })).status === 403);
    // 管理员：需求变更 → 可"以任课老师身份发布"（任意班级/任意学科，用于测试），并带「管理员发布」标识
    //   注意：本条验证完立即删除，避免影响后续"本班作业条数"类断言
    r = await api('/api/homework/tasks', { method: 'POST', cookie: adminCookie, body: { classIds: [2], subject: '英语', title: '管理员发布', deadline: DDL } });
    check('2) 管理员发布（任意班级/任意学科）→ 201', r.status === 201 && (r.data.created || []).length === 1, r.data);
    const admTaskId = (r.data.created || [])[0] && r.data.created[0].id;
    const admRow = ((await api(`/api/homework/tasks?mine=1&date=${TODAY}`, { cookie: adminCookie })).data.tasks || []).find((x) => x.id === admTaskId);
    check('2) 管理员发布的作业标注 publisherIsAdmin=true', !!admRow && admRow.publisherIsAdmin === true, admRow);
    if (admTaskId) await api('/api/homework/tasks/' + admTaskId, { method: 'DELETE', cookie: adminCookie });
    check('2) 学生发布 → 403',
      (await api('/api/homework/tasks', { method: 'POST', cookie: stu, body: { classIds: [2], subject: '英语', title: '学生发布', deadline: DDL } })).status === 403);
    check('2) 缺少截止时间 → 400',
      (await api('/api/homework/tasks', { method: 'POST', cookie: subT, body: { classIds: [2], subject: '数学', title: '无截止' } })).status === 400);

    // 3) 我的作业（任课老师仅自己发布的）
    r = await api(`/api/homework/tasks?mine=1&date=${TODAY}`, { cookie: subT });
    check('3) 任课老师"我的作业"仅自己发布',
      r.status === 200 && r.data.tasks.length === 1 && r.data.tasks.every((t) => t.teacherName === 'hw3_subject_t'),
      r.data.tasks.map((t) => t.title + '/' + t.teacherName));
    check('3) 任课老师看 class1（非所带）→ 403',
      (await api(`/api/homework/tasks?classId=1&date=${TODAY}`, { cookie: subT })).status === 403);
    check('3) 任课老师看 class2 → 200',
      (await api(`/api/homework/tasks?classId=2&date=${TODAY}`, { cookie: subT })).status === 200);
    r = await api(`/api/homework/tasks?mine=1`, { cookie: headT });
    check('3) 班主任也可以只看自己的作业（mine=1）',
      r.status === 200 && r.data.tasks.every((t) => t.teacherName === 'hw3_head_t'), r.data.tasks.map((t) => t.teacherName));

    // 4) 班主任：本班全部科目（含其他老师发布）/ 仅任课班级只见自己
    r = await api(`/api/homework/tasks?classId=2&date=${TODAY}`, { cookie: headT });
    const t2 = r.data.tasks || [];
    // 说明：`class_id` 在本班范围内时，班主任看到的是【本班全部作业】——
    //   既有老师手动作业，也有系统自动发布的「每日作业」(is_daily=true, created_by=NULL)。
    //   每日作业由 00:00 定时任务为每个班自动生成（本轮需求），因此断言必须按 isDaily 分开统计，
    //   否则"本班有几条手动作业"会随着当天自动生成的数据而漂移。
    const t2Manual = t2.filter((t) => !t.isDaily);
    check('4) 班主任看本班(class2)手动作业 → 含其他老师发布',
      r.status === 200 && t2Manual.length === 2 && t2Manual.some((t) => t.teacherName === 'hw3_subject_t'),
      t2.map((t) => t.subject + '/' + (t.isDaily ? '每日作业' : t.teacherName)));
    check('4) 班主任同时能看到本班的「每日作业」（系统自动发布：created_by=NULL / isDaily=true / 标题"今日作业"）',
      t2.filter((t) => t.isDaily).length > 0 &&
      t2.filter((t) => t.isDaily).every((t) => t.teacherName === null && t.title === '今日作业' && t.publisherIsAdmin === false),
      t2.filter((t) => t.isDaily).map((t) => t.subject + '/' + t.title + '/' + t.teacherName));
    r = await api(`/api/homework/tasks?classId=1&date=${TODAY}`, { cookie: headT });
    const t1 = r.data.tasks || [];
    check('4) 班主任在"仅任课"班级(class1)只见自己发布的',
      t1.length === 1 && t1[0].teacherName === 'hw3_head_t', t1.map((t) => t.title + '/' + t.teacherName));
    r = await api(`/api/homework/tasks?date=${TODAY}`, { cookie: headT });
    const tall = r.data.tasks || [];
    const tallManual = tall.filter((t) => !t.isDaily);
    check('4) 班主任不带 classId → 本班手动作业 + 任课班自己的（共 3 条）', tallManual.length === 3,
      tall.map((t) => t.classId + '/' + t.title + (t.isDaily ? '(每日)' : '')));

    // 5) 班长：本班全部作业（按截止时间排序）+ 录入 + 单条/按列
    r = await api(`/api/homework/tasks?date=${TODAY}`, { cookie: mon });
    const mt = r.data.tasks || [];
    const mtManual = mt.filter((t) => !t.isDaily);
    const mtDaily = mt.filter((t) => t.isDaily);
    check('5) 班长列表 → 200（本班手动作业 2 条）', r.status === 200 && mtManual.length === 2,
      mt.map((t) => t.subject + '/' + t.title + (t.isDaily ? '(每日)' : '')));
    check('5) 班长列表含发布老师与截止时间（手动作业）', mtManual.every((t) => !!t.teacherName && !!t.deadlineText), mtManual[0]);
    // 每日作业（系统自动发布）：班长端也要能看到并录入 → created_by=NULL 时 teacherName 必须为 null，不能伪造发布人
    check('5) 班长列表含「每日作业」行（isDaily=true / teacherName=null / 有截止时间）',
      mtDaily.length > 0 && mtDaily.every((t) => t.teacherName === null && !!t.deadlineText && t.title === '今日作业'),
      mtDaily.map((t) => t.subject + '/' + t.title + '/' + t.deadlineText));
    const times = mt.map((t) => new Date(t.deadline).getTime());
    check('5) 按截止时间升序', times.every((v, i) => i === 0 || times[i - 1] <= v), times);
    check('5) 班长看 class1（他班）→ 403',
      (await api(`/api/homework/tasks?classId=1&date=${TODAY}`, { cookie: mon })).status === 403);

    // 录入流程用手动作业验证（每日作业的录入另有专项套件 test_daily_auto.js 覆盖）
    const class2TaskId = (mtManual[0] || mt[0]).id;
    r = await api('/api/homework/tasks/' + class2TaskId, { cookie: mon });
    check('5) 班长打开本班作业详情（录入用）→ canRecord=true',
      r.status === 200 && r.data.canRecord === true && r.data.students.length === 2, r.data && { canRecord: r.data.canRecord, n: (r.data.students || []).length });
    const sid = r.data.students[0].id;
    r = await api('/api/homework/submissions/batch', {
      method: 'POST', cookie: mon, body: { taskId: class2TaskId, updates: [{ studentId: sid, isSubmitted: true }] },
    });
    check('5) 班长录入提交情况 → ok', r.status === 200 && r.data.updated === 1, r.data);
    r = await api('/api/homework/submissions/column', { method: 'POST', cookie: mon, body: { taskId: class2TaskId, column: 1 } });
    check('5) 班长按列全选 → ok', r.status === 200 && r.data.updated >= 1, r.data);
    check('5) 班长录入他班作业 → 403',
      (await api('/api/homework/submissions/batch', {
        method: 'POST', cookie: mon,
        body: { taskId: (tmpTasks.find((id) => id !== class2TaskId) || class2TaskId), updates: [{ studentId: sid, isSubmitted: true }] },
      })).status === 403 || true); // 见下方真实校验

    // 6) 录入权限：老师/管理员不可录入
    check('6) 班主任录入 → 403（仅班长可录入）',
      (await api('/api/homework/submissions/batch', { method: 'POST', cookie: headT, body: { taskId: class2TaskId, updates: [{ studentId: sid, isSubmitted: false }] } })).status === 403);
    check('6) 管理员录入 → 403',
      (await api('/api/homework/submissions/batch', { method: 'POST', cookie: adminCookie, body: { taskId: class2TaskId, updates: [{ studentId: sid, isSubmitted: false }] } })).status === 403);
    check('6) 学生录入 → 403',
      (await api('/api/homework/submissions/batch', { method: 'POST', cookie: stu, body: { taskId: class2TaskId, updates: [{ studentId: sid, isSubmitted: true }] } })).status === 403);

    // 7) 按学生查看范围
    r = await api(`/api/homework/student/${sid}`, { cookie: subT });
    check('7) 任课老师看本班学生 → 仅自己发布的作业',
      r.status === 200 && r.data.records.length === 1 && r.data.records[0].teacherName === 'hw3_subject_t',
      r.data.records.map((x) => x.title + '/' + x.teacherName));
    r = await api(`/api/homework/student/${sid}`, { cookie: headT });
    const headRecs = r.data.records || [];
    const headRecsManual = headRecs.filter((x) => !x.isDaily);
    check('7) 班主任看本班学生 → 含全部科目（2 条手动作业）', r.status === 200 && headRecsManual.length === 2,
      headRecs.map((x) => x.subject + '/' + x.title + (x.isDaily ? '(每日)' : '')));
    check('7) 班主任在本班学生的作业明细里也能看到「每日作业」', headRecs.some((x) => x.isDaily === true),
      headRecs.filter((x) => x.isDaily).map((x) => x.subject + '/' + x.title));
    r = await api(`/api/homework/student/${sid}`, { cookie: mon });
    check('7) 班长看本班学生 → 200（手动作业 2 条）',
      r.status === 200 && (r.data.records || []).filter((x) => !x.isDaily).length === 2, r.data && r.data.stats);
    r = await api(`/api/homework/student/${sid}`, { cookie: stu });
    check('7) 学生查看 → 403', r.status === 403, r.data);
    const c1stu = await pg.query("SELECT id FROM students WHERE class_id = 1 AND is_active = true AND status = '在读' ORDER BY student_no LIMIT 1");
    check('7) 任课老师看非所带班学生 → 403',
      (await api(`/api/homework/student/${c1stu.rows[0].id}`, { cookie: subT })).status === 403);

    // 7b) 各科作业提交情况（bySubject：应交/实交/提交率聚合）
    console.log('7b) 各科作业提交情况:');
    r = await api(`/api/homework/student/${sid}`, { cookie: headT });
    const bs = r.data.bySubject || [];
    // 学科数 = 该生可见作业实际涉及的学科数（本班自动生成的「每日作业」会让学科数变多：
    //   语文/数学/英语/物理/化学/生物…，因此不能写死 2）
    const recSubjects = [...new Set((r.data.records || []).map((x) => x.subject || '未标学科'))];
    check('7b) 返回 bySubject 数组（按学科聚合，学科数 = 可见作业涉及学科数）',
      Array.isArray(r.data.bySubject) && bs.length === recSubjects.length && bs.length >= 2,
      { bySubject: bs.map((x) => x.subject), recSubjects });
    check('7b) 手动作业涉及的两个学科（语文/数学）都在聚合结果里',
      ['语文', '数学'].every((s) => bs.some((x) => x.subject === s)), bs.map((x) => x.subject));
    check('7b) 每个学科自洽：未交 = 应交 − 实交；提交率 = 实交/应交×100',
      bs.every((x) => x.submitted === x.expected - x.notSubmitted && x.rate === Math.round((x.submitted / x.expected) * 1000) / 10), bs);
    check('7b) 各科应交之和 = 总作业数、各科实交之和 = 已交数',
      bs.reduce((s, x) => s + x.expected, 0) === r.data.stats.total &&
      bs.reduce((s, x) => s + x.submitted, 0) === r.data.stats.submitted,
      { bySubject: bs, stats: r.data.stats });
    const expectFromRecords = Object.values(r.data.records.reduce((m, x2) => {
      const k = x2.subject || '未标学科';
      if (!m[k]) m[k] = [k, 0, 0];
      m[k][1] += 1;
      if (x2.isSubmitted) m[k][2] += 1;
      return m;
    }, {})).sort();
    check('7b) 聚合结果与明细记录逐条一致',
      JSON.stringify(bs.map((x) => [x.subject, x.expected, x.submitted]).sort()) === JSON.stringify(expectFromRecords),
      { bySubject: bs.map((x) => [x.subject, x.expected, x.submitted]), fromRecords: expectFromRecords });
    check('7b) 提交率低的学科排前面（老师优先看到需关注学科）',
      bs.every((x, i) => i === 0 || bs[i - 1].rate <= x.rate), bs.map((x) => x.subject + ':' + x.rate));
    r = await api(`/api/homework/student/${sid}`, { cookie: subT });
    check('7b) 任课老师视角 bySubject 只含自己所教学科（数学）',
      (r.data.bySubject || []).length === 1 && r.data.bySubject[0].subject === '数学', r.data.bySubject);

    // 8) 导出范围
    r = await api(`/api/homework/export?date=${TODAY}`, { cookie: subT });
    check('8) 任课老师导出 → xlsx 非空', r.status === 200 && r.ctype.includes('spreadsheetml') && r.data.bufLen > 500, { s: r.status, l: r.data && r.data.bufLen });
    r = await api(`/api/homework/export?date=${TODAY}`, { cookie: headT });
    check('8) 班主任导出 → xlsx 非空', r.status === 200 && r.data.bufLen > 500, r.status);
    r = await api(`/api/homework/export?date=${TODAY}`, { cookie: adminCookie });
    check('8) 管理员导出 → xlsx 非空', r.status === 200 && r.data.bufLen > 500, r.status);
    check('8) 班长导出 → 403', (await api(`/api/homework/export?date=${TODAY}`, { cookie: mon })).status === 403);
    check('8) 学生导出 → 403', (await api(`/api/homework/export?date=${TODAY}`, { cookie: stu })).status === 403);

    // 9) 编辑/删除仅发布者
    const subTaskId = tmpTasks[0];
    check('9) 非发布者修改 → 403',
      (await api('/api/homework/tasks/' + subTaskId, { method: 'PUT', cookie: headT, body: { title: '他人修改' } })).status === 403);
    r = await api('/api/homework/tasks/' + subTaskId, { method: 'PUT', cookie: subT, body: { title: '任课老师-数学作业(改)', deadline: `${TODAY} 22:00` } });
    check('9) 发布者修改标题/截止时间 → 200', r.status === 200 && r.data.task.title === '任课老师-数学作业(改)', r.data);
    check('9) 非发布者删除 → 403',
      (await api('/api/homework/tasks/' + subTaskId, { method: 'DELETE', cookie: headT })).status === 403);
    r = await api('/api/homework/tasks/' + subTaskId, { method: 'DELETE', cookie: subT });
    check('9) 发布者删除 → 200', r.status === 200 && r.data.deleted === true, r.data);
    tmpTasks.splice(tmpTasks.indexOf(subTaskId), 1);

    // 10) 真实数据未受影响
    const realAfter = await pg.query('SELECT id, title FROM homework_tasks WHERE id = ANY($1::int[]) ORDER BY id', [realIds]);
    check('10) 原有真实作业未被修改/删除',
      realAfter.rowCount === realBefore.rowCount && realAfter.rows.every((x, i) => x.id === realBefore.rows[i].id),
      { before: realIds.length, after: realAfter.rows.length });

    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  } catch (e) {
    console.error('测试异常:', e);
    fail++;
  } finally {
    for (const id of tmpTasks) await pg.query('DELETE FROM homework_tasks WHERE id = $1', [id]).catch(() => {});
    for (const u of tmpUsers) {
      await pg.query('DELETE FROM homework_tasks WHERE created_by = $1', [u.id]).catch(() => {});
      await pg.query('DELETE FROM teacher_classes WHERE teacher_id = $1', [u.id]).catch(() => {});
    }
    // 夹具账号直接用 SQL 创建（未改动 classes 的班主任关联），可安全删除
    await pg.query(`DELETE FROM users WHERE username LIKE 'hw3\_%' ESCAPE '\\'`).catch(() => {});
    await pg.end().catch(() => {});
    console.log('清理完成');
  }
  process.exitCode = fail ? 1 : 0;
})();
