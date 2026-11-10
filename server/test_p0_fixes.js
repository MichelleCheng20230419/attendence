// ============================================================
// P0 数据库设计修复测试（migration_v29_p0_fixes.sql + 代码收敛）
//   问题二 班主任三处来源对齐 + 收敛写入源
//     1) classes.head_teacher_id 为权威字段，teacher_id 遗留列保持同值
//        （管理员建班/改班、新建教师账号带班、教师端保存带班记录、个人资料改班级）
//     2) 班主任唯一：同一教师不会同时是两个班的班主任（classes 与 teacher_classes 同步降级）
//     3) 删除教师账号不再被班级引用阻塞：classes.head_teacher_id/deputy_teacher_id → SET NULL
//     4) 学年组合导入（Excel 多 Sheet）复制班级时班主任落到 head_teacher_id
//     5) 学年一键升级的班级复制语句以 head_teacher_id 为准（源码级守卫；
//        该接口会真实迁移学生，测试中不调用）
//   问题四 ck_sessions_source：start_source ∈ {plan, manual, makeup}
//   问题六第 1 步 students.deleted_at 软删除
//     删除学生 = 软删除（is_active=false / status='deleted' / deleted_at 有值），
//     考勤、作业、巡堂、点赞历史全部保留；列表/搜索不再出现；重新导入同学号 → 复活同一行
//   测完清理并核对真实基线
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); }
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
async function apiUpload(p, buf, filename, cookie) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  const res = await fetch(BASE + p, { method: 'POST', headers: { Cookie: cookie }, body: fd, redirect: 'manual' });
  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('application/json')) { try { data = await res.json(); } catch (_) {} }
  return { status: res.status, data };
}
async function login(u, p) {
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('登录失败 ' + u + ': ' + r.status);
  const m = r.setc.match(/connect\.sid=([^;]+)/);
  return 'connect.sid=' + m[1];
}
const n1 = async (sql, params = []) => (await pg.query(sql, params)).rows[0].n;
const listOf = (d) => (d && (d.classes || d.rows || d.students || d.data)) || (Array.isArray(d) ? d : []);

const TAG = String(Date.now()).slice(-6);
const GRADE = 'P0年级' + TAG;
const CLASS_A = 'P0甲班' + TAG, CLASS_B = 'P0乙班' + TAG, CLASS_C = 'P0丙班' + TAG, CLASS_D = 'P0丁班' + TAG;
const T1 = 'p0_tea1_' + TAG, T2 = 'p0_tea2_' + TAG, T3 = 'p0_tea3_' + TAG;
const created = { gradeId: null, classIds: [], userIds: [], studentIds: [], sessionIds: [], taskIds: [] };
let realBefore = null;
let admin = null;
const t = {}; let stu = null, stuNo = null, recBefore = null;

