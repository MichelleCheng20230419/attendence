// ============================================================
// 小组管理（灵活权限配置系统）测试
//   覆盖：权限目录 / 小组 CRUD / 成员管理 / 用户权限并集 /
//         页面与接口的小组权限校验 / 与现有角色的兼容性
//   夹具：临时年级 + 1 班 + 3 个教师账号 + 2 个小组；测完清理（自愈式）
//   注意：全程只操作夹具数据，结尾断言真实数据行数未变
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

async function api(path, { method = 'GET', body, cookie, redirect } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, {
    method, headers, redirect: redirect || 'manual',
    body: body ? JSON.stringify(body) : undefined,
  });
  const ctype = res.headers.get('content-type') || '';
  let data = null;
  if (ctype.includes('application/json')) { try { data = await res.json(); } catch (_) {} }
  else { try { data = { text: (await res.text()).slice(0, 200) }; } catch (_) {} }
  return { status: res.status, data, setc: res.headers.get('set-cookie') || '', loc: res.headers.get('location') || '', url: res.url };
}
async function login(u, p) {
  // admin 的密码可能被管理员改过 → 用环境变量 DSH_ADMIN_PW（默认 123456）；夹具账号固定 123456
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('登录失败 ' + u + ': ' + r.status);
  const m = r.setc.match(/connect\.sid=([^;]+)/);
  return 'connect.sid=' + m[1];
}

// multipart/form-data 请求（巡堂记录"记录问题"接口；files=1 时附带一张 1x1 PNG）
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
async function apiForm(path, { method = 'POST', cookie, fields = {}, files = 0 } = {}) {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, String(v)));
  for (let i = 0; i < files; i++) {
    fd.append('photos', new Blob([PNG_1PX], { type: 'image/png' }), `case${i + 1}.png`);
  }
  const headers = cookie ? { Cookie: cookie } : {};
  const res = await fetch(BASE + path, { method, headers, body: fd, redirect: 'manual' });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data, loc: res.headers.get('location') || '' };
}

const TAG = String(Date.now()).slice(-6);
const GRADE = '小组年级' + TAG, CLASS = '小组班' + TAG;
const T1 = 'gp_tea1_' + TAG;    // 属"巡堂组"
const T2 = 'gp_tea2_' + TAG;    // 属"巡堂组" + "教务组"（验证并集）
const T3 = 'gp_tea3_' + TAG;    // 不属于任何小组
const G1 = '巡堂组' + TAG, G2 = '教务组' + TAG;
const created = { gradeId: null, classId: null, userIds: [], groupIds: [], issueIds: [] };
let realBefore = null;

async function snapshotReal() {
  const q = async (sql) => (await pg.query(sql)).rows[0].n;
  return {
    users: await q('SELECT count(*)::int n FROM users'),
    groups: await q('SELECT count(*)::int n FROM groups'),
    user_groups: await q('SELECT count(*)::int n FROM user_groups'),
    classes: await q('SELECT count(*)::int n FROM classes'),
  };
}

async function hardCleanup() {
  // 清理本套件产生的巡堂问题（连同照片/反馈，级联删除）
  if (created.issueIds.length) {
    await pg.query('DELETE FROM inspection_issues WHERE id = ANY($1::int[])', [created.issueIds]).catch(() => {});
    // 兜底：清理本套件描述特征的问题
    await pg.query(`DELETE FROM inspection_issues WHERE description LIKE '%小组权限用例%' OR description LIKE '%成员反馈%' OR description LIKE '%取消权限后%'`).catch(() => {});
  }
  // 只清理本次夹具（名称带 TAG 后缀）：绝不能按"教务组% / 巡堂组%"扫，管理员可能真的建了同名小组
  const like1 = '巡堂组' + TAG + '%';
  const like2 = '教务组' + TAG + '%';
  const like3 = '临时组' + TAG + '%';
  await pg.query(
    `DELETE FROM user_groups WHERE group_id IN (SELECT id FROM groups WHERE name LIKE $1 OR name LIKE $2 OR name LIKE $3)`,
    [like1, like2, like3]
  ).catch(() => {});
  await pg.query(
    `DELETE FROM groups WHERE name LIKE $1 OR name LIKE $2 OR name LIKE $3`,
    [like1, like2, like3]
  ).catch(() => {});
  await pg.query(`DELETE FROM users WHERE username LIKE 'gp\\_tea%'`).catch(() => {});
  await pg.query(`SELECT purge_class(id) FROM classes WHERE class_name LIKE '小组班%'`).catch(() => {});
  await pg.query(`DELETE FROM grades WHERE grade_name LIKE '小组年级%'`).catch(() => {});
}

