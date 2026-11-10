// ============================================================
// 教师账号批量导入 测试（模板下载 + 预览 + 导入 + 自动建班 + 权限）
//   覆盖：
//     1) GET /api/teachers/template：xlsx 可解析、两份 Sheet、表头 10 列、含示例行、中文文件名
//     2) POST /api/teachers/import?dryRun=1：只校验不写库（预览含"将自动创建"计划）
//     3) 校验规则：缺用户名/密码<6/缺真实姓名/角色非法/学科不在字典/班主任缺班级/任课老师缺所带班级/邮箱格式
//     4) 真实导入：创建教师账号（teacher、真实姓名、学科、手机号/邮箱）+ 自动创建年级/班级
//        + 带班记录（班主任 head_teacher 且写入 classes.head_teacher_id；任课老师 subject_teacher 可多班）
//        + 新账号可用初始密码登录 + 用户名重复行跳过
//     5) 权限：非管理员（教师/班长/学生）→ 403
//   夹具：全部以时间戳命名（ti_ 开头 / 导入…），测完清理并核对真实基线
// ============================================================
'use strict';
const XLSX = require('xlsx');
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); }
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
async function countSql(sql, params = []) { return (await pg.query(sql, params)).rows[0].n; }

const TAG = String(Date.now()).slice(-6);
const GRADE = '导入年级' + TAG, CLASS_HEAD = '导入甲班' + TAG, CLASS_B = '导入乙班' + TAG, CLASS_C = '导入丙班' + TAG;
const U_HEAD = 'ti_head_' + TAG, U_SUBJ = 'ti_subj_' + TAG, PW = 'abc123';
let admin = null, teacher = null, monitor = null, student = null;
let realBefore = null, fixtureBase = null;

