// ============================================================
// 作业管理「学科筛选固定为绑定学科」测试（BUG 修复：班主任的筛选一直是"全部"）
//   数据链路：users.subject → GET /api/teacher/subject → 列表接口 mySubject/subjectFilter → 前端筛选框
//   接口契约：
//     · 教师（任课 / 班主任）列表接口都返回 mySubject = 绑定学科、subjectFilter = 绑定学科、subjectEditable = false
//     · 管理员 subjectEditable = true、mySubject = null
//     · ?subject=绑定学科 能筛出本人该学科作业；?subject=其他学科 对本班任课/班主任不重要（不会看到别人的）
// 夹具：班主任（物理）1 名 + 任课老师（物理）1 名 + 班级/学生 + 各自作业；测完清理
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
const GRADE = '筛选修复年级' + TAG;
const C_HEAD = '筛选修复班主任班' + TAG;
const C_SUBJ = '筛选修复任课班' + TAG;
const PRE = 'sfx_' + TAG + '_';
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
  await pg.query('DELETE FROM homework_tasks WHERE title LIKE $1', ['SFX%' + TAG]).catch(() => {});
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name = ANY($1::text[])', [[C_HEAD, C_SUBJ]]).catch(() => {});
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(() => {});
}

(async () => {
  try {
    await cleanup();
    const base = {
      tasks: (await pg.query('SELECT count(*)::int n FROM homework_tasks')).rows[0].n,
      tc: (await pg.query('SELECT count(*)::int n FROM teacher_classes')).rows[0].n,
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
    };
    const cAdmin = await login('admin');

    // 夹具：班级 + 班主任（物理，1 班主任班 + 1 任课班）+ 纯任课老师（物理）
    const year = (await api('/api/settings', { cookie: cAdmin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: cAdmin, body: { gradeName: GRADE, gradeCode: 'SFX', academicYear: year } })).data.id;
    const ch = (await api('/api/classes', { method: 'POST', cookie: cAdmin, body: { className: C_HEAD, gradeName: GRADE, academicYear: year } })).data.id;
    const cs = (await api('/api/classes', { method: 'POST', cookie: cAdmin, body: { className: C_SUBJ, gradeName: GRADE, academicYear: year } })).data.id;
    created.classIds = [ch, cs];
    let r = await api('/api/users', {
      method: 'POST', cookie: cAdmin,
      body: {
        username: PRE + 'head', password: '123456', role: 'teacher', realName: '班主任物理', subject: '物理',
        teachingClasses: [{ classId: ch, roleInClass: 'head_teacher' }, { classId: cs, roleInClass: 'subject_teacher' }],
      },
    });
    check('0) 创建班主任（物理 + 1 班主任班 + 1 任课班）→ 201', r.status === 201, r.data);
    const headId = r.data.user.id;
    created.userIds.push(headId);
    r = await api('/api/users', {
      method: 'POST', cookie: cAdmin,
      body: { username: PRE + 'subj', password: '123456', role: 'teacher', realName: '任课物理', subject: '物理', teachingClasses: [{ classId: cs, roleInClass: 'subject_teacher' }] },
    });
    created.userIds.push(r.data.user.id);
    const subjId = r.data.user.id;
    r = await api('/api/users', {
      method: 'POST', cookie: cAdmin,
      body: { username: PRE + 'nosub', password: '123456', role: 'teacher', realName: '未绑定学科', teachingClasses: [{ classId: cs, roleInClass: 'subject_teacher' }] },
    });
    created.userIds.push(r.data.user.id);

    const cHead = await login(PRE + 'head');
    const cSubj = await login(PRE + 'subj');
    const cNosub = await login(PRE + 'nosub');

    // 1) 数据库 → API：绑定学科能否读到
    check('1) 数据库 users.subject = 物理（班主任）',
      (await pg.query('SELECT subject FROM users WHERE id = $1', [headId])).rows[0].subject === '物理');
    r = await api('/api/teacher/subject', { cookie: cHead });
    check('1) GET /api/teacher/subject（班主任）→ subject=物理',
      r.status === 200 && r.data.subject === '物理', r.data);

    // 2) 列表接口：班主任同样返回绑定学科（修复前 subjectLocked=false 且被前端忽略）
    r = await api('/api/homework/tasks?mine=1', { cookie: cHead });
    check('2) 班主任列表接口 mySubject=物理',
      r.status === 200 && r.data.mySubject === '物理', { mySubject: r.data.mySubject, subjectLocked: r.data.subjectLocked });
    check('2) 班主任列表接口 subjectFilter=物理 且 subjectEditable=false（新的筛选契约）',
      r.data.subjectFilter === '物理' && r.data.subjectEditable === false,
      { filter: r.data.subjectFilter, editable: r.data.subjectEditable });
    check('2) 班主任 isHeadTeacher=true（确实是班主任场景）', r.data.isHeadTeacher === true, r.data.isHeadTeacher);
    r = await api('/api/homework/tasks?mine=1', { cookie: cSubj });
    check('2) 纯任课老师同样 mySubject=物理 / subjectFilter=物理 / subjectEditable=false',
      r.data.mySubject === '物理' && r.data.subjectFilter === '物理' && r.data.subjectEditable === false, r.data);
    r = await api('/api/homework/tasks', { cookie: cAdmin });
    check('2) 管理员 subjectEditable=true、mySubject=null（不受限）',
      r.status === 200 && r.data.subjectEditable === true && (r.data.mySubject === null || r.data.mySubject === undefined),
      { editable: r.data.subjectEditable, mySubject: r.data.mySubject });
    r = await api('/api/homework/tasks?mine=1', { cookie: cNosub });
    check('2) 未绑定学科的老师 mySubject=null（前端据此提示绑定）', r.data.mySubject === null, r.data.mySubject);

    // 3) 筛选行为：班主任按绑定学科筛选能拿到自己的作业
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: cHead,
      body: { classIds: [ch, cs], subject: '物理', title: 'SFX-班主任物理' + TAG, deadline: DDL },
    });
    check('3) 班主任发布物理作业（两个班）→ 201', r.status === 201 && (r.data.created || []).length === 2, r.data);
    (r.data.created || []).forEach((t) => created.taskIds.push(t.id));
    r = await api(`/api/homework/tasks?mine=1&subject=${encodeURIComponent('物理')}&date=${TODAY}`, { cookie: cHead });
    check('3) ?subject=物理 能筛到自己的作业（2 条）',
      r.status === 200 && (r.data.tasks || []).length === 2 && (r.data.tasks || []).every((t) => t.subject === '物理'),
      (r.data.tasks || []).map((t) => t.subject));
    r = await api(`/api/homework/tasks?mine=1&subject=${encodeURIComponent('数学')}&date=${TODAY}`, { cookie: cHead });
    check('3) ?subject=数学 筛不到任何作业（本人没有数学作业）',
      r.status === 200 && (r.data.tasks || []).length === 0, (r.data.tasks || []).length);
    r = await api(`/api/homework/tasks?mine=1&date=${TODAY}`, { cookie: cSubj });
    check('3) 教师之间互不可见（纯任课老师看不到班主任的作业）',
      (r.data.tasks || []).length === 0, (r.data.tasks || []).length);

    // 4) 前端页面版本（确保浏览器不会再拿到旧脚本）
    r = await api('/homework-manage');
    const html = await (await fetch(BASE + '/homework-manage', { headers: { Cookie: cAdmin } })).text();
    check('4) 页面脚本带版本号 ?v=x.y.z（强制刷新缓存）', /homework-manage\.js\?v=\d+\.\d+\.\d+/.test(html), (html.match(/homework-manage\.js\?v=[\d.]+/) || [])[0]);
    const js = await (await fetch(BASE + '/homework-manage.js')).text();
    check('4) 脚本已按"绑定学科"锁定筛选（不再依赖 subjectLocked）',
      /teachSubject \|\| \(data && data\.mySubject\)/.test(js) && /el\.fSubject\.disabled = true/.test(js));
    check('4) 未绑定学科时给出"请先到个人中心…绑定所教学科"提示',
      /请先到.*个人中心/.test(js) && /绑定<b>所教学科<\/b>/.test(js));

    // ---------- 清理与真实数据核对 ----------
    await cleanup();
    const after = {
      tasks: (await pg.query('SELECT count(*)::int n FROM homework_tasks')).rows[0].n,
      tc: (await pg.query('SELECT count(*)::int n FROM teacher_classes')).rows[0].n,
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
    };
    check('5) 真实数据未变（tasks/teacher_classes/users）',
      base.tasks === after.tasks && base.tc === after.tc && base.users === after.users, { base, after });
    check('5) 夹具已清理',
      (await pg.query('SELECT count(*)::int n FROM users WHERE username LIKE $1', [PRE + '%'])).rows[0].n === 0 &&
      (await pg.query('SELECT count(*)::int n FROM homework_tasks WHERE title LIKE $1', ['SFX%' + TAG])).rows[0].n === 0);
    void subjId;
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
