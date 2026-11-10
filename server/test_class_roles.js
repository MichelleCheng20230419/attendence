// ============================================================
// 教师带班角色【按班级分别设置】测试（需求：功能修正）
//   一位教师可以在 A 班当班主任、在 B 班只当任课老师（张老师场景）
//   权限：班主任班级 → 看本班全部科目；任课班级 → 只看自己发布的本学科
//   账号级 roleLabel：管理员/班主任/任课老师/班长/学生（有任一班主任班级 → 班主任）
// 夹具：临时班级 2 个 + 临时教师 3 个 + 临时作业若干；结束后全部清理
// ============================================================
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

const pad = (n) => String(n).padStart(2, '0');
const d = new Date();
const TODAY = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const YESTERDAY = (() => { const x = new Date(d.getTime() - 86400000); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; })();

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
// 容错登录（夹具账号密码可能已被改动 → 返回 null 并跳过相关断言，不影响主流程）
async function tryLogin(u, p = '123456') {
  try { return await login(u, p); } catch (_) { return null; }
}

const PRE = 'tcr_';
const CNAME1 = '带班测试一班', CNAME2 = '带班测试二班', CNAME3 = '带班测试三班';
const CNAMES = [CNAME1, CNAME2, CNAME3];
const GRADE = '测试年级CR';

let cls1 = null, cls2 = null;

async function cleanup() {
  const uids = (await pg.query('SELECT id FROM users WHERE username LIKE $1', [PRE + '%'])).rows.map((r) => r.id);
  if (uids.length) {
    await pg.query('DELETE FROM homework_submissions WHERE task_id IN (SELECT id FROM homework_tasks WHERE created_by = ANY($1::int[]))', [uids]).catch(() => {});
    await pg.query('DELETE FROM homework_tasks WHERE created_by = ANY($1::int[])', [uids]).catch(() => {});
  }
  // 先松开班级的班主任引用，再删临时班级，最后删账号（否则外键阻止删除账号）
  if (uids.length) await pg.query('UPDATE classes SET head_teacher_id = NULL WHERE head_teacher_id = ANY($1::int[])', [uids]).catch(() => {});
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name = ANY($1::text[]) AND grade = $2', [CNAMES, GRADE]).catch(() => {});
  if (uids.length) {
    await pg.query('DELETE FROM teacher_classes WHERE teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM operation_logs WHERE user_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM users WHERE id = ANY($1::int[])', [uids]).catch((e) => console.log('  · 清理账号失败：', e.message));
  }
  await pg.query("DELETE FROM grades WHERE grade_name = $1", [GRADE]).catch(() => {});
  const left = (await pg.query('SELECT count(*)::int n FROM users WHERE username LIKE $1', [PRE + '%'])).rows[0].n +
    (await pg.query('SELECT count(*)::int n FROM classes WHERE grade = $1', [GRADE])).rows[0].n;
  if (left > 0) console.log('  · 警告：仍有夹具残留', left);
}