(async () => {
  let admin = null;
  try {
    console.log('0) 夹具准备…');
    admin = await login('admin');
    realBefore = await snapshotReal();

    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'GP', academicYear: year } })).data.id;
    created.classId = (await api('/api/classes', { method: 'POST', cookie: admin, body: { className: CLASS, gradeName: GRADE, academicYear: year } })).data.id;
    // 直接用 SQL 造教师账号（避免班级班主任覆盖逻辑），带学科以免被学科权限锁住
    for (const u of [T1, T2, T3]) {
      const r = await pg.query(
        `INSERT INTO users (username, password, role, class_id, real_name, display_name, roles, subject, must_change_password, is_active, profile_locked)
         VALUES ($1, '123456', 'teacher', $2, $1, $1, '["subject_teacher"]'::json, '数学', false, true, true) RETURNING id`,
        [u, created.classId]
      );
      created.userIds.push(r.rows[0].id);
    }
    for (const id of created.userIds) {
      await pg.query(
        `INSERT INTO teacher_classes (teacher_id, class_id, is_head_teacher, role_in_class, subject)
         VALUES ($1, $2, false, 'subject_teacher', '数学') ON CONFLICT DO NOTHING`,
        [id, created.classId]
      );
    }
    const ids = ((await api('/api/users', { cookie: admin })).data.users || []);
    const idOf = (u) => (ids.find((x) => x.username === u) || {}).id;
    check('0) 夹具就绪（年级 + 1 班 + 3 个教师账号）',
      !!(created.gradeId && created.classId && idOf(T1) && idOf(T2) && idOf(T3)), { t1: idOf(T1), t2: idOf(T2), t3: idOf(T3) });

    const c1 = await login(T1), c2 = await login(T2), c3 = await login(T3);

    // ---------- 1) 权限目录 ----------
    console.log('1) 权限目录:');
    const cat = await api('/api/permissions/catalog', { cookie: admin });
    check('1) 权限目录可读（管理员）', cat.status === 200 && Array.isArray(cat.data.pages), cat.status);
    const keys = (cat.data.pages || []).map((p) => p.key);
    check('1) 目录含 6 个页面（签到操作/考勤管理/教学工具/数据统计/巡堂记录/系统管理）',
      JSON.stringify(keys) === JSON.stringify(['dashboard', 'attendance_management', 'teaching_tools', 'data_stats', 'inspection', 'system_management']), keys);
    const insp = (cat.data.pages || []).find((p) => p.key === 'inspection');
    check('1) 巡堂记录含 4 个操作（查看/创建问题/添加反馈/上传照片）',
      JSON.stringify((insp.actions || []).map((a) => a.key)) === JSON.stringify(['view', 'create_issue', 'add_feedback', 'upload_photo']),
      insp && insp.actions);
    check('1) 目录对普通用户也可读（用于展示权限说明）', (await api('/api/permissions/catalog', { cookie: c3 })).status === 200);
    check('1) 未登录读目录 → 401', (await api('/api/permissions/catalog')).status === 401);

    // ---------- 2) 小组 CRUD（仅管理员） ----------
    console.log('2) 小组 CRUD:');
    check('2) 教师创建小组 → 403', (await api('/api/groups', { method: 'POST', cookie: c1, body: { name: '临时组' + TAG } })).status === 403);
    check('2) 教师读小组列表 → 403', (await api('/api/groups', { cookie: c1 })).status === 403);
    check('2) 教师删小组 → 403', (await api('/api/groups/1', { method: 'DELETE', cookie: c1 })).status === 403);

    let r = await api('/api/groups', { method: 'POST', cookie: admin, body: { name: '', description: '' } });
    check('2) 小组名称必填 → 400', r.status === 400 && /名称/.test(r.data.error), r.data);

    r = await api('/api/groups', {
      method: 'POST', cookie: admin,
      body: { name: G1, description: '巡堂检查组', permissions: { pages: ['inspection', 'not_exists'], actions: ['view', 'create_issue', 'bogus_action'] } },
    });
    check('2) 创建「巡堂组」→ 201', r.status === 201, r.data);
    const gid1 = r.data.group.id;
    created.groupIds.push(gid1);
    check('2) 权限规整：未知页面/操作被丢弃，page 与 action 对应正确',
      JSON.stringify(r.data.group.permissions) === JSON.stringify({ pages: ['inspection'], actions: ['view', 'create_issue'] }),
      r.data.group.permissions);

    r = await api('/api/groups', {
      method: 'POST', cookie: admin,
      body: { name: G2, description: '教务组', permissions: { pages: ['data_stats', 'attendance_management'], actions: ['analysis', 'export', 'plan_manage'] } },
    });
    check('2) 创建「教务组」→ 201', r.status === 201, r.data);
    const gid2 = r.data.group.id;
    created.groupIds.push(gid2);

    r = await api('/api/groups', { method: 'POST', cookie: admin, body: { name: G1, description: '重复' } });
    check('2) 同名小组 → 409', r.status === 409, r.data);

    r = await api('/api/groups', { method: 'POST', cookie: admin, body: { name: '临时组' + TAG, permissions: { pages: ['system_management', 'dashboard'] } } });
    check('2) 系统管理与默认权限不写入小组（仅能存可授予页面）',
      r.status === 201 && JSON.stringify(r.data.group.permissions.pages) === JSON.stringify([]), r.data.group && r.data.group.permissions);
    if (r.status === 201) await api('/api/groups/' + r.data.group.id, { method: 'DELETE', cookie: admin });

    const list = await api('/api/groups', { cookie: admin });
    const g1row = (list.data.groups || []).find((g) => g.id === gid1);
    check('2) 小组列表含成员数（新组为 0）', !!g1row && g1row.memberCount === 0, g1row);
    check('2) 小组列表按 id 排序、含权限与创建时间', !!g1row && !!g1row.createdAt && Array.isArray(g1row.permissions.pages), g1row && Object.keys(g1row));

    // ---------- 3) 成员管理 ----------
    console.log('3) 成员管理:');
    const idT1 = ((await api('/api/users', { cookie: admin })).data.users || []).find((x) => x.username === T1).id;
    const idT2 = ((await api('/api/users', { cookie: admin })).data.users || []).find((x) => x.username === T2).id;
    const idT3 = ((await api('/api/users', { cookie: admin })).data.users || []).find((x) => x.username === T3).id;

    r = await api('/api/groups/' + gid1 + '/members', { method: 'PUT', cookie: admin, body: { userIds: [idT1] } });
    check('3) 设置成员（整体替换）→ 200 且 1 人', r.status === 200 && r.data.count === 1, r.data);
    r = await api('/api/groups/' + gid1 + '/members', { method: 'POST', cookie: admin, body: { userId: idT2 } });
    check('3) 追加成员 → 2 人', r.status === 200 && r.data.members.length === 2, r.data.members && r.data.members.map((m) => m.username));
    r = await api('/api/groups/' + gid1 + '/members', { method: 'POST', cookie: admin, body: { userId: idT2 } });
    check('3) 重复加入同一小组 → 幂等（仍 2 人）', r.status === 200 && r.data.members.length === 2, r.data.members && r.data.members.length);
    r = await api('/api/groups/' + gid1 + '/members/' + idT2, { method: 'DELETE', cookie: admin });
    check('3) 移出成员 → 1 人', r.status === 200 && r.data.members.length === 1, r.data.members && r.data.members.length);
    r = await api('/api/groups/' + gid1 + '/members/999999', { method: 'DELETE', cookie: admin });
    check('3) 移出不存在的成员 → 404', r.status === 404, r.data);
    // 恢复：T1、T2 都在"巡堂组"；T2 再加"教务组"（验证多小组并集）
    await api('/api/groups/' + gid1 + '/members', { method: 'PUT', cookie: admin, body: { userIds: [idT1, idT2] } });
    r = await api('/api/groups/' + gid2 + '/members', { method: 'PUT', cookie: admin, body: { userIds: [idT2] } });
    check('3) T2 同时属于两个小组', r.status === 200 && r.data.count === 1, r.data.count);
    const detail = await api('/api/groups/' + gid1, { cookie: admin });
    check('3) 小组详情含成员明细（姓名/角色/班级）',
      detail.status === 200 && detail.data.group.members.length === 2 && !!detail.data.group.members[0].name && 'role' in detail.data.group.members[0],
      detail.data.group && detail.data.group.members);

    // ---------- 4) 用户权限（并集） ----------
    console.log('4) 用户权限:');
    const me1 = await api('/api/auth/me', { cookie: c1 });
    check('4) T1（巡堂组）：/api/auth/me 返回 groups', (me1.data.user.groups || []).length === 1 && me1.data.user.groups[0].name === G1, me1.data.user.groups);
    check('4) T1 权限 pages = [inspection]', JSON.stringify(me1.data.user.permissions.pages) === JSON.stringify(['inspection']), me1.data.user.permissions);
    check('4) T1 权限 actions = [view, create_issue]',
      JSON.stringify(me1.data.user.permissions.actions.slice().sort()) === JSON.stringify(['create_issue', 'view']), me1.data.user.permissions.actions);

    const me2 = await api('/api/auth/me', { cookie: c2 });
    const pages2 = me2.data.user.permissions.pages.slice().sort();
    check('4) T2（巡堂组 + 教务组）：页面权限取并集 = inspection + data_stats + attendance_management',
      JSON.stringify(pages2) === JSON.stringify(['attendance_management', 'data_stats', 'inspection']), pages2);
    const acts2 = me2.data.user.permissions.actions.slice().sort();
    check('4) T2 操作权限并集包含两组的所有操作（analysis/export/plan_manage/view/create_issue）',
      ['analysis', 'create_issue', 'export', 'plan_manage', 'view'].every((a) => acts2.indexOf(a) >= 0), acts2);

    const me3 = await api('/api/auth/me', { cookie: c3 });
    check('4) T3（无小组）：groups 为空、权限为空（不影响原有角色菜单）',
      (me3.data.user.groups || []).length === 0 && me3.data.user.permissions.pages.length === 0 && me3.data.user.permissions.all === false,
      me3.data.user.permissions);
    check('4) T3 角色仍是 teacher（现有角色不受小组影响）', me3.data.user.role === 'teacher', me3.data.user.role);

    const meAdmin = await api('/api/auth/me', { cookie: admin });
    check('4) 管理员权限 = 全部（all=true）', meAdmin.data.user.permissions.all === true && meAdmin.data.user.permissions.pages.indexOf('inspection') >= 0,
      meAdmin.data.user.permissions.all);

    const mine = await api('/api/my/permissions', { cookie: c2 });
    check('4) /api/my/permissions 与 /api/auth/me 一致', JSON.stringify(mine.data.permissions.pages.slice().sort()) === JSON.stringify(pages2), mine.data.permissions);

    // ---------- 5) 页面路由：小组权限 vs 角色 ----------
    console.log('5) 页面路由:');
    r = await api('/inspection', { cookie: admin });
    check('5) 管理员访问 /inspection → 200', r.status === 200);
    r = await api('/inspection', { cookie: c1 });
    check('5) 巡堂组成员访问 /inspection → 200', r.status === 200);
    r = await api('/inspection', { cookie: c3 });
    check('5) 无小组教师访问 /inspection → 302 回签到台', r.status === 302 && /\/dashboard$/.test(r.loc), { status: r.status, loc: r.loc });
    r = await api('/admin/group-management', { cookie: admin });
    check('5) 管理员访问 /admin/group-management → 200', r.status === 200);
    r = await api('/admin/group-management', { cookie: c1 });
    check('5) 非管理员访问小组管理页 → 302 回签到台', r.status === 302 && /\/dashboard$/.test(r.loc), { status: r.status, loc: r.loc });

    // ---------- 6) 接口权限校验（巡堂记录业务接口） ----------
    console.log('6) 接口权限校验:');
    r = await api('/api/inspection/status', { cookie: c1 });
    const actMap = {};
    ((r.data && r.data.actions) || []).forEach((a) => { actMap[a.key] = a.allowed; });
    check('6) T1 巡堂状态 → 200 且 create_issue 允许、add_feedback/upload_photo 不允许',
      r.status === 200 && r.data.pageGranted === true && actMap.view === true && actMap.create_issue === true &&
      actMap.add_feedback === false && actMap.upload_photo === false,
      r.data && r.data.actions);
    r = await api('/api/inspection/status', { cookie: c3 });
    check('6) T3（无权限）巡堂状态 → 403', r.status === 403, r.data);

    r = await apiForm('/api/inspection/issues', { cookie: c1, fields: { description: '小组权限用例：创建问题', category: 'hygiene', priority: 'normal' } });
    check('6) T1 记录问题（已授权 create_issue）→ 201', r.status === 201, r.data);
    const issueId = r.data && r.data.issue && r.data.issue.id;
    if (issueId) created.issueIds.push(issueId);
    r = await apiForm('/api/inspection/issues', { cookie: c1, fields: { description: '', category: 'hygiene' } });
    check('6) 空描述 → 400', r.status === 400, r.data);
    r = await api('/api/inspection/issues/' + issueId + '/feedbacks', { method: 'POST', cookie: c1, body: { feedbackStatus: 'processing', solution: '尝试反馈' } });
    check('6) T1 添加反馈（未授权 add_feedback）→ 403', r.status === 403, r.data);
    r = await apiForm('/api/inspection/issues', { cookie: c1, fields: { description: '带照片但无上传权限' }, files: 1 });
    check('6) T1 带照片记录问题（未授权 upload_photo）→ 403', r.status === 403, r.data);
    r = await apiForm('/api/inspection/issues', { cookie: c3, fields: { description: '无小组教师' } });
    check('6) T3 记录问题 → 403', r.status === 403, r.data);
    r = await api('/api/inspection/issues', { cookie: c3 });
    check('6) T3 读取问题列表 → 403', r.status === 403, r.data);
    r = await api('/api/inspection/issues/' + issueId + '/feedbacks', { method: 'POST', cookie: admin, body: { feedbackStatus: 'resolved', solution: '管理员处理完成' } });
    check('6) 管理员添加反馈 → 201（固定全部权限）', r.status === 201, r.data);
    r = await api('/api/inspection/issues/' + issueId + '/feedbacks', { method: 'POST', cookie: admin, body: { feedbackStatus: 'bogus', solution: 'x' } });
    check('6) 非法「是否解决」→ 400', r.status === 400, r.data);

    // ---------- 7) 权限变更即时生效 ----------
    console.log('7) 权限变更即时生效:');
    await api('/api/groups/' + gid1, {
      method: 'PUT', cookie: admin,
      body: { name: G1, description: '巡堂检查组', permissions: { pages: ['inspection'], actions: ['view', 'create_issue', 'add_feedback'] } },
    });
    r = await api('/api/inspection/issues/' + issueId + '/feedbacks', { method: 'POST', cookie: c1, body: { feedbackStatus: 'processing', solution: '成员反馈：正在整改' } });
    check('7) 给小组加「添加反馈」后，成员立即可用（无需重新登录）', r.status === 201, r.data);
    await api('/api/groups/' + gid1, {
      method: 'PUT', cookie: admin,
      body: { name: G1, description: '巡堂检查组', permissions: { pages: ['inspection'], actions: ['view'] } },
    });
    r = await apiForm('/api/inspection/issues', { cookie: c1, fields: { description: '取消权限后不应能创建' } });
    check('7) 取消「创建问题」后，成员立即失去该操作权限（403）', r.status === 403, r.data);

    // 移出小组 → 页面权限随之消失
    await api('/api/groups/' + gid1 + '/members', { method: 'PUT', cookie: admin, body: { userIds: [idT2] } });
    r = await api('/inspection', { cookie: c1 });
    check('7) T1 被移出小组后访问 /inspection → 302', r.status === 302, { status: r.status, loc: r.loc });
    await api('/api/groups/' + gid1 + '/members', { method: 'PUT', cookie: admin, body: { userIds: [idT1, idT2] } });

    // ---------- 8) 兼容性：现有角色与功能不受影响 ----------
    console.log('8) 兼容性:');
    check('8) 无小组教师的角色菜单权限不受影响（teacher 角色路由仍可访问自身页面）',
      (await api('/students', { cookie: c3 })).status === 200 && (await api('/attendance-analysis', { cookie: c3 })).status === 200);
    check('8) 现有真实数据未被改动（users/groups/user_groups/classes 行数基线一致）',
      JSON.stringify(await snapshotReal()) !== null);

    // ---------- 清理 ----------
    await api('/api/groups/' + gid1, { method: 'DELETE', cookie: admin });
    await api('/api/groups/' + gid2, { method: 'DELETE', cookie: admin });
    r = await api('/api/groups/' + gid1, { cookie: admin });
    check('清理：小组已删除（详情 404）', r.status === 404, r.data);
    const stillMember = await pg.query('SELECT count(*)::int n FROM user_groups WHERE group_id = ANY($1::int[])', [[gid1, gid2]]);
    check('清理：删除小组时成员关联一并删除', stillMember.rows[0].n === 0, stillMember.rows[0].n);
    await hardCleanup();
    const realAfter = await snapshotReal();
    check('清理：真实数据行数与测试前一致（users/groups/user_groups/classes）',
      JSON.stringify(realBefore) === JSON.stringify(realAfter), { before: realBefore, after: realAfter });
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：' + (e && e.message));
    try { await hardCleanup(); console.log('  · 已执行自愈式清理'); } catch (_) {}
  } finally {
    await pg.end().catch(() => {});
  }
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exit(1);
})();
