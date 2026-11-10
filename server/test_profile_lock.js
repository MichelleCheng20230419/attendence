// 教学设置「首次确认后锁定」生命周期 + 权限测试
//   规则：profile_locked=false（首次登录）→ 教师可自行设置学科/所带班级；
//         保存（确认并锁定）后 profile_locked=true → 教师端只读（GET 可读，PUT 403）；
//         管理员可在账号管理中修改，并可"重置为待确认"让教师重新确认。
// 夹具：临时教师 + 临时班级（含班主任场景），结束后清理并断言真实数据未变
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
  return { cookie: 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1], data: r.data };
}
async function tryLogin(u, p = '123456') {
  try { return await login(u, p); } catch (_) { return null; }
}

const PRE = 'tlock_';
const CNAME = '锁定测试班';
const GRADE = '锁定测试年级';
const TMP_NAMES = [PRE + 'new', PRE + 'head'];

let clsId = null;

async function cleanup() {
  const uids = (await pg.query('SELECT id FROM users WHERE username LIKE $1', [PRE + '%'])).rows.map((r) => r.id);
  if (uids.length) {
    await pg.query('UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL WHERE head_teacher_id = ANY($1::int[]) OR teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM homework_tasks WHERE created_by = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM teacher_classes WHERE teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM operation_logs WHERE user_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM users WHERE id = ANY($1::int[])', [uids]).catch((e) => console.log('  · 清理账号失败：', e.message));
  }
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name = $1 AND grade = $2', [CNAME, GRADE]).catch(() => {});
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(() => {});
  const left = (await pg.query('SELECT count(*)::int n FROM users WHERE username LIKE $1', [PRE + '%'])).rows[0].n;
  if (left > 0) console.log('  · 警告：仍有夹具账号残留', left);
}