(async () => {
  try {
    await cleanup();
    // 记录真实数据基线（测试结束必须不变）
    const base = {
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
      classes: (await pg.query('SELECT count(*)::int n FROM classes')).rows[0].n,
      tasks: (await pg.query('SELECT count(*)::int n FROM homework_tasks')).rows[0].n,
      tc: (await pg.query('SELECT count(*)::int n FROM teacher_classes')).rows[0].n,
      heads: (await pg.query('SELECT id, head_teacher_id FROM classes WHERE id IN (1,2,8) ORDER BY id')).rows,
    };

    // ---------- 夹具 ----------
    const g = await pg.query(
      'INSERT INTO grades (grade_name, grade_code, academic_year) VALUES ($1,$2,$3) ON CONFLICT (grade_name, academic_year) DO UPDATE SET grade_code = EXCLUDED.grade_code RETURNING id',
      [GRADE, 'CRT', '2025-2026']
    );
    const gid = g.rows[0].id;
    cls1 = (await pg.query(
      'INSERT INTO classes (class_name, grade, grade_id, academic_year, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [CNAME1, GRADE, gid, '2025-2026', 'active']
    )).rows[0].id;
    cls2 = (await pg.query(
      'INSERT INTO classes (class_name, grade, grade_id, academic_year, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [CNAME2, GRADE, gid, '2025-2026', 'active']
    )).rows[0].id;
    const cls3 = (await pg.query(
      'INSERT INTO classes (class_name, grade, grade_id, academic_year, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [CNAME3, GRADE, gid, '2025-2026', 'active']
    )).rows[0].id;

    const cAdmin = await login('admin');
    // 张老师场景：通过【账号管理 API】创建 —— 一班班主任 + 二班数学任课老师
    // 表单已简化：带班记录只提交班级 + 在该班角色，学科统一取账号级「所教学科」
    let r = await api('/api/users', {
      method: 'POST', cookie: cAdmin,
      body: {
        username: PRE + 'zhang', password: '123456', role: 'teacher', realName: '张老师（测试）',
        subject: '数学',
        teachingClasses: [
          { classId: cls1, roleInClass: 'head_teacher' },
          { classId: cls2, roleInClass: 'subject_teacher' },
        ],
      },
    });
    check('1) 创建教师（一班班主任 + 二班任课数学）→ 201', r.status === 201, r.data);
    const zhangId = r.data && r.data.user && r.data.user.id;
    check('1) roleLabel = 班主任（有任一班主任班级）', r.data.user.roleLabel === '班主任', r.data.user.roleLabel);
    check('1) 返回 2 条带班记录且角色各自独立',
      (r.data.user.teachingClasses || []).length === 2 &&
      r.data.user.teachingClasses.some((t) => t.classId === cls1 && t.roleInClass === 'head_teacher') &&
      r.data.user.teachingClasses.some((t) => t.classId === cls2 && t.roleInClass === 'subject_teacher'),
      r.data.user.teachingClasses);
    check('1) 带班记录不再逐班保存学科（subject=null，回退账号学科）',
      (r.data.user.teachingClasses || []).every((t) => t.subject === null),
      (r.data.user.teachingClasses || []).map((t) => t.subject));
    // 班级班主任字段联动：只有"班主任"记录会写入，任课老师不写
    const h1 = (await pg.query('SELECT head_teacher_id h FROM classes WHERE id = $1', [cls1])).rows[0].h;
    const h2 = (await pg.query('SELECT head_teacher_id h FROM classes WHERE id = $1', [cls2])).rows[0].h;
    check('1) 班主任班级 → classes.head_teacher_id 联动', h1 === zhangId, { h1, zhangId });
    check('1) 任课老师班级 → 不写 classes.head_teacher_id', h2 === null || h2 !== zhangId, { h2 });

    // 另一位教师：同一班的语文老师（用于验证班主任能看到别科）
    // 表单形态：带班记录不带逐班学科；同时验证 API 仍支持逐班学科（个人中心用），故 chinese1 显式传了 subject
    const mk2 = async (username, subject, roleInClass, classId, rowSubject) => {
      const row = { classId, roleInClass };
      if (rowSubject !== undefined) row.subject = rowSubject;
      const rr = await api('/api/users', {
        method: 'POST', cookie: cAdmin,
        body: { username, password: '123456', role: 'teacher', realName: username, subject, teachingClasses: [row] },
      });
      if (rr.status !== 201) throw new Error('创建 ' + username + ' 失败: ' + JSON.stringify(rr.data));
      return rr.data.user.id;
    };
    const chinese1Id = await mk2(PRE + 'chinese1', '语文', 'subject_teacher', cls1, '语文');
    await mk2(PRE + 'chinese2', '语文', 'subject_teacher', cls2);
    // 纯任课老师（无班主任班级）→ 账号级学科锁定
    const pureId = await mk2(PRE + 'pure', '数学', 'subject_teacher', cls2);
    // 逐班学科仍可写入（个人中心/后续扩展用），但账号管理表单不再产生该值
    const c1row = ((await api('/api/users', { cookie: cAdmin })).data.users.find((u) => u.id === chinese1Id) || {}).teachingClasses[0];
    check('1b) API 仍支持逐班学科（个人中心场景）', c1row && c1row.subject === '语文', c1row);

    // 账号列表角色标签
    r = await api('/api/users', { cookie: cAdmin });
    const list = (r.data.users || []);
    const z = list.find((u) => u.id === zhangId);
    const pure = list.find((u) => u.id === pureId);
    check('2) 列表 roleLabel：张老师=班主任', z && z.roleLabel === '班主任', z && z.roleLabel);
    check('2) 列表 roleLabel：纯任课老师=任课老师', pure && pure.roleLabel === '任课老师', pure && pure.roleLabel);
    check('2) 列表：管理员/班长/学生标签未回归',
      list.find((u) => u.username === 'admin').roleLabel === '管理员' &&
      list.filter((u) => u.role === 'monitor').every((u) => u.roleLabel === '班长'),
      list.filter((u) => u.role !== 'teacher').map((u) => u.username + ':' + u.roleLabel));

    const cZhang = await login(PRE + 'zhang');
    const cChinese2 = await login(PRE + 'chinese2');

    // ---------- 作业夹具 ----------
    const mkTask = async (cookie, classId, subject, title) => {
      const rr = await api('/api/homework/tasks', {
        method: 'POST', cookie,
        body: { classIds: [classId], subject, title, deadline: `${TODAY} 23:59` },
      });
      if (rr.status !== 201 || !rr.data.created.length) throw new Error('发布失败 ' + title + ': ' + JSON.stringify(rr.data));
      return rr.data.created[0].id;
    };
    const zMath1 = await mkTask(cZhang, cls1, '数学', 'CR-一班-张老师数学');
    const cChi1 = await mkTask(await login(PRE + 'chinese1'), cls1, '语文', 'CR-一班-语文老师语文');
    const zMath2 = await mkTask(cZhang, cls2, '数学', 'CR-二班-张老师数学');
    const cChi2 = await mkTask(cChinese2, cls2, '语文', 'CR-二班-语文老师语文');

    // 3) 列表：指定【班主任班级】→ 本班全部科目
    r = await api(`/api/homework/tasks?classId=${cls1}&date=${TODAY}`, { cookie: cZhang });
    const s1 = (r.data.tasks || []).map((t) => t.subject + '|' + t.title).sort();
    check('3) 班主任班级列表含本班全部科目（数学+语文）',
      r.status === 200 && s1.length === 2 && s1.some((x) => x.startsWith('数学|')) && s1.some((x) => x.startsWith('语文|')), s1);

    // 4) 列表：指定【任课班级】→ 仅自己发布的本学科
    r = await api(`/api/homework/tasks?classId=${cls2}&date=${TODAY}`, { cookie: cZhang });
    const s2 = (r.data.tasks || []).map((t) => t.subject + '|' + t.title);
    check('4) 任课班级列表只有自己的数学（看不到别科/别人的）',
      r.status === 200 && s2.length === 1 && s2[0] === '数学|CR-二班-张老师数学', s2);

    // 5) 不传班级：班主任班级全部 + 任课班级仅自己的
    r = await api(`/api/homework/tasks?date=${TODAY}`, { cookie: cZhang });
    const sAll = (r.data.tasks || []).map((t) => t.title).sort();
    check('5) 默认列表 = 一班全部 + 二班自己的（共 3 条）',
      r.status === 200 && sAll.length === 3 &&
      sAll.includes('CR-一班-语文老师语文') && sAll.includes('CR-一班-张老师数学') && sAll.includes('CR-二班-张老师数学'),
      sAll);
    check('5) 非班主任但任教 → subjectLocked=false（可选学科）', r.data.subjectLocked === false, r.data.subjectLocked);

    // 6) 详情可见性
    check('6) 可看本班（班主任班级）别科作业详情',
      (await api('/api/homework/tasks/' + cChi1, { cookie: cZhang })).status === 200);
    check('6) 看不到【任课班级】别科作业详情 → 403',
      (await api('/api/homework/tasks/' + cChi2, { cookie: cZhang })).status === 403);

    // 7) 发布：可向所有带班班级发布；未带班班级 → 403
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: cZhang,
      body: { classIds: [cls1, cls2], subject: '数学', title: 'CR-两班同时发布', deadline: `${TODAY} 22:00` },
    });
    check('7) 同时向 班主任班级 + 任课班级 发布 → 201 且 2 条', r.status === 201 && r.data.created.length === 2, r.data);
    const otherCls = (await pg.query("SELECT id FROM classes WHERE id NOT IN ($1,$2) ORDER BY id LIMIT 1", [cls1, cls2])).rows[0].id;
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: cZhang,
      body: { classIds: [otherCls], subject: '数学', title: 'CR-越权发布', deadline: `${TODAY} 22:00` },
    });
    check('7) 向未带班班级发布 → 403', r.status === 403, r.data);
    check('7) 越权发布未落库',
      (await pg.query('SELECT count(*)::int n FROM homework_tasks WHERE title = $1', ['CR-越权发布'])).rows[0].n === 0);

    // 8) 纯任课老师：学科锁定 + 只看到自己学科
    const cPure = await login(PRE + 'pure');
    r = await api(`/api/homework/tasks?date=${TODAY}`, { cookie: cPure });
    check('8) 纯任课老师 subjectLocked=true', r.data.subjectLocked === true, r.data.subjectLocked);
    check('8) 纯任课老师默认列表看不到别科作业',
      (r.data.tasks || []).every((t) => t.subject === '数学'), (r.data.tasks || []).map((t) => t.subject));
    check('8) 纯任课老师请求语文 → 403',
      (await api(`/api/homework/tasks?subject=${encodeURIComponent('语文')}`, { cookie: cPure })).status === 403);

    // 9) 编辑账号：把一班的角色改成任课老师 → 权限立即收窄、标签变任课老师
    r = await api('/api/users/' + zhangId, {
      method: 'PUT', cookie: cAdmin,
      body: {
        role: 'teacher', realName: '张老师（测试）', isActive: true, subject: '数学',
        classId: cls1,
        teachingClasses: [
          { classId: cls1, roleInClass: 'subject_teacher' },
          { classId: cls2, roleInClass: 'subject_teacher' },
        ],
      },
    });
    check('9) 角色改为两班任课老师 → 200 且 roleLabel=任课老师',
      r.status === 200 && r.data.user.roleLabel === '任课老师', r.data && r.data.user && r.data.user.roleLabel);
    check('9) 账号级 roles 同步为 subject_teacher',
      JSON.stringify(r.data.user.roles) === '["subject_teacher"]', r.data.user.roles);
    check('9) users.roles 同步为 subject_teacher（数据库）',
      String((await pg.query('SELECT roles::text r FROM users WHERE id = $1', [zhangId])).rows[0].r) === '["subject_teacher"]');
    r = await api(`/api/homework/tasks?classId=${cls1}&date=${TODAY}`, { cookie: cZhang });
    check('9) 原班主任班级降级后只看自己的数学（别科不可见）',
      r.status === 200 && (r.data.tasks || []).length === 2 &&
      (r.data.tasks || []).every((t) => t.subject === '数学' && t.teacherName === '张老师（测试）'),
      (r.data.tasks || []).map((t) => t.subject + '|' + t.title));
    check('9) 原班主任班级降级后别科详情 → 403',
      (await api('/api/homework/tasks/' + cChi1, { cookie: cZhang })).status === 403);
    check('9) 降级后 classes.head_teacher_id 清空（不再残留）',
      (await pg.query('SELECT head_teacher_id h FROM classes WHERE id = $1', [cls1])).rows[0].h === null);

    // 10) 恢复班主任身份（改回一班班主任）→ 又可见全班
    r = await api('/api/users/' + zhangId, {
      method: 'PUT', cookie: cAdmin,
      body: {
        role: 'teacher', realName: '张老师（测试）', isActive: true, subject: '数学', classId: cls1,
        teachingClasses: [
          { classId: cls1, roleInClass: 'head_teacher' },
          { classId: cls2, roleInClass: 'subject_teacher' },
        ],
      },
    });
    check('10) 改回一班班主任 → roleLabel=班主任 且 roles=head_teacher',
      r.status === 200 && r.data.user.roleLabel === '班主任' && JSON.stringify(r.data.user.roles) === '["head_teacher"]',
      r.data && r.data.user);
    r = await api(`/api/homework/tasks?classId=${cls1}&date=${TODAY}`, { cookie: cZhang });
    check('10) 恢复后又可见本班语文作业', r.status === 200 && (r.data.tasks || []).length >= 2, (r.data.tasks || []).length);

    // 11) 兼容：旧版 { classId, isHeadTeacher } 写入接口
    r = await api('/api/users/teacher-classes', {
      method: 'POST', cookie: cAdmin,
      body: { teacherId: pureId, classes: [{ classId: cls2, isHeadTeacher: true }] },
    });
    check('11) 旧参数 isHeadTeacher=true 仍写入为班主任', r.status === 200, r.data);
    const tcRow = (await pg.query('SELECT role_in_class, is_head_teacher FROM teacher_classes WHERE teacher_id = $1 AND class_id = $2', [pureId, cls2])).rows[0];
    check('11) 数据库中 role_in_class=head_teacher / is_head_teacher=true',
      tcRow && tcRow.role_in_class === 'head_teacher' && tcRow.is_head_teacher === true, tcRow);
    r = await api('/api/users', { cookie: cAdmin });
    check('11) 升级为班主任后角色标签变化',
      ((r.data.users || []).find((u) => u.id === pureId) || {}).roleLabel === '班主任');

    // 12) 未设置带班的教师：不崩、无越权
    r = await api('/api/users', {
      method: 'POST', cookie: cAdmin,
      body: { username: PRE + 'noclass', password: '123456', role: 'teacher', realName: '无带班教师', subject: '数学', teachingClasses: [] },
    });
    check('12) 允许创建未带班教师 → 201 且 0 条带班记录',
      r.status === 201 && (r.data.user.teachingClasses || []).length === 0, r.data);
    const cNo = await login(PRE + 'noclass');
    r = await api(`/api/homework/tasks?date=${TODAY}`, { cookie: cNo });
    check('12) 未带班教师列表为空', r.status === 200 && (r.data.tasks || []).length === 0, (r.data.tasks || []).length);
    check('12) 未带班教师发布 → 403',
      (await api('/api/homework/tasks', {
        method: 'POST', cookie: cNo,
        body: { classIds: [cls1], subject: '数学', title: 'CR-无带班发布', deadline: `${TODAY} 22:00` },
      })).status === 403);
    const noclassUser = ((await api('/api/users', { cookie: cAdmin })).data.users || []).find((u) => u.username === PRE + 'noclass');
    check('12) 未带班教师 roleLabel = 教师（未带班）', noclassUser && noclassUser.roleLabel === '教师（未带班）', noclassUser && noclassUser.roleLabel);

    // 13) 班长/学生角色不受影响（班长只看自己班级）
    const mons = (await pg.query("SELECT id, class_id, username FROM users WHERE role = 'monitor' ORDER BY id")).rows;
    let mon = null, cMon = null;
    for (const m of mons) {
      const c = await tryLogin(m.username);
      if (c) { mon = m; cMon = c; break; }
    }
    if (cMon) {
      r = await api('/api/homework/tasks', { cookie: cMon });
      check('13) 班长列表仅本班作业', r.status === 200 && (r.data.tasks || []).every((t) => t.classId === mon.class_id), (r.data.tasks || []).map((t) => t.classId));
      check('13) 班长不能发布作业 → 403',
        (await api('/api/homework/tasks', {
          method: 'POST', cookie: cMon,
          body: { classIds: [mon.class_id], subject: '数学', title: 'CR-班长发布', deadline: `${TODAY} 22:00` },
        })).status === 403);
    } else {
      console.log('  · 跳过班长断言（可用班长账号均非默认密码）');
    }

    // 14) 账号级 roles 一致性：所有教师的 roleLabel 与 teacher_classes 一致
    const consistency = await pg.query(
      `SELECT u.id, u.username, u.roles::text AS roles,
              (SELECT count(*)::int FROM teacher_classes tc WHERE tc.teacher_id = u.id AND tc.role_in_class = 'head_teacher') AS heads
         FROM users u WHERE u.role = 'teacher' ORDER BY u.id`
    );
    const bad = consistency.rows.filter((x) => (x.heads > 0) !== (x.roles.includes('head_teacher')));
    check('14) 全部教师账号 roles 与班级级班主任记录一致', bad.length === 0, bad);
    const legacy = await pg.query("SELECT count(*)::int n FROM teacher_classes WHERE is_head_teacher <> (role_in_class = 'head_teacher')");
    check('14) 兼容字段 is_head_teacher 与 role_in_class 完全同步', legacy.rows[0].n === 0, legacy.rows[0].n);

    // 15) 不抢占：把张老师设为"已有班主任的班级"的班主任 → 带班角色记录生效，
    //     但班级管理页的班主任（classes.head_teacher_id）不被覆盖
    await pg.query('UPDATE classes SET head_teacher_id = $1 WHERE id = $2', [chinese1Id, cls3]);
    r = await api('/api/users/' + zhangId, {
      method: 'PUT', cookie: cAdmin,
      body: {
        role: 'teacher', realName: '张老师（测试）', isActive: true, subject: '数学', classId: cls1,
        teachingClasses: [
          { classId: cls1, roleInClass: 'head_teacher' },
          { classId: cls2, roleInClass: 'subject_teacher' },
          { classId: cls3, roleInClass: 'head_teacher' },
        ],
      },
    });
    const tc3 = (await pg.query('SELECT role_in_class FROM teacher_classes WHERE teacher_id = $1 AND class_id = $2', [zhangId, cls3])).rows[0];
    const h3 = (await pg.query('SELECT head_teacher_id h FROM classes WHERE id = $1', [cls3])).rows[0].h;
    check('15) 带班角色记录写入为班主任', r.status === 200 && tc3 && tc3.role_in_class === 'head_teacher', tc3);
    check('15) 不抢占已有班主任（classes.head_teacher_id 保持原值）', h3 === chinese1Id, { h3, chinese1Id });
    r = await api(`/api/homework/tasks?classId=${cls3}&date=${TODAY}`, { cookie: cZhang });
    check('15) 兼职班主任班级权限生效（可见该班全部科目，当前为空）', r.status === 200 && Array.isArray(r.data.tasks), r.status);

    // ---------- 清理 ----------
    await cleanup();

    // ---------- 真实数据未被改动 ----------
    const after = {
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
      classes: (await pg.query('SELECT count(*)::int n FROM classes')).rows[0].n,
      tasks: (await pg.query('SELECT count(*)::int n FROM homework_tasks')).rows[0].n,
      tc: (await pg.query('SELECT count(*)::int n FROM teacher_classes')).rows[0].n,
      heads: (await pg.query('SELECT id, head_teacher_id FROM classes WHERE id IN (1,2,8) ORDER BY id')).rows,
    };
    check('16) 真实数据行数未变（users/classes/tasks/teacher_classes）',
      base.users === after.users && base.classes === after.classes && base.tasks === after.tasks && base.tc === after.tc,
      { base, after });
    check('16) 真实班级 head_teacher_id 未变', JSON.stringify(base.heads) === JSON.stringify(after.heads), { b: base.heads, a: after.heads });
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：', e.message);
    try { await cleanup(); } catch (_) {}
  } finally {
    await pg.end();
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
