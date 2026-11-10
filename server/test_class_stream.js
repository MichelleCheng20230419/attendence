// ============================================================
// 班级「选科组合 + 选科科目」测试（迁移 v34）
//   需求：不同班级选科不同（理科/文科/小理/小文/综合）→ 各班开设学科不同：
//         语文、数学、英语 所有班级默认都有；物理/化学/生物/政治/历史/地理 由选科组合决定；
//         班级绑定选科后，该班每天自动生成对应学科的「今日作业」条目。
//   覆盖：
//     1) 迁移与字段：classes.stream / classes.elective_subjects 存在，历史班级默认「综合 + 空选科」（行为不变）
//     2) 新建班级：组合预设自动勾选（理科→物化生 / 文科→政史地）、小理·小文·综合 手动、
//        科目归一化（固定顺序）、非法组合/非法科目 400、字符串科目串解析
//     3) 编辑班级：切组合时预设/保留规则、只改科目不改组合、清空科目回到全局默认
//     4) 通用班级接口（/api/classes）与班级管理接口（/api/classes/manage）都返回选科与"开设学科"
//     5) 每日作业按班级实际学科生成：理科 6 科 / 小理 5 科（动态）、
//        管理员显式覆盖优先于选科、清空覆盖后回到选科、综合班沿用全局默认（与 v33 一致）
//     6) Excel 批量导入：模板下载（含选科列与说明页）、导入建班 + 选科 + 班主任（姓名/账号两种）、
//        冲突/非法/找不到教师 → 逐行跳过并给出原因、兼容旧列名（所属年级名称 / 班主任账号）
//     7) 权限：教师/班长/学生 调用班级增改与导入/模板 → 403
//   夹具：1 个临时年级 + 若干临时班级 + 1 个临时教师（按时间戳命名）；测完自愈清理并核对真实基线
// 用法：node test_class_stream.js（需服务已启动；管理员密码取 DSH_ADMIN_PW）
// ============================================================
'use strict';
const XLSX = require('xlsx');
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function api(p, { method = 'GET', body, cookie, raw } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h.Cookie = cookie;
  const r = await fetch(BASE + p, { method, headers: h, redirect: 'manual', body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), cd: r.headers.get('content-disposition') || '', ct: r.headers.get('content-type') || '' };
  const ct = r.headers.get('content-type') || '';
  let d = null; if (ct.includes('application/json')) { try { d = await r.json(); } catch (_) {} }
  return { status: r.status, data: d, setc: r.headers.get('set-cookie') || '' };
}
async function upload(p, buf, name, cookie) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  const r = await fetch(BASE + p, { method: 'POST', headers: cookie ? { Cookie: cookie } : {}, body: fd, redirect: 'manual' });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, data: d };
}
async function login(u, p) {
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('登录失败 ' + u + ': ' + r.status);
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}
const n1 = async (sql, params = []) => (await pg.query(sql, params)).rows[0].n;

const TAG = String(Date.now()).slice(-6);
const GRADE = '选科年级' + TAG;
const PRE = 'cs_' + TAG + '_';
const TEACHER_NAME = '选科测试老师' + TAG;
const created = { gradeId: null, classIds: [], userIds: [] };
let admin = null, teacher = null, monitor = null, student = null;