async function snapshotReal() {
  return {
    users: await n1('SELECT count(*)::int n FROM users'),
    grades: await n1('SELECT count(*)::int n FROM grades'),
    classes: await n1('SELECT count(*)::int n FROM classes'),
    students: await n1('SELECT count(*)::int n FROM students'),
    sessions: await n1('SELECT count(*)::int n FROM attendance_sessions'),
    records: await n1('SELECT count(*)::int n FROM attendance_records'),
    plans: await n1('SELECT count(*)::int n FROM attendance_plans'),
    homework: await n1('SELECT count(*)::int n FROM homework_submissions'),
    rollcall: await n1('SELECT count(*)::int n FROM rollcall_records'),
    likes: await n1('SELECT count(*)::int n FROM student_likes'),
    teacherClasses: await n1('SELECT count(*)::int n FROM teacher_classes'),
  };
}
async function hardCleanup() {
  const warn = (l) => (e) => console.log('  · 清理失败（' + l + '）：' + e.message);
  const sids = (await pg.query("SELECT id FROM students WHERE student_no LIKE 'P0%'")).rows.map((r) => r.id);
  if (sids.length) {
    await pg.query('DELETE FROM attendance_records WHERE student_id = ANY($1::int[])', [sids]).catch(warn('records'));
    await pg.query('DELETE FROM homework_submissions WHERE student_id = ANY($1::int[])', [sids]).catch(warn('hwsub'));
    await pg.query('DELETE FROM rollcall_records WHERE student_id = ANY($1::int[])', [sids]).catch(warn('rollcall'));
    await pg.query('DELETE FROM student_likes WHERE student_id = ANY($1::int[])', [sids]).catch(warn('likes'));
    await pg.query('DELETE FROM students WHERE id = ANY($1::int[])', [sids]).catch(warn('students'));
  }
  await pg.query("DELETE FROM homework_tasks WHERE title = 'P0作业'").catch(warn('tasks'));
  if (created.sessionIds.length) {
    await pg.query('DELETE FROM attendance_sessions WHERE id = ANY($1::int[])', [created.sessionIds]).catch(warn('sessions'));
  }
  // 顺序：班级 → 账号（teacher_classes 随账号 CASCADE）→ 年级
  await pg.query("SELECT purge_class(id) FROM classes WHERE class_name LIKE 'P0%'").catch(warn('classes'));
  await pg.query("DELETE FROM users WHERE username LIKE 'p0\\_%'").catch(warn('users'));
  await pg.query("DELETE FROM grades WHERE grade_name LIKE 'P0%'").catch(warn('grades'));
}

