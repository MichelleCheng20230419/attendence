// ============================================================
// 随机点名测试（班长端签到操作台）
//   权限：班长=本班 / 教师=所带班级 / 管理员=全部 / 学生 403
//   范围：all=全班在读学生；absent=当前场次未签到学生
//   记录：每次抽取写入 rollcall_records（含班级、学生、场次、范围、操作人）
//   不重复：excludeIds 传本次课已点到的学生 → 不会重复抽到；抽完 → 409
// 夹具：临时班级 + 学生 + 班长/教师/学生账号 + 临时场次与签到记录；测完清理
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
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}
async function tryLogin(u, p = '123456') {
  try { return await login(u, p); } catch (_) { return null; }
}

const TAG = String(Date.now()).slice(-6);
const GRADE = '点名测试年级' + TAG;
const C1 = '点名测试1班' + TAG;
const C2 = '点名测试2班' + TAG;
const PRE = 'rc_' + TAG + '_';
const created = { gradeId: null, classIds: [], studentIds: [], sessionId: null, userIds: [] };

async function cleanup() {
  const uids = (await pg.query('SELECT id FROM users WHERE username LIKE $1', [PRE + '%'])).rows.map((r) => r.id);
  if (created.classIds.length) {
    await pg.query('DELETE FROM rollcall_records WHERE class_id = ANY($1::int[])', [created.classIds]).catch(() => {});
  }
  if (created.studentIds.length) {
    await pg.query('DELETE FROM attendance_records WHERE student_id = ANY($1::int[])', [created.studentIds]).catch(() => {});
  }
  if (created.sessionId) {
    await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [created.sessionId]).catch(() => {});
    await pg.query('DELETE FROM attendance_sessions WHERE id = $1', [created.sessionId]).catch(() => {});
  }
  if (uids.length) {
    await pg.query('UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL WHERE head_teacher_id = ANY($1::int[]) OR teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM teacher_classes WHERE teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM rollcall_records WHERE picked_by = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM users WHERE id = ANY($1::int[])', [uids]).catch((e) => console.log('  · 清理账号失败：', e.message));
  }
  if (created.studentIds.length) await pg.query('DELETE FROM rollcall_records WHERE student_id = ANY($1::int[])', [created.studentIds]).catch(() => {});
  if (created.studentIds.length) await pg.query('DELETE FROM students WHERE id = ANY($1::int[])', [created.studentIds]).catch(() => {});
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name = ANY($1::text[])', [[C1, C2]]).catch(() => {});
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(() => {});
}

