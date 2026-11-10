// ============================================================
// 叫号系统（announcements）权限与流程测试
//   发布：任课老师/班主任 ✅所带班级；班长 ❌；学生 ❌；管理员 ✅任意班级
//   教师端列表：老师=自己发布的；管理员=全部；班长/学生 ❌
//   班长端收件箱：仅本班（他人班级 403）；非班长 403
//   标记已处理 / 播报：仅本班班长
//   删除：发布者 / 管理员
// 夹具：2 个班级 + 学生 + 班长/任课老师/班主任/管理员；测完清理（自愈式）
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
const GRADE = '叫号年级' + TAG;
const CA = '叫号A班' + TAG;
const CB = '叫号B班' + TAG;
const PRE = 'an_' + TAG + '_';
const created = { gradeId: null, classIds: [], userIds: [], studentIds: [] };

async function cleanup() {
  const uids = (await pg.query('SELECT id FROM users WHERE username LIKE $1', [PRE + '%'])).rows.map((r) => r.id);
  const cids = (await pg.query('SELECT id FROM classes WHERE class_name = ANY($1::text[])', [[CA, CB]])).rows.map((r) => r.id);
  const sids = (await pg.query("SELECT id FROM students WHERE student_no LIKE 'ANA%' OR student_no LIKE 'ANB%'")).rows.map((r) => r.id);
  const allCids = [...new Set([...created.classIds, ...cids])];
  const allSids = [...new Set([...created.studentIds, ...sids])];
  if (allCids.length) {
    await pg.query('DELETE FROM announcements WHERE class_id = ANY($1::int[])', [allCids]).catch(() => {});
  }
  if (allSids.length) {
    await pg.query('DELETE FROM announcements WHERE student_id = ANY($1::int[])', [allSids]).catch(() => {});
  }
  if (uids.length) {
    await pg.query('DELETE FROM announcements WHERE teacher_id = ANY($1::int[]) OR processed_by = ANY($1::int[])', [uids]).catch(() => {});
  }
  await pg.query("DELETE FROM announcements WHERE location LIKE 'ANTEST%'").catch(() => {});
  if (allSids.length) {
    await pg.query('DELETE FROM attendance_records WHERE student_id = ANY($1::int[])', [allSids]).catch(() => {});
    await pg.query('DELETE FROM students WHERE id = ANY($1::int[])', [allSids]).catch((e) => console.log('  · 清理学生失败：', e.message));
  }
  if (uids.length) {
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
      ann: (await pg.query('SELECT count(*)::int n FROM announcements')).rows[0].n,
      students: (await pg.query('SELECT count(*)::int n FROM students')).rows[0].n,
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
      classes: (await pg.query('SELECT count(*)::int n FROM classes')).rows[0].n,
    };
    const cAdmin = await login('admin');
    // 真实数据里可能已有叫号（老师实际使用），断言一律基于"夹具增量"，不受真实数据影响
    const baseAnnIds = new Set((await pg.query('SELECT id FROM announcements')).rows.map((x) => x.id));

    // ---------- 0) 夹具 ----------
    const year = (await api('/api/settings', { cookie: cAdmin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: cAdmin, body: { gradeName: GRADE, gradeCode: 'AN', academicYear: year } })).data.id;
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
    const stuA = await mkStudents(ca, 3, 'ANA');
    const stuB = await mkStudents(cb, 2, 'ANB');
    check('0) 夹具：A 班 3 人 / B 班 2 人', stuA.length === 3 && stuB.length === 2, { a: stuA.length, b: stuB.length });

    // A 班班长、A 班任课老师、A 班班主任（同时带 B 班）、B 班班长
    let r = await api('/api/users', { method: 'POST', cookie: cAdmin, body: { username: PRE + 'mon', password: '123456', role: 'monitor', realName: '叫号班长', classId: ca, mustChangePassword: false } });
    check('0) 创建 A 班班长 → 201', r.status === 201, r.data);
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', { method: 'POST', cookie: cAdmin, body: { username: PRE + 'monb', password: '123456', role: 'monitor', realName: 'B班班长', classId: cb, mustChangePassword: false } });
    check('0) 创建 B 班班长 → 201', r.status === 201, r.data);
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', { method: 'POST', cookie: cAdmin, body: { username: PRE + 'subj', password: '123456', role: 'teacher', realName: '叫号任课', subject: '物理', profileLocked: true, teachingClasses: [{ classId: ca, roleInClass: 'subject_teacher' }] } });
    check('0) 创建 A 班任课老师 → 201', r.status === 201, r.data);
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', { method: 'POST', cookie: cAdmin, body: { username: PRE + 'head', password: '123456', role: 'teacher', realName: '叫号班主任', subject: '语文', profileLocked: true, teachingClasses: [{ classId: cb, roleInClass: 'head_teacher' }] } });
    check('0) 创建 B 班班主任 → 201', r.status === 201, r.data);
    created.userIds.push(r.data.user.id);
    r = await api('/api/users', { method: 'POST', cookie: cAdmin, body: { username: PRE + 'stu', password: '123456', role: 'student', realName: '叫号学生', classId: ca, mustChangePassword: false } });
    created.userIds.push(r.data.user.id);

    const cMon = await tryLogin(PRE + 'mon');
    const cMonB = await tryLogin(PRE + 'monb');
    const cSubj = await login(PRE + 'subj');
    const cHead = await login(PRE + 'head');
    const cStu = await tryLogin(PRE + 'stu');
    check('0) 班长/老师/学生可登录', !!cMon && !!cMonB && !!cSubj && !!cHead && !!cStu, { cMon: !!cMon, cMonB: !!cMonB, cSubj: !!cSubj, cHead: !!cHead, cStu: !!cStu });

    const when = '2026-03-05 10:30';

    // ---------- 1) 发布权限 ----------
    r = await api('/api/announcements', { method: 'POST', cookie: cSubj, body: { classId: ca, studentId: stuA[0].id, location: 'ANTEST教务处', scheduledTime: when, note: '任课老师发布' } });
    check('1) 任课老师发布所带班级 → 201', r.status === 201 && r.data.announcement && r.data.announcement.status === 'pending', r.data);
    const idSubj = r.data && r.data.announcement && r.data.announcement.id;
    check('1) 返回班级/学生/地点/时间正确',
      r.data.announcement.classId === ca && r.data.announcement.studentId === stuA[0].id &&
      r.data.announcement.location === 'ANTEST教务处' && r.data.announcement.priority === 'normal' &&
      /2026-03-05 10:30/.test(r.data.announcement.scheduledText || ''), r.data.announcement);

    r = await api('/api/announcements', { method: 'POST', cookie: cHead, body: { classId: cb, studentId: stuB[0].id, location: 'ANTEST班主任办公室', scheduledTime: when, priority: 'urgent' } });
    check('1) 班主任发布所带班级 → 201（紧急）', r.status === 201 && r.data.announcement.priority === 'urgent', r.data);
    const idHead = r.data.announcement.id;

    r = await api('/api/announcements', { method: 'POST', cookie: cSubj, body: { classId: cb, studentId: stuB[0].id, location: 'ANTEST越权', scheduledTime: when } });
    check('1) 老师发布非所带班级 → 403', r.status === 403, r.data);

    r = await api('/api/announcements', { method: 'POST', cookie: cMon, body: { classId: ca, studentId: stuA[0].id, location: 'ANTEST班长', scheduledTime: when } });
    check('1) 班长发布 → 403（班长不能发布）', r.status === 403, r.data);

    r = await api('/api/announcements', { method: 'POST', cookie: cStu, body: { classId: ca, studentId: stuA[0].id, location: 'ANTEST学生', scheduledTime: when } });
    check('1) 学生发布 → 403', r.status === 403, r.data);

    r = await api('/api/announcements', { method: 'POST', cookie: cAdmin, body: { classId: cb, studentId: stuB[1].id, location: 'ANTEST管理员', scheduledTime: when } });
    check('1) 管理员发布任意班级 → 201', r.status === 201, r.data);
    const idAdmin = r.data.announcement.id;

    r = await api('/api/announcements', { method: 'POST', body: { classId: ca, studentId: stuA[0].id, location: 'x', scheduledTime: when } });
    check('1) 未登录发布 → 401', r.status === 401, r.data);

    // ---------- 2) 参数校验 ----------
    const bad = async (body, label) => {
      const rr = await api('/api/announcements', { method: 'POST', cookie: cSubj, body });
      check('2) ' + label + ' → 400', rr.status === 400, rr.data);
    };
    await bad({ studentId: stuA[0].id, location: 'ANTESTx', scheduledTime: when }, '缺班级');
    await bad({ classId: ca, location: 'ANTESTx', scheduledTime: when }, '缺学生');
    await bad({ classId: ca, studentId: stuA[0].id, scheduledTime: when }, '缺"到何处"');
    await bad({ classId: ca, studentId: stuA[0].id, location: 'ANTESTx' }, '缺"何时"');
    await bad({ classId: ca, studentId: stuA[0].id, location: 'ANTESTx', scheduledTime: '不是时间' }, '何时格式非法');
    await bad({ classId: ca, studentId: stuA[0].id, location: 'A'.repeat(101), scheduledTime: when }, '"到何处"超 100 字');
    r = await api('/api/announcements', { method: 'POST', cookie: cSubj, body: { classId: ca, studentId: stuB[0].id, location: 'ANTESTx', scheduledTime: when } });
    check('2) 学生不属于该班级 → 404', r.status === 404, r.data);
    r = await api('/api/announcements', { method: 'POST', cookie: cSubj, body: { classId: 99999999, studentId: stuA[0].id, location: 'ANTESTx', scheduledTime: when } });
    check('2) 老师向不存在的班级发布 → 403（先校验班级权限，不泄露班级存在性）', r.status === 403, r.data);
    r = await api('/api/announcements', { method: 'POST', cookie: cAdmin, body: { classId: 99999999, studentId: stuA[0].id, location: 'ANTESTx', scheduledTime: when } });
    check('2) 管理员向不存在的班级发布 → 404', r.status === 404, r.data);

    // ---------- 3) 教师端列表范围 ----------
    r = await api('/api/announcements', { cookie: cSubj });
    check('3) 任课老师列表 → 只看到自己发布的',
      r.status === 200 && r.data.announcements.length === 1 && r.data.announcements[0].id === idSubj &&
      r.data.total === 1 && r.data.pending === 1, { n: r.data.announcements.length, ids: r.data.announcements.map((a) => a.id) });
    check('3) 任课老师列表带可选班级（仅所带班级）',
      Array.isArray(r.data.classes) && r.data.classes.length === 1 && r.data.classes[0].classId === ca, r.data.classes);

    r = await api('/api/announcements', { cookie: cHead });
    check('3) 班主任列表 → 只看到自己发布的（B班）',
      r.status === 200 && r.data.announcements.length === 1 && r.data.announcements[0].id === idHead, r.data.announcements);

    r = await api('/api/announcements', { cookie: cAdmin });
    const adminIds = (r.data.announcements || []).map((a) => a.id);
    const fixtureIds = [idSubj, idHead, idAdmin];
    check('3) 管理员列表 → 看到全部 3 条夹具叫号（不受真实数据影响）',
      r.status === 200 && fixtureIds.every((id) => adminIds.includes(id)), { n: adminIds.length });
    check('3) 管理员列表带全部班级供发布', Array.isArray(r.data.classes) && r.data.classes.length >= 2, (r.data.classes || []).length);
    check('3) 列表按发布时间倒序（夹具三条顺序 = 管理员 > 班主任 > 任课）',
      adminIds.indexOf(idAdmin) < adminIds.indexOf(idHead) && adminIds.indexOf(idHead) < adminIds.indexOf(idSubj),
      { admin: adminIds.indexOf(idAdmin), head: adminIds.indexOf(idHead), subj: adminIds.indexOf(idSubj) });

    r = await api('/api/announcements', { cookie: cMon });
    check('3) 班长访问教师端列表 → 403', r.status === 403, r.data);
    r = await api('/api/announcements', { cookie: cStu });
    check('3) 学生访问教师端列表 → 403', r.status === 403, r.data);
    r = await api('/api/announcements');
    check('3) 未登录访问列表 → 401', r.status === 401, r.data);

    // 筛选（只断言夹具数据，真实叫号可能同时命中）
    r = await api('/api/announcements?status=processed', { cookie: cAdmin });
    const procIds = (r.data.announcements || []).map((a) => a.id);
    check('3) 状态筛选 processed → 不含夹具叫号（均为待处理）',
      r.status === 200 && !fixtureIds.some((id) => procIds.includes(id)), procIds);
    r = await api('/api/announcements?status=pending', { cookie: cAdmin });
    const pendIds = (r.data.announcements || []).map((a) => a.id);
    check('3) 状态筛选 pending → 含全部 3 条夹具叫号',
      r.status === 200 && fixtureIds.every((id) => pendIds.includes(id)), pendIds.length);
    r = await api('/api/announcements?status=xxx', { cookie: cAdmin });
    check('3) 非法状态 → 400', r.status === 400, r.data);
    r = await api('/api/announcements?classId=' + cb, { cookie: cAdmin });
    const cbIds = (r.data.announcements || []).map((a) => a.id);
    check('3) 班级筛选 → 恰好含 B 班 2 条夹具（不含 A 班）',
      r.status === 200 && cbIds.includes(idHead) && cbIds.includes(idAdmin) && !cbIds.includes(idSubj), cbIds);
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    r = await api('/api/announcements?date=' + todayStr, { cookie: cAdmin });
    const todayIds = (r.data.announcements || []).map((a) => a.id);
    check('3) 日期筛选（今天）→ 含全部 3 条夹具叫号',
      r.status === 200 && fixtureIds.every((id) => todayIds.includes(id)), todayIds.length);
    r = await api('/api/announcements?date=2000-01-01', { cookie: cAdmin });
    check('3) 日期筛选（无数据日）→ 0 条', r.status === 200 && r.data.announcements.length === 0, r.data.announcements.length);

    // ---------- 4) 班长端收件箱 ----------
    r = await api('/api/announcements/inbox', { cookie: cMon });
    check('4) A班班长收件箱 → 仅本班 1 条（任课老师发的A班）',
      r.status === 200 && r.data.classId === ca && r.data.announcements.length === 1 &&
      r.data.announcements.every((a) => a.classId === ca), { n: (r.data.announcements || []).length, ids: (r.data.announcements || []).map((a) => a.classId) });
    check('4) 收件箱返回未处理数 / 待播报列表',
      r.data.pendingCount === 1 && r.data.unplayed.length === 1, { p: r.data.pendingCount, u: r.data.unplayed.length });
    check('4) 收件箱带班级名', r.data.className === CA, r.data.className);

    r = await api('/api/announcements/inbox', { cookie: cMonB });
    check('4) B班班长收件箱 → 仅本班 2 条（班主任紧急 + 管理员）',
      r.status === 200 && r.data.announcements.length === 2 && r.data.announcements.every((a) => a.classId === cb),
      (r.data.announcements || []).map((a) => a.classId));

    r = await api('/api/announcements/inbox?classId=' + cb, { cookie: cMon });
    check('4) 班长查询他班收件箱 → 403', r.status === 403, r.data);
    r = await api('/api/announcements/inbox', { cookie: cSubj });
    check('4) 老师访问收件箱 → 403', r.status === 403, r.data);
    r = await api('/api/announcements/inbox', { cookie: cStu });
    check('4) 学生访问收件箱 → 403', r.status === 403, r.data);
    r = await api('/api/announcements/inbox');
    check('4) 未登录访问收件箱 → 401', r.status === 401, r.data);

    // ---------- 5) 详情权限 ----------
    r = await api('/api/announcements/' + idSubj, { cookie: cSubj });
    check('5) 发布老师看自己的叫号详情 → 200', r.status === 200 && r.data.announcement.id === idSubj, r.data);
    r = await api('/api/announcements/' + idSubj, { cookie: cMon });
    check('5) 本班班长看详情 → 200', r.status === 200, r.data);
    r = await api('/api/announcements/' + idSubj, { cookie: cMonB });
    check('5) 他班班长看详情 → 403', r.status === 403, r.data);
    r = await api('/api/announcements/' + idHead, { cookie: cSubj });
    check('5) 老师看别人发的详情 → 403', r.status === 403, r.data);
    r = await api('/api/announcements/99999999', { cookie: cAdmin });
    check('5) 不存在的叫号 → 404', r.status === 404, r.data);

    // ---------- 6) 标记已处理 / 播报 ----------
    r = await api('/api/announcements/' + idSubj + '/played', { method: 'POST', cookie: cMonB });
    check('6) 他班班长标记播报 → 403', r.status === 403, r.data);
    r = await api('/api/announcements/' + idSubj + '/played', { method: 'POST', cookie: cSubj });
    check('6) 老师标记播报 → 403', r.status === 403, r.data);
    r = await api('/api/announcements/' + idSubj + '/played', { method: 'POST', cookie: cMon });
    check('6) 本班班长标记已播报 → 200', r.status === 200 && r.data.ok === true, r.data);
    check('6) 数据库 is_played=true', (await pg.query('SELECT is_played FROM announcements WHERE id = $1', [idSubj])).rows[0].is_played === true);
    r = await api('/api/announcements/inbox', { cookie: cMon });
    check('6) 播报后本班 unplayed=0', r.data.unplayed.length === 0, r.data.unplayed.length);

    r = await api('/api/announcements/' + idSubj + '/process', { method: 'POST', cookie: cMonB });
    check('6) 他班班长标记已处理 → 403', r.status === 403, r.data);
    r = await api('/api/announcements/' + idSubj + '/process', { method: 'POST', cookie: cSubj });
    check('6) 老师标记已处理 → 403', r.status === 403, r.data);
    r = await api('/api/announcements/' + idSubj + '/process', { method: 'POST', cookie: cMon });
    check('6) 本班班长标记已处理 → 200 且状态 processed', r.status === 200 && r.data.announcement.status === 'processed', r.data);
    const dbRow = (await pg.query('SELECT status, processed_at, processed_by, processed_by_name, is_played FROM announcements WHERE id = $1', [idSubj])).rows[0];
    check('6) 数据库写入处理人/处理时间',
      dbRow.status === 'processed' && dbRow.processed_at !== null && dbRow.processed_by_name === '叫号班长' && dbRow.is_played === true, dbRow);
    r = await api('/api/announcements/inbox', { cookie: cMon });
    check('6) 处理后 pendingCount=0（本班仅 1 条）', r.data.pendingCount === 0, r.data.pendingCount);
    r = await api('/api/announcements?status=processed', { cookie: cSubj });
    check('6) 老师端已处理筛选 → 1 条', r.status === 200 && r.data.announcements.length === 1, r.data.announcements.length);
    r = await api('/api/announcements/' + idSubj + '/process', { method: 'POST', cookie: cMon });
    check('6) 重复标记已处理 → 200（幂等）', r.status === 200 && r.data.announcement.status === 'processed', r.status);

    // ---------- 7) 删除权限 ----------
    r = await api('/api/announcements/' + idSubj, { method: 'DELETE', cookie: cHead });
    check('7) 老师删除他人叫号 → 403', r.status === 403, r.data);
    r = await api('/api/announcements/' + idSubj, { method: 'DELETE', cookie: cMon });
    check('7) 班长删除 → 403', r.status === 403, r.data);
    r = await api('/api/announcements/' + idSubj, { method: 'DELETE', cookie: cSubj });
    check('7) 发布老师删除自己的 → 200', r.status === 200 && r.data.deleted === true, r.data);
    check('7) 数据库已删除', (await pg.query('SELECT count(*)::int n FROM announcements WHERE id = $1', [idSubj])).rows[0].n === 0);
    r = await api('/api/announcements/' + idHead, { method: 'DELETE', cookie: cAdmin });
    check('7) 管理员删除任意 → 200', r.status === 200, r.data);
    r = await api('/api/announcements/' + idAdmin, { method: 'DELETE', cookie: cAdmin });
    check('7) 管理员删除自己的 → 200', r.status === 200, r.data);
    check('7) 夹具叫号已清空',
      (await pg.query('SELECT count(*)::int n FROM announcements WHERE class_id = ANY($1::int[])', [[ca, cb]])).rows[0].n === 0);

    // ---------- 8) 页面路由与脚本 ----------
    const page = async (cookie, url) => {
      const res = await fetch(BASE + url, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
      const html = res.status === 200 ? await res.text() : '';
      return { status: res.status, loc: res.headers.get('location') || '', ok: /叫号管理/.test(html) };
    };
    let pr = await page(cSubj, '/announcements');
    check('8) 老师访问 /announcements → 200 页面', pr.status === 200 && pr.ok, pr);
    pr = await page(cAdmin, '/announcements');
    check('8) 管理员访问 /announcements → 200', pr.status === 200 && pr.ok, pr);
    pr = await page(cMon, '/announcements');
    check('8) 班长访问 /announcements → 302 回看板', pr.status === 302 && pr.loc === '/dashboard', pr);
    pr = await page(cStu, '/announcements');
    check('8) 学生访问 /announcements → 302 回看板', pr.status === 302 && pr.loc === '/dashboard', pr);
    pr = await page(null, '/announcements');
    check('8) 未登录访问 /announcements → 302 登录页', pr.status === 302 && pr.loc === '/login', pr);
    const jsRes = await fetch(BASE + '/announcements.js');
    const jsTxt = jsRes.status === 200 ? await jsRes.text() : '';
    check('8) 页面脚本存在且调用叫号接口',
      jsRes.status === 200 && /\/api\/announcements/.test(jsTxt) && /scheduledTime/.test(jsTxt));

    // 班长端入口（签到操作台）应包含叫号按钮与播报脚本
    const idxRes = await fetch(BASE + '/dashboard', { headers: { Cookie: cMon } });
    const idxHtml = idxRes.status === 200 ? await idxRes.text() : '';
    // 顶部导航栏自 v3.11.0 起由统一组件 navbar.js 渲染（签到台也挂同一份），因此断言：
    //   ① 签到操作台 HTML 含导航栏挂载点与组件脚本；② 组件内包含班长端叫号入口
    check('8) 签到操作台挂载统一导航栏（navbarHost + navbar.js）',
      /id="navbarHost"/.test(idxHtml) && /navbar\.js/.test(idxHtml), idxHtml.length);
    const navRes0 = await fetch(BASE + '/navbar.js');
    const navTxt0 = navRes0.status === 200 ? await navRes0.text() : '';
    check('8) 统一导航栏组件含叫号入口（btnAnnouncements）', /btnAnnouncements/.test(navTxt0), navTxt0.length);
    const appRes = await fetch(BASE + '/app.js');
    const appTxt = appRes.status === 200 ? await appRes.text() : '';
    check('8) app.js 含叫号收件箱与语音播报逻辑',
      /\/api\/announcements\/inbox/.test(appTxt) && /speechSynthesis/.test(appTxt) && /请.*到/.test(appTxt));

    // ---------- 9) 真实数据未变 ----------
    await cleanup();
    const after = {
      ann: (await pg.query('SELECT count(*)::int n FROM announcements')).rows[0].n,
      students: (await pg.query('SELECT count(*)::int n FROM students')).rows[0].n,
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
      classes: (await pg.query('SELECT count(*)::int n FROM classes')).rows[0].n,
    };
    check('9) 真实数据未变（叫号/学生/账号/班级）',
      base.ann === after.ann && base.students === after.students && base.users === after.users && base.classes === after.classes,
      { base, after });
    const nowIds = new Set((await pg.query('SELECT id FROM announcements')).rows.map((x) => x.id));
    check('9) 未误删测试前已存在的真实叫号',
      [...baseAnnIds].every((id) => nowIds.has(id)), { baseAnnIds: [...baseAnnIds], now: [...nowIds] });
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
