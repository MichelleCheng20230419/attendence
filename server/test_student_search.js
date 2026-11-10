// ============================================================
// 考勤分析「搜索学生」测试
//   覆盖：
//     1) GET /api/attendance/student/search：姓名/学号模糊搜索、精确优先、无匹配、参数校验
//     2) 范围：管理员可按年级/班级过滤；教师仅本班；班长/学生 403；未登录 401
//     3) GET /api/attendance/student/:id/detail：应到/实到/请假/缺勤/出勤率 + 签到记录明细
//        场次归属与班级统计完全一致（全校场次都算 / 本班专属算 / 别班专属不算）
//     4) 与班级学生明细口径一致性、日期范围联动、错误码（400/403/404）、非在读开关
//   夹具：1 年级 + 2 班 + 5 学生（1 名休学）+ 1 教师（绑 A 班）+ 1 班长 + 1 学生账号
//         + 3 场已结束签到（2020-03-02 全校 / 03-03 A 班专属 / 03-04 B 班专属）
//         + 记录（已签到/迟到/请假/缺勤）
//   时间窗刻意用 2020 年：该时间段库里没有任何真实场次，断言可以精确到个位数
//   （测试开始会断言"该窗口只有本用例的 3 场"，若真实数据侵入会立刻报错）
//   测完清理并核对真实基线
// ============================================================
'use strict';
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
async function login(u, p) {
  // admin 的密码可能被管理员改过 → 用环境变量 DSH_ADMIN_PW（默认 123456）；夹具账号固定 123456
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('登录失败 ' + u + ': ' + r.status);
  const m = r.setc.match(/connect\.sid=([^;]+)/);
  return 'connect.sid=' + m[1];
}
async function countSql(sql, params = []) { return (await pg.query(sql, params)).rows[0].n; }

const TAG = String(Date.now()).slice(-6);
const GRADE = '搜索年级' + TAG, CLASS_A = '搜索甲班' + TAG, CLASS_B = '搜索乙班' + TAG;
const TEA = 'ss_tea_' + TAG, MON = 'ss_mon_' + TAG, STU_USER = 'ss_stu_' + TAG;
const D1 = '2020-03-02', D2 = '2020-03-03', D3 = '2020-03-04';
const created = { gradeId: null, classA: null, classB: null, userIds: [], studentIds: [], sessionIds: [], planIds: [] };
let realBefore = null;
let admin = null, tea = null, mon = null, stuAcc = null;
let zhangA = null, zhangB = null, zhang2 = null, liA = null, offA = null;

