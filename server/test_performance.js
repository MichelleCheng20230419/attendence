// ============================================================
// 随机点名（带学科）+ 点赞 + 课堂表现 权限测试
//   点名/点赞：仅班长（本班）
//   查看范围：学科老师 本学科 / 班主任 本班全部学科 / 管理员 全校
//            班长 → 课堂表现/点名记录 ❌（403），但「点赞排行榜」✅ 只读本班（班长端需求）
//            学生 → 全部 ❌（403）
//   导出：班长 ❌，老师/班主任/管理员 ✅
// 夹具：2 个班级（A/B）+ 学生 + 班长/任课老师/班主任/管理员 + 点名与点赞数据；测完清理
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
async function tryLogin(u, p = '123456') { try { return await login(u, p); } catch (_) { return null; } }

const TAG = String(Date.now()).slice(-6);
const GRADE = '课堂表现年级' + TAG;
const CA = '课堂表现A班' + TAG;
const CB = '课堂表现B班' + TAG;
const PRE = 'pf_' + TAG + '_';
const created = { gradeId: null, classIds: [], userIds: [], studentIds: [] };

async function cleanup() {
  // 按"前缀/名称"自愈式清理：即使中途异常未收集到 id 也能清干净
  const uids = (await pg.query('SELECT id FROM users WHERE username LIKE $1', [PRE + '%'])).rows.map((r) => r.id);
  const cids = (await pg.query('SELECT id FROM classes WHERE class_name = ANY($1::text[])', [[CA, CB]])).rows.map((r) => r.id);
  const sids = (await pg.query("SELECT id FROM students WHERE student_no LIKE 'PFA%' OR student_no LIKE 'PFB%'")).rows.map((r) => r.id);
  const allCids = [...new Set([...created.classIds, ...cids])];
  const allSids = [...new Set([...created.studentIds, ...sids])];
  if (allCids.length) {
    await pg.query('DELETE FROM student_likes WHERE class_id = ANY($1::int[])', [allCids]).catch(() => {});
    await pg.query('DELETE FROM rollcall_records WHERE class_id = ANY($1::int[])', [allCids]).catch(() => {});
  }
  if (allSids.length) {
    await pg.query('DELETE FROM student_likes WHERE student_id = ANY($1::int[])', [allSids]).catch(() => {});
    await pg.query('DELETE FROM rollcall_records WHERE student_id = ANY($1::int[])', [allSids]).catch(() => {});
    await pg.query('DELETE FROM attendance_records WHERE student_id = ANY($1::int[])', [allSids]).catch(() => {});
    await pg.query('DELETE FROM students WHERE id = ANY($1::int[])', [allSids]).catch((e) => console.log('  · 清理学生失败：', e.message));
  }
  if (uids.length) {
    await pg.query('DELETE FROM student_likes WHERE operator_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM rollcall_records WHERE picked_by = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL WHERE head_teacher_id = ANY($1::int[]) OR teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM teacher_classes WHERE teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM users WHERE id = ANY($1::int[])', [uids]).catch((e) => console.log('  · 清理账号失败：', e.message));
  }
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name = ANY($1::text[])', [[CA, CB]]).catch((e) => console.log('  · 清理班级失败：', e.message));
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(() => {});
}

