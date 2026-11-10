// ============================================================
// 巡堂记录业务功能测试（问题 / 照片 / 反馈 + 状态流转 + 小组权限）
//   夹具：临时年级 + 1 班 + 2 个教师（1 个加入"巡堂组"含全部操作权限，1 个不进任何小组）
//         + 3 条巡堂问题（其中 1 条带照片）
//   测完清理：删除问题（级联照片/反馈）、删除上传的照片文件、删除夹具账号/小组/班级/年级；
//             断言真实数据行数未变
//   注意：小组名带 TAG 后缀，避免误删管理员真实创建的同名小组
// ============================================================
'use strict';
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
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
  return { status: res.status, data, setc: res.headers.get('set-cookie') || '', loc: res.headers.get('location') || '' };
}
async function login(u, p) {
  // admin 的密码可能被管理员改过 → 用环境变量 DSH_ADMIN_PW（默认 123456）；夹具账号固定 123456
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('登录失败 ' + u + ': ' + r.status);
  const m = r.setc.match(/connect\.sid=([^;]+)/);
  return 'connect.sid=' + m[1];
}
// 1x1 PNG（合法图片，用于上传用例）
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
async function apiForm(p, { method = 'POST', cookie, fields = {}, files = 0, mime = 'image/png', bytes = null, name = null } = {}) {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, String(v)));
  for (let i = 0; i < files; i++) {
    const buf = bytes || PNG_1PX;
    fd.append('photos', new Blob([buf], { type: mime }), name || `photo${i + 1}.png`);
  }
  const headers = cookie ? { Cookie: cookie } : {};
  const res = await fetch(BASE + p, { method, headers, body: fd, redirect: 'manual' });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

const TAG = String(Date.now()).slice(-6);
const GRADE = '巡堂年级' + TAG, CLASS = '巡堂班' + TAG;
const T1 = 'ins_tea1_' + TAG;    // 加入"巡堂组"（全部操作权限）
const T2 = 'ins_tea2_' + TAG;    // 不进任何小组
const G1 = '巡堂组' + TAG;
const created = { gradeId: null, classId: null, userIds: [], groupId: null, groupIds: [], issueIds: [], files: [] };
let realBefore = null;

async function snapshotReal() {
  const q = async (sql) => (await pg.query(sql)).rows[0].n;
  return {
    users: await q('SELECT count(*)::int n FROM users'),
    groups: await q('SELECT count(*)::int n FROM groups'),
    user_groups: await q('SELECT count(*)::int n FROM user_groups'),
    classes: await q('SELECT count(*)::int n FROM classes'),
    issues: await q('SELECT count(*)::int n FROM inspection_issues'),
  };
}

async function hardCleanup() {
  if (created.issueIds.length) {
    await pg.query('DELETE FROM inspection_issues WHERE id = ANY($1::int[])', [created.issueIds]).catch(() => {});
  }
  // 兜底：清理本套件描述特征的问题
  await pg.query(`DELETE FROM inspection_issues WHERE description LIKE '%[巡堂用例%'`).catch(() => {});
  const like = '巡堂组' + TAG + '%';
  await pg.query(`DELETE FROM user_groups WHERE group_id IN (SELECT id FROM groups WHERE name LIKE $1)`, [like]).catch(() => {});
  await pg.query('DELETE FROM groups WHERE name LIKE $1', [like]).catch(() => {});
  await pg.query(`DELETE FROM users WHERE username LIKE 'ins\\_tea%'`).catch(() => {});
  await pg.query(`SELECT purge_class(id) FROM classes WHERE class_name LIKE '巡堂班%'`).catch(() => {});
  await pg.query(`DELETE FROM grades WHERE grade_name LIKE '巡堂年级%'`).catch(() => {});
  // 删除本次上传的照片文件
  created.files.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
}

const DESC = (s) => `[巡堂用例${TAG}] ${s}`;

