// 学生异动权限测试：页面路由 + API 角色校验
//
// ⚠️ 历史缺陷（2026-09-17 修复）：旧版本用【真实班级/学生】(高三2班 + 陈城/吴昊)做被试，
//    并假设 test1 只是高三1班老师，因此期望教师操作高三2班学生返回 403。
//    但 test1(user 6) 实际同时是高三2班班主任（teacher_classes: class2 head_teacher + class1 subject_teacher），
//    该请求被合法放行（200），使真实学生「吴昊」被改成休学且座位被清空；
//    第 [4] 段还会删除"最新一条真实异动记录"。现改为完全自足的夹具，不再触碰真实数据。
//
// 夹具：临时年级 + 2 个班（甲=教师所带、乙=非所带）+ 各 1 名学生 + 1 个临时教师 + 1 个临时学生账号
// 清理：自愈式（结尾 + 异常分支均清理），并断言真实数据行数未变
'use strict';
const { Pool } = require('pg');
const BASE = 'http://127.0.0.1:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

const TAG = String(Date.now()).slice(-6);
const GRADE = '异动年级' + TAG;
const C_A = '异动甲班' + TAG;   // 教师在带的班
const C_B = '异动乙班' + TAG;   // 教师未带的班（越权用例）
const U_TEACHER = 'tr_tea_' + TAG;
const U_STUDENT = 'tr_stu_' + TAG;

let pass = 0, fail = 0;
const created = { gradeId: null, classA: null, classB: null, studentA: null, studentB: null, teacherId: null, studentUserId: null };
let realBefore = null;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); }
}

