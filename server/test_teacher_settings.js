// ============================================================
// 教师教学设置 API 测试：只读读取 + 权限矩阵 + 管理员联动
//   GET  /api/teacher/settings            教学设置（学科 + 所带班级 + 锁定状态）
//   GET  /api/teacher/subject             所教学科
//   GET  /api/teacher/classes             所带班级
//   PUT  /api/teacher/subject|classes     锁定后 403（教师不可自行修改，仅管理员可改）
//   管理员修改：PUT /api/users/:id（学科 + 带班记录 + 带班角色）→ 教师端立即显示更新
// 首次登录"确认并锁定"的完整生命周期见 test_profile_lock.js
// 夹具：临时教师（直接 SQL 建 teacher_classes，不动 classes 表）+ 临时班长/学生；结束后清理
// ============================================================
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
async function tryLogin(u, p = '123456') {
  try { return await login(u, p); } catch (_) { return null; }
}
async function mkUser(username, role, classId, subject, locked) {
  const r = await pg.query(
    `INSERT INTO users (username, password, role, class_id, real_name, display_name, roles, subject, profile_locked, must_change_password, is_active)
     VALUES ($1, '123456', $2, $3, $1, $1, '[]'::json, $4, $5, false, true) RETURNING id`,
    [username, role, classId, subject, locked]
  );
  return r.rows[0].id;
}

const PRE = 'tch_set_';
const NAMES = [PRE + 'a', PRE + 'b', PRE + 'mon', PRE + 'stu'];

async function cleanup() {
  const uids = (await pg.query('SELECT id FROM users WHERE username LIKE $1', [PRE + '%'])).rows.map((r) => r.id);
  if (uids.length) {
    await pg.query('DELETE FROM teacher_classes WHERE teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM operation_logs WHERE user_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM users WHERE id = ANY($1::int[])', [uids]).catch((e) => console.log('  · 清理账号失败：', e.message));
  }
}