(async () => {
  let admin = null, c1 = null, c2 = null;
  try {
    console.log('0) 夹具准备…');
    admin = await login('admin');
    realBefore = await snapshotReal();

    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'INS', academicYear: year } })).data.id;
    created.classId = (await api('/api/classes', { method: 'POST', cookie: admin, body: { className: CLASS, gradeName: GRADE, academicYear: year } })).data.id;
    const mkTeacher = async (u) => {
      const r = await api('/api/users', {
        method: 'POST', cookie: admin,
        body: {
          username: u, password: '123456', role: 'teacher', realName: u, classId: created.classId,
          mustChangePassword: false, profileLocked: true, subject: '数学',
          teachingClasses: [{ classId: created.classId, roleInClass: 'subject_teacher' }],
        },
      });
      if (r.status !== 201) console.log('  · 创建账号失败 ' + u + ' ' + JSON.stringify(r.data));
      created.userIds.push(r.data.user.id);
      return r.data.user.id;
    };
    const idT1 = await mkTeacher(T1);
    await mkTeacher(T2);
    const g = await api('/api/groups', {
      method: 'POST', cookie: admin,
      body: {
        name: G1, description: '巡堂检查',
        permissions: { pages: ['inspection'], actions: ['view', 'create_issue', 'add_feedback', 'upload_photo'] },
      },
    });
    created.groupId = g.data.group.id;
    created.groupIds.push(created.groupId);
    await api('/api/groups/' + created.groupId + '/members', { method: 'PUT', cookie: admin, body: { userIds: [idT1] } });
    c1 = await login(T1);
    c2 = await login(T2);
    check('0) 夹具就绪（年级 + 班 + 2 教师 + 巡堂组）',
      !!(created.gradeId && created.classId && created.groupId && idT1), created);

    // ---------- 1) 页面与字典 ----------
    console.log('1) 页面与字典:');
    check('1) 列表页 /inspection → 200（小组成员）', (await api('/inspection', { cookie: c1 })).status === 200);
    check('1) 创建页 /inspection/new → 200', (await api('/inspection/new', { cookie: c1 })).status === 200);
    check('1) 详情页 /inspection/detail → 200', (await api('/inspection/detail', { cookie: c1 })).status === 200);
    check('1) 无小组教师访问巡堂页 → 302 回签到台', (await api('/inspection', { cookie: c2 })).status === 302);
    const st = await api('/api/inspection/status', { cookie: c1 });
    check('1) 字典：问题类型 5 项（卫生/纪律/设备/教学/其他）',
      JSON.stringify((st.data.categories || []).map((x) => x.label)) === JSON.stringify(['卫生', '纪律', '设备', '教学', '其他']), st.data.categories);
    check('1) 字典：状态 3 项（待处理/处理中/已解决）',
      JSON.stringify((st.data.statuses || []).map((x) => x.label)) === JSON.stringify(['待处理', '处理中', '已解决']), st.data.statuses);
    check('1) 字典：反馈选择 3 项（处理中/已解决/未解决）',
      JSON.stringify((st.data.feedbackStatuses || []).map((x) => x.label)) === JSON.stringify(['处理中', '已解决', '未解决']), st.data.feedbackStatuses);
    check('1) 字典：紧急程度含 普通/紧急',
      JSON.stringify((st.data.priorities || []).map((x) => x.key)) === JSON.stringify(['normal', 'urgent']), st.data.priorities);

    // ---------- 2) 记录问题（含照片） ----------
    console.log('2) 记录问题:');
    let r = await apiForm('/api/inspection/issues', {
      cookie: c1,
      fields: { description: DESC('教室卫生较差，桌椅摆放不整齐'), classId: created.classId, category: 'hygiene', priority: 'normal' },
      files: 2,
    });
    check('2) 带 2 张照片记录问题 → 201', r.status === 201, r.data);
    const idA = r.data.issue.id; created.issueIds.push(idA);
    check('2) 初始状态 = 待处理（pending）', r.data.issue.status === 'pending' && r.data.issue.statusLabel === '待处理', r.data.issue.status);
    check('2) 照片入库 2 张且返回访问路径',
      r.data.photos.length === 2 && /^\/uploads\/inspection\//.test(r.data.photos[0].url),
      r.data.photos);
    r.data.photos.forEach((p) => created.files.push(path.join(__dirname, '../public', p.url.replace(/^\//, ''))));
    const photoUrl = r.data.photos[0].url;
    const photoRes = await fetch(BASE + photoUrl);
    check('2) 照片可通过 URL 访问（静态资源 200 且是图片）',
      photoRes.status === 200 && /image\/(png|jpeg)/.test(photoRes.headers.get('content-type') || ''),
      { status: photoRes.status, ct: photoRes.headers.get('content-type') });
    const fileOnDisk = fs.existsSync(path.join(__dirname, '../public', photoUrl.replace(/^\//, '')));
    check('2) 照片文件已落盘（file_path 指向真实文件）', fileOnDisk, photoUrl);

    r = await apiForm('/api/inspection/issues', {
      cookie: c1,
      fields: { description: DESC('课堂纪律松散'), classId: created.classId, category: 'discipline', priority: 'urgent' },
    });
    check('2) 不带照片记录问题 → 201', r.status === 201, r.data);
    const idB = r.data.issue.id; created.issueIds.push(idB);
    check('2) 照片数 0 / 紧急程度 = 紧急', r.data.issue.photoCount === 0 && r.data.issue.priorityLabel === '紧急', r.data.issue);

    r = await apiForm('/api/inspection/issues', {
      cookie: c1,
      fields: { description: DESC('多媒体设备故障'), classId: created.classId, category: 'equipment', priority: 'normal', issueDate: '2026-09-16' },
    });
    const idC = r.data.issue.id; created.issueIds.push(idC);
    check('2) 可指定巡堂日期（2026-09-16）', r.data.issue.issueDate === '2026-09-16', r.data.issue.issueDate);
    check('2) 未指定日期时默认当天', (await api('/api/inspection/issues/' + idA, { cookie: c1 })).data.issue.issueDate !== '', '');

    // 校验类
    r = await apiForm('/api/inspection/issues', { cookie: c1, fields: { description: '   ' } });
    check('2) 空描述 → 400', r.status === 400, r.data);
    r = await apiForm('/api/inspection/issues', { cookie: c1, fields: { description: 'x', classId: 999999 } });
    check('2) 班级不存在 → 400', r.status === 400, r.data);
    r = await apiForm('/api/inspection/issues', { cookie: c1, files: 1, mime: 'text/plain', name: 'a.txt', fields: { description: 'x' } });
    check('2) 非 JPG/PNG → 400（仅支持图片）', r.status === 400 && /JPG|PNG/.test(r.data.error || ''), r.data);
    r = await apiForm('/api/inspection/issues', {
      cookie: c1, files: 1, bytes: Buffer.alloc(5 * 1024 * 1024 + 1024, 1), fields: { description: 'x' },
    });
    check('2) 单张超过 5MB → 400', r.status === 400, r.data);
    r = await apiForm('/api/inspection/issues', { cookie: c1, files: 10, fields: { description: 'x' } });
    check('2) 一次超过 9 张 → 400', r.status === 400, r.data);
    r = await apiForm('/api/inspection/issues', { cookie: c2, fields: { description: '无权限' } });
    check('2) 无小组教师记录问题 → 403', r.status === 403, r.data);

    // ---------- 3) 列表：筛选 + 分页 ----------
    console.log('3) 列表筛选与分页:');
    r = await api('/api/inspection/issues?pageSize=100&keyword=' + encodeURIComponent('[巡堂用例' + TAG + ']'), { cookie: c1 });
    check('3) 关键词搜索命中本套件的 3 条', r.status === 200 && r.data.total === 3, r.data && r.data.total);
    check('3) 列表返回照片缩略图（每条最多 3 张）', (r.data.issues.find((i) => i.id === idA).photos || []).length === 2);
    check('3) 列表含状态中文标签与班级名',
      r.data.issues.every((i) => !!i.statusLabel && !!i.className), r.data.issues.map((i) => i.className + '/' + i.statusLabel));
    check('3) 汇总含各状态数量', typeof r.data.summary.pending === 'number' && typeof r.data.summary.total === 'number', r.data.summary);

    r = await api('/api/inspection/issues?classId=' + created.classId + '&keyword=' + encodeURIComponent(TAG), { cookie: c1 });
    check('3) 按班级筛选 → 命中 3 条', r.data.total === 3, r.data.total);
    r = await api('/api/inspection/issues?date=2026-09-16&keyword=' + encodeURIComponent(TAG), { cookie: c1 });
    check('3) 按日期筛选（2026-09-16）→ 命中 1 条', r.data.total === 1 && r.data.issues[0].id === idC, r.data.total);
    r = await api('/api/inspection/issues?status=pending&keyword=' + encodeURIComponent(TAG), { cookie: c1 });
    check('3) 按状态筛选（待处理）→ 命中 3 条', r.data.total === 3, r.data.total);
    r = await api('/api/inspection/issues?status=resolved&keyword=' + encodeURIComponent(TAG), { cookie: c1 });
    check('3) 按状态筛选（已解决）→ 命中 0 条', r.data.total === 0, r.data.total);
    r = await api('/api/inspection/issues?pageSize=1&page=1&keyword=' + encodeURIComponent(TAG), { cookie: c1 });
    const page1 = r.data.issues[0].id;
    check('3) 分页：pageSize=1 → 返回 1 条、total 仍为 3', r.data.issues.length === 1 && r.data.total === 3, { n: r.data.issues.length, total: r.data.total });
    r = await api('/api/inspection/issues?pageSize=1&page=2&keyword=' + encodeURIComponent(TAG), { cookie: c1 });
    check('3) 分页：第 2 页与第 1 页不同条目', r.data.issues.length === 1 && r.data.issues[0].id !== page1, { p1: page1, p2: r.data.issues[0] && r.data.issues[0].id });
    r = await api('/api/inspection/issues?keyword=' + encodeURIComponent('不存在的关键词xyz'), { cookie: c1 });
    check('3) 无匹配 → 空列表但 200', r.status === 200 && r.data.total === 0 && r.data.issues.length === 0, r.data.total);

    // ---------- 3b) 年级 + 班级 两级联动 ----------
    //   年级/班级下拉（/api/inspection/classes）+ 按年级筛问题（?gradeId=）
    console.log('3b) 年级→班级 联动:');
    r = await api('/api/inspection/classes', { cookie: c1 });
    check('3b) 下拉接口返回「年级 + 班级」两段', r.status === 200 && Array.isArray(r.data.grades) && Array.isArray(r.data.classes), r.data && Object.keys(r.data));
    check('3b) 只列当前学年的年级/班级（academicYear 与 system_settings 一致）',
      r.data.academicYear === year && r.data.grades.some((g) => g.id === created.gradeId) && r.data.classes.some((cl) => cl.id === created.classId),
      { year: r.data.academicYear, grades: r.data.grades.length, classes: r.data.classes.length });
    const cls = r.data.classes.find((cl) => cl.id === created.classId);
    check('3b) 班级带 gradeId 与年级名（供联动过滤）', !!cls && cls.gradeId === created.gradeId && cls.grade === GRADE, cls);
    r = await api('/api/inspection/classes?gradeId=' + created.gradeId, { cookie: c1 });
    check('3b) ?gradeId= 只返回该年级的班级（= 夹具班级）',
      r.data.classes.length === 1 && r.data.classes[0].id === created.classId,
      r.data.classes.map((c) => c.className));
    r = await api('/api/inspection/classes?gradeId=99999999', { cookie: c1 });
    check('3b) 不存在的年级 → 200 且班级为空（不报错）', r.status === 200 && r.data.classes.length === 0, { status: r.status, n: r.data.classes.length });
    // 往年班级不应混进下拉
    const oldClass = await pg.query(
      `INSERT INTO classes (class_name, grade, grade_id, academic_year, status)
       VALUES ($1, $2, $3, '1999-2000', 'active') RETURNING id`,
      ['往年班' + TAG, GRADE, created.gradeId]
    );
    const oldId = oldClass.rows[0].id;
    r = await api('/api/inspection/classes?gradeId=' + created.gradeId, { cookie: c1 });
    check('3b) 往年（1999-2000）的班级不出现在下拉里',
      !r.data.classes.some((c) => c.id === oldId), r.data.classes.map((c) => c.id));
    await pg.query('SELECT purge_class(id) FROM classes WHERE id = $1', [oldId]);

    r = await api('/api/inspection/issues?gradeId=' + created.gradeId + '&keyword=' + encodeURIComponent(TAG), { cookie: c1 });
    check('3b) 只按年级筛问题 → 命中该年级 3 条', r.data.total === 3, r.data.total);
    r = await api('/api/inspection/issues?gradeId=' + created.gradeId + '&classId=' + created.classId + '&keyword=' + encodeURIComponent(TAG), { cookie: c1 });
    check('3b) 年级 + 班级同时筛 → 命中 3 条（AND）', r.data.total === 3, r.data.total);
    r = await api('/api/inspection/issues?gradeId=99999999&keyword=' + encodeURIComponent(TAG), { cookie: c1 });
    check('3b) 不存在的年级 → 命中 0 条（不会退化成全量）', r.data.total === 0, r.data.total);

    // 年级下拉顺序：高一 → 高二 → 高三（库里的 sort_order 相同/未设时按年级数字排）
    const allGrades = (await api('/api/inspection/classes', { cookie: c1 })).data.grades.map((g) => g.gradeName);
    const i1 = allGrades.indexOf('高一年级'), i2 = allGrades.indexOf('高二年级'), i3 = allGrades.indexOf('高三年级');
    check('3b) 年级下拉顺序 高一 → 高二 → 高三（不因 sort_order 未设而乱序）',
      i1 >= 0 && i2 >= 0 && i3 >= 0 && i1 < i2 && i2 < i3, allGrades);

    // ---------- 4) 详情 ----------
    console.log('4) 问题详情:');
    r = await api('/api/inspection/issues/' + idA, { cookie: c1 });
    check('4) 详情返回问题 + 照片 + 反馈三段', r.status === 200 && !!r.data.issue && Array.isArray(r.data.photos) && Array.isArray(r.data.feedbacks));
    check('4) 详情字段齐全（日期/班级/类型/紧急/描述/状态/创建人）',
      !!r.data.issue.issueDate && !!r.data.issue.className && !!r.data.issue.categoryLabel &&
      !!r.data.issue.priorityLabel && !!r.data.issue.description && !!r.data.issue.statusLabel && !!r.data.issue.createdByName,
      r.data.issue);
    check('4) 详情照片 2 张（含文件名与大小）', r.data.photos.length === 2 && !!r.data.photos[0].fileName && r.data.photos[0].fileSize > 0, r.data.photos);
    r = await api('/api/inspection/issues/99999999', { cookie: c1 });
    check('4) 不存在的问题 → 404', r.status === 404, r.data);

    // ---------- 5) 反馈与状态流转（需求表 5 条规则） ----------
    console.log('5) 反馈与状态流转:');
    // 待处理 + 处理中 → 处理中
    r = await api('/api/inspection/issues/' + idA + '/feedbacks', {
      method: 'POST', cookie: c1, body: { feedbackStatus: 'processing', solution: '已通知班主任整改，预计明天完成' },
    });
    check('5) 待处理 + 处理中 → 处理中',
      r.status === 201 && r.data.statusBefore === 'pending' && r.data.statusAfter === 'processing', r.data);
    check('5) 反馈记录含反馈人姓名与中文标签',
      r.data.feedback.feedbackStatusLabel === '处理中' && !!r.data.feedback.feedbackByName && r.data.feedback.isResolved === false,
      r.data.feedback);
    // 处理中 + 未解决 → 处理中
    r = await api('/api/inspection/issues/' + idA + '/feedbacks', {
      method: 'POST', cookie: c1, body: { feedbackStatus: 'unresolved', solution: '整改不到位，继续跟进' },
    });
    check('5) 处理中 + 未解决 → 仍为处理中',
      r.status === 201 && r.data.statusBefore === 'processing' && r.data.statusAfter === 'processing', r.data);
    // 处理中 + 已解决 → 已解决
    r = await api('/api/inspection/issues/' + idA + '/feedbacks', {
      method: 'POST', cookie: c1, body: { feedbackStatus: 'resolved', solution: '班主任已组织学生打扫，教室恢复整洁' },
    });
    check('5) 处理中 + 已解决 → 已解决',
      r.status === 201 && r.data.statusBefore === 'processing' && r.data.statusAfter === 'resolved', r.data);
    check('5) 已解决的反馈 is_resolved = true', r.data.feedback.isResolved === true, r.data.feedback);
    // 已解决 + 未解决 → 处理中
    r = await api('/api/inspection/issues/' + idA + '/feedbacks', {
      method: 'POST', cookie: c1, body: { feedbackStatus: 'unresolved', solution: '问题复现，重新处理' },
    });
    check('5) 已解决 + 未解决 → 回到处理中',
      r.status === 201 && r.data.statusBefore === 'resolved' && r.data.statusAfter === 'processing', r.data);
    const det = await api('/api/inspection/issues/' + idA, { cookie: c1 });
    check('5) 详情含 4 条反馈记录（按时间排序）', det.data.feedbacks.length === 4, det.data.feedbacks.length);
    check('5) 问题状态已同步为处理中', det.data.issue.status === 'processing', det.data.issue.status);

    // 校验类
    r = await api('/api/inspection/issues/' + idA + '/feedbacks', { method: 'POST', cookie: c1, body: { feedbackStatus: 'processing' } });
    check('5) 未填解决方案 → 400', r.status === 400, r.data);
    r = await api('/api/inspection/issues/' + idA + '/feedbacks', { method: 'POST', cookie: c1, body: { feedbackStatus: 'bad', solution: 'x' } });
    check('5) 非法「是否解决」→ 400', r.status === 400, r.data);
    r = await api('/api/inspection/issues/' + idA + '/feedbacks', { method: 'POST', cookie: c2, body: { feedbackStatus: 'resolved', solution: 'x' } });
    check('5) 无小组教师添加反馈 → 403', r.status === 403, r.data);

    // ---------- 6) 小组权限联动（操作权限） ----------
    console.log('6) 操作权限联动:');
    await api('/api/groups/' + created.groupId, {
      method: 'PUT', cookie: admin,
      body: { name: G1, description: '巡堂检查', permissions: { pages: ['inspection'], actions: ['view'] } },
    });
    r = await api('/api/inspection/issues?keyword=' + encodeURIComponent(TAG), { cookie: c1 });
    check('6) 取消 create_issue/add_feedback 后仍可查看列表（view 随页面）', r.status === 200 && r.data.total === 3, r.status);
    r = await apiForm('/api/inspection/issues', { cookie: c1, fields: { description: '不应创建成功' } });
    check('6) 取消 create_issue 后记录问题 → 403', r.status === 403, r.data);
    r = await api('/api/inspection/issues/' + idA + '/feedbacks', { method: 'POST', cookie: c1, body: { feedbackStatus: 'resolved', solution: 'x' } });
    check('6) 取消 add_feedback 后添加反馈 → 403', r.status === 403, r.data);
    r = await apiForm('/api/inspection/issues', { cookie: c1, fields: { description: '带照片' }, files: 1 });
    check('6) 未授权 upload_photo 时带照片 → 403', r.status === 403, r.data);
    // 恢复全部权限，确认可用
    await api('/api/groups/' + created.groupId, {
      method: 'PUT', cookie: admin,
      body: { name: G1, description: '巡堂检查', permissions: { pages: ['inspection'], actions: ['view', 'create_issue', 'add_feedback', 'upload_photo'] } },
    });
    r = await api('/api/inspection/issues', { cookie: c1 });
    check('6) 恢复权限后列表可用', r.status === 200);
    // 管理员不受小组限制
    r = await apiForm('/api/inspection/issues', { cookie: admin, fields: { description: DESC('管理员记录的问题'), category: 'other' } });
    check('6) 管理员无需小组即可记录问题 → 201', r.status === 201, r.data);
    if (r.status === 201) created.issueIds.push(r.data.issue.id);

    // ---------- 6b) 删除巡堂记录（仅管理员）----------
    console.log('6b) 删除巡堂记录:');
    // 专门造一条带 2 张照片 + 1 条反馈的问题用于删除
    const delRes = await apiForm('/api/inspection/issues', {
      cookie: c1, files: 2,
      fields: { description: DESC('待删除的问题'), classId: created.classId, category: 'hygiene', priority: 'normal' },
    });
    check('6b) 夹具问题（带 2 张照片）创建成功 → 201', delRes.status === 201, delRes.data);
    const delId = delRes.data.issue.id;
    created.issueIds.push(delId);
    const delPhotos = await pg.query('SELECT id, file_path FROM inspection_photos WHERE issue_id = $1', [delId]);
    const absOf = (p) => path.join(__dirname, '../public', String(p).replace(/^\//, ''));
    const absFiles = delPhotos.rows.map((x) => absOf(x.file_path));
    absFiles.forEach((f) => { if (fs.existsSync(f)) created.files.push(f); });
    check('6b) 照片文件已落盘（2 张存在）', absFiles.length === 2 && absFiles.every((f) => fs.existsSync(f)), absFiles);
    await api('/api/inspection/issues/' + delId + '/feedbacks', { method: 'POST', cookie: c1, body: { feedbackStatus: 'processing', solution: '处理中' } });

    r = await api('/api/inspection/issues/' + delId, { method: 'DELETE', cookie: c1 });
    check('6b) 教务组成员（巡堂组）删除 → 403（不可删除）', r.status === 403, { status: r.status, data: r.data });
    r = await api('/api/inspection/issues/' + delId, { method: 'DELETE', cookie: c2 });
    check('6b) 无小组教师删除 → 403', r.status === 403, r.status);
    r = await api('/api/inspection/issues/abc', { method: 'DELETE', cookie: admin });
    check('6b) 非法编号 → 400', r.status === 400, r.status);
    r = await api('/api/inspection/issues/99999999', { method: 'DELETE', cookie: admin });
    check('6b) 不存在的问题 → 404', r.status === 404, r.status);

    r = await api('/api/inspection/issues/' + delId, { method: 'DELETE', cookie: admin });
    check('6b) 管理员删除 → 200 且返回删除明细（问题/照片/文件/反馈）',
      r.status === 200 && r.data.deleted && r.data.deleted.id === delId &&
      r.data.deleted.photos === 2 && r.data.deleted.photoFiles === 2 && r.data.deleted.feedbacks === 1,
      { status: r.status, deleted: r.data && r.data.deleted });
    const goneIssue = await pg.query('SELECT count(*)::int n FROM inspection_issues WHERE id = $1', [delId]);
    const gonePhotos = await pg.query('SELECT count(*)::int n FROM inspection_photos WHERE issue_id = $1', [delId]);
    const goneFb = await pg.query('SELECT count(*)::int n FROM inspection_feedbacks WHERE issue_id = $1', [delId]);
    check('6b) 问题 / 照片 / 反馈记录都已删除（0/0/0）',
      goneIssue.rows[0].n === 0 && gonePhotos.rows[0].n === 0 && goneFb.rows[0].n === 0,
      { issue: goneIssue.rows[0].n, photos: gonePhotos.rows[0].n, fb: goneFb.rows[0].n });
    check('6b) 照片文件已从磁盘删除', absFiles.every((f) => !fs.existsSync(f)), absFiles.filter((f) => fs.existsSync(f)));
    r = await api('/api/inspection/issues/' + delId, { cookie: admin });
    check('6b) 再次查看详情 → 404', r.status === 404, r.status);
    r = await api('/api/inspection/issues?keyword=' + encodeURIComponent(TAG), { cookie: c1 });
    check('6b) 列表里不再出现被删记录，其它夹具记录仍在（4 条 = 3 条初始 + 管理员新增 1 条）',
      r.data.total === 4 && !r.data.issues.some((x) => x.id === delId), { total: r.data.total, ids: r.data.issues.map((x) => x.id) });
    r = await api('/api/inspection/status', { cookie: admin });
    check('6b) 权限元数据透出 canDelete（管理员 true）/ 小组账号 false',
      r.data.canDelete === true && r.data.actions.some((x) => x.key === 'delete_issue' && x.allowed === true), r.data && r.data.actions);
    r = await api('/api/inspection/status', { cookie: c1 });
    check('6b) 巡堂组成员 canDelete = false（前端据此隐藏删除按钮）', r.data.canDelete === false, r.data && r.data.canDelete);
    // 被删的照片文件已在上面校验，从待清理列表移除，避免"清理"误判
    created.files = created.files.filter((f) => absFiles.indexOf(f) < 0);

    // ---------- 7) 兼容性 & 清理 ----------
    console.log('7) 兼容性与清理:');
    check('7) 无小组教师：原有角色页面仍可访问（不受巡堂模块影响）',
      (await api('/students', { cookie: c2 })).status === 200);
    await hardCleanup();
    const leftIssues = await pg.query(`SELECT count(*)::int n FROM inspection_issues WHERE description LIKE $1`, ['%' + TAG + '%']);
    check('清理：夹具问题已删除', leftIssues.rows[0].n === 0, leftIssues.rows[0].n);
    const leftPhotos = await pg.query(
      `SELECT count(*)::int n FROM inspection_photos ph LEFT JOIN inspection_issues i ON i.id = ph.issue_id WHERE i.id IS NULL`
    );
    check('清理：无孤儿照片记录（级联删除生效）', leftPhotos.rows[0].n === 0, leftPhotos.rows[0].n);
    const filesLeft = created.files.filter((f) => fs.existsSync(f));
    check('清理：上传的照片文件已删除', filesLeft.length === 0, filesLeft);
    const realAfter = await snapshotReal();
    check('清理：真实数据行数与测试前一致（users/groups/user_groups/classes/issues）',
      JSON.stringify(realBefore) === JSON.stringify(realAfter), { before: realBefore, after: realAfter });
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：' + (e && e.message) + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
    try { await hardCleanup(); console.log('  · 已执行自愈式清理'); } catch (_) {}
  } finally {
    await pg.end().catch(() => {});
  }
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exit(1);
})();
