// ============================================================
// 学期设置 测试（系统管理 → 学年管理 → 学期设置）
//   覆盖：
//     1) GET /api/term 权限（未登录 401 / 登录可读）与返回结构
//     2) GET /api/settings 带 term / termDefaults / termResolved；教师 403
//     3) PUT /api/settings/term 权限（教师 403）+ 校验（格式/不存在的日期/起>止/只填一半）
//     4) 保存后「本学期」按配置统计：currentTerm 切换、结束日期截到今天
//     5) 未配置（清空）时回退默认口径（上学期 9/1~次年 1/31、下学期 2/1~7/15）
//     6) 巡堂统计（/api/inspection/stats/overview?range=term）随配置变化 + termConfigured 透出
//     7) 课堂表现（/api/performance/records?period=term）窗口与配置一致
//   注意：本用例会写 system_settings（真实配置）→ 开始先快照，结束（含异常）一定还原；
//         夹具（年级/班级/教师/问题/点名记录）均带时间戳标记，结束时删除并核对真实基线。
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
function pad(n) { return String(n).padStart(2, '0'); }
function todayStr(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// 独立复算「默认口径」（故意不复用后端代码，避免自证）
function expectedDefault(date = new Date()) {
  const m = date.getMonth() + 1;
  const y = m >= 9 ? date.getFullYear() : date.getFullYear() - 1;
  const firstStart = `${y}-09-01`, firstEnd = `${y + 1}-01-31`;
  const secondStart = `${y + 1}-02-01`, secondEnd = `${y + 1}-07-15`;
  const current = (m >= 9 || m === 1) ? 'first' : 'second';
  const rawStart = current === 'first' ? firstStart : secondStart;
  const rawEnd = current === 'first' ? firstEnd : secondEnd;
  const today = todayStr(date);
  return { current, startDate: rawStart, endDate: rawEnd > today ? today : rawEnd };
}

const TAG = String(Date.now()).slice(-6);
const KEYS = ['term_first_start', 'term_first_end', 'term_second_start', 'term_second_end', 'current_term'];
const GRADE = '学期年级' + TAG, CLASS = '学期甲班' + TAG, TEA = 'term_tea_' + TAG;
const created = { gradeId: null, classId: null, userId: null, issueIds: [], rollcallIds: [] };
let snapshot = null;      // system_settings 原值（null 表示该 key 原本不存在）
let realBefore = null;
let admin = null, teacher = null;

async function readSettings() {
  const { rows } = await pg.query('SELECT key, value FROM system_settings WHERE key = ANY($1)', [KEYS]);
  const m = {};
  for (const k of KEYS) m[k] = null;
  for (const r of rows) m[r.key] = r.value;
  return m;
}
async function writeSetting(key, value) {
  if (value === null) { await pg.query('DELETE FROM system_settings WHERE key = $1', [key]); return; }
  await pg.query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}
async function restoreSettings() {
  if (!snapshot) return;
  for (const k of KEYS) await writeSetting(k, snapshot[k]);
}
async function countSql(sql, params = []) { return (await pg.query(sql, params)).rows[0].n; }
async function snapshotReal() {
  return {
    users: await countSql('SELECT count(*)::int n FROM users'),
    grades: await countSql('SELECT count(*)::int n FROM grades'),
    classes: await countSql('SELECT count(*)::int n FROM classes'),
    issues: await countSql('SELECT count(*)::int n FROM inspection_issues'),
    rollcall: await countSql('SELECT count(*)::int n FROM rollcall_records'),
  };
}
async function hardCleanup() {
  const warn = (label) => (e) => console.log('  · 清理失败（' + label + '）：' + e.message);
  if (created.rollcallIds.length) await pg.query('DELETE FROM rollcall_records WHERE id = ANY($1::int[])', [created.rollcallIds]).catch(warn('rollcall'));
  if (created.issueIds.length) await pg.query('DELETE FROM inspection_issues WHERE id = ANY($1::int[])', [created.issueIds]).catch(warn('issues'));
  await pg.query(`DELETE FROM rollcall_records WHERE picked_by_name LIKE 'termfix%'`).catch(warn('rollcall-termfix'));
  await pg.query(`DELETE FROM inspection_issues WHERE description LIKE '[学期用例%'`).catch(warn('issues-stamp'));
  if (created.userId) await pg.query('DELETE FROM user_groups WHERE user_id = $1', [created.userId]).catch(warn('user_groups'));
  if (created.userId) await pg.query('DELETE FROM teacher_classes WHERE teacher_id = $1', [created.userId]).catch(warn('teacher_classes'));
  // 注意：创建教师账号时会把班级的班主任字段指向该账号（classes.head_teacher_id），
  //       必须先删夹具班级（解除引用）再删账号，否则外键约束会挡住删除。
  await pg.query(`SELECT purge_class(id) FROM classes WHERE class_name LIKE '学期甲班%'`).catch(warn('classes'));
  if (created.userId) await pg.query('DELETE FROM users WHERE id = $1', [created.userId]).catch(warn('users-byid'));
  await pg.query('DELETE FROM users WHERE username LIKE $1', ['term\\_tea\\_%']).catch(warn('users'));
  await pg.query(`DELETE FROM grades WHERE grade_name LIKE '学期年级%'`).catch(warn('grades'));
}

// 设学期设置（走 API，顺带验证接口）
async function putTerm(body) {
  return api('/api/settings/term', { method: 'PUT', cookie: admin, body });
}
async function seedTerm(cfg) {
  const r = await putTerm(cfg);
  if (r.status !== 200) throw new Error('设置学期失败 ' + JSON.stringify(r.data));
  return r.data;
}

(async () => {
  try {
    console.log('0) 夹具准备…');
    snapshot = await readSettings();
    admin = await login('admin');
    realBefore = await snapshotReal();
    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;

    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'TM', academicYear: year } })).data.id;
    created.classId = (await api('/api/classes', { method: 'POST', cookie: admin, body: { className: CLASS, gradeName: GRADE, academicYear: year } })).data.id;
    const u = await api('/api/users', {
      method: 'POST', cookie: admin,
      body: { username: TEA, password: '123456', role: 'teacher', realName: TEA, classId: created.classId, mustChangePassword: false, profileLocked: true },
    });
    created.userId = u.data.user.id;
    teacher = await login(TEA);
    check('0) 夹具就绪（年级/班级/教师）', !!created.gradeId && !!created.classId && !!created.userId, created);

    // ---------- 1) GET /api/term 权限与结构 ----------
    console.log('1) GET /api/term 权限与结构:');
    let r = await api('/api/term');
    check('1) 未登录 → 401', r.status === 401, r.status);
    r = await api('/api/term', { cookie: admin });
    check('1) 管理员可读（200）', r.status === 200, r.status);
    check('1) 返回结构含 configured/source/currentTerm/startDate/endDate/label',
      r.data && ['configured', 'source', 'currentTerm', 'currentTermLabel', 'startDate', 'endDate', 'label']
        .every((k) => Object.prototype.hasOwnProperty.call(r.data, k)), r.data);
    r = await api('/api/term', { cookie: teacher });
    check('1) 教师也可读（各页面「本学期」筛选用得到）', r.status === 200, r.status);

    // ---------- 2) GET /api/settings ----------
    console.log('2) GET /api/settings:');
    r = await api('/api/settings', { cookie: admin });
    check('2) 管理员：返回 term / termDefaults / termResolved',
      r.status === 200 && r.data.term && r.data.termDefaults && r.data.termResolved, r.data && Object.keys(r.data));
    check('2) termDefaults 为四个日期（上学期/下学期默认起止）',
      r.data.termDefaults && ['firstStart', 'firstEnd', 'secondStart', 'secondEnd'].every((k) => /^\d{4}-\d{2}-\d{2}$/.test(r.data.termDefaults[k])),
      r.data.termDefaults);
    r = await api('/api/settings', { cookie: teacher });
    check('2) 教师 → 403（学年/学期设置仅管理员）', r.status === 403, r.status);

    // ---------- 3) PUT 权限与校验 ----------
    console.log('3) PUT /api/settings/term 权限与校验:');
    r = await api('/api/settings/term', { method: 'PUT', cookie: teacher, body: { firstStart: '2026-09-01', firstEnd: '2027-01-31' } });
    check('3) 教师保存 → 403', r.status === 403, r.status);
    const bad = async (body, label) => {
      const rr = await putTerm(body);
      check('3) ' + label + ' → 400', rr.status === 400, { status: rr.status, data: rr.data });
    };
    await bad({ firstStart: '2026/09/01', firstEnd: '2027-01-31' }, '日期格式非法（2026/09/01）');
    await bad({ firstStart: '2026-02-30', firstEnd: '2027-01-31' }, '不存在的日期（2026-02-30）');
    await bad({ firstStart: '2027-01-31', firstEnd: '2026-09-01' }, '开始晚于结束');
    await bad({ firstStart: '2026-09-01' }, '只填开始不填结束');
    r = await putTerm({ firstStart: '2026-09-01', firstEnd: '2027-01-31', currentTerm: 'xxx' });
    check('3) currentTerm 非法值归一为 first（200）', r.status === 200 && r.data.term.currentTerm === 'first', r.data && r.data.term);

    // ---------- 4) 已配置：按配置统计 ----------
    console.log('4) 保存后按配置统计:');
    // 用历史窗口（2020 年）便于把巡堂/点名夹具放进/放出窗口
    let saved = await seedTerm({ firstStart: '2020-01-01', firstEnd: '2020-03-31', secondStart: '2020-04-01', secondEnd: '2020-06-30', currentTerm: 'first' });
    check('4) 保存成功：configured=true，source=configured', saved.term.configured === true, saved.term);
    r = await api('/api/term', { cookie: admin });
    check('4) 上学期区间 = 2020-01-01 ~ 2020-03-31',
      r.data.startDate === '2020-01-01' && r.data.endDate === '2020-03-31', r.data);
    check('4) currentTermLabel = 上学期', r.data.currentTermLabel === '上学期', r.data.currentTermLabel);
    const dbNow = await readSettings();
    check('4) 已写入 system_settings 五条 key',
      dbNow.term_first_start === '2020-01-01' && dbNow.term_first_end === '2020-03-31'
      && dbNow.term_second_start === '2020-04-01' && dbNow.term_second_end === '2020-06-30' && dbNow.current_term === 'first',
      dbNow);

    await seedTerm({ firstStart: '2020-01-01', firstEnd: '2020-03-31', secondStart: '2020-04-01', secondEnd: '2020-06-30', currentTerm: 'second' });
    r = await api('/api/term', { cookie: admin });
    check('4) 切到下学期 → 区间 = 2020-04-01 ~ 2020-06-30 且 label=下学期',
      r.data.startDate === '2020-04-01' && r.data.endDate === '2020-06-30' && r.data.currentTermLabel === '下学期', r.data);

    // 结束日期晚于今天 → 截到今天（"本学期至今"）
    await seedTerm({ firstStart: '2020-01-01', firstEnd: '2099-01-31', secondStart: '2020-04-01', secondEnd: '2099-06-30', currentTerm: 'first' });
    r = await api('/api/term', { cookie: admin });
    check('4) 结束日期晚于今天 → endDate 截到今天（本学期至今）',
      r.data.endDate === todayStr(), { endDate: r.data.endDate, today: todayStr() });

    // ---------- 4b) 只填「当前学期」也算已配置（管理员最常用的填法）----------
    console.log('4b) 只配置当前学期:');
    await seedTerm({ firstStart: '2026-09-01', firstEnd: '2027-01-30', secondStart: '', secondEnd: '', currentTerm: 'first' });
    r = await api('/api/term', { cookie: admin });
    check('4b) 只填上学期且当前学期=上学期 → configured=true、区间=上学期（不被"未配置"拦住）',
      r.data.configured === true && r.data.source === 'configured'
      && r.data.startDate === '2026-09-01' && r.data.rawEndDate === '2027-01-30',
      r.data);
    check('4b) 学期未结束 → 统计区间截到今天，且标记 clipped',
      r.data.endDate === todayStr() && r.data.clipped === true, { endDate: r.data.endDate, clipped: r.data.clipped, today: todayStr() });
    check('4b) 未填的学期仍被如实标出（missingTerms=[second]、bothConfigured=false）',
      JSON.stringify(r.data.missingTerms) === '["second"]' && r.data.bothConfigured === false,
      { missing: r.data.missingTerms, both: r.data.bothConfigured });
    r = await api('/api/settings', { cookie: admin });
    check('4b) 设置页 term 字段同步（firstConfigured=true / secondConfigured=false）',
      r.data.term.configured === true && r.data.term.firstConfigured === true && r.data.term.secondConfigured === false,
      r.data.term);

    await seedTerm({ firstStart: '2026-09-01', firstEnd: '2027-01-30', secondStart: '', secondEnd: '', currentTerm: 'second' });
    r = await api('/api/term', { cookie: admin });
    check('4b) 只填上学期但当前学期=下学期 → configured=false（提示先设置当前学期）',
      r.data.configured === false && r.data.source === 'default' && r.data.currentTermLabel === '下学期', r.data);
    check('4b) 未配置时仍尊重管理员选的当前学期（按下学期默认口径 2027-02-01 起算）',
      r.data.rawStartDate === '2027-02-01', { rawStart: r.data.rawStartDate, label: r.data.label });

    // ---------- 5) 未配置：回退默认口径 + 提示 ----------
    console.log('5) 未配置（清空）→ 默认口径:');
    await seedTerm({ firstStart: '', firstEnd: '', secondStart: '', secondEnd: '', currentTerm: 'second' });
    r = await api('/api/term', { cookie: admin });
    const exp = expectedDefault();
    check('5) configured=false 且 source=default', r.data.configured === false && r.data.source === 'default', r.data);
    check('5) 默认口径区间与独立复算一致（' + exp.startDate + ' ~ ' + exp.endDate + '）',
      r.data.startDate === exp.startDate && r.data.endDate === exp.endDate, { got: r.data, exp });
    check('5) 未配置时当前学期按月份推断（' + exp.current + '）', r.data.currentTerm === exp.current, r.data.currentTerm);

    // ---------- 6) 巡堂统计随配置变化 ----------
    console.log('6) 巡堂统计（range=term）随配置变化:');
    const mkIssue = async (date, desc) => {
      const ins = await pg.query(
        `INSERT INTO inspection_issues (issue_date, category, priority, status, description, created_by_name, created_at)
         VALUES ($1::date, 'hygiene', 'normal', 'pending', $2, 'termfix', now()) RETURNING id`,
        [date, '[学期用例' + TAG + '] ' + desc]
      );
      created.issueIds.push(ins.rows[0].id);
      return ins.rows[0].id;
    };
    await mkIssue('2020-02-10', '窗口内 1');
    await mkIssue('2020-03-01', '窗口内 2');
    await mkIssue('2020-04-05', '窗口外（下学期）');

    await seedTerm({ firstStart: '2020-01-01', firstEnd: '2020-03-31', secondStart: '2020-04-01', secondEnd: '2020-06-30', currentTerm: 'first' });
    r = await api('/api/inspection/stats/overview?range=term', { cookie: admin });
    check('6) 已配置：filter.startDate/endDate = 配置区间',
      r.status === 200 && r.data.filter.startDate === '2020-01-01' && r.data.filter.endDate === '2020-03-31', r.data && r.data.filter);
    check('6) 已配置：termConfigured=true', r.data.filter.termConfigured === true, r.data.filter);
    check('6) 已配置：只统计窗口内问题（2 条夹具）', r.data.total === 2, { total: r.data.total, filter: r.data.filter });

    await seedTerm({ firstStart: '', firstEnd: '', secondStart: '', secondEnd: '', currentTerm: 'first' });
    r = await api('/api/inspection/stats/overview?range=term', { cookie: admin });
    const defWin = expectedDefault();
    const expTotal = await countSql(
      `SELECT count(*)::int n FROM inspection_issues i
        WHERE i.issue_date >= $1::date AND i.issue_date <= $2::date`,
      [defWin.startDate, defWin.endDate]
    );
    check('6) 未配置：termConfigured=false（前端据此提示）', r.data.filter.termConfigured === false, r.data.filter);
    check('6) 未配置：按默认口径统计（与 SQL 计数一致）',
      r.data.filter.startDate === defWin.startDate && r.data.total === expTotal, { filter: r.data.filter, total: r.data.total, expTotal });

    // ---------- 7) 课堂表现随配置变化 ----------
    console.log('7) 课堂表现（period=term）随配置变化:');
    const insRc = await pg.query(
      `INSERT INTO rollcall_records (class_id, scope, picked_by_name, created_at, subject)
       VALUES (NULL, 'all', 'termfix', '2020-02-15 10:00:00', '数学') RETURNING id`
    );
    created.rollcallIds.push(insRc.rows[0].id);

    await seedTerm({ firstStart: '2020-01-01', firstEnd: '2020-03-31', secondStart: '2020-04-01', secondEnd: '2020-06-30', currentTerm: 'first' });
    r = await api('/api/performance/records?period=term&limit=200', { cookie: admin });
    check('7) 已配置：termConfigured=true 且 termStart/termEnd = 配置区间',
      r.status === 200 && r.data.termConfigured === true && r.data.termStart === '2020-01-01' && r.data.termEnd === '2020-03-31', r.data && { c: r.data.termConfigured, s: r.data.termStart, e: r.data.termEnd });
    const expRc = await countSql(
      `SELECT count(*)::int n FROM rollcall_records r WHERE r.created_at >= $1::date AND r.created_at < ($2::date + interval '1 day')`,
      ['2020-01-01', '2020-03-31']
    );
    check('7) 已配置：统计条数 = 窗口内 SQL 计数（含夹具）', r.data.total === expRc && r.data.total >= 1, { total: r.data.total, expRc });
    check('7) 已配置：窗口内夹具记录在结果里', (r.data.records || []).some((x) => x.operatorName === 'termfix'), (r.data.records || []).length);

    await seedTerm({ firstStart: '', firstEnd: '', secondStart: '', secondEnd: '', currentTerm: 'first' });
    r = await api('/api/performance/records?period=term&limit=200', { cookie: admin });
    const expRc2 = await countSql(
      `SELECT count(*)::int n FROM rollcall_records r WHERE r.created_at >= $1::date AND r.created_at < ($2::date + interval '1 day')`,
      [defWin.startDate, defWin.endDate]
    );
    check('7) 未配置：termConfigured=false 且按默认口径统计',
      r.data.termConfigured === false && r.data.termStart === defWin.startDate && r.data.total === expRc2,
      { c: r.data.termConfigured, s: r.data.termStart, total: r.data.total, expRc2 });
    check('7) 未配置：窗口内夹具（2020 年）已不在统计内',
      !(r.data.records || []).some((x) => x.operatorName === 'termfix'), (r.data.records || []).length);

    // ---------- 8) 参数编号不冲突（scope/subject 占位符 + 时间条件占位符）----------
    //   resolveTime 生成的 $n 必须接在已用参数之后，否则 class_id 会被当成日期解析 → 500
    console.log('8) scope/subject + 时间条件 参数编号:');
    const cid = created.classId;
    r = await api('/api/performance/records?classId=' + cid + '&date=' + todayStr(), { cookie: admin });
    check('8) classId + date（单日）→ 200 不再 500', r.status === 200, r.status);
    r = await api('/api/performance/records?classId=' + cid + '&from=2020-01-01&to=2020-12-31', { cookie: admin });
    check('8) classId + from/to → 200', r.status === 200, r.status);
    r = await api('/api/performance/records?classId=' + cid + '&subject=数学&period=term', { cookie: admin });
    check('8) classId + subject + period=term → 200 且带回学期窗口',
      r.status === 200 && !!r.data.termStart && r.data.termEnd, { status: r.status, data: r.data && { s: r.data.termStart, e: r.data.termEnd } });
    r = await api('/api/performance/export?classId=' + cid + '&period=term', { cookie: admin });
    check('8) 导出 classId + period=term → 不是 500（无记录时 404）', r.status === 404 || r.status === 200, r.status);
    r = await api('/api/performance/likes?classId=' + cid + '&period=term', { cookie: admin });
    check('8) 点赞排行 classId + period=term → 200', r.status === 200, r.status);
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：' + (e && e.stack ? e.stack : e));
  } finally {
    console.log('8) 清理与基线核对…');
    try {
      await hardCleanup();
      await restoreSettings();
    } catch (e) { console.log('  · 清理异常：' + e.message); }
    const after = await snapshotReal();
    const same = JSON.stringify(after) === JSON.stringify(realBefore);
    check('8) 真实数据行数回到用例前（users/grades/classes/issues/rollcall）', same, { before: realBefore, after });
    const restored = await readSettings();
    check('8) system_settings 学期设置恢复原值', JSON.stringify(restored) === JSON.stringify(snapshot), { snapshot, restored });
    console.log(`\n结果：✔ ${pass}  ✘ ${fail}`);
    await pg.end();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