(async () => {
  try {
    await cleanup();
    const base = {
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
      tc: (await pg.query('SELECT count(*)::int n FROM teacher_classes')).rows[0].n,
      heads: (await pg.query('SELECT id, head_teacher_id FROM classes ORDER BY id')).rows,
    };

    // 夹具：教师A（已锁定；class1 任课老师 + class2 班主任，学科数学）
    //       教师B（已锁定；class2 任课老师，学科语文）；班长/学生各一
    const tA = await mkUser(PRE + 'a', 'teacher', null, '数学', true);
    const tB = await mkUser(PRE + 'b', 'teacher', null, '语文', true);
    await pg.query("INSERT INTO teacher_classes (teacher_id, class_id, role_in_class) VALUES ($1, 1, 'subject_teacher'), ($1, 2, 'head_teacher')", [tA]);
    await pg.query("INSERT INTO teacher_classes (teacher_id, class_id, role_in_class) VALUES ($1, 2, 'subject_teacher')", [tB]);
    await mkUser(PRE + 'mon', 'monitor', 1, null, false);
    await mkUser(PRE + 'stu', 'student', 1, null, false);
    const cA = await login(PRE + 'a');
    const cB = await login(PRE + 'b');
    const cMon = await tryLogin(PRE + 'mon');
    const cStu = await login(PRE + 'stu');
    const cAdmin = await login('admin');

    // 1) 读取：学科
    let r = await api('/api/teacher/subject', { cookie: cA });
    check('1) GET subject → 数学 且只读（canEdit=false）',
      r.status === 200 && r.data.subject === '数学' && r.data.canEdit === false && r.data.profileLocked === true, r.data);

    // 2) 读取：所带班级（含在该班角色）
    r = await api('/api/teacher/classes', { cookie: cA });
    const byId = new Map((r.data.classes || []).map((c) => [c.classId, c]));
    check('2) GET classes → 2 个班级且角色正确（class1 任课 / class2 班主任）',
      r.status === 200 && r.data.classes.length === 2 &&
      byId.get(1).roleInClass === 'subject_teacher' && byId.get(2).roleInClass === 'head_teacher', r.data.classes);
    check('2) 返回含班级名 + 班主任班级 headClassIds=[2]',
      (r.data.classes || []).every((c) => !!c.className) && JSON.stringify(r.data.headClassIds) === '[2]',
      { names: (r.data.classes || []).map((c) => c.className), heads: r.data.headClassIds });

    // 3) 读取：settings 汇总
    r = await api('/api/teacher/settings', { cookie: cA });
    check('3) GET settings → 学科/班级/锁定状态齐全且只读',
      r.status === 200 && r.data.subject === '数学' && r.data.classes.length === 2 &&
      r.data.canEdit === false && r.data.profileLocked === true &&
      r.data.hint === '教学设置已锁定，如需修改请联系管理员', r.data);

    // 4) 写入：已锁定 → 403（教师不可自行修改学科/班级/带班角色）
    check('4) PUT subject → 403（已锁定）',
      (await api('/api/teacher/subject', { method: 'PUT', cookie: cA, body: { subject: '英语' } })).status === 403);
    check('4) PUT classes → 403（已锁定）',
      (await api('/api/teacher/classes', { method: 'PUT', cookie: cA, body: { classIds: [1, 2, 3] } })).status === 403);
    check('4) PUT classes 带 lock → 403（已锁定）',
      (await api('/api/teacher/classes', { method: 'PUT', cookie: cA, body: { classIds: [1], lock: true } })).status === 403);
    const dbA = (await pg.query('SELECT subject FROM users WHERE id = $1', [tA])).rows[0];
    const tcA = (await pg.query('SELECT class_id, role_in_class FROM teacher_classes WHERE teacher_id = $1 ORDER BY class_id', [tA])).rows;
    check('4) 越权写入未生效（学科仍数学，带班记录仍 2 条且角色不变）',
      dbA.subject === '数学' && tcA.length === 2 && tcA[0].role_in_class === 'subject_teacher' && tcA[1].role_in_class === 'head_teacher',
      { subject: dbA.subject, tcA });

    // 5) 权限：非教师不可读/写
    for (const [name, ck] of [['学生', cStu], ['管理员', cAdmin]]) {
      check(`5) ${name} GET settings → 403`, (await api('/api/teacher/settings', { cookie: ck })).status === 403);
      check(`5) ${name} PUT classes → 403`,
        (await api('/api/teacher/classes', { method: 'PUT', cookie: ck, body: { classIds: [1] } })).status === 403);
    }
    if (cMon) {
      check('5) 班长 GET subject → 403', (await api('/api/teacher/subject', { cookie: cMon })).status === 403);
    }

    // 6) 数据隔离：教师B只看到自己的
    r = await api('/api/teacher/classes', { cookie: cB });
    check('6) 教师B只看到 class2（不受教师A影响）',
      r.data.classes.length === 1 && r.data.classes[0].classId === 2 && r.data.classes[0].roleInClass === 'subject_teacher', r.data.classes);
    check('6) 教师B学科=语文', (await api('/api/teacher/subject', { cookie: cB })).data.subject === '语文');

    // 7) 管理员可改：学科 + 带班记录 + 带班角色 → 教师端立即更新
    r = await api('/api/users/' + tA, {
      method: 'PUT', cookie: cAdmin,
      body: {
        role: 'teacher', realName: PRE + 'a（修改后）', isActive: true, subject: '物理',
        teachingClasses: [
          { classId: 1, roleInClass: 'head_teacher' },
          { classId: 2, roleInClass: 'subject_teacher' },
        ],
      },
    });
    check('7) 管理员修改教师学科/班级/角色 → 200 且仍锁定',
      r.status === 200 && r.data.user.profileLocked === true && r.data.user.subject === '物理', r.data && r.data.user);
    r = await api('/api/teacher/settings', { cookie: cA });
    const after = new Map((r.data.classes || []).map((c) => [c.classId, c]));
    check('7) 教师端显示已更新（学科物理；class1 班主任、class2 任课老师）',
      r.data.subject === '物理' && r.data.classes.length === 2 &&
      after.get(1).roleInClass === 'head_teacher' && after.get(2).roleInClass === 'subject_teacher', r.data);
    check('7) 角色汇总同步（有班主任班级 → roles=head_teacher）',
      String((await pg.query('SELECT roles::text r FROM users WHERE id = $1', [tA])).rows[0].r) === '["head_teacher"]');
    check('7) 教师仍不能自行修改（403）',
      (await api('/api/teacher/subject', { method: 'PUT', cookie: cA, body: { subject: '数学' } })).status === 403);
    check('7) /auth/me 返回最新教学信息（profileLocked=true, teachClassIds=[1,2]）',
      await (async () => {
        const me = await api('/api/auth/me', { cookie: cA });
        return me.data.user.profileLocked === true && me.data.user.subject === '物理' &&
          JSON.stringify([...me.data.user.teachClassIds].sort()) === '[1,2]';
      })());

    // 8) 管理员"重置为待确认" → 教师端变为可编辑（数据保留）
    r = await api('/api/users/' + tA, {
      method: 'PUT', cookie: cAdmin,
      body: {
        role: 'teacher', realName: PRE + 'a（修改后）', isActive: true, subject: '物理',
        teachingClasses: [
          { classId: 1, roleInClass: 'head_teacher' },
          { classId: 2, roleInClass: 'subject_teacher' },
        ],
        resetProfileLock: true,
      },
    });
    check('8) 重置为待确认 → profileLocked=false', r.status === 200 && r.data.user.profileLocked === false, r.data.user.profileLocked);
    r = await api('/api/teacher/settings', { cookie: cA });
    check('8) 教师端 canEdit=true 且数据保留（物理 / 2 个班级）',
      r.data.canEdit === true && r.data.subject === '物理' && r.data.classes.length === 2, r.data);

    // ---------- 清理与真实数据核对 ----------
    await cleanup();
    const afterBase = {
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
      tc: (await pg.query('SELECT count(*)::int n FROM teacher_classes')).rows[0].n,
      heads: (await pg.query('SELECT id, head_teacher_id FROM classes ORDER BY id')).rows,
    };
    check('9) 真实数据未变（users / teacher_classes）',
      base.users === afterBase.users && base.tc === afterBase.tc, { base, afterBase });
    check('9) 真实班级班主任未变', JSON.stringify(base.heads) === JSON.stringify(afterBase.heads), { b: base.heads, a: afterBase.heads });
  } catch (e) {
    console.error('测试异常:', e.message);
    fail++;
    try { await cleanup(); } catch (_) {}
  } finally {
    await pg.end().catch(() => {});
    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
    console.log('清理完成');
  }
  process.exitCode = fail ? 1 : 0;
})();