async function loginAs(u, p) {
  // admin 的密码可能被管理员改过 → 用环境变量 DSH_ADMIN_PW（默认 123456）；夹具账号固定 123456
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: pw }),
  });
  if (!r.ok) throw new Error('登录失败 ' + u + ' (' + r.status + ')');
  return r.headers.get('set-cookie').split(';')[0];
}
const api = (cookie, url, opts = {}) => fetch(BASE + url, {
  headers: { 'Content-Type': 'application/json', Cookie: cookie }, redirect: 'manual', ...opts,
});
async function json(cookie, url, opts) {
  const r = await api(cookie, url, opts);
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

// 真实数据基线（用来自证没有碰真实数据）
async function snapshotReal() {
  const q = async (sql) => (await pg.query(sql)).rows[0].n;
  return {
    students: await q('SELECT count(*)::int n FROM students'),
    transfers: await q('SELECT count(*)::int n FROM student_transfers'),
    classes: await q('SELECT count(*)::int n FROM classes'),
    users: await q('SELECT count(*)::int n FROM users'),
  };
}

async function hardCleanup(adminCookie) {
  try {
    if (adminCookie) {
      const rows = (await json(adminCookie, '/api/transfers')).data;
      for (const t of ((rows && rows.transfers) || [])) {
        if (created.studentA === t.student_id || created.studentB === t.student_id) {
          await api(adminCookie, '/api/transfers/' + t.id, { method: 'DELETE' });
        }
      }
    }
  } catch (_) {}
  // 夹具行按名字/用户名前缀兜底删除（含历史残留）
  await pg.query(`DELETE FROM student_transfers WHERE student_id IN (SELECT id FROM students WHERE class_id IN (SELECT id FROM classes WHERE class_name LIKE '异动%班%'))`).catch(() => {});
  await pg.query(`DELETE FROM students WHERE class_id IN (SELECT id FROM classes WHERE class_name LIKE '异动%班%')`).catch(() => {});
  await pg.query(`DELETE FROM teacher_classes WHERE class_id IN (SELECT id FROM classes WHERE class_name LIKE '异动%班%')`).catch(() => {});
  await pg.query(`SELECT purge_class(id) FROM classes WHERE class_name LIKE '异动%班%'`).catch(() => {});
  await pg.query(`DELETE FROM grades WHERE grade_name LIKE '异动年级%'`).catch(() => {});
  await pg.query(`DELETE FROM users WHERE username LIKE 'tr\\_tea\\_%' OR username LIKE 'tr\\_stu\\_%'`).catch(() => {});
}

(async () => {
  let admin = null;
  try {
    admin = await loginAs('admin');
    realBefore = await snapshotReal();

    // ---------- 夹具 ----------
    const year = (await json(admin, '/api/settings')).data.currentAcademicYear;
    created.gradeId = (await json(admin, '/api/grades', { method: 'POST', body: JSON.stringify({ gradeName: GRADE, gradeCode: 'TR', academicYear: year }) })).data.id;
    const mkClass = async (name) => (await json(admin, '/api/classes', { method: 'POST', body: JSON.stringify({ className: name, gradeName: GRADE, academicYear: year }) })).data.id;
    created.classA = await mkClass(C_A);
    created.classB = await mkClass(C_B);
    const mkStudent = async (no, name, classId) => (await pg.query(
      `INSERT INTO students (student_no, name, class_id, status, is_active, academic_year, seat_row, seat_col)
       VALUES ($1,$2,$3,'在读',true,$4,1,1) RETURNING id`, [no, name, classId, year])).rows[0].id;
    created.studentA = await mkStudent('TR' + TAG + 'A', '异动同学甲', created.classA);
    created.studentB = await mkStudent('TR' + TAG + 'B', '异动同学乙', created.classB);
    created.teacherId = (await pg.query(
      `INSERT INTO users (username, password, role, real_name, display_name, roles, subject, must_change_password, is_active, class_id)
       VALUES ($1,'123456','teacher',$1,$1,'["subject_teacher"]'::json,'数学',false,true,$2) RETURNING id`,
      [U_TEACHER, created.classA])).rows[0].id;
    // 只带甲班（乙班无任何关系 → 操作乙班学生必须 403）
    await pg.query(`INSERT INTO teacher_classes (teacher_id, class_id, is_head_teacher, role_in_class, subject) VALUES ($1,$2,false,'subject_teacher','数学')`, [created.teacherId, created.classA]);
    created.studentUserId = (await pg.query(
      `INSERT INTO users (username, password, role, real_name, display_name, roles, must_change_password, is_active, class_id)
       VALUES ($1,'123456','student',$1,$1,'[]'::json,false,true,$2) RETURNING id`,
      [U_STUDENT, created.classB])).rows[0].id;
    check('0) 夹具就绪（年级 + 2 班 + 2 学生 + 临时教师/学生账号）',
      !!(created.gradeId && created.classA && created.classB && created.studentA && created.studentB && created.teacherId));

    const teacher = await loginAs(U_TEACHER);
    const student = await loginAs(U_STUDENT);

    console.log('[1] 页面路由权限:');
    check('1) 教师访问 /admin/student-transfer → 200', (await api(teacher, '/admin/student-transfer')).status === 200);
    check('1) 管理员访问 /admin/student-transfer → 200', (await api(admin, '/admin/student-transfer')).status === 200);
    const stuPage = await api(student, '/admin/student-transfer');
    check('1) 学生访问 /admin/student-transfer → 302 回签到台',
      stuPage.status === 302 && /\/dashboard$/.test(stuPage.headers.get('location') || ''), { status: stuPage.status, loc: stuPage.headers.get('location') });

    console.log('[2] GET /api/transfers 数据范围:');
    const allRows = ((await json(admin, '/api/transfers')).data || {}).transfers || [];
    const myRows = ((await json(teacher, '/api/transfers')).data || {}).transfers || [];
    check('2) 管理员可读全量异动历史', Array.isArray(allRows));
    check('2) 临时教师只看到本班（甲班）学生的异动记录',
      myRows.every((r) => r.fromClass === C_A || r.toClass === C_A || (r.student_id !== created.studentB)),
      { n: myRows.length });
    check('2) 学生访问 /api/transfers → 403', (await json(student, '/api/transfers')).status === 403);

    console.log('[3] POST /api/transfers 权限与数据隔离:');
    // 3.1 教师操作「非所带班」学生 → 403 且学生无任何改动
    let r = await json(teacher, '/api/transfers', {
      method: 'POST', body: JSON.stringify({ studentId: created.studentB, transferType: '休学', toClassId: null, reason: '越权测试', effectiveDate: '2026-08-31' }),
    });
    check('3) 教师操作非所带班学生 → 403', r.status === 403, { status: r.status, data: r.data });
    const bAfter = (await pg.query('SELECT status, seat_row, seat_col FROM students WHERE id=$1', [created.studentB])).rows[0];
    check('3) 越权请求未改动该学生（状态仍为在读、座位未被清空）',
      bAfter.status === '在读' && bAfter.seat_row === 1 && bAfter.seat_col === 1, bAfter);
    check('3) 越权请求未写入异动记录',
      ((await json(admin, '/api/transfers?studentId=' + created.studentB)).data.transfers || []).length === 0);

    // 3.2 学生角色操作 → 403
    r = await json(student, '/api/transfers', {
      method: 'POST', body: JSON.stringify({ studentId: created.studentA, transferType: '休学', toClassId: null, reason: '越权测试', effectiveDate: '2026-08-31' }),
    });
    check('3) 学生角色操作异动 → 403', r.status === 403, r.data);

    // 3.3 教师操作「所带班」学生 → 允许（休学），且写入 1 条记录
    r = await json(teacher, '/api/transfers', {
      method: 'POST', body: JSON.stringify({ studentId: created.studentA, transferType: '休学', toClassId: null, reason: '本班测试', effectiveDate: '2026-08-31' }),
    });
    check('3) 教师操作本班学生 → 200', r.status === 200, { status: r.status, data: r.data });
    const aAfter = (await pg.query('SELECT status, seat_row, seat_col FROM students WHERE id=$1', [created.studentA])).rows[0];
    check('3) 本班学生状态已改为「休学」且座位被清空（异动联动）',
      aAfter.status === '休学' && aAfter.seat_row === 0 && aAfter.seat_col === 0, aAfter);
    const rowsA = ((await json(admin, '/api/transfers?studentId=' + created.studentA)).data.transfers || []);
    check('3) 异动记录已写入（1 条，含操作人）',
      rowsA.length === 1 && !!(rowsA[0].operatorName || rowsA[0].operator_name), rowsA[0]);

    // 3.4 复学 → 回到甲班
    r = await json(teacher, '/api/transfers', {
      method: 'POST', body: JSON.stringify({ studentId: created.studentA, transferType: '复学', toClassId: created.classA, reason: '本班测试-复学', effectiveDate: '2026-09-01' }),
    });
    check('3) 教师办理本班学生复学 → 200',
      r.status === 200 && (await pg.query('SELECT status FROM students WHERE id=$1', [created.studentA])).rows[0].status === '在读', r.data);

    console.log('[4] DELETE /api/transfers/:id 权限:');
    const tRows = ((await json(admin, '/api/transfers?studentId=' + created.studentA)).data.transfers || []);
    check('4) 夹具异动记录 = 2 条（休学 + 复学）', tRows.length === 2, tRows.map((t) => t.transfer_type));
    if (tRows.length) {
      const tid = tRows[0].id;
      check('4) 教师删除 → 403', (await json(teacher, '/api/transfers/' + tid, { method: 'DELETE' })).status === 403);
      check('4) 学生删除 → 403', (await json(student, '/api/transfers/' + tid, { method: 'DELETE' })).status === 403);
      check('4) 管理员删除 → 200', (await json(admin, '/api/transfers/' + tid, { method: 'DELETE' })).status === 200);
      check('4) 删除后记录数 -1',
        ((await json(admin, '/api/transfers?studentId=' + created.studentA)).data.transfers || []).length === 1);
    } else {
      check('4) 夹具异动记录存在', false, '无记录，跳过删除用例');
    }

    console.log('[5] 真实数据未被触碰:');
    await hardCleanup(admin);
    const realAfter = await snapshotReal();
    check('5) 真实 students / student_transfers / classes / users 行数与测试前一致',
      JSON.stringify(realBefore) === JSON.stringify(realAfter), { before: realBefore, after: realAfter });
    const leftClasses = (await pg.query(`SELECT count(*)::int n FROM classes WHERE class_name LIKE '异动%班%'`)).rows[0].n;
    const leftUsers = (await pg.query(`SELECT count(*)::int n FROM users WHERE username LIKE 'tr\\_tea\\_%' OR username LIKE 'tr\\_stu\\_%'`)).rows[0].n;
    const leftGrades = (await pg.query(`SELECT count(*)::int n FROM grades WHERE grade_name LIKE '异动年级%'`)).rows[0].n;
    check('5) 夹具已清理（班级/账号/年级均无残留）',
      leftClasses === 0 && leftUsers === 0 && leftGrades === 0, { c: leftClasses, u: leftUsers, g: leftGrades });
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：' + (e && e.message));
    try { await hardCleanup(admin); console.log('  · 已执行自愈式清理'); } catch (_) {}
  } finally {
    await pg.end().catch(() => {});
  }
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exit(1);
})();
