// ============================================================
// 作业发布「学科自动带出且不可修改」测试（后端兜底）
//   规则：教师发布作业的学科必须等于其在该班的所教学科
//     · 不符 → 403「学科不可修改：你只能发布所教学科（X）的作业」
//     · 未绑定学科 → 400「请先到个人中心绑定所教学科」
//     · 班主任同样受限（学科取自 users.subject / 该班学科）
//     · 非本班班级 → 403（原有规则不变）；管理员不发布（原有规则不变）
// 夹具：临时班级/年级 + 3 名临时教师（物理任课两班 / 无学科 / 班主任）+ 临时作业；测完清理
// ============================================================
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

const pad = (n) => String(n).padStart(2, '0');
const d0 = new Date();
const TODAY = `${d0.getFullYear()}-${pad(d0.getMonth() + 1)}-${pad(d0.getDate())}`;
const DDL = `${TODAY} 23:59`;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function api(path, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data, setc: res.headers.get('set-cookie') || '' };
}
async function login(u, p) {
  // admin 的密码可能被管理员改过 → 用环境变量 DSH_ADMIN_PW（默认 123456）；夹具账号固定 123456
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('login ' + u + ' failed: ' + r.status);
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}

const TAG = String(Date.now()).slice(-6);
const GRADE = '发布学科测试年级' + TAG;
const C1 = '发布学科测试A班' + TAG;
const C2 = '发布学科测试B班' + TAG;
const PRE = 'psub_' + TAG + '_';
const created = { gradeId: null, classIds: [], userIds: [], taskIds: [] };

async function cleanup() {
  const uids = (await pg.query('SELECT id FROM users WHERE username LIKE $1', [PRE + '%'])).rows.map((r) => r.id);
  if (uids.length) {
    await pg.query('DELETE FROM homework_submissions WHERE task_id IN (SELECT id FROM homework_tasks WHERE created_by = ANY($1::int[]))', [uids]).catch(() => {});
    await pg.query('DELETE FROM homework_tasks WHERE created_by = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL WHERE head_teacher_id = ANY($1::int[]) OR teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM teacher_classes WHERE teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM users WHERE id = ANY($1::int[])', [uids]).catch((e) => console.log('  · 清理账号失败：', e.message));
  }
  if (created.taskIds.length) await pg.query('DELETE FROM homework_tasks WHERE id = ANY($1::int[])', [created.taskIds]).catch(() => {});
  await pg.query('DELETE FROM homework_tasks WHERE title LIKE $1', ['PSUB%' + TAG]).catch(() => {});
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name = ANY($1::text[])', [[C1, C2]]).catch(() => {});
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(() => {});
}