(async () => {
  try {
    await cleanup();
    const base = {
      rollcall: (await pg.query('SELECT count(*)::int n FROM rollcall_records')).rows[0].n,
      likes: (await pg.query('SELECT count(*)::int n FROM student_likes')).rows[0].n,
      students: (await pg.query('SELECT count(*)::int n FROM students')).rows[0].n,
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
    };
    const cAdmin = await login('admin');

    // ---------- 夹具 ----------
    const year = (await api('/api/settings', { cookie: cAdmin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: cAdmin, body: { gradeName: GRADE, gradeCode: 'PF', academicYear: year } })).data.id;
    const mkClass = async (name) => (await api('/api/classes', { method: 'POST', cookie: cAdmin, body: { className: name, gradeName: GRADE, academicYear: year } })).data.id;
    const ca = await mkClass(CA);
    const cb = await mkClass(CB);
    created.classIds = [ca, cb];
    const mkStudents = async (classId, n, prefix) => {
      for (let i = 1; i <= n; i += 1) {
        const rr = await api('/api/students', { method: 'POST', cookie: cAdmin, body: { studentNo: prefix + TAG + String(i).padStart(2, '0'), name: prefix + '同学' + i, classId, status: '在读' } });
        if (rr.status >= 300) console.log('  · 创建学生失败：', rr.status, JSON.stringify(rr.data));
        else if (rr.data && rr.data.student) created.studentIds.push(rr.data.student.id);
      }
      const list = (await api('/api/students?classId=' + classId + '&status=' + encodeURIComponent('在读'), { cookie: cAdmin })).data.students || [];
      list.forEach((s) => { if (!created.studentIds.includes(s.id)) created.studentIds.push(s.id); });
      return list;
    };
    const stuA = await mkStudents(ca, 3, 'PFA');
    const stuB = await mkStudents(cb, 2, 'PFB');
    check('0) 夹具：A 班 3 人 / B 班 2 人', stuA.length === 3 && stuB.length === 2, { a: stuA.length, b: stuB.length });

    // 账号：A 班班长、A 班任课老师（物理）、A 班班主任（语文）、B 班任课老师（数学）
    let r = await api('/api/users', { method: 'POST', cookie: cAdmin, body: { username: PRE + 'mon', password: '123456', role: 'monitor', realName: '表现班长', classId: ca } });
    check('0) 创建 A 班班长 → 201', r.status === 201, r.data);
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', { method: 'POST', cookie: cAdmin, body: { username: PRE + 'subj', password: '123456', role: 'teacher', realName: '物理老师', subject: '物理', profileLocked: true, teachingClasses: [{ classId: ca, roleInClass: 'subject_teacher' }] } });
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', { method: 'POST', cookie: cAdmin, body: { username: PRE + 'head', password: '123456', role: 'teacher', realName: '语文班主任', subject: '语文', profileLocked: true, teachingClasses: [{ classId: ca, roleInClass: 'head_teacher' }, { classId: cb, roleInClass: 'subject_teacher' }] } });
    created.userIds.push(r.data.user.id);

    const cMon = await tryLogin(PRE + 'mon');
    const cSubj = await login(PRE + 'subj');
    const cHead = await login(PRE + 'head');
    check('0) 班长/老师可登录', !!cMon && !!cSubj && !!cHead);

    // ---------- 1) 班长点名（带学科） ----------
    r = await api('/api/rollcall/classes', { cookie: cMon });
    check('1) 班长端点名页返回学科列表与 canLike',
      r.status === 200 && Array.isArray(r.data.subjects) && r.data.subjects.length >= 10 && r.data.canLike === true && r.data.role === 'monitor',
      { subjects: (r.data.subjects || []).length, canLike: r.data.canLike });
    r = await api('/api/rollcall/pick', { method: 'POST', cookie: cMon, body: { subject: '物理' } });
    check('1) 班长带学科点名 → 201 且记录学科=物理',
      r.status === 201 && r.data.subject === '物理' && r.data.likeCount === 0, r.data);
    const recId = r.data.recordId;
    const pickedStudent = r.data.student;
    check('1) 点名记录写入 subject',
      (await pg.query('SELECT subject FROM rollcall_records WHERE id = $1', [recId])).rows[0].subject === '物理');
    r = await api('/api/rollcall/pick', { method: 'POST', cookie: cMon, body: { subject: '不存在学科' } });
    check('1) 非法学科 → 400', r.status === 400, r.data);

    // ---------- 2) 点赞（班长 / 任课老师 / 班主任 / 管理员；学生不可） ----------
    r = await api('/api/rollcall/likes', { method: 'POST', cookie: cMon, body: { studentId: pickedStudent.id, subject: '物理' } });
    check('2) 班长点赞 → 201 且返回累计赞数',
      r.status === 201 && r.data.likeCount === 1 && r.data.subject === '物理', r.data);
    r = await api('/api/rollcall/likes', { method: 'POST', cookie: cMon, body: { studentId: pickedStudent.id, subject: '物理' } });
    check('2) 再次点赞 → 累计 2 赞', r.status === 201 && r.data.likeCount === 2, r.data);
    await api('/api/rollcall/likes', { method: 'POST', cookie: cMon, body: { studentId: pickedStudent.id, subject: '语文' } });
    check('2) 另一学科单独计数（语文 1 / 物理 2）',
      (await pg.query("SELECT subject, count(*)::int n FROM student_likes WHERE student_id = $1 GROUP BY subject ORDER BY subject", [pickedStudent.id])).rows
        .map((x) => x.subject + ':' + x.n).join(',') === '物理:2,语文:1');
    check('2) 任课老师点赞（本班）→ 201（老师也可点赞）',
      (await api('/api/rollcall/likes', { method: 'POST', cookie: cSubj, body: { classId: ca, studentId: pickedStudent.id, subject: '生物' } })).status === 201);
    check('2) 班主任点赞（本班）→ 201',
      (await api('/api/rollcall/likes', { method: 'POST', cookie: cHead, body: { classId: ca, studentId: pickedStudent.id, subject: '地理' } })).status === 201);
    check('2) 管理员点赞（任意班级）→ 201',
      (await api('/api/rollcall/likes', { method: 'POST', cookie: cAdmin, body: { classId: ca, studentId: pickedStudent.id, subject: '化学' } })).status === 201);
    check('2) 老师点赞非所带班级 → 403（班级范围不变）',
      (await api('/api/rollcall/likes', { method: 'POST', cookie: cSubj, body: { classId: cb, studentId: stuB[0].id, subject: '物理' } })).status === 403);
    check('2) 缺少学科 → 400', (await api('/api/rollcall/likes', { method: 'POST', cookie: cMon, body: { studentId: pickedStudent.id } })).status === 400);
    check('2) 非本班学生 → 404',
      (await api('/api/rollcall/likes', { method: 'POST', cookie: cMon, body: { studentId: stuB[0].id, subject: '物理' } })).status === 404);
    // 学生账号不可点赞（用独立用户名，避免与第 7 段的学生账号冲突）
    const stuUserName = PRE + 'stulike';
    const ru = await api('/api/users', { method: 'POST', cookie: cAdmin, body: { username: stuUserName, password: '123456', role: 'student', realName: '表现学生', classId: ca, mustChangePassword: false } });
    created.userIds.push(ru.data.user.id);
    const cStuLike = await login(stuUserName);
    check('2) 学生点赞 → 403（学生不可点赞）',
      (await api('/api/rollcall/likes', { method: 'POST', cookie: cStuLike, body: { classId: ca, studentId: pickedStudent.id, subject: '物理' } })).status === 403);

    // 补几条多学科/多学生点名，便于后续范围核对
    await api('/api/rollcall/pick', { method: 'POST', cookie: cMon, body: { subject: '语文' } });
    await api('/api/rollcall/pick', { method: 'POST', cookie: cMon, body: { subject: '数学' } });

    // ---------- 3) 班长：不看课堂表现（叫号提醒 + 随机点名）；仅"点赞排行榜"只读开放 ----------
    r = await api(`/api/performance/records?classId=${ca}`, { cookie: cMon });
    check('3) 班长查看点名记录 → 403（课堂表现仅管理员/班主任/任课老师）', r.status === 403, r.data);
    r = await api(`/api/performance/likes`, { cookie: cMon });
    check('3) 班长查看点赞排行榜 → 200（只读本班；班长端需求）',
      r.status === 200 && r.data.isMonitor === true && String(r.data.scopeLabel).indexOf('A班') >= 0, { status: r.status, scope: r.data && r.data.scopeLabel });
    check('3) 班长点赞排行榜只含本班学生（B 班学生不出现）',
      (r.data.ranking || []).length > 0 && !(r.data.ranking || []).some((x) => String(x.studentNo || '').indexOf('PFB') === 0),
      (r.data.ranking || []).map((x) => x.studentNo));
    const bClass = cb;
    if (bClass) {
      check('3) 班长查别的班级点赞 → 403（范围锁定本班）',
        (await api(`/api/performance/likes?classId=${bClass}`, { cookie: cMon })).status === 403);
    }
    check('3) 班长点赞排行榜筛选项接口可用（/api/likes/options → 200）',
      (await api('/api/likes/options', { cookie: cMon })).status === 200);
    check('3) 班长导出 → 403',
      (await api(`/api/performance/export?type=records&classId=${ca}`, { cookie: cMon })).status === 403);
    check('3) 班长导出点赞 → 403（只读不导出）',
      (await api(`/api/performance/export?type=likes`, { cookie: cMon })).status === 403);
    r = await api(`/api/performance/options`, { cookie: cMon });
    check('3) 班长 options → 403', r.status === 403, r.data);
    // 班长仍可用：随机点名 + 叫号提醒（接收）
    check('3) 班长随机点名仍可用（/api/rollcall/classes → 200）',
      (await api('/api/rollcall/classes', { cookie: cMon })).status === 200);
    check('3) 班长叫号收件箱仍可用（/api/announcements/inbox → 200）',
      (await api('/api/announcements/inbox', { cookie: cMon })).status === 200);

    // ---------- 4) 学科老师：只看本学科 ----------
    r = await api('/api/performance/options', { cookie: cSubj });
    check('4) 学科老师 options：仅本学科可选、可导出',
      r.status === 200 && r.data.scopeLabel === '本学科' && r.data.canExport === true &&
      (r.data.classes || []).length === 1 && JSON.stringify(r.data.classes[0].subjects) === '["物理"]', r.data.classes);
    r = await api(`/api/performance/records?classId=${ca}`, { cookie: cSubj });
    check('4) 学科老师只看物理点名记录（1 条）',
      r.status === 200 && r.data.total === 1 && r.data.records.every((x) => x.subject === '物理'),
      (r.data.records || []).map((x) => x.subject));
    r = await api(`/api/performance/records?classId=${ca}&subject=${encodeURIComponent('语文')}`, { cookie: cSubj });
    check('4) 学科老师显式查语文 → 查不到（范围收窄仍有作用）', r.data.total === 0, r.data.total);
    r = await api('/api/performance/likes', { cookie: cSubj });
    check('4) 学科老师点赞排名只统计物理（2 赞）',
      r.status === 200 && r.data.ranking.length === 1 && r.data.ranking[0].likes === 2, r.data.ranking);
    check('4) 学科老师访问未带班班级 → 403',
      (await api(`/api/performance/records?classId=${cb}`, { cookie: cSubj })).status === 403);
    r = await api(`/api/performance/export?type=records&classId=${ca}`, { cookie: cSubj });
    check('4) 学科老师导出点名记录 → xlsx 非空', r.status === 200 && r.ctype.includes('spreadsheet') && r.data.bufLen > 800, r.status);
    r = await api(`/api/performance/export?type=likes&classId=${ca}`, { cookie: cSubj });
    check('4) 学科老师导出点赞数据 → xlsx 非空', r.status === 200 && r.ctype.includes('spreadsheet') && r.data.bufLen > 500, r.status);

    // ---------- 5) 班主任：本班全部学科 ----------
    r = await api('/api/performance/options', { cookie: cHead });
    check('5) 班主任 options：本班全部学科 + 可导出，且只包含自己的班级',
      r.status === 200 && r.data.scopeLabel === '本班全部学科' && r.data.canExport === true &&
      (r.data.classes || []).length === 2 && r.data.classes.every((c) => [ca, cb].includes(c.classId)),
      (r.data.classes || []).map((c) => c.classId));
    r = await api(`/api/performance/records`, { cookie: cHead });
    check('5) 班主任（不传班级）看到所带班级全部学科点名记录（3 条）',
      r.status === 200 && r.data.total === 3, r.data.total);
    r = await api(`/api/performance/records?classId=${ca}&subject=${encodeURIComponent('数学')}`, { cookie: cHead });
    check('5) 班主任按学科筛选（数学）→ 1 条', r.data.total === 1, r.data.total);
    r = await api(`/api/performance/likes?subject=${encodeURIComponent('物理')}`, { cookie: cHead });
    check('5) 班主任按学科看点赞（物理 2 赞）', r.data.ranking.length === 1 && r.data.ranking[0].likes === 2, r.data.ranking);
    r = await api(`/api/performance/export?type=likes&classId=${ca}`, { cookie: cHead });
    check('5) 班主任导出本班点赞数据 → xlsx 非空', r.status === 200 && r.data.bufLen > 500, r.status);

    // ---------- 6) 管理员：全校 ----------
    r = await api('/api/performance/options', { cookie: cAdmin });
    check('6) 管理员 options：全校 + 可导出', r.status === 200 && r.data.scopeLabel === '全校' && r.data.canExport === true, r.data.scopeLabel);
    r = await api('/api/performance/records', { cookie: cAdmin });
    check('6) 管理员不传班级 → 全校点名记录（≥3 条）', r.status === 200 && r.data.total >= 3, r.data.total);
    r = await api(`/api/performance/records?classId=${cb}`, { cookie: cAdmin });
    check('6) 管理员可按班级查看（B 班 0 条）', r.status === 200 && r.data.total === 0, r.data.total);
    r = await api(`/api/performance/export?type=records`, { cookie: cAdmin });
    check('6) 管理员导出全校 → xlsx 非空', r.status === 200 && r.data.bufLen > 800, r.status);

    // ---------- 7) 学生禁止 ----------
    const cStu = await tryLogin('admin');   // 用管理员登录态模拟"非目标角色"另有断言；学生用自习账号
    r = await api('/api/users', { method: 'POST', cookie: cAdmin, body: { username: PRE + 'stu', password: '123456', role: 'student', realName: '表现学生', classId: ca } });
    created.userIds.push(r.data.user.id);
    const cStudent = await login(PRE + 'stu');
    check('7) 学生查看点名记录 → 403', (await api('/api/performance/records', { cookie: cStudent })).status === 403);
    check('7) 学生查看点赞数据 → 403', (await api('/api/performance/likes', { cookie: cStudent })).status === 403);
    check('7) 学生导出 → 403', (await api('/api/performance/export?type=records', { cookie: cStudent })).status === 403);
    check('7) 学生点名 → 403', (await api('/api/rollcall/pick', { method: 'POST', cookie: cStudent, body: { subject: '物理' } })).status === 403);
    void cStu;

    // ---------- 8) 页面路由 ----------
    const page = async (cookie, url) => {
      const res = await fetch(BASE + url, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
      const html = res.status === 200 ? await res.text() : '';
      return { status: res.status, loc: res.headers.get('location') || '', ok: /课堂表现/.test(html) };
    };
    let pr = await page(cSubj, '/performance');
    check('8) 学科老师访问 /performance → 200 页面', pr.status === 200 && pr.ok, pr);
    pr = await page(cMon, '/performance');
    check('8) 班长访问 /performance → 302 回看板（课堂表现不对班长开放）', pr.status === 302 && pr.loc === '/dashboard', pr);
    pr = await page(cAdmin, '/performance');
    check('8) 管理员访问 /performance → 200', pr.status === 200 && pr.ok, pr);
    pr = await page(cStudent, '/performance');
    check('8) 学生访问 /performance → 302 回看板', pr.status === 302 && pr.loc === '/dashboard', pr);
    pr = await page(null, '/performance');
    check('8) 未登录访问 → 302 登录页', pr.status === 302 && pr.loc === '/login', pr);
    const jsRes = await fetch(BASE + '/performance.js');
    check('8) 页面脚本存在且调用课堂表现接口',
      jsRes.status === 200 && /\/api\/performance\/records/.test(await jsRes.text()));

    // ---------- 9) 真实数据未变 ----------
    await cleanup();
    const after = {
      rollcall: (await pg.query('SELECT count(*)::int n FROM rollcall_records')).rows[0].n,
      likes: (await pg.query('SELECT count(*)::int n FROM student_likes')).rows[0].n,
      students: (await pg.query('SELECT count(*)::int n FROM students')).rows[0].n,
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
    };
    check('9) 真实数据未变（点名/点赞/学生/账号）',
      base.rollcall === after.rollcall && base.likes === after.likes && base.students === after.students && base.users === after.users,
      { base, after });
    check('9) 夹具已清理',
      (await pg.query('SELECT count(*)::int n FROM users WHERE username LIKE $1', [PRE + '%'])).rows[0].n === 0 &&
      (await pg.query('SELECT count(*)::int n FROM classes WHERE class_name = ANY($1::text[])', [[CA, CB]])).rows[0].n === 0);
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