(async () => {
  try {
    console.log('0) 夹具准备…');
    realBefore = await snapshotReal();
    admin = await login('admin');
    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;

    const g = await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'P0', academicYear: year } });
    created.gradeId = g.data.id;
    const mkClass = async (name, headTeacherId) => {
      const r = await api('/api/classes', {
        method: 'POST', cookie: admin,
        body: { className: name, gradeName: GRADE, academicYear: year, headTeacherId },
      });
      if (r.status !== 201) throw new Error('创建班级失败 ' + name + ' ' + JSON.stringify(r.data));
      created.classIds.push(r.data.id);
      return r.data.id;
    };
    const clsA = await mkClass(CLASS_A, null);
    const clsB = await mkClass(CLASS_B, null);
    const clsC = await mkClass(CLASS_C, null);
    const mkTeacher = async (u, classId, locked) => {
      const r = await api('/api/users', {
        method: 'POST', cookie: admin,
        body: { username: u, password: '123456', role: 'teacher', realName: u, classId, mustChangePassword: false, profileLocked: locked !== false },
      });
      if (r.status !== 201) throw new Error('创建账号失败 ' + u + ' ' + JSON.stringify(r.data));
      const id = r.data.user.id;
      created.userIds.push(id);
      return { id, cookie: await login(u) };
    };
    t.t1 = await mkTeacher(T1, clsA);   // 新建教师带班 → 甲班班主任
    t.t2 = await mkTeacher(T2, clsB);   // 乙班班主任
    t.t3 = await mkTeacher(T3, clsC, false); // 未锁定教学设置，便于验证教师端保存班级
    check('0) 夹具就绪（1 年级 + 3 班 + 3 教师账号）',
      !!created.gradeId && created.classIds.length === 3 && created.userIds.length === 3, created);

    const clsRow = async (id) => (await pg.query(
      'SELECT head_teacher_id, teacher_id, deputy_teacher_id FROM classes WHERE id = $1', [id]
    )).rows[0];
    const tcRow = async (cid, tid) => (await pg.query(
      'SELECT role_in_class, is_head_teacher FROM teacher_classes WHERE class_id = $1 AND teacher_id = $2', [cid, tid]
    )).rows[0];

    // ---------- 1) 班主任三处来源对齐 ----------
    console.log('1) 班主任来源对齐（问题二）:');
    let rA = await clsRow(clsA);
    check('1) 新建教师账号带班 → 甲班 head_teacher_id 与 teacher_id 同值（=T1）',
      rA.head_teacher_id === t.t1.id && rA.teacher_id === t.t1.id, rA);
    check('1) 同时写入 teacher_classes 班主任记录（三处来源一致）',
      (await tcRow(clsA, t.t1.id)) && (await tcRow(clsA, t.t1.id)).role_in_class === 'head_teacher', await tcRow(clsA, t.t1.id));

    // 管理员建班时直接指定班主任 → 两列同值 + 该教师原班主任班解除
    const clsD = await mkClass(CLASS_D, t.t1.id);
    const rD = await clsRow(clsD), rA2 = await clsRow(clsA);
    check('1) 管理员建班带班主任 → 丁班 head_teacher_id 与 teacher_id 同值（=T1）',
      rD.head_teacher_id === t.t1.id && rD.teacher_id === t.t1.id, rD);
    check('1) 教师改带丁班 → 甲班两列一并清空（不残留双班主任）',
      rA2.head_teacher_id === null && rA2.teacher_id === null, rA2);
    const tcA1 = await tcRow(clsA, t.t1.id);
    check('1) 甲班带班记录同步降级为任课老师（classes 与 teacher_classes 对齐）',
      !tcA1 || (tcA1.role_in_class === 'subject_teacher' && tcA1.is_head_teacher === false), tcA1);

    // 管理员改派班主任（PUT，force 覆盖）
    const put = await api(`/api/classes/${clsC}`, {
      method: 'PUT', cookie: admin,
      body: { className: CLASS_C, headTeacherId: t.t1.id, force: true },
    });
    const rC = await clsRow(clsC), rD2 = await clsRow(clsD);
    check('1) 管理员改派班主任 → 丙班两列同步为 T1，丁班两列清空',
      put.status === 200 && rC.head_teacher_id === t.t1.id && rC.teacher_id === t.t1.id &&
      rD2.head_teacher_id === null && rD2.teacher_id === null, { status: put.status, C: rC, D: rD2 });
    const tcD = await tcRow(clsD, t.t1.id);
    check('1) 丁班带班记录降级为任课老师（换班不留残留身份）',
      !tcD || (tcD.role_in_class === 'subject_teacher' && tcD.is_head_teacher === false), tcD);

    // 来源：教师端保存所教班级（PUT /api/teacher/classes）——任课班级不得越权成为班主任
    const saveTc = await api('/api/teacher/classes', {
      method: 'PUT', cookie: t.t3.cookie,
      body: { classIds: [clsA], subject: '数学' },
    });
    const rA3 = await clsRow(clsA);
    check('1) 教师保存任课班级（非班主任）→ 不会写入 head_teacher_id/teacher_id（越权防护）',
      saveTc.status === 200 && rA3.head_teacher_id === null && rA3.teacher_id === null,
      { status: saveTc.status, row: rA3, body: saveTc.data });
    const tcA3 = await tcRow(clsA, t.t3.id);
    check('1) 教师保存任课班级 → teacher_classes 记为任课老师（subject_teacher）',
      !!tcA3 && tcA3.role_in_class === 'subject_teacher' && tcA3.is_head_teacher === false, tcA3);

    // 来源：个人资料改班级（PUT /api/user/profile）——教师选所带班级即成为该班班主任
    const prof = await api('/api/user/profile', {
      method: 'PUT', cookie: t.t3.cookie,
      body: { displayName: 'P0三老师', classId: clsB },
    });
    const rB3 = await clsRow(clsB), rA3b = await clsRow(clsA);
    check('1) 个人资料改班级 → 乙班两列同步为 T3',
      prof.status === 200 && rB3.head_teacher_id === t.t3.id && rB3.teacher_id === t.t3.id,
      { status: prof.status, row: rB3, body: prof.data });
    check('1) 原班主任身份班级（甲班）不残留：两列本就为空且带班记录降为任课老师',
      rA3b.head_teacher_id === null && rA3b.teacher_id === null &&
      (!(await tcRow(clsA, t.t3.id)) || (await tcRow(clsA, t.t3.id)).role_in_class === 'subject_teacher'),
      { A: rA3b, tc: await tcRow(clsA, t.t3.id) });

    // 接口读取一致（班级管理列表 = 前端读 head_teacher_id / head_teacher_name）
    const clsList = await api('/api/classes/manage', { cookie: admin });
    const listRow = listOf(clsList.data).find((c) => c.id === clsB);
    check('1) 班级管理接口返回 head_teacher_id = T3 且带班主任姓名（前端展示一致）',
      !!listRow && listRow.head_teacher_id === t.t3.id && !!listRow.head_teacher_name,
      listRow);
    check('1) 全局不变式：teacher_id 与 head_teacher_id 零不一致（遗留列同步）',
      (await n1('SELECT count(*)::int n FROM classes WHERE COALESCE(head_teacher_id, -1) <> COALESCE(teacher_id, -1)')) === 0);
    check('1) 全局不变式：无「同一教师担任两个班班主任」（head_teacher_id 唯一）',
      (await n1('SELECT count(*)::int n FROM (SELECT head_teacher_id FROM classes WHERE head_teacher_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x')) === 0);

    // 删除教师账号：FK ON DELETE SET NULL（旧行为会被 23503 阻塞）
    await api(`/api/classes/${clsC}`, { method: 'PUT', cookie: admin, body: { className: CLASS_C, headTeacherId: t.t2.id, force: true } });
    const delT2 = await api(`/api/users/${t.t2.id}`, { method: 'DELETE', cookie: admin });
    const rCafter = await clsRow(clsC);
    check('1) 删除正在担任班主任的教师账号 → 200（ON DELETE SET NULL 生效，不再被阻塞）',
      delT2.status === 200, { status: delT2.status, data: delT2.data });
    check('1) 删除后该班两列自动置空，班级本身保留',
      !!rCafter && rCafter.head_teacher_id === null && rCafter.teacher_id === null, rCafter);
    check('1) 删除后该教师的带班记录一并清除（teacher_classes CASCADE）',
      (await n1('SELECT count(*)::int n FROM teacher_classes WHERE teacher_id = $1', [t.t2.id])) === 0);

    // 学年一键升级的班级复制语句（源码守卫：不能退回只写 teacher_id）
    const adminSrc = fs.readFileSync(path.join(__dirname, 'src/routes/admin.js'), 'utf8');
    check('1) 学年一键升级复制班级时以 head_teacher_id 为准（源码守卫）',
      /SELECT id, class_name, COALESCE\(head_teacher_id, teacher_id\) AS head_id/.test(adminSrc) &&
      /INSERT INTO classes \(class_name, grade, grade_id, academic_year, head_teacher_id, teacher_id, status\)/.test(adminSrc));

    // 学年组合导入（真实走接口：Excel 多 Sheet）
    const IMPORT_GRADE = 'P0导入年级' + TAG, IMPORT_CLASS = 'P0导入班' + TAG;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { '年级名称': IMPORT_GRADE, '年级代码': 'P0I', '学年': year },
    ]), '年级');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { '班级名称': IMPORT_CLASS, '所属年级名称': IMPORT_GRADE, '学年': year, '班主任账号': T1 },
    ]), '班级');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { '学号': 'P0' + TAG + '02', '姓名': 'P0导入生', '所属班级名称': IMPORT_CLASS, '学年': year },
    ]), '学生');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { '教师账号': T1, '班级名称': IMPORT_CLASS, '学年': year },
    ]), '教师带班');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const imp = await apiUpload('/api/academic-year/import', buf, 'p0.xlsx', admin);
    const impCls = (await pg.query(
      'SELECT id, head_teacher_id, teacher_id FROM classes WHERE class_name = $1', [IMPORT_CLASS]
    )).rows[0];
    check('1) 学年组合导入 → 接口 200 且班级创建成功', imp.status === 200 && !!impCls, { status: imp.status, body: imp.data });
    check('1) 组合导入的班级班主任写入 head_teacher_id 与 teacher_id（两列同值 = T1）',
      !!impCls && impCls.head_teacher_id === t.t1.id && impCls.teacher_id === t.t1.id, impCls);
    check('1) 组合导入的教师带班同步写入 teacher_classes',
      !!impCls && !!(await tcRow(impCls.id, t.t1.id)), impCls);

    // ---------- 2) start_source CHECK ----------
    console.log('2) start_source 取值约束（问题四）:');
    const ck = await pg.query(
      "SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_sessions_source'"
    );
    check('2) 约束 ck_sessions_source 存在且已校验（convalidated）',
      ck.rowCount === 1 && ck.rows[0].convalidated === true, ck.rows);
    check('2) 取值白名单 = plan / manual / makeup',
      ck.rowCount === 1 && /plan/.test(ck.rows[0].def) && /manual/.test(ck.rows[0].def) && /makeup/.test(ck.rows[0].def),
      ck.rows[0] && ck.rows[0].def);
    const mkSess = async (src) => {
      try {
        const r = await pg.query(
          `INSERT INTO attendance_sessions (start_time, deadline, status, start_source, deadline_minutes)
           VALUES (now(), now() + interval '30 min', 'closed', $1, 30) RETURNING id`, [src]
        );
        created.sessionIds.push(r.rows[0].id);
        return { ok: true, id: r.rows[0].id };
      } catch (e) { return { ok: false, code: e.code }; }
    };
    const sPlan = await mkSess('plan'), sManual = await mkSess('manual'), sMakeup = await mkSess('makeup');
    check('2) plan 合法', sPlan.ok, sPlan);
    check('2) manual 合法', sManual.ok, sManual);
    check('2) makeup 合法（补签场次预留取值）', sMakeup.ok, sMakeup);
    const sBad = await mkSess('xxx');
    check('2) 非法取值 xxx 被 CHECK 拒绝（23514）', sBad.ok === false && sBad.code === '23514', sBad);
    const sEmpty = await mkSess('');
    check('2) 空字符串被拒绝（NOT NULL + CHECK 双保险）', sEmpty.ok === false, sEmpty);
    check('2) 既有真实场次取值仍合法（白名单外 0 行）',
      // v35 起白名单加入 'auto'（每天自动生成的早/晚场次）
      (await n1("SELECT count(*)::int n FROM attendance_sessions WHERE start_source NOT IN ('plan','manual','makeup','auto')")) === 0);

    // ---------- 3) 学生软删除 ----------
    console.log('3) 学生软删除（问题六第 1 步）:');
    stuNo = 'P0' + TAG + '01';
    const mk = await api('/api/students', { method: 'POST', cookie: admin, body: { studentNo: stuNo, name: 'P0测试生', classId: clsA } });
    stu = (mk.data && (mk.data.id || (mk.data.student && mk.data.student.id))) || null;
    check('3) 学生创建成功', mk.status === 201 && !!stu, { status: mk.status, data: mk.data });

    const ses = sPlan.id;
    await pg.query(
      `INSERT INTO attendance_records (session_id, student_id, status, checkin_time, check_in_method)
       VALUES ($1, $2, 'present', now(), 'manual')`, [ses, stu]
    );
    const task = await pg.query(
      `INSERT INTO homework_tasks (class_id, subject, date, created_by, title, deadline)
       VALUES ($1, '数学', CURRENT_DATE, $2, 'P0作业', now() + interval '3 days') RETURNING id`,
      [clsA, t.t1.id]
    );
    created.taskIds.push(task.rows[0].id);
    await pg.query('INSERT INTO homework_submissions (task_id, student_id, is_submitted) VALUES ($1, $2, true)', [task.rows[0].id, stu]);
    await pg.query(
      `INSERT INTO rollcall_records (class_id, student_id, session_id, scope, picked_by, picked_by_name)
       VALUES ($1, $2, $3, 'class', $4, 'p0fix')`, [clsA, stu, ses, t.t1.id]
    );
    await pg.query(
      `INSERT INTO student_likes (student_id, class_id, subject, operator_id, operator_name, like_count)
       VALUES ($1, $2, '数学', $3, 'p0fix', 1)`, [stu, clsA, t.t1.id]
    );
    const hist = async () => ({
      rec: await n1('SELECT count(*)::int n FROM attendance_records WHERE student_id = $1', [stu]),
      hw: await n1('SELECT count(*)::int n FROM homework_submissions WHERE student_id = $1', [stu]),
      rc: await n1('SELECT count(*)::int n FROM rollcall_records WHERE student_id = $1', [stu]),
      like: await n1('SELECT count(*)::int n FROM student_likes WHERE student_id = $1', [stu]),
    });
    recBefore = await hist();
    check('3) 历史数据就绪（考勤 1 / 作业 1 / 巡堂 1 / 点赞 1）',
      recBefore.rec === 1 && recBefore.hw === 1 && recBefore.rc === 1 && recBefore.like === 1, recBefore);

    const del = await api(`/api/students/${stu}`, { method: 'DELETE', cookie: admin });
    check('3) DELETE /api/students/:id → 200 且标记 softDeleted',
      del.status === 200 && del.data && del.data.deleted === true && del.data.softDeleted === true, { status: del.status, data: del.data });
    const srow = (await pg.query('SELECT is_active, status, deleted_at, student_no FROM students WHERE id = $1', [stu])).rows[0];
    check('3) 学生行仍存在（未被物理删除）', !!srow, srow);
    check('3) is_active=false / status=deleted / deleted_at 有值',
      !!srow && srow.is_active === false && srow.status === 'deleted' && !!srow.deleted_at, srow);
    const recAfter = await hist();
    check('3) 考勤/作业/巡堂/点赞历史全部保留（无 CASCADE 误删）',
      JSON.stringify(recAfter) === JSON.stringify(recBefore), { before: recBefore, after: recAfter });

    const list1 = await api(`/api/students?classId=${clsA}`, { cookie: admin });
    const arr1 = Array.isArray(list1.data) ? list1.data : (list1.data.students || list1.data.rows || []);
    check('3) 学生列表不再出现该生', list1.status === 200 && !arr1.some((x) => x.id === stu), { status: list1.status, n: arr1.length });
    const srch = await api('/api/attendance/student/search?keyword=' + encodeURIComponent('P0测试生'), { cookie: admin });
    check('3) 考勤分析搜索不再命中（total=0）', srch.status === 200 && srch.data.total === 0, srch.data);
    const clsList2 = await api('/api/classes/manage', { cookie: admin });
    const rowA2 = listOf(clsList2.data).find((c) => c.id === clsA);
    check('3) 班级管理列表学生数不含已删除学生（0 人）',
      !!rowA2 && rowA2.student_count === 0, rowA2);

    const del2 = await api(`/api/students/${stu}`, { method: 'DELETE', cookie: admin });
    check('3) 重复删除 → 404「学生不存在或已删除」',
      del2.status === 404 && /已删除|不存在/.test((del2.data && del2.data.error) || ''), { status: del2.status, data: del2.data });
    const delBad = await api('/api/students/99999999', { method: 'DELETE', cookie: admin });
    check('3) 删除不存在的学生 → 404', delBad.status === 404, delBad.status);
    // 权限：非管理员/非本班教师不可删除
    const otherTea = await mkTeacher('p0_tea4_' + TAG, clsC);
    const delPerm = await api(`/api/students/${stu}`, { method: 'DELETE', cookie: otherTea.cookie });
    check('3) 非本班教师删除 → 403（只能删本人所带班级）',
      delPerm.status === 403, { status: delPerm.status, data: delPerm.data });
    const monAcc = await api('/api/users', {
      method: 'POST', cookie: admin,
      body: { username: 'p0_mon_' + TAG, password: '123456', role: 'monitor', realName: 'P0班长', classId: clsA, mustChangePassword: false, profileLocked: true },
    });
    created.userIds.push(monAcc.data.user.id);
    const monCookie = await login('p0_mon_' + TAG);
    const delMon = await api(`/api/students/${stu}`, { method: 'DELETE', cookie: monCookie });
    check('3) 班长删除学生 → 403（权限不因软删除放宽）', delMon.status === 403, { status: delMon.status, data: delMon.data });

    const re = await api('/api/students', { method: 'POST', cookie: admin, body: { studentNo: stuNo, name: 'P0测试生', classId: clsB } });
    const reId = re.data && (re.data.id || (re.data.student && re.data.student.id));
    const rrow = (await pg.query('SELECT is_active, status, deleted_at, class_id FROM students WHERE student_no = $1', [stuNo])).rows[0];
    check('3) 同学号重新添加 → 复用同一行（复活，不新建）', reId === stu, { reId, stu, status: re.status });
    check('3) 复活后 is_active=true / status=在读 / deleted_at 清空 / 班级更新为乙班',
      !!rrow && rrow.is_active === true && rrow.status === '在读' && rrow.deleted_at === null && rrow.class_id === clsB, rrow);
    check('3) 复活后历史仍在（考勤/点赞 计数不变）',
      (await n1('SELECT count(*)::int n FROM attendance_records WHERE student_id = $1', [stu])) === 1 &&
      (await n1('SELECT count(*)::int n FROM student_likes WHERE student_id = $1', [stu])) === 1);
    const srch2 = await api('/api/attendance/student/search?keyword=' + encodeURIComponent('P0测试生'), { cookie: admin });
    check('3) 复活后搜索重新命中（total=1）', srch2.status === 200 && srch2.data.total === 1, srch2.data);
    const del3 = await api(`/api/students/${stu}`, { method: 'DELETE', cookie: t.t3.cookie });
    check('3) 本班教师（乙班班主任 T3）可删除本班学生（200 + softDeleted）',
      del3.status === 200 && del3.data && del3.data.softDeleted === true, { status: del3.status, data: del3.data });
    const stuCnt = await n1('SELECT count(*)::int n FROM students WHERE class_id = $1 AND is_active = true', [clsB]);
    const stuCntAll = await n1('SELECT count(*)::int n FROM students WHERE class_id = $1', [clsB]);
    check('3) 乙班在读 0 人 / 物理行 1 行（软删除保留历史载体）', stuCnt === 0 && stuCntAll === 1, { active: stuCnt, all: stuCntAll });

    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const ana = await api(`/api/attendance/analysis/student-detail?startDate=${from}&endDate=${today}&classId=${clsB}`, { cookie: admin });
    const anaRows = (ana.data && ana.data.rows) || [];
    check('4) 考勤分析班级明细不含已删除学生',
      ana.status === 200 && !anaRows.some((x) => x.id === stu || x.name === 'P0测试生'), { status: ana.status, n: anaRows.length, body: ana.data });
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：' + (e && e.stack ? e.stack : e));
  } finally {
    console.log('6) 清理与基线核对…');
    try { await hardCleanup(); } catch (e) { console.log('  · 清理异常：' + e.message); }
    const after = await snapshotReal();
    check('6) 真实数据行数回到用例前（users/grades/classes/students/sessions/records/plans/homework/rollcall/likes/teacher_classes）',
      JSON.stringify(after) === JSON.stringify(realBefore), { before: realBefore, after });
    check('6) 无夹具残留（班级/账号/年级/学生）',
      (await n1("SELECT count(*)::int n FROM classes WHERE class_name LIKE 'P0%'")) === 0 &&
      (await n1("SELECT count(*)::int n FROM users WHERE username LIKE 'p0\\_%'")) === 0 &&
      (await n1("SELECT count(*)::int n FROM grades WHERE grade_name LIKE 'P0%'")) === 0 &&
      (await n1("SELECT count(*)::int n FROM students WHERE student_no LIKE 'P0%'")) === 0);
    check('6) 无夹具场次/作业任务残留',
      (await n1("SELECT count(*)::int n FROM homework_tasks WHERE title = 'P0作业'")) === 0 &&
      (await n1("SELECT count(*)::int n FROM attendance_sessions WHERE start_source = 'makeup'")) === 0);
    console.log(`\n结果：✔ ${pass}  ✘ ${fail}`);
    await pg.end();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
