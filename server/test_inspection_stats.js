// ============================================================
// 巡查面板（巡堂数据统计）测试
//   覆盖：统计卡片 / 班级排行（含列头排序）/ 趋势（按周）/ 类型分布 / 导出 Excel /
//         筛选（时间范围 week|month|term|all|custom + 年级）/ 权限（页面权限 inspection）
//   夹具：临时年级 + 2 个班 + 1 个教师（巡堂组）+ 若干问题（不同班级/类型/状态/日期）
//   测完清理（含照片文件），并断言真实数据行数一致
// ============================================================
'use strict';
const { Pool } = require('pg');
const XLSX = require('xlsx');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); }
}

async function api(p, { method = 'GET', body, cookie, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + p, { method, headers, redirect: 'manual', body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), ctype: res.headers.get('content-type') || '', cd: res.headers.get('content-disposition') || '' };
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
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
async function createIssue(cookie, { desc, classId, category = 'hygiene', priority = 'normal', date, photos = 0 }) {
  const fd = new FormData();
  fd.append('description', desc);
  if (classId) fd.append('classId', String(classId));
  fd.append('category', category);
  fd.append('priority', priority);
  if (date) fd.append('issueDate', date);
  for (let i = 0; i < photos; i++) fd.append('photos', new Blob([PNG_1PX], { type: 'image/png' }), `s${i + 1}.png`);
  const res = await fetch(BASE + '/api/inspection/issues', { method: 'POST', headers: { Cookie: cookie }, body: fd, redirect: 'manual' });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

const TAG = String(Date.now()).slice(-6);
const GRADE = '面板年级' + TAG, CLASS_A = '面板甲班' + TAG, CLASS_B = '面板乙班' + TAG;
const T1 = 'ip_tea_' + TAG, G1 = '面板巡堂组' + TAG;
const T2 = 'ip_tea2_' + TAG;               // 无小组教师（用来验证权限）
const created = { gradeId: null, classIds: [], userIds: [], groupId: null, issueIds: [] };
let realBefore = null;
let c1 = null, c2 = null, admin = null;

function isoDaysAgo(n) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const DESC = (s) => `[面板用例${TAG}] ${s}`;

async function snapshotReal() {
  const q = async (sql) => (await pg.query(sql)).rows[0].n;
  return {
    users: await q('SELECT count(*)::int n FROM users'),
    groups: await q('SELECT count(*)::int n FROM groups'),
    classes: await q('SELECT count(*)::int n FROM classes'),
    issues: await q('SELECT count(*)::int n FROM inspection_issues'),
  };
}

async function hardCleanup() {
  if (created.issueIds.length) await pg.query('DELETE FROM inspection_issues WHERE id = ANY($1::int[])', [created.issueIds]).catch(() => {});
  await pg.query(`DELETE FROM inspection_issues WHERE description LIKE '[面板用例%'`).catch(() => {});
  const like = '面板巡堂组' + TAG + '%';
  await pg.query(`DELETE FROM user_groups WHERE group_id IN (SELECT id FROM groups WHERE name LIKE $1)`, [like]).catch(() => {});
  await pg.query('DELETE FROM groups WHERE name LIKE $1', [like]).catch(() => {});
  await pg.query(`DELETE FROM users WHERE username LIKE 'ip\\_tea%'`).catch(() => {});
  await pg.query(`SELECT purge_class(id) FROM classes WHERE class_name LIKE '面板%班%'`).catch(() => {});
  await pg.query(`DELETE FROM grades WHERE grade_name LIKE '面板年级%'`).catch(() => {});
}

(async () => {
  try {
    console.log('0) 夹具准备…');
    admin = await login('admin');
    realBefore = await snapshotReal();
    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'IP', academicYear: year } })).data.id;
    for (const name of [CLASS_A, CLASS_B]) {
      created.classIds.push((await api('/api/classes', { method: 'POST', cookie: admin, body: { className: name, gradeName: GRADE, academicYear: year } })).data.id);
    }
    const mkTeacher = async (u, clsIdx) => {
      const classId = created.classIds[clsIdx];
      const r = await api('/api/users', {
        method: 'POST', cookie: admin,
        body: {
          username: u, password: '123456', role: 'teacher', realName: u, classId,
          mustChangePassword: false, profileLocked: true, subject: '数学',
          teachingClasses: [{ classId, roleInClass: 'subject_teacher' }],
        },
      });
      if (r.status !== 201) console.log('  · 创建账号失败 ' + u + ' ' + JSON.stringify(r.data));
      created.userIds.push(r.data.user.id);
      return r.data.user.id;
    };
    const id1 = await mkTeacher(T1, 0);
    await mkTeacher(T2, 1);
    const g = await api('/api/groups', {
      method: 'POST', cookie: admin,
      body: { name: G1, description: '巡查面板用例', permissions: { pages: ['inspection'], actions: ['view', 'create_issue', 'add_feedback', 'upload_photo'] } },
    });
    created.groupId = g.data.group.id;
    await api('/api/groups/' + created.groupId + '/members', { method: 'PUT', cookie: admin, body: { userIds: [id1] } });
    c1 = await login(T1);
    c2 = await login(T2);

    // 问题数据：甲班 4 条（2 已解决 / 1 处理中 / 1 待处理）、乙班 1 条（已解决），另 1 条未指定班级
    const mk = async (opts) => {
      const r = await createIssue(c1, opts);
      if (r.status !== 201) throw new Error('创建问题失败 ' + JSON.stringify(r.data));
      created.issueIds.push(r.data.issue.id);
      return r.data.issue.id;
    };
    const a1 = await mk({ desc: DESC('卫生问题 1'), classId: created.classIds[0], category: 'hygiene', date: isoDaysAgo(20), photos: 1 });
    const a2 = await mk({ desc: DESC('纪律问题 1'), classId: created.classIds[0], category: 'discipline', date: isoDaysAgo(6) });
    const a3 = await mk({ desc: DESC('设备问题 1'), classId: created.classIds[0], category: 'equipment', date: isoDaysAgo(2) });
    const a4 = await mk({ desc: DESC('教学问题 1'), classId: created.classIds[0], category: 'teaching', date: isoDaysAgo(1) });
    const b1 = await mk({ desc: DESC('卫生问题 2'), classId: created.classIds[1], category: 'hygiene', date: isoDaysAgo(3) });
    await mk({ desc: DESC('其他问题（未指定班级）'), category: 'other', date: isoDaysAgo(1) });
    // 状态：a1 已解决、a2 已解决、a3 处理中、a4 待处理、b1 已解决
    const fb = async (id, st) => { await api('/api/inspection/issues/' + id + '/feedbacks', { method: 'POST', cookie: c1, body: { feedbackStatus: st, solution: '用例反馈' } }); };
    await fb(a1, 'resolved');
    await fb(a2, 'resolved');
    await fb(a3, 'processing');
    await fb(b1, 'resolved');
    const stRows = await pg.query('SELECT status, count(*)::int n FROM inspection_issues WHERE description LIKE $1 GROUP BY status ORDER BY status', ['%' + TAG + '%']);
    check('0) 夹具就绪（2 班 6 条问题：3 已解决 / 1 处理中 / 2 待处理）',
      stRows.rows.map((r) => r.status + ':' + r.n).join(',') === 'pending:2,processing:1,resolved:3',
      stRows.rows);

    // ---------- 1) 统计卡片 ----------
    // 说明：按年级筛选时，"未指定班级"的问题（class_id 为空）不属于任何年级 → 不计入（甲班 4 + 乙班 1 = 5）
    console.log('1) 统计卡片:');
    let r = await api('/api/inspection/stats/overview?range=all&gradeId=' + created.gradeId, { cookie: c1 });
    const ov = r.data;
    check('1) 统计卡片：总数 5 / 已解决 3 / 处理中 1 / 待处理 1（按年级筛选）',
      r.status === 200 && ov.total === 5 && ov.resolved === 3 && ov.processing === 1 && ov.pending === 1,
      ov);
    check('1) 统计卡片：涉及班级 2（甲/乙）', ov.classCount === 2, ov.classCount);
    check('1) 统计卡片：解决率 = 60%', ov.resolveRate === 60, ov.resolveRate);
    check('1) 返回生效的筛选条件（range/年级）',
      ov.filter.range === 'all' && ov.filter.gradeId === created.gradeId && ov.filter.gradeName === GRADE, ov.filter);
    r = await api('/api/inspection/stats/overview?range=all', { cookie: c1 });
    check('1) 不筛年级 → 含"未指定班级"那条（本夹具 6 条）', r.data.total >= 6, r.data.total);
    r = await api('/api/inspection/stats/overview?range=all&gradeId=999999', { cookie: c1 });
    check('1) 年级不存在 → 0 条（不报错、不返回全量）', r.status === 200 && r.data.total === 0, r.data && r.data.total);

    // ---------- 2) 筛选（时间范围 / 年级） ----------
    console.log('2) 筛选:');
    // 依据夹具的"相对天数"独立计算期望值，避免依赖运行日期
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    const dayOffset = (n) => { const d = new Date(today0); d.setDate(d.getDate() - n); return d; };
    const weekStart = (() => { const d = new Date(today0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; })();
    const monthStart = new Date(today0.getFullYear(), today0.getMonth(), 1);
    const fixtureDates = [20, 6, 3, 2, 1].map(dayOffset);   // 甲/乙班问题的日期（未指定班级那条不计入年级筛选）
    const countFrom = (from) => fixtureDates.filter((d) => d >= from && d <= today0).length;
    const countWithin = (from, to) => fixtureDates.filter((d) => d >= from && d <= to).length;

    r = await api('/api/inspection/stats/overview?range=month&gradeId=' + created.gradeId, { cookie: c1 });
    check(`2) 本月：仅统计本月日期（期望 ${countFrom(monthStart)} 条）`, r.data.total === countFrom(monthStart), { got: r.data.total, want: countFrom(monthStart) });
    // 本周口径 = 周一~今天；用同一接口的 custom 口径（周一~今天）交叉验证，避免"周一当天"等日期漂移误报
    const isoWeek = (() => { const d = weekStart; return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    const wkRef = await api('/api/inspection/stats/overview?range=custom&startDate=' + isoWeek + '&endDate=' + isoDaysAgo(0) + '&gradeId=' + created.gradeId, { cookie: c1 });
    r = await api('/api/inspection/stats/overview?range=week&gradeId=' + created.gradeId, { cookie: c1 });
    check(`2) 本周（周一至今）与 custom(周一~今天) 口径一致（期望 ${wkRef.data.total} 条）`,
      r.data.total === wkRef.data.total, { got: r.data.total, want: wkRef.data.total, weekStart: isoWeek });
    const cFrom = dayOffset(7), cTo = dayOffset(1);
    r = await api('/api/inspection/stats/overview?range=custom&startDate=' + isoDaysAgo(7) + '&endDate=' + isoDaysAgo(1) + '&gradeId=' + created.gradeId, { cookie: c1 });
    check(`2) 自定义时间（7 天前~昨天）：期望 ${countWithin(cFrom, cTo)} 条`, r.data.total === countWithin(cFrom, cTo), { got: r.data.total, want: countWithin(cFrom, cTo) });
    r = await api('/api/inspection/stats/overview?range=term&gradeId=' + created.gradeId, { cookie: c1 });
    check('2) 本学期：≤ 全部且 ≥ 本月', r.data.total >= countFrom(monthStart) && r.data.total <= 5, r.data.total);
    r = await api('/api/inspection/stats/overview?range=all&gradeId=' + created.gradeId, { cookie: c1 });
    check('2) 年级筛选：仅本夹具年级 → 5 条', r.data.total === 5, r.data.total);

    // ---------- 3) 班级排行（默认从少到多 + 列头排序） ----------
    console.log('3) 班级排行:');
    r = await api('/api/inspection/stats/class-ranking?range=all&gradeId=' + created.gradeId, { cookie: c1 });
    const rk = r.data.ranking;
    check('3) 默认按问题数从少到多（问题最少的排最前）',
      rk.length === 2 && rk[0].total <= rk[1].total && rk[0].rank === 1, rk.map((x) => x.className + ':' + x.total));
    check('3) 排行含 班级名/问题数/已解决/待处理/解决率',
      rk.every((x) => !!x.className && typeof x.total === 'number' && typeof x.resolved === 'number' && typeof x.pending === 'number' && typeof x.resolveRate === 'number'),
      rk[0]);
    const jia = rk.find((x) => x.className === CLASS_A), yi = rk.find((x) => x.className === CLASS_B);
    check('3) 甲班 4 条（已解决 2 / 待处理 1，解决率 50%）', jia.total === 4 && jia.resolved === 2 && jia.pending === 1 && jia.resolveRate === 50, jia);
    check('3) 乙班 1 条（已解决 1，解决率 100%）', yi.total === 1 && yi.resolved === 1 && yi.resolveRate === 100, yi);
    r = await api('/api/inspection/stats/class-ranking?range=all&gradeId=' + created.gradeId + '&sort=total&order=desc', { cookie: c1 });
    check('3) 点「问题数」列头再点一次 → 从多到少（desc）',
      r.data.ranking[0].total >= r.data.ranking[r.data.ranking.length - 1].total && r.data.order === 'desc',
      r.data.ranking.map((x) => x.total));
    r = await api('/api/inspection/stats/class-ranking?range=all&gradeId=' + created.gradeId + '&sort=rate&order=desc', { cookie: c1 });
    check('3) 按解决率排序（desc）生效',
      r.data.ranking[0].resolveRate >= r.data.ranking[r.data.ranking.length - 1].resolveRate,
      r.data.ranking.map((x) => x.resolveRate));
    r = await api('/api/inspection/stats/class-ranking?range=all&gradeId=' + created.gradeId + '&sort=className&order=asc', { cookie: c1 });
    check('3) 按班级名排序生效', r.data.ranking[0].className === CLASS_A, r.data.ranking.map((x) => x.className));
    r = await api('/api/inspection/stats/class-ranking?range=all', { cookie: c1 });
    check('3) 不筛年级 → 含"未指定班级"一行',
      r.data.ranking.some((x) => x.className === '未指定班级'), r.data.ranking.map((x) => x.className));

    // ---------- 4) 趋势（按周） ----------
    console.log('4) 问题趋势:');
    r = await api('/api/inspection/stats/trend?range=all&gradeId=' + created.gradeId, { cookie: c1 });
    const pts = r.data.points;
    check('4) 趋势点位按周升序，含周起止与数量',
      pts.length >= 2 && pts.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.weekStart) && typeof p.total === 'number' && !!p.label),
      pts);
    check('4) 周次升序排列',
      pts.every((p, i) => i === 0 || pts[i - 1].weekStart < p.weekStart), pts.map((p) => p.weekStart));
    const sumTrend = pts.reduce((s, p) => s + p.total, 0);
    check('4) 各周数量之和 = 问题总数（5，按年级筛选）', sumTrend === 5, { sum: sumTrend, pts: pts.map((p) => p.total) });
    check('4) 含已解决数量字段（第二条折线用）', pts.every((p) => typeof p.resolved === 'number'), pts.map((p) => p.resolved));

    // ---------- 5) 类型分布 ----------
    console.log('5) 类型分布:');
    r = await api('/api/inspection/stats/type-distribution?range=all&gradeId=' + created.gradeId, { cookie: c1 });
    const items = r.data.items, byKey = {};
    items.forEach((i) => { byKey[i.key] = i; });
    check('5) 含 5 个类型（卫生/纪律/设备/教学/其他）且百分比合计 ≈100%',
      ['hygiene', 'discipline', 'equipment', 'teaching', 'other'].every((k) => !!byKey[k]) &&
      Math.abs(items.reduce((s, i) => s + i.percent, 0) - 100) <= 0.3,
      items.map((i) => i.label + ':' + i.count + '/' + i.percent + '%'));
    check('5) 卫生 2 条（40%）、纪律 1、设备 1、教学 1、其他 0（按年级筛选共 5 条）',
      byKey.hygiene.count === 2 && byKey.discipline.count === 1 && byKey.equipment.count === 1 &&
      byKey.teaching.count === 1 && byKey.other.count === 0 && byKey.hygiene.percent === 40,
      { h: byKey.hygiene.count, d: byKey.discipline.count, e: byKey.equipment.count, t: byKey.teaching.count, o: byKey.other.count });
    check('5) 中文标签齐全', items.every((i) => /卫生|纪律|设备|教学|其他/.test(i.label)), items.map((i) => i.label));

    // ---------- 6) 导出 Excel ----------
    console.log('6) 导出:');
    r = await api('/api/inspection/stats/export?range=all&gradeId=' + created.gradeId, { cookie: c1, raw: true });
    check('6) 导出返回 xlsx（Content-Type 正确）',
      r.status === 200 && /spreadsheetml\.sheet/.test(r.ctype), { status: r.status, ct: r.ctype });
    check('6) 响应头带中文文件名（filename*=UTF-8）', /filename\*=UTF-8''/.test(r.cd), r.cd);
    check('6) 文件非空（>2KB）', r.buf.length > 2048, r.buf.length);
    const wb = XLSX.read(r.buf, { type: 'buffer' });
    check('6) 含两个工作表：巡堂问题明细 + 统计汇总',
      JSON.stringify(wb.SheetNames) === JSON.stringify(['巡堂问题明细', '统计汇总']), wb.SheetNames);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['巡堂问题明细'], { defval: '' });
    check('6) 明细行数 = 5（当前筛选结果，按年级筛选）', rows.length === 5, rows.length);
    check('6) 明细含 日期/年级/班级/问题类型/状态/问题描述 等列',
      ['日期', '年级', '班级', '问题类型', '紧急程度', '状态', '问题描述', '照片数', '最近解决方案'].every((k) => k in (rows[0] || {})),
      rows[0]);
    const sum = XLSX.utils.sheet_to_json(wb.Sheets['统计汇总'], { defval: '' });
    const sumMap = {};
    sum.forEach((x) => { sumMap[x['项目']] = x['值']; });
    check('6) 汇总表内容正确（总数 5 / 已解决 3 / 解决率 60%）',
      sumMap['问题总数'] === 5 && sumMap['已解决'] === 3 && sumMap['解决率'] === '60%', sumMap);
    r = await api('/api/inspection/stats/export?range=week&gradeId=' + created.gradeId, { cookie: c1, raw: true });
    const wb2 = XLSX.read(r.buf, { type: 'buffer' });
    // 无数据时导出会写一行占位提示（{提示:'当前筛选条件下没有巡堂问题'}）→ 统计行数时排除
    const rows2 = XLSX.utils.sheet_to_json(wb2.Sheets['巡堂问题明细'], { defval: '' }).filter((x) => !x['提示']);
    check(`6) 导出遵循当前筛选（本周行数 = 概览本周总数）`, rows2.length === wkRef.data.total, { got: rows2.length, want: wkRef.data.total });

    // ---------- 7) 权限 ----------
    console.log('7) 权限:');
    for (const p of ['overview', 'class-ranking', 'trend', 'type-distribution']) {
      const rr = await api('/api/inspection/stats/' + p + '?range=all', { cookie: c2 });
      check(`7) 无小组教师访问 stats/${p} → 403`, rr.status === 403, rr.status);
    }
    check('7) 无小组教师导出 → 403', (await api('/api/inspection/stats/export?range=all', { cookie: c2, raw: true })).status === 403);
    check('7) 未登录访问 → 401', (await api('/api/inspection/stats/overview?range=all')).status === 401);
    check('7) 管理员访问（固定全部权限）→ 200',
      (await api('/api/inspection/stats/overview?range=all', { cookie: admin })).status === 200);
    check('7) 小组成员可访问巡查面板页面 /inspection/panel → 200',
      (await api('/inspection/panel', { cookie: c1 })).status === 200);
    check('7) 无小组教师访问 /inspection/panel → 302 回签到台',
      (await api('/inspection/panel', { cookie: c2 })).status === 302);

    // ---------- 8) 兼容性 & 清理 ----------
    console.log('8) 兼容性与清理:');
    check('8) 无小组教师原有角色页面不受影响（/students 200）', (await api('/students', { cookie: c2 })).status === 200);
    await hardCleanup();
    const left = await pg.query(`SELECT count(*)::int n FROM inspection_issues WHERE description LIKE $1`, ['%' + TAG + '%']);
    check('清理：夹具问题已删除', left.rows[0].n === 0, left.rows[0].n);
    const realAfter = await snapshotReal();
    check('清理：真实数据行数与测试前一致（users/groups/classes/issues）',
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