async function snapshotReal() {
  return {
    users: await countSql('SELECT count(*)::int n FROM users'),
    grades: await countSql('SELECT count(*)::int n FROM grades'),
    classes: await countSql('SELECT count(*)::int n FROM classes'),
    students: await countSql('SELECT count(*)::int n FROM students'),
    sessions: await countSql('SELECT count(*)::int n FROM attendance_sessions'),
    records: await countSql('SELECT count(*)::int n FROM attendance_records'),
    plans: await countSql('SELECT count(*)::int n FROM attendance_plans'),
  };
}
async function mkSession(dateStr, timeStr, classId = null) {
  const r = await pg.query(
    `INSERT INTO attendance_sessions (start_time, deadline, status, start_source, deadline_minutes, created_by_name, class_id)
     VALUES ($1::date + $2::time, $1::date + $2::time + interval '30 minutes', 'closed', 'manual', 30, 'ssfix', $3) RETURNING id`,
    [dateStr, timeStr, classId]
  );
  created.sessionIds.push(r.rows[0].id);
  return r.rows[0].id;
}
async function mkPlan(sessionId, dateStr, timeStr, classId) {
  const r = await pg.query(
    `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, status, session_id, class_id, created_by_name)
     VALUES ($1::date, $2::time, 30, 'done', $3, $4, 'ssfix') RETURNING id`,
    [dateStr, timeStr, sessionId, classId]
  );
  created.planIds.push(r.rows[0].id);
}
async function mkRec(sessionId, studentId, status, checkinAt, leaveReason) {
  await pg.query(
    `INSERT INTO attendance_records (session_id, student_id, status, checkin_time, leave_reason, check_in_method)
     VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [sessionId, studentId, status, checkinAt, leaveReason || null]
  );
}
async function hardCleanup() {
  const warn = (l) => (e) => console.log('  · 清理失败（' + l + '）：' + e.message);
  if (created.sessionIds.length) await pg.query('DELETE FROM attendance_sessions WHERE id = ANY($1::int[])', [created.sessionIds]).catch(warn('sessions'));
  await pg.query('DELETE FROM attendance_sessions WHERE created_by_name = $1', ['ssfix']).catch(warn('sessions-fix'));
  await pg.query('DELETE FROM attendance_plans WHERE created_by_name = $1', ['ssfix']).catch(warn('plans'));
  // 注意顺序：教师账号会被写成班级的 head_teacher_id → 必须先删夹具班级再删账号
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name LIKE $1', ['搜索%班%']).catch(warn('classes'));
  await pg.query('DELETE FROM users WHERE username LIKE $1', ['ss\\_%']).catch(warn('users'));
  await pg.query('DELETE FROM grades WHERE grade_name LIKE $1', ['搜索年级%']).catch(warn('grades'));
}

const SEARCH = (kw, extra = '') => `/api/attendance/student/search?keyword=${encodeURIComponent(kw)}${extra}`;
const DETAIL = (id, s = D1, e = D3) => `/api/attendance/student/${id}/detail?startDate=${s}&endDate=${e}`;

(async () => {
  try {
    console.log('0) 夹具准备…');
    realBefore = await snapshotReal();
    admin = await login('admin');
    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'SS', academicYear: year } })).data.id;
    created.classA = (await api('/api/classes', { method: 'POST', cookie: admin, body: { className: CLASS_A, gradeName: GRADE, academicYear: year } })).data.id;
    created.classB = (await api('/api/classes', { method: 'POST', cookie: admin, body: { className: CLASS_B, gradeName: GRADE, academicYear: year } })).data.id;

    const mkStudent = async (no, name, classId, status = '在读') => {
      const r = await api('/api/students', { method: 'POST', cookie: admin, body: { studentNo: no, name, classId, status } });
      const id = (r.data && (r.data.id || (r.data.student && r.data.student.id))) || null;
      created.studentIds.push(id);
      return id;
    };
    zhangA = await mkStudent('SS' + TAG + '01', '张一三', created.classA);      // 甲班：已签到 + 请假
    zhang2 = await mkStudent('SS' + TAG + '02', '张一明', created.classA);      // 甲班：迟到 + 缺勤
    liA = await mkStudent('SS' + TAG + '03', '李一四', created.classA);         // 甲班：无记录
    zhangB = await mkStudent('SS' + TAG + '04', '张一丰', created.classB);      // 乙班：全勤（跨班同名）
    offA = await mkStudent('SS' + TAG + '05', '张一休', created.classA); // 甲班：休学（默认不出现）
    // POST /api/students 不支持自定义状态（固定"在读"）→ 用 SQL 设为休学，验证非在读开关
    await pg.query("UPDATE students SET status = '休学' WHERE id = $1", [offA]);
    check('0) 已把张一休设为「休学」（用于验证"包含非在读"开关）',
      (await pg.query('SELECT status FROM students WHERE id = $1', [offA])).rows[0].status === '休学');

    const mkUser = async (u, role, classId) => {
      const r = await api('/api/users', {
        method: 'POST', cookie: admin,
        body: { username: u, password: '123456', role, realName: u, classId, mustChangePassword: false, profileLocked: true },
      });
      if (r.status !== 201) throw new Error('创建账号失败 ' + u + ' ' + JSON.stringify(r.data));
      created.userIds.push(r.data.user.id);
      return r.data.user.id;
    };
    await mkUser(TEA, 'teacher', created.classA);
    await mkUser(MON, 'monitor', created.classA);
    await mkUser(STU_USER, 'student', created.classA);
    tea = await login(TEA); mon = await login(MON); stuAcc = await login(STU_USER);

    // 3 场已结束签到：S1 全校（class_id IS NULL）/ S2 甲班专属 / S3 乙班专属
    //   方案 A（v33）后场次归属的唯一真源 = attendance_sessions.class_id
    const s1 = await mkSession(D1, '08:00:00', null);
    const s2 = await mkSession(D2, '08:00:00', created.classA);
    const s3 = await mkSession(D3, '08:00:00', created.classB);
    await mkPlan(s2, D2, '08:00:00', created.classA);
    await mkPlan(s3, D3, '08:00:00', created.classB);
    await mkRec(s1, zhangA, 'present', `${D1} 08:03:25+08`);
    await mkRec(s2, zhangA, 'leave', null, '病假');
    await mkRec(s1, zhang2, 'late', `${D1} 08:20:10+08`);
    await mkRec(s2, zhang2, 'absent', null);
    await mkRec(s1, zhangB, 'present', `${D1} 08:02:00+08`);
    await mkRec(s3, zhangB, 'present', `${D3} 08:03:00+08`);
    check('0) 夹具就绪（2 班 + 5 学生 + 3 场次 + 2 计划 + 6 条记录）',
      created.studentIds.length === 5 && created.sessionIds.length === 3 && created.planIds.length === 2, created);
    // 隔离性守卫：该时间窗内库里只有本用例的 3 场（真实数据不会干扰下面的精确断言）
    const inWindow = await countSql(
      `SELECT count(*)::int n FROM attendance_sessions WHERE start_time >= $1::date AND start_time < ($2::date + interval '1 day')`,
      [D1, D3]
    );
    check('0) 时间窗隔离：2020-03-02~03-04 内只有本用例的 3 场', inWindow === 3, inWindow);

    // ---------- 1) 搜索 ----------
    console.log('1) 学生搜索:');
    let r = await api(SEARCH('张一'), { cookie: admin });
    check('1) 模糊搜索「张一」→ 命中 3 名在读（休学的张一休默认不出现）',
      r.status === 200 && r.data.total === 3 && !r.data.students.some((x) => x.name === '张一休'),
      r.data && r.data.students.map((x) => x.name));
    r = await api(SEARCH('张一三'), { cookie: admin });
    check('1) 精确姓名排第一（张一三 · 甲班）',
      r.status === 200 && r.data.students[0].name === '张一三' && r.data.students[0].className === CLASS_A,
      r.data && r.data.students.map((x) => x.name + '/' + x.className));
    check('1) 返回学号/班级/年级（列表展示用）',
      !!(r.data.students[0].studentNo && r.data.students[0].className && r.data.students[0].grade), r.data.students[0]);
    r = await api(SEARCH('SS' + TAG + '03'), { cookie: admin });
    check('1) 按学号搜索 → 命中李一四', r.status === 200 && r.data.total === 1 && r.data.students[0].name === '李一四', r.data && r.data.students);
    r = await api(SEARCH('一三'), { cookie: admin });
    check('1) 名字中间片段模糊匹配 → 张一三', r.data.total === 1 && r.data.students[0].name === '张一三', r.data && r.data.students);
    r = await api(SEARCH('张一', '&includeNonEnrolled=1'), { cookie: admin });
    check('1) 勾选"包含非在读"→ 休学学生也出现（4 名）', r.data.total === 4 && r.data.students.some((x) => x.name === '张一休'), r.data && r.data.students.map((x) => x.name));
    r = await api(SEARCH('不存在的学生xyz'), { cookie: admin });
    check('1) 无匹配 → 200 且 total=0（前端提示"未找到该学生"）', r.status === 200 && r.data.total === 0, r.data);
    r = await api(SEARCH(''), { cookie: admin });
    check('1) 空关键词 → 400', r.status === 400, { status: r.status, data: r.data });

    // ---------- 2) 范围与权限 ----------
    console.log('2) 范围与权限:');
    r = await api(SEARCH('张一', '&classId=' + created.classA), { cookie: admin });
    check('2) 管理员按班级过滤 → 只出甲班 2 名', r.data.total === 2 && r.data.students.every((x) => x.className === CLASS_A), r.data && r.data.students.map((x) => x.className));
    r = await api(SEARCH('张一', '&grade=' + encodeURIComponent(GRADE)), { cookie: admin });
    check('2) 管理员按年级过滤 → 本年级 3 名', r.data.total === 3, r.data && r.data.total);
    r = await api(SEARCH('张一', '&grade=' + encodeURIComponent('不存在的年级')), { cookie: admin });
    check('2) 不存在的年级 → 0 条', r.data.total === 0, r.data && r.data.total);
    r = await api(SEARCH('张一'), { cookie: tea });
    check('2) 教师（绑甲班）搜索 → 只见本班 2 名（乙班张一丰不出现）',
      r.status === 200 && r.data.total === 2 && !r.data.students.some((x) => x.className === CLASS_B),
      r.data && r.data.students.map((x) => x.name + '/' + x.className));
    r = await api(SEARCH('张一', '&classId=' + created.classB), { cookie: tea });
    check('2) 教师传别班 classId 也拿不到别班数据（后端强制本班）',
      r.data.total === 2 && !r.data.students.some((x) => x.className === CLASS_B), r.data && r.data.total);
    r = await api(SEARCH('张一'), { cookie: mon });
    check('2) 班长搜索 → 403', r.status === 403, { status: r.status, data: r.data });
    r = await api(SEARCH('张一'), { cookie: stuAcc });
    check('2) 学生搜索 → 403', r.status === 403, { status: r.status, data: r.data });
    r = await api(SEARCH('张一'));
    check('2) 未登录 → 401', r.status === 401, r.status);

    // ---------- 3) 学生考勤详情 ----------
    console.log('3) 学生考勤详情:');
    r = await api(DETAIL(zhangA), { cookie: admin });
    check('3) 详情返回 学生信息 + 统计 + 记录明细 三段',
      r.status === 200 && !!r.data.student && !!r.data.stats && Array.isArray(r.data.records), r.data && Object.keys(r.data));
    check('3) 应到=2（全校场次 S1 + 甲班专属 S2；乙班专属 S3 不计入）',
      r.data.stats.expected === 2 && r.data.range.sessions === 2, { stats: r.data.stats, range: r.data.range });
    check('3) 实到=1 / 请假=1 / 缺勤=0 / 出勤率=50%',
      r.data.stats.attended === 1 && r.data.stats.leave === 1 && r.data.stats.absent === 0 && r.data.stats.rate === 50, r.data.stats);
    check('3) 记录明细 2 条：S1 已签到 08:03:25、S2 请假（带事由 病假）',
      r.data.records.length === 2 &&
      r.data.records[0].date === D1 && r.data.records[0].status === 'present' && r.data.records[0].statusLabel === '已签到' && r.data.records[0].checkinTime === '08:03:25' &&
      r.data.records[1].date === D2 && r.data.records[1].status === 'leave' && r.data.records[1].statusLabel === '请假' && r.data.records[1].leaveReason === '病假',
      r.data.records);

    r = await api(DETAIL(zhang2), { cookie: admin });
    check('3) 迟到计入实到 + 缺勤记录识别：实到=1 / 迟到=1 / 缺勤=1 / 出勤率=50%',
      r.data.stats.attended === 1 && r.data.stats.late === 1 && r.data.stats.absent === 1 && r.data.stats.rate === 50, r.data.stats);
    check('3) 迟到带签到时间 08:20:10；缺勤签到时间为空',
      r.data.records[0].statusLabel === '迟到' && r.data.records[0].checkinTime === '08:20:10' &&
      r.data.records[1].statusLabel === '缺勤' && r.data.records[1].checkinTime === null,
      r.data.records);

    r = await api(DETAIL(liA), { cookie: admin });
    check('3) 无任何记录的学生：应到=2 / 缺勤=2 / 出勤率=0%',
      r.data.stats.expected === 2 && r.data.stats.attended === 0 && r.data.stats.absent === 2 && r.data.stats.rate === 0, r.data.stats);
    check('3) 无记录时逐场显示"缺勤"（两条，签到时间为空）',
      r.data.records.length === 2 && r.data.records.every((x) => x.status === 'absent' && x.statusLabel === '缺勤' && x.checkinTime === null), r.data.records);

    r = await api(DETAIL(zhangB), { cookie: admin });
    check('3) 乙班学生：应到=2（S1 + 乙班专属 S3）/ 实到=2 / 出勤率=100%',
      r.data.stats.expected === 2 && r.data.stats.attended === 2 && r.data.stats.rate === 100, r.data.stats);

    // ---------- 4) 日期范围与口径一致性 ----------
    console.log('4) 日期范围与口径一致性:');
    r = await api(DETAIL(zhangA, D1, D1), { cookie: admin });
    check('4) 只查 S1 当天 → 应到=1 / 实到=1 / 1 条记录',
      r.data.stats.expected === 1 && r.data.stats.attended === 1 && r.data.records.length === 1, { stats: r.data.stats, n: r.data.records.length });
    r = await api(DETAIL(zhangA, D2, D2), { cookie: admin });
    check('4) 只查 S2 当天 → 应到=1 / 请假=1 / 出勤率=0%',
      r.data.stats.expected === 1 && r.data.stats.leave === 1 && r.data.stats.rate === 0, r.data.stats);

    const cls = await api(`/api/attendance/analysis/student-detail?startDate=${D1}&endDate=${D3}&classId=${created.classA}`, { cookie: admin });
    const row = (cls.data.rows || []).find((x) => x.name === '张一三');
    const clsRow2 = (cls.data.rows || []).find((x) => x.name === '李一四');
    const one = (await api(DETAIL(zhangA), { cookie: admin })).data.stats;
    const one2 = (await api(DETAIL(liA), { cookie: admin })).data.stats;
    check('4) 与班级学生明细口径一致（张一三 应到/实到/请假/缺勤/出勤率 完全相同）',
      !!row && row.expected === one.expected && row.attended === one.attended && row.leave === one.leave && row.absent === one.absent && row.rate === one.rate,
      { classRow: row, studentApi: one });
    check('4) 无记录学生同样一致（李一四：应到 2 / 缺勤 2 / 出勤率 0%）',
      !!clsRow2 && clsRow2.expected === one2.expected && clsRow2.absent === one2.absent && clsRow2.rate === one2.rate,
      { classRow: clsRow2, studentApi: one2 });

    // ---------- 5) 详情权限与错误码 ----------
    console.log('5) 详情权限与错误码:');
    r = await api(DETAIL(zhangB), { cookie: tea });
    check('5) 教师查看别班学生详情 → 403', r.status === 403, { status: r.status, data: r.data });
    r = await api(DETAIL(zhangA), { cookie: tea });
    check('5) 教师查看本班学生详情 → 200', r.status === 200 && r.data.student.name === '张一三', r.status);
    r = await api(DETAIL(zhangA), { cookie: mon });
    check('5) 班长看详情 → 403', r.status === 403, r.status);
    r = await api('/api/attendance/student/99999999/detail?startDate=' + D1 + '&endDate=' + D3, { cookie: admin });
    check('5) 学生不存在 → 404', r.status === 404, { status: r.status, data: r.data });
    r = await api('/api/attendance/student/abc/detail?startDate=' + D1 + '&endDate=' + D3, { cookie: admin });
    check('5) 学生参数非法 → 400', r.status === 400, r.status);
    r = await api('/api/attendance/student/' + zhangA + '/detail', { cookie: admin });
    check('5) 缺少日期参数 → 400', r.status === 400, { status: r.status, data: r.data });
    r = await api(`/api/attendance/student/${zhangA}/detail?startDate=2020-01-01&endDate=2026-12-31`, { cookie: admin });
    check('5) 范围超过 366 天 → 400', r.status === 400, { status: r.status, data: r.data });
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：' + (e && e.stack ? e.stack : e));
  } finally {
    console.log('6) 清理与基线核对…');
    try { await hardCleanup(); } catch (e) { console.log('  · 清理异常：' + e.message); }
    const after = await snapshotReal();
    check('6) 真实数据行数回到用例前（users/grades/classes/students/sessions/records/plans）',
      JSON.stringify(after) === JSON.stringify(realBefore), { before: realBefore, after });
    const left = await countSql("SELECT count(*)::int n FROM attendance_sessions WHERE created_by_name = 'ssfix'");
    check('6) 无夹具场次残留', left === 0, left);
    console.log(`\n结果：✔ ${pass}  ✘ ${fail}`);
    await pg.end();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