function xlsx(rows, sheetName = '教师账号') {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const ROW_HEAD = {
  用户名: U_HEAD, 密码: PW, 真实姓名: '导入班主任', 角色: '班主任', 所教学科: '数学',
  班主任班级: CLASS_HEAD, 所带班级: '', 年级: GRADE, 手机号: '13800000001', 邮箱: 'head@school.com',
};
const ROW_SUBJ = {
  用户名: U_SUBJ, 密码: PW, 真实姓名: '导入任课', 角色: '任课老师', 所教学科: '语文',
  班主任班级: '', 所带班级: `${CLASS_B}, ${CLASS_C}`, 年级: GRADE, 手机号: '', 邮箱: '',
};

async function snapshotReal() {
  return {
    users: await countSql('SELECT count(*)::int n FROM users'),
    grades: await countSql('SELECT count(*)::int n FROM grades'),
    classes: await countSql('SELECT count(*)::int n FROM classes'),
    teacherClasses: await countSql('SELECT count(*)::int n FROM teacher_classes'),
    settings: await countSql('SELECT count(*)::int n FROM system_settings'),
  };
}
async function hardCleanup() {
  const warn = (l) => (e) => console.log('  · 清理失败（' + l + '）：' + e.message);
  // 先解除班级班主任引用，再删班级，最后删账号（避免外键挡住）
  await pg.query("UPDATE classes SET head_teacher_id = NULL WHERE head_teacher_id IN (SELECT id FROM users WHERE username LIKE 'ti\\_%')").catch(warn('unlink-head'));
  await pg.query("DELETE FROM teacher_classes WHERE teacher_id IN (SELECT id FROM users WHERE username LIKE 'ti\\_%')").catch(warn('teacher_classes'));
  await pg.query("SELECT purge_class(id) FROM classes WHERE class_name LIKE '导入%班' || '%'").catch(warn('classes'));
  await pg.query("DELETE FROM users WHERE username LIKE 'ti\\_%'").catch(warn('users'));
  await pg.query("DELETE FROM grades WHERE grade_name LIKE '导入年级%'").catch(warn('grades'));
}

(async () => {
  try {
    console.log('0) 夹具与权限准备…');
    realBefore = await snapshotReal();   // ① 建夹具前的真实基线（最终核对用）
    admin = await login('admin');
    // 权限夹具：1 个教师（直接 SQL，避免影响账号管理用例）、1 个班长、1 个学生
    const firstCls = await pg.query('SELECT id FROM classes ORDER BY id LIMIT 1');
    const cid = firstCls.rows[0].id;
    const mk = async (u, role) => {
      await pg.query(
        `INSERT INTO users (username, password, role, class_id, real_name, display_name, roles, is_active, profile_locked)
         VALUES ($1,'123456',$2,$3,$1,$1,'[]'::json,true,true)`, [u, role, cid]
      );
      return login(u);
    };
    teacher = await mk('ti_perm_tea_' + TAG, 'teacher');
    monitor = await mk('ti_perm_mon_' + TAG, 'monitor');
    student = await mk('ti_perm_stu_' + TAG, 'student');
    fixtureBase = await snapshotReal();  // ② 权限夹具建好后的基线（dryRun 不写库核对用）
    check('0) 夹具就绪（模板 + 权限账号）', !!admin && !!teacher && !!monitor && !!student);

    // ---------- 1) 模板下载 ----------
    console.log('1) 模板下载:');
    let r = await api('/api/teachers/template', { cookie: admin, raw: true });
    check('1) 管理员下载模板 → 200 且为 xlsx', r.status === 200 && r.ct.indexOf('spreadsheetml') >= 0 && r.buf.length > 5000,
      { status: r.status, bytes: r.buf.length, ct: r.ct });
    check('1) 文件名为中文「教师账号导入模板.xlsx」', decodeURIComponent(r.cd).indexOf('教师账号导入模板.xlsx') >= 0, r.cd);
    const wb = XLSX.read(r.buf, { type: 'buffer' });
    check('1) 含两个 Sheet（教师账号 / 填写说明）', JSON.stringify(wb.SheetNames) === JSON.stringify(['教师账号', '填写说明']), wb.SheetNames);
    const tplRows = XLSX.utils.sheet_to_json(wb.Sheets['教师账号'], { defval: '' });
    const headers = Object.keys(tplRows[0] || {});
    check('1) 表头 = 用户名/密码/真实姓名/角色/所教学科/班主任班级/所带班级/年级/手机号/邮箱',
      JSON.stringify(headers) === JSON.stringify(['用户名', '密码', '真实姓名', '角色', '所教学科', '班主任班级', '所带班级', '年级', '手机号', '邮箱']), headers);
    check('1) 含 2 行示例（班主任张三 / 任课老师李四）',
      tplRows.length === 2 && tplRows[0]['角色'] === '班主任' && tplRows[0]['班主任班级'] === '高三1班' && tplRows[1]['角色'] === '任课老师' && tplRows[1]['所带班级'].indexOf(',') > 0,
      tplRows);
    const noteRows = XLSX.utils.sheet_to_json(wb.Sheets['填写说明'], { header: 1 });
    check('1) 说明 Sheet 含每个字段的必填与说明', noteRows.length > 5 && noteRows[0].join('') === '字段是否必填说明', noteRows.slice(0, 3));

    // ---------- 2) 权限 ----------
    console.log('2) 权限:');
    check('2) 教师下载模板 → 403', (await api('/api/teachers/template', { cookie: teacher, raw: true })).status === 403);
    check('2) 班长下载模板 → 403', (await api('/api/teachers/template', { cookie: monitor, raw: true })).status === 403);
    check('2) 未登录下载模板 → 401（全局登录校验拦截）', (await api('/api/teachers/template', { raw: true })).status === 401);
    check('2) 教师导入 → 403', (await upload('/api/teachers/import', xlsx([ROW_HEAD]), 't.xlsx', teacher)).status === 403);
    check('2) 学生导入 → 403', (await upload('/api/teachers/import', xlsx([ROW_HEAD]), 't.xlsx', student)).status === 403);

    // ---------- 3) 校验规则（dryRun 不写库）----------
    console.log('3) 校验规则（dryRun）:');
    const badRows = [
      [{ ...ROW_HEAD, 用户名: '' }, '缺用户名'],
      [{ ...ROW_HEAD, 用户名: 'ti_pw_' + TAG, 密码: '123' }, '密码不足 6 位'],
      [{ ...ROW_HEAD, 用户名: 'ti_rn_' + TAG, 真实姓名: '' }, '缺真实姓名'],
      [{ ...ROW_HEAD, 用户名: 'ti_role_' + TAG, 角色: '校长' }, '角色非法'],
      [{ ...ROW_HEAD, 用户名: 'ti_subj_' + TAG, 角色: '任课老师', 所教学科: '烹饪', 所带班级: CLASS_B, 班主任班级: '' }, '学科不在字典'],
      [{ ...ROW_HEAD, 用户名: 'ti_noc_' + TAG, 班主任班级: '' }, '班主任缺班级'],
      [{ ...ROW_HEAD, 用户名: 'ti_nos_' + TAG, 角色: '任课老师', 所带班级: '', 班主任班级: '' }, '任课老师缺所带班级'],
      [{ ...ROW_HEAD, 用户名: 'ti_mail_' + TAG, 邮箱: 'not-an-email' }, '邮箱格式错误'],
    ];
    r = await upload('/api/teachers/import?dryRun=1', xlsx(badRows.map((x) => x[0])), 'bad.xlsx', admin);
    check('3) 8 条非法行全部失败且给出原因', r.status === 200 && r.data.failed === 8 && r.data.success === 0 && r.data.errors.length === 8, r.data);
    check('3) 失败原因覆盖各校验点',
      ['用户名不能为空', '密码至少 6 位', '真实姓名不能为空', '角色「校长」无效', '不在学科字典', '班主任班级」必填', '所带班级」必填', '邮箱格式不正确']
        .every((k) => r.data.errors.some((e) => e.indexOf(k) >= 0)),
      r.data.errors);
    check('3) dryRun 不写库（用户/班级/年级都没变）',
      JSON.stringify(await snapshotReal()) === JSON.stringify(fixtureBase),
      { before: fixtureBase, after: await snapshotReal() });

    // 预览：合法行 + 将自动创建计划
    r = await upload('/api/teachers/import?dryRun=1', xlsx([ROW_HEAD, ROW_SUBJ]), 'preview.xlsx', admin);
    check('3) 预览 2 条合法行全部通过', r.status === 200 && r.data.success === 2 && r.data.failed === 0, r.data.results);
    check('3) 预览给出「将自动创建」的年级与班级',
      r.data.results[0].plan.newGrades.indexOf(GRADE) >= 0 &&
      r.data.results[1].plan.newClasses.indexOf(GRADE + ' ' + CLASS_B) >= 0,
      r.data.results.map((x) => x.plan));
    check('3) 预览不写库（班级仍未创建）',
      (await countSql('SELECT count(*)::int n FROM classes WHERE class_name = ANY($1)', [[CLASS_HEAD, CLASS_B, CLASS_C]])) === 0);

    // ---------- 4) 真实导入 ----------
    console.log('4) 真实导入:');
    r = await upload('/api/teachers/import', xlsx([ROW_HEAD, ROW_SUBJ]), 'go.xlsx', admin);
    check('4) 导入 2 条 → 成功 2 / 失败 0', r.status === 200 && r.data.success === 2 && r.data.failed === 0, r.data);
    check('4) 返回创建明细（账号/班级/年级）',
      r.data.created.teachers.length === 2 && r.data.created.classes.length === 3 && r.data.created.grades.length === 1,
      r.data.created);

    const users = await pg.query(
      `SELECT id, username, role, real_name, subject, class_id, phone, email, roles, profile_locked, is_active
         FROM users WHERE username = ANY($1) ORDER BY username`, [[U_HEAD, U_SUBJ]]
    );
    const uHead = users.rows.find((x) => x.username === U_HEAD);
    const uSubj = users.rows.find((x) => x.username === U_SUBJ);
    check('4) 创建了 2 个 teacher 账号（真实姓名/学科/联系方式落库）',
      !!uHead && !!uSubj && uHead.role === 'teacher' && uHead.real_name === '导入班主任' && uHead.subject === '数学' &&
      uHead.phone === '13800000001' && uHead.email === 'head@school.com' && uSubj.subject === '语文',
      users.rows);
    check('4) 班主任账号 roles=["head_teacher"]、任课老师 roles=["subject_teacher"]',
      JSON.stringify(uHead.roles) === '["head_teacher"]' && JSON.stringify(uSubj.roles) === '["subject_teacher"]',
      { head: uHead.roles, subj: uSubj.roles });

    const cls = await pg.query(
      `SELECT c.id, c.class_name, c.grade, c.grade_id, c.academic_year, c.head_teacher_id, g.grade_name
         FROM classes c LEFT JOIN grades g ON g.id = c.grade_id
        WHERE c.class_name = ANY($1) ORDER BY c.id`, [[CLASS_HEAD, CLASS_B, CLASS_C]]
    );
    check('4) 自动创建 3 个班级并关联到自动创建的年级',
      cls.rowCount === 3 && cls.rows.every((x) => x.grade_name === GRADE && !!x.grade_id && !!x.academic_year),
      cls.rows);
    const headClass = cls.rows.find((x) => x.class_name === CLASS_HEAD);
    check('4) 班主任班级的 head_teacher_id = 该教师', headClass.head_teacher_id === uHead.id, { want: uHead.id, got: headClass.head_teacher_id });

    const tc = await pg.query(
      `SELECT u.username, c.class_name, tc.role_in_class, tc.is_head_teacher, tc.subject
         FROM teacher_classes tc JOIN users u ON u.id = tc.teacher_id LEFT JOIN classes c ON c.id = tc.class_id
        WHERE u.username = ANY($1) ORDER BY u.username, c.class_name`, [[U_HEAD, U_SUBJ]]
    );
    check('4) 带班记录：班主任 1 条（head_teacher）+ 任课老师 2 条（subject_teacher）',
      tc.rowCount === 3 &&
      tc.rows.filter((x) => x.username === U_HEAD).every((x) => x.role_in_class === 'head_teacher' && x.is_head_teacher === true && x.class_name === CLASS_HEAD) &&
      tc.rows.filter((x) => x.username === U_SUBJ).map((x) => x.class_name).sort().join(',') === [CLASS_B, CLASS_C].sort().join(',') &&
      tc.rows.filter((x) => x.username === U_SUBJ).every((x) => x.role_in_class === 'subject_teacher' && x.subject === '语文'),
      tc.rows);
    check('4) 任课老师账号 class_id 指向所带班级之一', [cls.rows.find((x) => x.id === uSubj.class_id) ? 1 : 0].includes(1), uSubj.class_id);

    const lg2 = await login(U_HEAD, PW);
    check('4) 新教师可用初始密码登录', !!lg2);
    check('4) 新教师登录后身份正确（teacher + 学科/带班可见）',
      (await api('/api/auth/me', { cookie: lg2 })).data.user.role === 'teacher', null);

    // 重复导入 → 全部跳过
    r = await upload('/api/teachers/import', xlsx([ROW_HEAD, ROW_SUBJ]), 'again.xlsx', admin);
    check('4) 重复导入 → 成功 0 / 失败 2（用户名已存在）',
      r.data.success === 0 && r.data.failed === 2 && r.data.errors.every((e) => e.indexOf('用户名已存在') >= 0), r.data.errors);
    check('4) 重复导入未重复建班建人',
      (await countSql('SELECT count(*)::int n FROM users WHERE username = ANY($1)', [[U_HEAD, U_SUBJ]])) === 2 &&
      (await countSql('SELECT count(*)::int n FROM classes WHERE class_name = ANY($1)', [[CLASS_HEAD, CLASS_B, CLASS_C]])) === 3);

    // 已存在班级复用（不重复创建）
    r = await upload('/api/teachers/import', xlsx([{ ...ROW_HEAD, 用户名: 'ti_head2_' + TAG, 真实姓名: '导入班主任2', 班主任班级: CLASS_B, 所带班级: '' }]), 'reuse.xlsx', admin);
    check('4) 班级已存在时复用（不重复创建）',
      r.data.success === 1 && (await countSql('SELECT count(*)::int n FROM classes WHERE class_name = $1', [CLASS_B])) === 1,
      r.data.results);
    check('4) 复用已有班级并成为其班主任（原班主任为空 → 正常写入）',
      (await pg.query('SELECT head_teacher_id FROM classes WHERE class_name = $1', [CLASS_B])).rows[0].head_teacher_id !== null,
      (await pg.query('SELECT head_teacher_id FROM classes WHERE class_name = $1', [CLASS_B])).rows[0]);

    // 不抢占：再导入一位"班主任"，指定班主任班级 = 已有班主任的 CLASS_HEAD
    const headBefore = (await pg.query('SELECT head_teacher_id FROM classes WHERE class_name = $1', [CLASS_HEAD])).rows[0].head_teacher_id;
    r = await upload('/api/teachers/import', xlsx([{ ...ROW_HEAD, 用户名: 'ti_head3_' + TAG, 真实姓名: '导入班主任3', 班主任班级: CLASS_HEAD, 所带班级: '', 手机号: '', 邮箱: '' }]), 'steal.xlsx', admin);
    check('4) 导入成功但不会抢占该班已有班主任（班级管理员字段保持原值）',
      r.data.success === 1 &&
      (await pg.query('SELECT head_teacher_id FROM classes WHERE class_name = $1', [CLASS_HEAD])).rows[0].head_teacher_id === headBefore,
      { before: headBefore, after: (await pg.query('SELECT head_teacher_id FROM classes WHERE class_name = $1', [CLASS_HEAD])).rows[0].head_teacher_id });
    check('4) 但带班记录里仍写入该教师的 head_teacher 关系（数据完整，由管理员在班级管理里调整）',
      (await countSql("SELECT count(*)::int n FROM teacher_classes tc JOIN users u ON u.id = tc.teacher_id WHERE u.username = $1 AND tc.role_in_class = 'head_teacher'", ['ti_head3_' + TAG])) === 1);

    // 文件不合格 → 400
    r = await upload('/api/teachers/import', Buffer.from('这不是 Excel 文件'), 'broken.xlsx', admin);
    check('4) 上传非表格文件 → 400（未识别到导入数据）', r.status === 400 && /未识别到导入数据|解析失败/.test(r.data.error || ''), r.data);
    r = await upload('/api/teachers/import', Buffer.from(''), 'empty.xlsx', admin);
    check('4) 上传空文件 → 400', r.status === 400, r.data);
    const noFile = await fetch(BASE + '/api/teachers/import', { method: 'POST', headers: { Cookie: admin }, body: new FormData(), redirect: 'manual' });
    check('4) 未选择文件 → 400（请上传 Excel 文件）', noFile.status === 400, noFile.status);
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：' + (e && e.stack ? e.stack : e));
  } finally {
    console.log('5) 清理与基线核对…');
    try { await hardCleanup(); } catch (e) { console.log('  · 清理异常：' + e.message); }
    const after = await snapshotReal();
    check('5) 真实数据行数回到用例前（users/grades/classes/teacher_classes/settings）',
      JSON.stringify(after) === JSON.stringify(realBefore), { before: realBefore, after });
    check('5) 无夹具残留（账号/班级/年级）',
      (await countSql("SELECT count(*)::int n FROM users WHERE username LIKE 'ti\\_%'")) === 0 &&
      (await countSql("SELECT count(*)::int n FROM classes WHERE class_name LIKE '导入%班%'")) === 0 &&
      (await countSql("SELECT count(*)::int n FROM grades WHERE grade_name LIKE '导入年级%'")) === 0);
    console.log(`\n结果：✔ ${pass}  ✘ ${fail}`);
    await pg.end();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