function xlsxFromRows(rows, sheetName = '班级导入') {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function snapshot() {
  return {
    users: await n1('SELECT count(*)::int n FROM users'),
    grades: await n1('SELECT count(*)::int n FROM grades'),
    classes: await n1('SELECT count(*)::int n FROM classes'),
    students: await n1('SELECT count(*)::int n FROM students'),
    sessions: await n1('SELECT count(*)::int n FROM attendance_sessions'),
    records: await n1('SELECT count(*)::int n FROM attendance_records'),
    plans: await n1('SELECT count(*)::int n FROM attendance_plans'),
    tasks: await n1('SELECT count(*)::int n FROM homework_tasks'),
  };
}

async function cleanup() {
  const warn = (l) => (e) => console.log('  · 清理失败（' + l + '）：' + e.message);
  await pg.query("UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL WHERE head_teacher_id IN (SELECT id FROM users WHERE username LIKE $1) OR teacher_id IN (SELECT id FROM users WHERE username LIKE $1)", [PRE + '%']).catch(warn('unlink'));
  await pg.query('DELETE FROM teacher_classes WHERE teacher_id IN (SELECT id FROM users WHERE username LIKE $1)', [PRE + '%']).catch(warn('teacher_classes'));
  await pg.query("DELETE FROM homework_submissions WHERE task_id IN (SELECT id FROM homework_tasks WHERE class_id IN (SELECT id FROM classes WHERE class_name LIKE $1))", ['选科%班%']).catch(warn('subs'));
  await pg.query("DELETE FROM homework_tasks WHERE class_id IN (SELECT id FROM classes WHERE class_name LIKE $1)", ['选科%班%']).catch(warn('tasks'));
  await pg.query("SELECT purge_class(id) FROM classes WHERE class_name LIKE $1", ['选科%班%']).catch(warn('purge'));
  await pg.query('DELETE FROM users WHERE username LIKE $1', [PRE + '%']).catch(warn('users'));
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(warn('grades'));
}

// 便捷：读某班的选科与"开设学科"（直接查库 + 走接口两种口径对比用）
async function classRow(classId) {
  const r = await pg.query('SELECT id, class_name, stream, elective_subjects, daily_subjects FROM classes WHERE id = $1', [classId]);
  return r.rows[0] || null;
}
const jarr = (v) => (Array.isArray(v) ? v : (v ? JSON.parse(v) : []));

(async () => {
  try {
    await cleanup();
    const base = await snapshot();
    console.log('0) 夹具准备…');
    admin = await login('admin');
    // 权限夹具（教师/班长/学生）：直接 SQL 建账号，避免与账号管理用例互相影响
    const firstCls = (await pg.query('SELECT id FROM classes ORDER BY id LIMIT 1')).rows[0];
    const mkAcc = async (u, role) => {
      await pg.query(
        `INSERT INTO users (username, password, role, class_id, real_name, display_name, roles, is_active, profile_locked)
         VALUES ($1,'123456',$2,$3,$1,$1,'[]'::json,true,true)`,
        [u, role, firstCls.id]
      );
      return login(u);
    };
    teacher = await mkAcc(PRE + 'tea', 'teacher');
    monitor = await mkAcc(PRE + 'mon', 'monitor');
    student = await mkAcc(PRE + 'stu', 'student');
    // 年级 + 用于"导入班主任按姓名匹配"的教师账号（管理员 API 建，保证 real_name 唯一）
    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'CS', academicYear: year } })).data.id;
    const tr = await api('/api/users', {
      method: 'POST', cookie: admin,
      body: { username: PRE + 'head', password: '123456', role: 'teacher', realName: TEACHER_NAME, classId: firstCls.id, mustChangePassword: false, profileLocked: true, force: true },
    });
    created.userIds.push(tr.data.user.id);
    check('0) 夹具就绪（年级 + 教师/班长/学生权限账号 + 1 个可作班主任的教师）',
      !!created.gradeId && !!teacher && !!monitor && !!student && !!tr.data.user.id, { grade: created.gradeId });

    // ---------- 1) 迁移与字段 ----------
    console.log('1) 迁移与字段（v34）:');
    const cols = (await pg.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'classes' AND column_name IN ('stream','elective_subjects','daily_subjects')`
    )).rows.map((r) => r.column_name).sort();
    check('1) classes 具备 stream / elective_subjects（并保留 v32 的 daily_subjects）',
      JSON.stringify(cols) === JSON.stringify(['daily_subjects', 'elective_subjects', 'stream']), cols);
    check('1) 存在选科组合 CHECK 约束（只允许 理科/文科/小理/小文/综合）',
      (await n1("SELECT count(*)::int n FROM pg_constraint WHERE conname = 'classes_stream_check'")) === 1);
    const bad = await pg.query("UPDATE classes SET stream = '体育班' WHERE id = $1 RETURNING id", [firstCls.id]).catch((e) => e);
    check('1) 直接写非法组合被数据库约束拒绝', !!(bad && bad.code === '23514'), bad && bad.code);
    // 注意：真实使用中管理员可能已经给某些班配了选科 —— 这里只断言"数据合法性"，
    //       不断言"没有任何班配置了选科"（那是把正常使用当失败）
    check('1) 所有班级的选科数据合法（stream 非空且 ∈ 5 种；elective_subjects 是数组且只含 6 门选科）',
      (await n1('SELECT count(*)::int n FROM classes WHERE stream IS NULL')) === 0 &&
      (await n1("SELECT count(*)::int n FROM classes WHERE elective_subjects IS NULL OR jsonb_typeof(elective_subjects) <> 'array'")) === 0 &&
      (await n1(`SELECT count(*)::int n FROM classes c, jsonb_array_elements_text(c.elective_subjects) AS s
                  WHERE s NOT IN ('物理','化学','生物','政治','历史','地理')`)) === 0,
      (await pg.query(`SELECT id, class_name, stream, elective_subjects::text FROM classes
                        WHERE stream IS NULL OR elective_subjects IS NULL OR jsonb_typeof(elective_subjects) <> 'array'`)).rows);
    // 未被设置选科的班 → 每日作业仍走全局默认（与 v33 行为一致；真实库里若都已设置则跳过）
    const noElective = (await pg.query(
      "SELECT id, class_name FROM classes WHERE COALESCE(jsonb_array_length(elective_subjects), 0) = 0 AND daily_subjects IS NULL ORDER BY id LIMIT 1"
    )).rows[0];
    if (noElective) {
      const cfgNo = (await api('/api/homework/daily-subjects?classId=' + noElective.id, { cookie: admin })).data;
      check('1) 未设置选科的班（' + noElective.class_name + '）→ 每日作业仍按全局默认 6 科（v33 行为不变）',
        cfgNo.source === 'global' && cfgNo.effective.length === 6, cfgNo);
    } else {
      console.log('  · 跳过「未设置选科的班沿用全局默认」：真实库里所有班都已配置选科（正常使用）');
    }

    // ---------- 2) 新建班级：组合预设 / 归一化 / 校验 ----------
    console.log('2) 新建班级（选科组合 + 选科科目）:');
    const mkClass = async (name, body) => {
      const r = await api('/api/classes', { method: 'POST', cookie: admin, body: { className: name, gradeId: created.gradeId, academicYear: (await api('/api/settings', { cookie: admin })).data.currentAcademicYear, ...body } });
      if (r.status === 201 && r.data.id) created.classIds.push(r.data.id);
      return r;
    };
    let r = await mkClass('选科理科班' + TAG, { stream: '理科' });
    check('2) 理科班创建 → 201 且自动勾选 物理/化学/生物',
      r.status === 201 && r.data.stream === '理科' && JSON.stringify(r.data.electiveSubjects) === JSON.stringify(['物理', '化学', '生物']), r.data);
    check('2) 开设学科 = 语文+数学+英语+物化生（6 科）',
      JSON.stringify(r.data.effectiveSubjects) === JSON.stringify(['语文', '数学', '英语', '物理', '化学', '生物']), r.data.effectiveSubjects);
    const clsScience = r.data.id;

    r = await mkClass('选科文科班' + TAG, { stream: '文科' });
    check('2) 文科班 → 自动勾选 政治/历史/地理，开设 6 科',
      r.status === 201 && JSON.stringify(r.data.electiveSubjects) === JSON.stringify(['政治', '历史', '地理']) &&
      JSON.stringify(r.data.effectiveSubjects) === JSON.stringify(['语文', '数学', '英语', '政治', '历史', '地理']), r.data);
    const clsArts = r.data.id;

    // 小理：手动勾选（乱序 → 归一化成固定顺序）
    r = await mkClass('选科小理班' + TAG, { stream: '小理', electiveSubjects: ['地理', '物理', '化学'] });
    check('2) 小理班手动勾选 → 科目按固定顺序归一（物理/化学/地理），开设 6 科',
      r.status === 201 && JSON.stringify(r.data.electiveSubjects) === JSON.stringify(['物理', '化学', '地理']) &&
      r.data.effectiveSubjects.length === 6, r.data);
    const clsSmallSci = r.data.id;

    // 小文 + 字符串科目串（顿号/逗号/空格混写 → 解析后按固定顺序归一：生物 < 政治 < 历史）
    r = await mkClass('选科小文班' + TAG, { stream: '小文', electiveSubjects: '政治、历史， 生物' });
    check('2) 小文班用「顿号/逗号混写」的科目串 → 解析为 生物/政治/历史（按固定科目顺序归一）',
      r.status === 201 && JSON.stringify(r.data.electiveSubjects) === JSON.stringify(['生物', '政治', '历史']), r.data);

    // 理科 + 显式科目（以传入为准，不套预设）
    r = await mkClass('选科理改班' + TAG, { stream: '理科', electiveSubjects: ['政治'] });
    check('2) 选科组合=理科但显式传科目 → 以传入为准（政治），不套用预设',
      r.status === 201 && JSON.stringify(r.data.electiveSubjects) === JSON.stringify(['政治']), r.data);

    // 综合 + 空科目
    r = await mkClass('选科综合班' + TAG, { stream: '综合', electiveSubjects: [] });
    check('2) 综合班不设选科 → 开设学科只含 语文/数学/英语（每日作业走全局默认）',
      r.status === 201 && r.data.electiveSubjects.length === 0 &&
      JSON.stringify(r.data.effectiveSubjects) === JSON.stringify(['语文', '数学', '英语']), r.data);
    const clsGeneral = r.data.id;

    // 校验：非法组合 / 非法科目 / 缺年级
    r = await api('/api/classes', { method: 'POST', cookie: admin, body: { className: '选科坏组合班' + TAG, gradeId: created.gradeId, academicYear: '2026-2027', stream: '体育班' } });
    check('2) 非法选科组合 → 400（提示可选值）', r.status === 400 && /选科组合无效/.test(r.data.error), r.data);
    r = await api('/api/classes', { method: 'POST', cookie: admin, body: { className: '选科坏科目班' + TAG, gradeId: created.gradeId, academicYear: '2026-2027', stream: '小理', electiveSubjects: ['数学'] } });
    check('2) 选科科目里写了「数学」（语文/数学/英语不接受配置）→ 400', r.status === 400 && /选科科目无效/.test(r.data.error), r.data);
    check('2) 非法组合/科目不会留下班级记录',
      (await n1("SELECT count(*)::int n FROM classes WHERE class_name LIKE '选科坏%'")) === 0);

    // ---------- 3) 班级管理接口回显 ----------
    console.log('3) 班级管理/通用接口回显:');
    let list = (await api('/api/classes/manage', { cookie: admin })).data.classes || [];
    const mScience = list.find((c) => c.id === clsScience);
    check('3) /api/classes/manage 返回 stream / elective_subjects / effective_subjects',
      !!mScience && mScience.stream === '理科' &&
      JSON.stringify(mScience.elective_subjects) === JSON.stringify(['物理', '化学', '生物']) &&
      mScience.effective_subjects.length === 6, mScience);
    let all = (await api('/api/classes', { cookie: admin })).data.classes || [];
    const gScience = all.find((c) => c.id === clsScience);
    check('3) /api/classes（下拉用）同样带选科与开设学科',
      !!gScience && gScience.stream === '理科' && JSON.stringify(gScience.electiveSubjects) === JSON.stringify(['物理', '化学', '生物']) &&
      gScience.effectiveSubjects.length === 6, gScience);

    // ---------- 4) 编辑班级：切换组合 / 只改科目 / 清空 ----------
    console.log('4) 编辑班级:');
    r = await api('/api/classes/' + clsScience, { method: 'PUT', cookie: admin, body: { className: '选科理科班' + TAG, stream: '文科' } });
    check('4) 理科 → 文科（不传科目）→ 自动切到 政治/历史/地理', r.status === 200);
    let row = await classRow(clsScience);
    check('4) 库中 stream=文科、选科=政史地', row.stream === '文科' && JSON.stringify(jarr(row.elective_subjects)) === JSON.stringify(['政治', '历史', '地理']), row);

    r = await api('/api/classes/' + clsScience, { method: 'PUT', cookie: admin, body: { className: '选科理科班' + TAG, stream: '小理' } });
    row = await classRow(clsScience);
    check('4) 文科 → 小理（不传科目）→ 保留原有选科（不清空）',
      r.status === 200 && JSON.stringify(jarr(row.elective_subjects)) === JSON.stringify(['政治', '历史', '地理']), row);

    r = await api('/api/classes/' + clsScience, { method: 'PUT', cookie: admin, body: { className: '选科理科班' + TAG, electiveSubjects: ['生物', '历史'] } });
    row = await classRow(clsScience);
    check('4) 只改科目（不传组合）→ 组合保持 小理、科目更新为 生物/历史（固定顺序）',
      r.status === 200 && row.stream === '小理' && JSON.stringify(jarr(row.elective_subjects)) === JSON.stringify(['生物', '历史']), row);

    r = await api('/api/classes/' + clsScience, { method: 'PUT', cookie: admin, body: { className: '选科理科班' + TAG, electiveSubjects: [] } });
    row = await classRow(clsScience);
    check('4) 清空选科科目 → 回到"只含语数英"（每日作业走全局默认）',
      r.status === 200 && jarr(row.elective_subjects).length === 0, row);
    // 复原为理科，供第 5 段使用
    await api('/api/classes/' + clsScience, { method: 'PUT', cookie: admin, body: { className: '选科理科班' + TAG, stream: '理科', electiveSubjects: ['物理', '化学', '生物'] } });
    row = await classRow(clsScience);
    check('4) 复原为理科班（供后续每日作业用例）', row.stream === '理科' && jarr(row.elective_subjects).length === 3, row);

    // ---------- 5) 每日作业按班级实际学科生成 ----------
    console.log('5) 每日作业（班长端按选科生成）:');
    let cfg = (await api('/api/homework/daily-subjects?classId=' + clsScience, { cookie: admin })).data;
    check('5) 理科班科目配置：source=class_stream、6 科、来源说明含"理科"',
      cfg.source === 'class_stream' && cfg.effective.length === 6 && /理科/.test(cfg.sourceDetail || '') && cfg.stream === '理科', cfg);
    let en = (await api('/api/homework/daily/ensure', { method: 'POST', cookie: admin, body: { classId: clsScience } })).data;
    check('5) 理科班生成今日作业 → 6 科（语文/数学/英语/物理/化学/生物）',
      en.subjects.length === 6 && en.subjects.join(',') === '语文,数学,英语,物理,化学,生物' && en.createdCount === 6, en);
    check('5) 库里确实建了 6 条「今日作业」条目（is_daily=true）',
      (await n1("SELECT count(*)::int n FROM homework_tasks WHERE class_id = $1 AND is_daily = true AND date = CURRENT_DATE", [clsScience])) === 6);
    en = (await api('/api/homework/daily/ensure', { method: 'POST', cookie: admin, body: { classId: clsScience } })).data;
    check('5) 重复生成幂等（createdCount=0，科目不变）', en.createdCount === 0 && en.subjects.length === 6, en);

    const cfgSmall = (await api('/api/homework/daily-subjects?classId=' + clsSmallSci, { cookie: admin })).data;
    const enSmall = (await api('/api/homework/daily/ensure', { method: 'POST', cookie: admin, body: { classId: clsSmallSci } })).data;
    check('5) 小理班（物理/化学/地理）→ 生成 6 科（语数英+物化地），来源=选科',
      cfgSmall.source === 'class_stream' && enSmall.subjects.join(',') === '语文,数学,英语,物理,化学,地理', enSmall);

    const cfgArts = (await api('/api/homework/daily-subjects?classId=' + clsArts, { cookie: admin })).data;
    const enArts = (await api('/api/homework/daily/ensure', { method: 'POST', cookie: admin, body: { classId: clsArts } })).data;
    check('5) 文科班 → 生成 6 科（语数英+政史地）',
      cfgArts.source === 'class_stream' && enArts.subjects.join(',') === '语文,数学,英语,政治,历史,地理', enArts);

    const enGeneral = (await api('/api/homework/daily/ensure', { method: 'POST', cookie: admin, body: { classId: clsGeneral } })).data;
    check('5) 综合班（未设选科）→ 沿用全局默认（与 v33 行为一致）',
      enGeneral.source === 'global' && enGeneral.subjects.length === 6 && enGeneral.subjects.join(',') === '语文,数学,英语,物理,化学,生物', enGeneral);

    // 管理员显式覆盖 > 班级选科
    let put = await api('/api/homework/daily-subjects', { method: 'PUT', cookie: admin, body: { classId: clsScience, subjects: ['语文', '数学'] } });
    check('5) 管理员为该班显式配置 语文/数学 → 生效 2 科', put.status === 200 && put.data.effective.join(',') === '语文,数学', put.data);
    let enOverride = (await api('/api/homework/daily/ensure', { method: 'POST', cookie: admin, body: { classId: clsScience } })).data;
    check('5) 显式覆盖优先于选科推导（只生成 2 科，source=class）',
      enOverride.subjects.join(',') === '语文,数学' && enOverride.source === 'class', enOverride);
    put = await api('/api/homework/daily-subjects', { method: 'PUT', cookie: admin, body: { classId: clsScience, subjects: [] } });
    check('5) 清空显式覆盖 → 回到按选科推导（6 科）',
      put.status === 200 && put.data.source === 'class_stream' && put.data.effective.length === 6, put.data);

    // ---------- 6) Excel 批量导入 ----------
    console.log('6) Excel 批量导入（含选科）:');
    let tpl = await api('/api/classes/import-template', { cookie: admin, raw: true });
    check('6) 模板下载 → 200 xlsx 且文件名含「班级信息导入模板」',
      tpl.status === 200 && tpl.ct.indexOf('spreadsheetml') >= 0 && decodeURIComponent(tpl.cd).indexOf('班级信息导入模板.xlsx') >= 0,
      { status: tpl.status, cd: tpl.cd });
    const twb = XLSX.read(tpl.buf, { type: 'buffer' });
    const tplRows = XLSX.utils.sheet_to_json(twb.Sheets['班级导入'], { defval: '' });
    check('6) 模板表头 = 班级名称/年级/学年/选科组合/选科科目/班主任',
      JSON.stringify(Object.keys(tplRows[0] || {})) === JSON.stringify(['班级名称', '年级', '学年', '选科组合', '选科科目', '班主任']), Object.keys(tplRows[0] || {}));
    check('6) 模板含示例行（理科/文科/小理/小文/综合）与「填写说明」页',
      tplRows.length === 5 && !!twb.Sheets['填写说明'], tplRows.length);

    const rows = [
      { 班级名称: '选科导入理班' + TAG, 年级: GRADE, 学年: '', 选科组合: '理科', 选科科目: '', 班主任: TEACHER_NAME },
      { 班级名称: '选科导入文班' + TAG, 年级: GRADE, 学年: '', 选科组合: '文科', 选科科目: '政治、历史、地理', 班主任: '' },
      { 班级名称: '选科导入小理班' + TAG, 年级: GRADE, 学年: '', 选科组合: '小理', 选科科目: '物理,生物,地理', 班主任: '' },
      { 班级名称: '选科导入坏组合班' + TAG, 年级: GRADE, 学年: '', 选科组合: '竞赛班', 选科科目: '', 班主任: '' },
      { 班级名称: '选科导入无年级班' + TAG, 年级: '不存在的年级', 学年: '', 选科组合: '综合', 选科科目: '', 班主任: '' },
      { 班级名称: '选科导入无师班' + TAG, 年级: GRADE, 学年: '', 选科组合: '综合', 选科科目: '', 班主任: '查无此人老师' },
    ];
    let up = await upload('/api/classes/import', xlsxFromRows(rows), 'classes.xlsx', admin);
    check('6) 导入 6 行 → 新增 3、跳过 3（坏组合/无年级/找不到教师）',
      up.status === 200 && up.data.inserted === 3 && up.data.skipped === 3, up.data);
    const reasons = (up.data.errors || []).map((e) => e.reason).join(' | ');
    check('6) 跳过原因逐行给出（选科组合无效 / 年级不存在 / 找不到教师）',
      /选科组合无效/.test(reasons) && /年级不存在/.test(reasons) && /找不到教师/.test(reasons), up.data.errors);
    const impScience = (await pg.query("SELECT id, stream, elective_subjects, head_teacher_id FROM classes WHERE class_name = $1", ['选科导入理班' + TAG])).rows[0];
    check('6) 理科行导入后：stream=理科、自动物化生、班主任按「姓名」匹配成功',
      !!impScience && impScience.stream === '理科' &&
      JSON.stringify(jarr(impScience.elective_subjects)) === JSON.stringify(['物理', '化学', '生物']) &&
      impScience.head_teacher_id === created.userIds[0], impScience);
    const impSmall = (await pg.query("SELECT id, stream, elective_subjects FROM classes WHERE class_name = $1", ['选科导入小理班' + TAG])).rows[0];
    check('6) 小理行：科目按固定顺序归一（物理/生物/地理）',
      !!impSmall && impSmall.stream === '小理' &&
      JSON.stringify(jarr(impSmall.elective_subjects)) === JSON.stringify(['物理', '生物', '地理']), impSmall);
    check('6) 班主任带班关系已建立（teacher_classes 有该教师与导入班级的记录）',
      (await n1('SELECT count(*)::int n FROM teacher_classes WHERE teacher_id = $1 AND class_id = $2', [created.userIds[0], impScience.id])) === 1);
    check('6) 同名班级重复导入 → 跳过并说明原因',
      (await upload('/api/classes/import', xlsxFromRows([rows[0]]), 'again.xlsx', admin)).data.errors.some((e) => /已存在同名班级/.test(e.reason)));

    // 旧模板列名兼容（所属年级名称 + 班主任账号）
    const legacy = [{ 班级名称: '选科导入旧版班' + TAG, 所属年级名称: GRADE, 学年: '', 班主任账号: PRE + 'head' }];
    const upLegacy = await upload('/api/classes/import', xlsxFromRows(legacy), 'legacy.xlsx', admin);
    const legacyRow = (await pg.query("SELECT id, stream, elective_subjects, head_teacher_id FROM classes WHERE class_name = $1", ['选科导入旧版班' + TAG])).rows[0];
    check('6) 兼容旧模板列名（所属年级名称/班主任账号）→ 仍可导入',
      upLegacy.data.inserted === 1 && !!legacyRow && legacyRow.head_teacher_id === created.userIds[0], upLegacy.data);
    check('6) 旧模板行未写选科 → 默认「综合 + 空选科」（不猜科目）',
      !!legacyRow && legacyRow.stream === '综合' && jarr(legacyRow.elective_subjects).length === 0, legacyRow);

    // ---------- 7) 权限 ----------
    console.log('7) 权限:');
    const check403 = (label, rr) => check(`7) ${label} → 403`, rr.status === 403, { status: rr.status, data: rr.data });
    check403('教师新建班级', await api('/api/classes', { method: 'POST', cookie: teacher, body: { className: '选科越权班' + TAG, gradeId: created.gradeId } }));
    check403('教师改班级选科', await api('/api/classes/' + clsScience, { method: 'PUT', cookie: teacher, body: { className: 'x', stream: '文科' } }));
    check403('教师下载导入模板', await api('/api/classes/import-template', { cookie: teacher }));
    check403('班长导入班级', await upload('/api/classes/import', xlsxFromRows([rows[0]]), 'x.xlsx', monitor));
    check403('学生下载导入模板', await api('/api/classes/import-template', { cookie: student }));

    // ---------- 8) 清理与基线 ----------
    console.log('8) 清理与基线:');
    await cleanup();
    const after = await snapshot();
    check('8) 真实数据行数回到用例前（users/grades/classes/students/sessions/records/plans/homework_tasks）',
      JSON.stringify(base) === JSON.stringify(after), { base, after });
    check('8) 夹具已清理（班级/年级/账号/作业条目）',
      (await n1("SELECT count(*)::int n FROM classes WHERE class_name LIKE '选科%班%'")) === 0 &&
      (await n1('SELECT count(*)::int n FROM grades WHERE grade_name = $1', [GRADE])) === 0 &&
      (await n1('SELECT count(*)::int n FROM users WHERE username LIKE $1', [PRE + '%'])) === 0);
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