(async () => {
  try {
    await cleanup();
    const base = {
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
      classes: (await pg.query('SELECT count(*)::int n FROM classes')).rows[0].n,
      tc: (await pg.query('SELECT count(*)::int n FROM teacher_classes')).rows[0].n,
      locked: (await pg.query('SELECT count(*)::int n FROM users WHERE role = $1 AND profile_locked = true', ['teacher'])).rows[0].n,
      lockMap: (await pg.query(
        "SELECT username, profile_locked::text AS l FROM users WHERE role = 'teacher' AND username NOT LIKE $1 ORDER BY username",
        [PRE + '%']
      )).rows,
      heads: (await pg.query('SELECT id, head_teacher_id FROM classes ORDER BY id')).rows,
    };

    const cAdmin = (await login('admin')).cookie;

    // 夹具：临时年级 + 班级（用于教师选择）+ 两个临时教师
    const g = await pg.query(
      'INSERT INTO grades (grade_name, grade_code, academic_year) VALUES ($1,$2,$3) RETURNING id',
      [GRADE, 'TLK', '2025-2026']
    );
    clsId = (await pg.query(
      'INSERT INTO classes (class_name, grade, grade_id, academic_year, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [CNAME, GRADE, g.rows[0].id, '2025-2026', 'active']
    )).rows[0].id;

    // 管理员新建教师（不填学科/班级）→ 默认未锁定，待教师首次确认
    let r = await api('/api/users', {
      method: 'POST', cookie: cAdmin,
      body: { username: PRE + 'new', password: '123456', role: 'teacher', realName: '新教师（锁定测试）', teachingClasses: [] },
    });
    check('1) 管理员新建教师 → 201 且 profileLocked=false（待确认）',
      r.status === 201 && r.data.user.profileLocked === false, r.data && r.data.user && r.data.user.profileLocked);
    const tNewId = r.data.user.id;

    // 1) 首次登录：登录响应 + /auth/me + /teacher/settings 都提示需要确认
    const lgNew = await login(PRE + 'new');
    check('1) 登录响应 needProfileSetup=true', lgNew.data.needProfileSetup === true, lgNew.data);
    const cNew = lgNew.cookie;
    r = await api('/api/auth/me', { cookie: cNew });
    check('1) /auth/me profileLocked=false 且 needProfileSetup=true',
      r.data.user.profileLocked === false && r.data.user.needProfileSetup === true,
      { l: r.data.user.profileLocked, n: r.data.user.needProfileSetup });
    r = await api('/api/teacher/settings', { cookie: cNew });
    check('1) GET /teacher/settings canEdit=true（首次可编辑）',
      r.status === 200 && r.data.canEdit === true && r.data.profileLocked === false && r.data.classes.length === 0, r.data);
    check('1) 未选学科时不允许锁定 → 400',
      (await api('/api/teacher/classes', { method: 'PUT', cookie: cNew, body: { classIds: [clsId], lock: true } })).status === 400);
    check('1) 非法学科 → 400',
      (await api('/api/teacher/subject', { method: 'PUT', cookie: cNew, body: { subject: '体育课' } })).status === 400);

    // 2) 首次确认：一次提交学科 + 班级 + lock → 保存并锁定
    r = await api('/api/teacher/classes', {
      method: 'PUT', cookie: cNew,
      body: { subject: '物理', classIds: [clsId], lock: true },
    });
    check('2) 首次「确认并锁定」→ 200 且 profileLocked=true',
      r.status === 200 && r.data.profileLocked === true && r.data.subject === '物理', r.data);
    check('2) 带班记录写入为任课老师',
      (r.data.classes || []).length === 1 && r.data.classes[0].roleInClass === 'subject_teacher' &&
      r.data.classes[0].classId === clsId, r.data.classes);
    const dbRow = (await pg.query('SELECT subject, profile_locked, roles::text AS roles FROM users WHERE id = $1', [tNewId])).rows[0];
    check('2) 数据库 profile_locked=true / subject=物理 / roles=subject_teacher',
      dbRow.profile_locked === true && dbRow.subject === '物理' && dbRow.roles === '["subject_teacher"]', dbRow);

    // 3) 锁定后：读可、写禁
    r = await api('/api/teacher/settings', { cookie: cNew });
    check('3) 锁定后 GET settings：canEdit=false，回显学科与班级角色',
      r.status === 200 && r.data.canEdit === false && r.data.profileLocked === true && r.data.subject === '物理' &&
      r.data.classes.length === 1 && r.data.classes[0].roleInClass === 'subject_teacher', r.data);
    check('3) 锁定后提示语 = 教学设置已锁定，如需修改请联系管理员',
      r.data.hint === '教学设置已锁定，如需修改请联系管理员', r.data.hint);
    const putSub = await api('/api/teacher/subject', { method: 'PUT', cookie: cNew, body: { subject: '数学' } });
    check('3) 锁定后 PUT 学科 → 403', putSub.status === 403 && putSub.data.profileLocked === true, putSub.data);
    const putCls = await api('/api/teacher/classes', { method: 'PUT', cookie: cNew, body: { classIds: [] } });
    check('3) 锁定后 PUT 班级 → 403', putCls.status === 403, putCls.data);
    const after = (await pg.query('SELECT subject FROM users WHERE id = $1', [tNewId])).rows[0];
    const afterTc = (await pg.query('SELECT count(*)::int n FROM teacher_classes WHERE teacher_id = $1', [tNewId])).rows[0].n;
    check('3) 越权写入未生效（学科仍=物理，班级记录仍 1 条）', after.subject === '物理' && afterTc === 1, { subject: after.subject, n: afterTc });

    // 4) 管理员可改：学科 + 班级 + 带班角色（班主任）；锁定状态保持 true
    r = await api('/api/users/' + tNewId, {
      method: 'PUT', cookie: cAdmin,
      body: {
        role: 'teacher', realName: '新教师（锁定测试）', isActive: true, subject: '化学',
        teachingClasses: [{ classId: clsId, roleInClass: 'head_teacher' }],
      },
    });
    check('4) 管理员修改教师教学设置 → 200', r.status === 200, r.data);
    check('4) profile_locked 保持 true（管理员修改不解除锁定）', r.data.user.profileLocked === true, r.data.user.profileLocked);
    r = await api('/api/teacher/settings', { cookie: cNew });
    check('4) 教师端显示已更新（学科=化学；班级角色=班主任）',
      r.data.subject === '化学' && r.data.classes.length === 1 && r.data.classes[0].roleInClass === 'head_teacher' &&
      r.data.classes[0].classId === clsId, r.data);
    check('4) 管理员设班主任后 roles 升为 head_teacher',
      String((await pg.query('SELECT roles::text r FROM users WHERE id = $1', [tNewId])).rows[0].r) === '["head_teacher"]');

    // 5) 管理员"重置为待确认" → 教师可再次修改，且改完仍可重新锁定
    r = await api('/api/users/' + tNewId, {
      method: 'PUT', cookie: cAdmin,
      body: {
        role: 'teacher', realName: '新教师（锁定测试）', isActive: true, subject: '化学',
        teachingClasses: [{ classId: clsId, roleInClass: 'head_teacher' }],
        resetProfileLock: true,
      },
    });
    check('5) 管理员重置为待确认 → profileLocked=false', r.status === 200 && r.data.user.profileLocked === false, r.data.user.profileLocked);
    r = await api('/api/teacher/settings', { cookie: cNew });
    check('5) 教师端恢复可编辑（canEdit=true，数据仍保留）',
      r.data.canEdit === true && r.data.subject === '化学' && r.data.classes.length === 1, r.data);
    const putAgain = await api('/api/teacher/classes', {
      method: 'PUT', cookie: cNew,
      body: { subject: '化学', classIds: [clsId], lock: true },
    });
    check('5) 教师再次确认锁定 → 200 且 profileLocked=true', putAgain.status === 200 && putAgain.data.profileLocked === true, putAgain.data);
    check('5) 班主任班级自动保留（不可被取消）',
      (putAgain.data.classes || []).some((c) => c.classId === clsId && c.roleInClass === 'head_teacher'), putAgain.data.classes);

    // 6) 权限矩阵：非教师角色
    const mons = (await pg.query("SELECT id, class_id, username FROM users WHERE role = 'monitor' ORDER BY id")).rows;
    let cMon = null;
    for (const m of mons) { const c = await tryLogin(m.username); if (c) { cMon = c.cookie; break; } }
    if (cMon) {
      check('6) 班长 GET /teacher/settings → 403', (await api('/api/teacher/settings', { cookie: cMon })).status === 403);
      check('6) 班长 PUT /teacher/classes → 403',
        (await api('/api/teacher/classes', { method: 'PUT', cookie: cMon, body: { classIds: [] } })).status === 403);
    } else {
      console.log('  · 跳过班长断言（无默认密码的班长账号）');
    }
    check('6) 管理员 GET /teacher/settings → 403（管理员用账号管理页）',
      (await api('/api/teacher/settings', { cookie: cAdmin })).status === 403);

    // 7) 真实教师账号的锁定状态与基线一致（新增教师可能仍是"待首次确认"，属正常业务状态）
    const realTeachers = await pg.query(
      "SELECT username, profile_locked::text AS l FROM users WHERE role = 'teacher' AND username NOT LIKE $1 ORDER BY username",
      [PRE + '%']
    );
    check('7) 真实教师账号锁定状态未被测试改动',
      JSON.stringify(realTeachers.rows) === JSON.stringify(base.lockMap),
      { before: base.lockMap, after: realTeachers.rows });

    // ---------- 清理与真实数据核对 ----------
    await cleanup();
    const afterBase = {
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
      classes: (await pg.query('SELECT count(*)::int n FROM classes')).rows[0].n,
      tc: (await pg.query('SELECT count(*)::int n FROM teacher_classes')).rows[0].n,
      locked: (await pg.query('SELECT count(*)::int n FROM users WHERE role = $1 AND profile_locked = true', ['teacher'])).rows[0].n,
      heads: (await pg.query('SELECT id, head_teacher_id FROM classes ORDER BY id')).rows,
    };
    check('8) 真实数据未变（users/classes/teacher_classes/锁定教师数）',
      base.users === afterBase.users && base.classes === afterBase.classes && base.tc === afterBase.tc && base.locked === afterBase.locked,
      { base, afterBase });
    check('8) 真实班级班主任未变', JSON.stringify(base.heads) === JSON.stringify(afterBase.heads), { b: base.heads, a: afterBase.heads });
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