(async () => {
  try {
    await cleanup();
    const base = {
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
      classes: (await pg.query('SELECT count(*)::int n FROM classes')).rows[0].n,
      tasks: (await pg.query('SELECT count(*)::int n FROM homework_tasks')).rows[0].n,
      tc: (await pg.query('SELECT count(*)::int n FROM teacher_classes')).rows[0].n,
    };
    const cAdmin = await login('admin');

    // 夹具：年级 + 2 个班级
    const year = (await api('/api/settings', { cookie: cAdmin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: cAdmin, body: { gradeName: GRADE, gradeCode: 'PSB', academicYear: year } })).data.id;
    const c1 = (await api('/api/classes', { method: 'POST', cookie: cAdmin, body: { className: C1, gradeName: GRADE, academicYear: year } })).data.id;
    const c2 = (await api('/api/classes', { method: 'POST', cookie: cAdmin, body: { className: C2, gradeName: GRADE, academicYear: year } })).data.id;
    created.classIds = [c1, c2];

    // 教师甲：物理，任课 A/B 两班；教师乙：无学科，任课 A 班；教师丙：班主任（语文，A 班班主任）
    let r = await api('/api/users', {
      method: 'POST', cookie: cAdmin,
      body: {
        username: PRE + 'phys', password: '123456', role: 'teacher', realName: '物理老师', subject: '物理',
        teachingClasses: [{ classId: c1, roleInClass: 'subject_teacher' }, { classId: c2, roleInClass: 'subject_teacher' }],
      },
    });
    check('0) 创建物理教师（A/B 两班任课）→ 201', r.status === 201, r.data);
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', {
      method: 'POST', cookie: cAdmin,
      body: { username: PRE + 'nosub', password: '123456', role: 'teacher', realName: '无学科老师', teachingClasses: [{ classId: c1, roleInClass: 'subject_teacher' }] },
    });
    check('0) 创建无学科教师（A 班任课）→ 201', r.status === 201, r.data);
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', {
      method: 'POST', cookie: cAdmin,
      body: { username: PRE + 'head', password: '123456', role: 'teacher', realName: '班主任语文老师', subject: '语文', teachingClasses: [{ classId: c1, roleInClass: 'head_teacher' }] },
    });
    check('0) 创建班主任教师（语文，A 班班主任）→ 201', r.status === 201, r.data);
    created.userIds.push(r.data.user.id);

    const cPhys = await login(PRE + 'phys');
    const cNosub = await login(PRE + 'nosub');
    const cHead = await login(PRE + 'head');

    // 1) 前端自动带出（接口口径）：教师学科 = 物理
    r = await api('/api/teacher/subject', { cookie: cPhys });
    check('1) GET /api/teacher/subject 返回绑定学科=物理（前端据此自动带出）',
      r.status === 200 && r.data.subject === '物理', r.data);
    r = await api('/api/teacher/classes', { cookie: cPhys });
    check('1) GET /api/teacher/classes 返回 2 个所带班级（前端默认全选）',
      r.status === 200 && (r.data.classes || []).length === 2 && (r.data.classIds || []).length === 2, r.data.classIds);

    // 2) 用绑定学科发布 → 成功（两个班）
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: cPhys,
      body: { classIds: [c1, c2], subject: '物理', title: 'PSUB-物理两班' + TAG, deadline: DDL },
    });
    check('2) 用所教学科发布到两个班级 → 201 且 2 条', r.status === 201 && (r.data.created || []).length === 2, r.data);
    (r.data.created || []).forEach((t) => created.taskIds.push(t.id));

    // 3) 换成别的学科 → 403（学科不可修改）
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: cPhys,
      body: { classIds: [c1], subject: '数学', title: 'PSUB-越权学科' + TAG, deadline: DDL },
    });
    check('3) 物理老师用数学发布 → 403 且提示"学科不可修改"',
      r.status === 403 && /学科不可修改/.test(r.data.error || '') && r.data.mySubject === '物理', r.data);
    check('3) 越权学科未落库',
      (await pg.query('SELECT count(*)::int n FROM homework_tasks WHERE title = $1', ['PSUB-越权学科' + TAG])).rows[0].n === 0);
    check('3) 缺 subject 字段 → 400（有效学科校验）',
      (await api('/api/homework/tasks', { method: 'POST', cookie: cPhys, body: { classIds: [c1], title: 'PSUB-无学科' + TAG, deadline: DDL } })).status === 400);

    // 4) 未绑定学科的教师 → 400「请先到个人中心绑定所教学科」
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: cNosub,
      body: { classIds: [c1], subject: '物理', title: 'PSUB-未绑定' + TAG, deadline: DDL },
    });
    check('4) 未绑定学科的老师发布 → 400 且提示绑定学科',
      r.status === 400 && /请先到个人中心绑定所教学科/.test(r.data.error || ''), r.data);
    check('4) 未绑定学科的老师 GET subject 返回 null（前端据此提示并禁用发布）',
      (await api('/api/teacher/subject', { cookie: cNosub })).data.subject === null);

    // 5) 班主任同样受限：语文班主任用数学发布 → 403
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: cHead,
      body: { classIds: [c1], subject: '数学', title: 'PSUB-班主任越权' + TAG, deadline: DDL },
    });
    check('5) 班主任（所教学科=语文）用数学发布 → 403', r.status === 403 && /语文/.test(r.data.error || ''), r.data);
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: cHead,
      body: { classIds: [c1], subject: '语文', title: 'PSUB-班主任语文' + TAG, deadline: DDL },
    });
    check('5) 班主任用自己的学科（语文）发布 → 201', r.status === 201 && (r.data.created || []).length === 1, r.data);
    (r.data.created || []).forEach((t) => created.taskIds.push(t.id));

    // 6) 非本班班级仍被拦截（原有规则不变）
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: cPhys,
      body: { classIds: [1], subject: '物理', title: 'PSUB-非本班' + TAG, deadline: DDL },
    });
    check('6) 向未带班班级发布 → 403（班级校验优先）', r.status === 403 && /只能给自己所带的班级/.test(r.data.error || ''), r.data);

    // 7) 管理员：可"以任课老师身份发布"（需求变更）——任意班级 + 任意学科，并带「管理员发布」标识
    r = await api('/api/homework/tasks', { method: 'POST', cookie: cAdmin, body: { classIds: [c1], subject: '物理', title: 'PSUB-管理员' + TAG, deadline: DDL } });
    check('7) 管理员发布到任意班级/任意学科 → 201（管理员测试发布）', r.status === 201 && (r.data.created || []).length === 1, r.data);
    (r.data.created || []).forEach((t) => created.taskIds.push(t.id));
    const adminTaskId = (r.data.created || [])[0] && r.data.created[0].id;
    const adminFlag = ((await api('/api/homework/tasks?mine=1', { cookie: cAdmin })).data.tasks || []).find((x) => x.id === adminTaskId);
    check('7) 管理员发布的作业带 publisherIsAdmin 标识（前端显示「管理员发布」）',
      !!adminFlag && adminFlag.publisherIsAdmin === true, adminFlag);
    // （班长/学生的发布权限在 test_admin_publish_and_session_delete.js 中覆盖）

    // 8) 编辑作业不改学科（PUT 只改标题/截止/备注）
    const taskId = created.taskIds[0];
    r = await api('/api/homework/tasks/' + taskId, { method: 'PUT', cookie: cPhys, body: { title: 'PSUB-改标题' + TAG, subject: '数学' } });
    check('8) PUT 修改作业（带 subject 字段）→ 只改标题、学科不变',
      r.status === 200 && (await pg.query('SELECT subject FROM homework_tasks WHERE id = $1', [taskId])).rows[0].subject === '物理', r.data);

    // 9) /auth/me 也带出所教学科（页面可直接使用）
    const me = await api('/api/auth/me', { cookie: cPhys });
    check('9) /auth/me 返回 subject=物理 便于页面自动带出', me.data.user.subject === '物理', me.data.user.subject);

    // ---------- 清理与真实数据核对 ----------
    await cleanup();
    const after = {
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
      classes: (await pg.query('SELECT count(*)::int n FROM classes')).rows[0].n,
      tasks: (await pg.query('SELECT count(*)::int n FROM homework_tasks')).rows[0].n,
      tc: (await pg.query('SELECT count(*)::int n FROM teacher_classes')).rows[0].n,
    };
    check('10) 真实数据未变（users/classes/tasks/teacher_classes）',
      base.users === after.users && base.classes === after.classes && base.tasks === after.tasks && base.tc === after.tc,
      { base, after });
    check('10) 夹具已清理',
      (await pg.query('SELECT count(*)::int n FROM homework_tasks WHERE title LIKE $1', ['PSUB%' + TAG])).rows[0].n === 0 &&
      (await pg.query('SELECT count(*)::int n FROM users WHERE username LIKE $1', [PRE + '%'])).rows[0].n === 0);
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