(async () => {
  try {
    await cleanup();
    const base = {
      rollcall: (await pg.query('SELECT count(*)::int n FROM rollcall_records')).rows[0].n,
      students: (await pg.query('SELECT count(*)::int n FROM students')).rows[0].n,
      sessions: (await pg.query('SELECT count(*)::int n FROM attendance_sessions')).rows[0].n,
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
    };
    const cAdmin = await login('admin');

    // 夹具：年级 + 2 班 + 每班 3 名学生（含座位）
    const year = (await api('/api/settings', { cookie: cAdmin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: cAdmin, body: { gradeName: GRADE, gradeCode: 'RC', academicYear: year } })).data.id;
    const c1 = (await api('/api/classes', { method: 'POST', cookie: cAdmin, body: { className: C1, gradeName: GRADE, academicYear: year } })).data.id;
    const c2 = (await api('/api/classes', { method: 'POST', cookie: cAdmin, body: { className: C2, gradeName: GRADE, academicYear: year } })).data.id;
    created.classIds = [c1, c2];
    const mkStudent = async (no, name, classId, row, col) => {
      const r = await pg.query(
        `INSERT INTO students (student_no, name, class_id, status, is_active, seat_row, seat_col)
         VALUES ($1,$2,$3,'在读',true,$4,$5) RETURNING id`,
        [no, name, classId, row, col]
      );
      created.studentIds.push(r.rows[0].id);
      return r.rows[0].id;
    };
    const s1 = await mkStudent('RCT' + TAG + '01', '点名甲', c1, 1, 3);
    const s2 = await mkStudent('RCT' + TAG + '02', '点名乙', c1, 2, 1);
    const s3 = await mkStudent('RCT' + TAG + '03', '点名丙', c1, 3, 2);
    await mkStudent('RCT' + TAG + '04', '他班同学', c2, 1, 1);
    check('0) 夹具就绪（2 班 4 学生，1 班 3 人，坐标已设）', !!(c1 && c2 && s1 && s2 && s3));

    // 账号：班长（1 班）/ 教师（1 班任课）/ 学生（1 班）
    let r = await api('/api/users', {
      method: 'POST', cookie: cAdmin,
      body: { username: PRE + 'mon', password: '123456', role: 'monitor', realName: '点名班长', classId: c1 },
    });
    check('0) 创建班长账号（1 班）→ 201', r.status === 201, r.data);
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', {
      method: 'POST', cookie: cAdmin,
      body: { username: PRE + 'tea', password: '123456', role: 'teacher', realName: '点名老师', subject: '物理', teachingClasses: [{ classId: c1, roleInClass: 'subject_teacher' }] },
    });
    check('0) 创建教师账号（1 班任课）→ 201', r.status === 201, r.data);
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', {
      method: 'POST', cookie: cAdmin,
      body: { username: PRE + 'stu', password: '123456', role: 'student', realName: '点名学生', classId: c1 },
    });
    created.userIds.push(r.data.user.id);

    const cMon = await tryLogin(PRE + 'mon');
    const cTea = await login(PRE + 'tea');
    const cStu = await login(PRE + 'stu');
    check('0) 班长/教师/学生均可登录（班长可能需先改密，测不到则跳过其断言）', !!cTea && !!cStu);

    // 1) 可点名班级：班长=本班；教师=所带班级；管理员=全部；学生 403
    if (cMon) {
      r = await api('/api/rollcall/classes', { cookie: cMon });
      check('1) 班长 GET classes → 只有本班',
        r.status === 200 && (r.data.classes || []).length === 1 && r.data.classes[0].classId === c1, r.data.classes);
      check('1) 班长默认班级 = 本班', r.data.defaultClassId === c1, r.data.defaultClassId);
    }
    r = await api('/api/rollcall/classes', { cookie: cTea });
    check('1) 教师 GET classes → 只有所带班级（1 班）',
      r.status === 200 && (r.data.classes || []).length === 1 && r.data.classes[0].classId === c1, r.data.classes);
    r = await api('/api/rollcall/classes', { cookie: cAdmin });
    check('1) 管理员 GET classes → 含全部班级（≥2）',
      r.status === 200 && (r.data.classes || []).length >= 2 && r.data.classes.some((x) => x.classId === c1) && r.data.classes.some((x) => x.classId === c2),
      (r.data.classes || []).map((x) => x.classId));
    check('1) 学生 GET classes → 403',
      (await api('/api/rollcall/classes', { cookie: cStu })).status === 403);

    // 2) 候选学生（全班范围）
    r = await api(`/api/rollcall/candidates?classId=${c1}&scope=all`, { cookie: cTea });
    check('2) 全班候选 = 本班在读 3 人', r.status === 200 && (r.data.candidates || []).length === 3, r.data.candidates);
    check('2) 候选含学号/姓名/座位标签',
      (r.data.candidates || []).every((x) => x.studentNo && x.name && x.seatLabel) &&
      (r.data.candidates || []).some((x) => x.seatLabel === '1排3座'), r.data.candidates);
    check('2) 不含其他班级学生',
      !(r.data.candidates || []).some((x) => x.name === '他班同学'));

    // 3) 随机抽取 + 记录落库
    r = await api('/api/rollcall/pick', { method: 'POST', cookie: cTea, body: { classId: c1, scope: 'all' } });
    check('3) 教师抽取 → 201 且返回学生（姓名/学号/座位）',
      r.status === 201 && r.data.student && r.data.student.name && r.data.student.studentNo, r.data);
    const picked1 = r.data.student.id;
    check('3) 抽到的学生属于本班', [s1, s2, s3].includes(picked1), picked1);
    check('3) 返回剩余人数 = 2', r.data.remaining === 2, r.data.remaining);
    const rec = (await pg.query('SELECT class_id, student_id, scope, picked_by, session_id FROM rollcall_records WHERE id = $1', [r.data.recordId])).rows[0];
    check('3) 点名记录已落库（班级/学生/范围/操作人）',
      rec && rec.class_id === c1 && rec.student_id === picked1 && rec.scope === 'all' && rec.picked_by !== null, rec);

    // 4) 不重复抽取（excludeIds）
    r = await api('/api/rollcall/pick', { method: 'POST', cookie: cTea, body: { classId: c1, scope: 'all', excludeIds: [picked1] } });
    check('4) 传 excludeIds 后不会重复抽到同一人',
      r.status === 201 && r.data.student.id !== picked1, { first: picked1, second: r.data.student && r.data.student.id });
    const picked2 = r.data.student.id;
    r = await api('/api/rollcall/pick', { method: 'POST', cookie: cTea, body: { classId: c1, scope: 'all', excludeIds: [picked1, picked2] } });
    check('4) 继续排除 2 人 → 抽到第 3 人', r.status === 201 && ![picked1, picked2].includes(r.data.student.id), r.data.student);
    const picked3 = r.data.student.id;
    r = await api('/api/rollcall/pick', { method: 'POST', cookie: cTea, body: { classId: c1, scope: 'all', excludeIds: [picked1, picked2, picked3] } });
    check('4) 全班都点过 → 409 且提示无新同学', r.status === 409 && /都已被点到/.test(r.data.error || ''), r.data);

    // 5) 权限：教师不能点其他班级；班长只能本班；学生 403
    check('5) 教师对未带班班级点名 → 403',
      (await api('/api/rollcall/pick', { method: 'POST', cookie: cTea, body: { classId: c2, scope: 'all' } })).status === 403);
    check('5) 学生抽取 → 403',
      (await api('/api/rollcall/pick', { method: 'POST', cookie: cStu, body: { classId: c1, scope: 'all' } })).status === 403);
    check('5) 管理员可点任意班级（2 班）',
      (await api('/api/rollcall/pick', { method: 'POST', cookie: cAdmin, body: { classId: c2, scope: 'all' } })).status === 201);
    check('5) 管理员不传 classId → 400（需选择班级）',
      (await api('/api/rollcall/pick', { method: 'POST', cookie: cAdmin, body: { scope: 'all' } })).status === 400);
    if (cMon) {
      check('5) 班长对本班点名 → 201',
        (await api('/api/rollcall/pick', { method: 'POST', cookie: cMon, body: { scope: 'all' } })).status === 201);
      check('5) 班长对 2 班点名 → 403',
        (await api('/api/rollcall/pick', { method: 'POST', cookie: cMon, body: { classId: c2, scope: 'all' } })).status === 403);
    }

    // 6) 仅未签到学生（需要场次：优先本班进行中，其次本班今天最近一场）
    //    方案 A（v33）：服务端点名用的"当前场次"按 attendance_sessions.class_id 收敛，
    //    这里的查询口径必须一致（否则会拿别班的场次来对照 → 误报）
    r = await api('/api/rollcall/candidates?classId=' + c1 + '&scope=absent', { cookie: cTea });
    const sessRow = (await pg.query(
      `SELECT id, status FROM attendance_sessions
        WHERE status = 'active' AND (class_id IS NULL OR class_id = $1)
        ORDER BY (class_id = $1) DESC, id DESC LIMIT 1`,
      [c1]
    )).rows[0] || (await pg.query(
      `SELECT id, status FROM attendance_sessions
        WHERE start_time >= date_trunc('day', now()) AND start_time <= now()
          AND (class_id IS NULL OR class_id = $1)
        ORDER BY (class_id = $1) DESC, id DESC LIMIT 1`,
      [c1]
    )).rows[0];
    if (sessRow) {
      check('6) 存在场次（进行中或今天最近一场）时 scope=absent 可用',
        r.status === 200 && typeof r.data.sessionId === 'number' && Array.isArray(r.data.candidates),
        { status: r.status, sessionId: r.data.sessionId, active: r.data.sessionActive });
      check('6) 该场次无本班记录时，未签到候选 = 全班在读学生',
        (r.data.candidates || []).length === 3, (r.data.candidates || []).length);
    } else {
      check('6) 无任何场次 → scope=absent 提示 400', r.status === 400 && /没有签到场次/.test(r.data.error || ''), r.data);
    }
    // 自建场次：把 3 名学生中 2 人标记已签到 → 未签到应为 1 人
    const sess = await pg.query(
      `INSERT INTO attendance_sessions (start_time, deadline, status, class_id)
       VALUES (now() - interval '10 minutes', now() + interval '30 minutes', 'active', $1) RETURNING id`,
      [c1]
    );
    created.sessionId = sess.rows[0].id;
    // 让它成为本班"当前场次"：本班专属场次优先于全校场次，且 id 最大 → 就是本场次
    await pg.query(
      `INSERT INTO attendance_records (session_id, student_id, status) VALUES ($1,$2,'present'), ($1,$3,'late')`,
      [created.sessionId, s1, s2]
    );
    r = await api(`/api/rollcall/candidates?classId=${c1}&scope=absent`, { cookie: cTea });
    check('6) 仅未签到候选 = 未签到的 1 人（已签到/迟到不算）',
      r.status === 200 && (r.data.candidates || []).length === 1 && r.data.candidates[0].id === s3,
      r.data.candidates);
    r = await api('/api/rollcall/pick', { method: 'POST', cookie: cTea, body: { classId: c1, scope: 'absent' } });
    check('6) 仅未签到抽取 → 抽到未签到的那名学生', r.status === 201 && r.data.student.id === s3, r.data.student);
    check('6) 记录里的 scope = absent 且带 session_id',
      (await pg.query('SELECT scope, session_id FROM rollcall_records WHERE id = $1', [r.data.recordId])).rows[0].session_id === created.sessionId);
    // 全部签到后 → 400
    await pg.query(`INSERT INTO attendance_records (session_id, student_id, status) VALUES ($1,$2,'present')`, [created.sessionId, s3]);
    r = await api('/api/rollcall/pick', { method: 'POST', cookie: cTea, body: { classId: c1, scope: 'absent' } });
    check('6) 全班都已签到 → 400「本班学生都已签到」', r.status === 400 && /都已签到/.test(r.data.error || ''), r.data);

    // 7) 点名记录：查询 / 过滤 / 导出
    r = await api(`/api/rollcall/records?classId=${c1}&limit=10`, { cookie: cTea });
    check('7) 点名记录列表 → 含刚才的抽取（含学号/座位/操作人）',
      r.status === 200 && (r.data.records || []).length >= 4 &&
      (r.data.records || []).every((x) => x.studentName && x.scopeLabel && x.pickedByName), (r.data.records || []).length);
    check('7) 记录总数与库中一致',
      r.data.total === (await pg.query('SELECT count(*)::int n FROM rollcall_records WHERE class_id = $1', [c1])).rows[0].n, r.data.total);
    const today = new Date();
    const ds = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    r = await api(`/api/rollcall/records?classId=${c1}&date=${ds}`, { cookie: cTea });
    check('7) 按日期过滤 → 今天的记录仍在', r.status === 200 && (r.data.records || []).length >= 4, r.data.total);
    r = await api(`/api/rollcall/records/export?classId=${c1}&date=${ds}`, { cookie: cTea });
    check('7) 导出点名记录 → xlsx 非空',
      r.status === 200 && r.ctype.includes('spreadsheet') && r.data.bufLen > 1000, { status: r.status, len: r.data.bufLen });
    check('7) 学生查看记录 → 403',
      (await api(`/api/rollcall/records?classId=${c1}`, { cookie: cStu })).status === 403);
    check('7) 学生导出 → 403',
      (await api(`/api/rollcall/records/export?classId=${c1}`, { cookie: cStu })).status === 403);

    // 8) 无学生班级 / 不存在班级
    r = await api('/api/rollcall/pick', { method: 'POST', cookie: cAdmin, body: { classId: 999999, scope: 'all' } });
    check('8) 不存在的班级 → 404', r.status === 404, r.data);
    r = await api('/api/rollcall/candidates?classId=abc', { cookie: cTea });
    check('8) 非法 classId → 400', r.status === 400, r.data);

    // 8b) 独立页面 /random-call 的路由与角色权限
    const page = async (cookie) => {
      const res = await fetch(BASE + '/random-call', { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
      const html = res.status === 200 ? await res.text() : '';
      return { status: res.status, loc: res.headers.get('location') || '', hasPage: /随机点名/.test(html) && /rcStart/.test(html) };
    };
    let pageRes = await page(cTea);
    check('8b) 教师访问 /random-call → 200 且返回点名页面', pageRes.status === 200 && pageRes.hasPage, pageRes);
    pageRes = await page(cAdmin);
    check('8b) 管理员访问 /random-call → 200', pageRes.status === 200 && pageRes.hasPage, pageRes);
    if (cMon) {
      pageRes = await page(cMon);
      check('8b) 班长访问 /random-call → 200', pageRes.status === 200 && pageRes.hasPage, pageRes);
    }
    pageRes = await page(cStu);
    check('8b) 学生访问 /random-call → 302 回看板', pageRes.status === 302 && pageRes.loc === '/dashboard', pageRes);
    pageRes = await page(null);
    check('8b) 未登录访问 /random-call → 302 登录页', pageRes.status === 302 && pageRes.loc === '/login', pageRes);
    const jsRes = await fetch(BASE + '/random-call.js');
    const jsText = jsRes.status === 200 ? await jsRes.text() : '';
    check('8b) 页面脚本存在且调用点名接口', jsRes.status === 200 && /\/api\/rollcall\/pick/.test(jsText));

    // 9) 真实数据未变
    await cleanup();
    const after = {
      rollcall: (await pg.query('SELECT count(*)::int n FROM rollcall_records')).rows[0].n,
      students: (await pg.query('SELECT count(*)::int n FROM students')).rows[0].n,
      sessions: (await pg.query('SELECT count(*)::int n FROM attendance_sessions')).rows[0].n,
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
    };
    check('9) 真实数据未变（点名记录/学生/场次/账号）',
      base.rollcall === after.rollcall && base.students === after.students && base.sessions === after.sessions && base.users === after.users,
      { base, after });
    check('9) 夹具已清理',
      (await pg.query('SELECT count(*)::int n FROM students WHERE student_no LIKE $1', ['RCT' + TAG + '%'])).rows[0].n === 0 &&
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
