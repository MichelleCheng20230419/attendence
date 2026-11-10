// ============================================================
// 教师账号批量导入（管理员）
//   GET  /api/teachers/template   下载标准 Excel 模板
//   POST /api/teachers/import     批量导入（?dryRun=1 只校验不写库）
//
//   模板列：用户名 / 密码 / 真实姓名 / 角色 / 所教学科 / 班主任班级 / 所带班级 / 年级 / 手机号 / 邮箱
//   导入逻辑：
//     1) 逐行校验必填字段（用户名、密码≥6、真实姓名、角色、所教学科、年级；
//        角色=班主任 → 班主任班级必填；角色=任课老师 → 所带班级必填，多个用逗号分隔）
//     2) 班级不存在 → 按「年级 + 班级名」自动创建（年级也不存在时一并创建，关联当前学年）
//     3) 创建教师账号（角色 teacher、真实姓名、所教学科、手机号/邮箱），
//        并按角色写入带班记录：班主任 → head_teacher（同时写入班级班主任字段，不抢占已有班主任）；
//        任课老师 → subject_teacher（可多班）
//     4) 用户名已存在 / 字段缺失 → 跳过并记录原因
//   每一行一个事务：中途失败则整行回滚（含自动创建的班级）
// ============================================================
const XLSX = require('xlsx');
const pool = require('../db');
const { SUBJECTS, SUBJECT_SET } = require('../subjects');
const { saveTeacherClasses, syncHeadTeacherFromClasses } = require('../routes/users');

// 模板列（顺序即 Excel 列顺序）
const COLUMNS = ['用户名', '密码', '真实姓名', '角色', '所教学科', '班主任班级', '所带班级', '年级', '手机号', '邮箱'];
const REQUIRED_HINT = {
  用户名: '登录账号（唯一）',
  密码: '初始密码（至少 6 位）',
  真实姓名: '教师姓名',
  角色: '班主任 / 任课老师',
  所教学科: SUBJECTS.join(' / '),
  班主任班级: '角色为班主任时必填，如 高三1班',
  所带班级: '角色为任课老师时必填，多个用逗号分隔，如 高三2班,高三3班',
  年级: '班级所属年级，如 高三年级',
  手机号: '选填',
  邮箱: '选填',
};
const EXAMPLE_ROWS = [
  { 用户名: 'zhangsan', 密码: '123456', 真实姓名: '张三', 角色: '班主任', 所教学科: '数学', 班主任班级: '高三1班', 所带班级: '', 年级: '高三年级', 手机号: '13800138000', 邮箱: 'zhangsan@school.com' },
  { 用户名: 'lisi', 密码: '123456', 真实姓名: '李四', 角色: '任课老师', 所教学科: '语文', 班主任班级: '', 所带班级: '高三2班,高三3班', 年级: '高三年级', 手机号: '13800138001', 邮箱: 'lisi@school.com' },
];

// 角色别名 → 标准角色
const ROLE_ALIAS = {
  班主任: 'head_teacher',
  head_teacher: 'head_teacher',
  headteacher: 'head_teacher',
  任课老师: 'subject_teacher',
  任课教师: 'subject_teacher',
  subject_teacher: 'subject_teacher',
  teacher: 'subject_teacher',
};
const ROLE_LABEL = { head_teacher: '班主任', subject_teacher: '任课老师' };

function splitClasses(v) {
  return String(v == null ? '' : v)
    .split(/[,，、;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}
function str(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max ? s.slice(0, max) : s;
}

// ---------- 模板 ----------
function buildTemplateBuffer() {
  const ws = XLSX.utils.json_to_sheet(EXAMPLE_ROWS, { header: COLUMNS });
  ws['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 24 }, { wch: 12 }, { wch: 14 }, { wch: 24 }];
  const head = XLSX.utils.aoa_to_sheet([
    ['字段', '是否必填', '说明'],
    ...COLUMNS.map((c) => [c, ['手机号', '邮箱'].includes(c) ? '选填' : (c === '班主任班级' || c === '所带班级' ? '条件必填' : '✅ 必填'), REQUIRED_HINT[c]]),
    ['', '', ''],
    ['说明', '', '1) 表头行请勿修改；第 2、3 行是示例，导入前请替换为真实数据（可整行删除）'],
    ['', '', '2) 班主任：填「班主任班级」；任课老师：填「所带班级」（多个用逗号分隔）'],
    ['', '', '3) 班级不存在时系统会按「年级 + 班级名」自动创建（年级不存在则一并创建）'],
    ['', '', '4) 用户名已存在的行会跳过并在导入结果里列出原因'],
  ]);
  head['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 72 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '教师账号');
  XLSX.utils.book_append_sheet(wb, head, '填写说明');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---------- 解析 ----------
// xlsx/xlsm 是 zip（PK 头）；xls 是二进制（含 NUL）；其余按 UTF-8 文本（CSV）解析
// —— CSV 必须按 UTF-8 解码后再交给 SheetJS，否则中文表头会被当成 latin1 乱码导致"读不到列"
function readWorkbook(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const isZip = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (isZip) return XLSX.read(buf, { type: 'buffer' });
  let hasNul = false;
  const head = buf.slice(0, 512);
  for (let i = 0; i < head.length; i++) if (head[i] === 0) { hasNul = true; break; }
  if (hasNul) return XLSX.read(buf, { type: 'buffer' });   // .xls（BIFF）
  const text = buf.toString('utf8').replace(/^\uFEFF/, ''); // 去掉 Excel 导出 CSV 的 BOM
  return XLSX.read(text, { type: 'string' });
}

function parseRows(buffer) {
  const wb = readWorkbook(buffer);
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });
  // 去掉示例说明行/空行（用户名与密码都为空时不参与导入）
  return raw
    .map((r, i) => ({ row: i + 2, raw: r }))   // Excel 行号（含表头）
    .filter(({ raw: r }) => str(r['用户名']) || str(r['密码']) || str(r['真实姓名']));
}

// ---------- 单行校验（不写库）----------
function validateRow(raw) {
  const username = str(raw['用户名'], 50);
  const password = str(raw['密码'], 100);
  const realName = str(raw['真实姓名'], 50);
  const roleRaw = str(raw['角色'], 20);
  const subject = str(raw['所教学科'], 20);
  const grade = str(raw['年级'], 20);
  const headClass = str(raw['班主任班级'], 50);
  const subjectClasses = splitClasses(raw['所带班级']);
  const phone = str(raw['手机号'], 20);
  const email = str(raw['邮箱'], 100);

  if (!username) return { error: '用户名不能为空' };
  if (!password) return { error: '密码不能为空' };
  if (password.length < 6) return { error: '密码至少 6 位' };
  if (!realName) return { error: '真实姓名不能为空' };
  const role = ROLE_ALIAS[roleRaw];
  if (!roleRaw) return { error: '角色不能为空' };
  if (!role) return { error: `角色「${roleRaw}」无效（填 班主任 或 任课老师）` };
  if (!subject) return { error: '所教学科不能为空' };
  if (!SUBJECT_SET.has(subject)) return { error: `所教学科「${subject}」不在学科字典（${SUBJECTS.join('/')}）` };
  if (!grade) return { error: '年级不能为空' };
  if (role === 'head_teacher' && !headClass) return { error: '角色为班主任时，「班主任班级」必填' };
  if (role === 'subject_teacher' && subjectClasses.length === 0) return { error: '角色为任课老师时，「所带班级」必填（多个用逗号分隔）' };
  if (email && email.indexOf('@') < 0) return { error: `邮箱格式不正确：${email}` };

  return {
    data: {
      username, password, realName, role, subject, grade, headClass, subjectClasses, phone, email,
      classNames: role === 'head_teacher' ? [headClass] : subjectClasses,
    },
  };
}

// ---------- 学年 / 年级 / 班级 ----------
async function currentYear(q) {
  const r = await q("SELECT value FROM system_settings WHERE key = 'current_academic_year'");
  return (r.rows[0] && r.rows[0].value) || '2026-2027';
}

// 确保年级存在（不存在则创建）；返回 { id, created }
async function ensureGrade(q, gradeName, year, created) {
  const found = await q(
    `SELECT id FROM grades WHERE grade_name = $1 AND (academic_year = $2 OR academic_year IS NULL)
      ORDER BY (academic_year = $2) DESC NULLS LAST, id LIMIT 1`,
    [gradeName, year]
  );
  if (found.rowCount > 0) return { id: found.rows[0].id, created: false };
  const ins = await q(
    `INSERT INTO grades (grade_name, grade_code, academic_year, sort_order) VALUES ($1, '', $2, 0) RETURNING id`,
    [gradeName, year]
  );
  created.grades.push(gradeName);
  return { id: ins.rows[0].id, created: true };
}

// 确保班级存在（不存在则创建）；返回 { id, created }
async function ensureClass(q, className, gradeId, gradeName, year, created) {
  const found = await q(
    `SELECT id FROM classes WHERE class_name = $1 AND grade_id = $2 AND (academic_year = $3 OR academic_year IS NULL)
      ORDER BY (academic_year = $3) DESC NULLS LAST, id LIMIT 1`,
    [className, gradeId, year]
  );
  if (found.rowCount > 0) return { id: found.rows[0].id, created: false };
  const ins = await q(
    `INSERT INTO classes (class_name, grade, grade_id, academic_year, status) VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (class_name, grade_id, academic_year) DO NOTHING RETURNING id`,
    [className, gradeName, gradeId, year]
  );
  if (ins.rowCount === 0) {
    const again = await q(
      'SELECT id FROM classes WHERE class_name = $1 AND grade_id = $2 AND academic_year = $3 LIMIT 1',
      [className, gradeId, year]
    );
    return { id: again.rows[0] ? again.rows[0].id : null, created: false };
  }
  created.classes.push(`${gradeName} ${className}`);
  return { id: ins.rows[0].id, created: true };
}

// 只读探测（dryRun 预览用）：班级是否存在、将自动创建哪些
async function probeRow(data, year) {
  const q = pool.query.bind(pool);
  const plan = { newGrades: [], newClasses: [] };
  const g = await q(
    `SELECT id FROM grades WHERE grade_name = $1 AND (academic_year = $2 OR academic_year IS NULL) LIMIT 1`,
    [data.grade, year]
  );
  if (g.rowCount === 0) plan.newGrades.push(data.grade);
  const gradeId = g.rowCount > 0 ? g.rows[0].id : null;
  for (const cn of data.classNames) {
    if (!gradeId) { plan.newClasses.push(`${data.grade} ${cn}`); continue; }
    const c = await q(
      `SELECT id FROM classes WHERE class_name = $1 AND grade_id = $2 AND (academic_year = $3 OR academic_year IS NULL) LIMIT 1`,
      [cn, gradeId, year]
    );
    if (c.rowCount === 0) plan.newClasses.push(`${data.grade} ${cn}`);
  }
  const dup = await q('SELECT id FROM users WHERE username = $1 LIMIT 1', [data.username]);
  return { plan, usernameExists: dup.rowCount > 0 };
}

// ---------- 导入主流程 ----------
async function importTeachers(buffer, { dryRun = false } = {}) {
  const rows = parseRows(buffer);
  if (rows.length === 0) {
    throw new Error('未识别到导入数据：请使用标准模板（表头需包含 用户名/密码/真实姓名/角色/所教学科/年级 等列）');
  }
  const created = { teachers: [], classes: [], grades: [] };
  const results = [];
  const year = await currentYear(pool.query.bind(pool));

  for (const { row, raw } of rows) {
    const v = validateRow(raw);
    if (v.error) {
      results.push({ row, username: str(raw['用户名']), name: str(raw['真实姓名']), ok: false, error: v.error });
      continue;
    }
    const data = v.data;

    if (dryRun) {
      const probe = await probeRow(data, year);
      if (probe.usernameExists) {
        results.push({ row, username: data.username, name: data.realName, role: ROLE_LABEL[data.role], ok: false, error: '用户名已存在（导入时会跳过）' });
        continue;
      }
      results.push({
        row, username: data.username, name: data.realName, role: ROLE_LABEL[data.role], subject: data.subject, grade: data.grade,
        classes: data.classNames, ok: true,
        plan: { newGrades: probe.plan.newGrades, newClasses: probe.plan.newClasses },
      });
      continue;
    }

    const client = await pool.connect();
    try {
      const dup = await pool.query('SELECT id FROM users WHERE username = $1 LIMIT 1', [data.username]);
      if (dup.rowCount > 0) {
        results.push({ row, username: data.username, name: data.realName, role: ROLE_LABEL[data.role], ok: false, error: '用户名已存在' });
        continue;
      }
      // 年级/班级先建（独立提交）：saveTeacherClasses 内部用连接池校验班级存在性，
      // 若放在未提交的事务里会因其它连接看不到而误报"班级不存在"
      const rowCreated = { classes: [], grades: [] };
      const g = await ensureGrade(pool.query.bind(pool), data.grade, year, rowCreated);
      const classIds = [];
      for (const cn of data.classNames) {
        const c = await ensureClass(pool.query.bind(pool), cn, g.id, data.grade, year, rowCreated);
        if (!c.id) throw new Error(`班级「${cn}」创建失败`);
        classIds.push({ classId: c.id, className: cn });
      }

      // 账号 + 带班记录放一个事务：失败则整行回滚（自动创建的班级保留，属"空班"无害）
      await client.query('BEGIN');
      const q = client.query.bind(client);
      const primary = classIds[0] ? classIds[0].classId : null;
      const roles = data.role === 'head_teacher' ? ['head_teacher'] : ['subject_teacher'];
      const ins = await q(
        `INSERT INTO users (username, password, role, class_id, academic_year, real_name, display_name,
                            is_active, must_change_password, roles, subject, profile_locked, phone, email)
         VALUES ($1,$2,'teacher',$3,$4,$5,$5,true,false,$6::json,$7,true,$8,$9) RETURNING id`,
        [data.username, data.password, primary, year, data.realName, JSON.stringify(roles), data.subject,
          data.phone || null, data.email || null]
      );
      const userId = ins.rows[0].id;
      const saved = await saveTeacherClasses(userId, classIds.map((c) => ({
        classId: c.classId,
        roleInClass: data.role,
        subject: data.role === 'subject_teacher' ? data.subject : null,
      })), client);
      if (saved.error) throw new Error(saved.error);
      await syncHeadTeacherFromClasses(userId, client);
      await client.query('COMMIT');
      created.teachers.push(data.username);
      created.classes.push(...rowCreated.classes);
      created.grades.push(...rowCreated.grades);
      results.push({
        row, username: data.username, name: data.realName, role: ROLE_LABEL[data.role], subject: data.subject,
        grade: data.grade, classes: data.classNames, ok: true, userId,
        createdClasses: rowCreated.classes, createdGrades: rowCreated.grades,
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      results.push({ row, username: data.username, name: data.realName, role: ROLE_LABEL[data.role], ok: false, error: e.message || '导入失败' });
    } finally {
      client.release();
    }
  }

  const success = results.filter((x) => x.ok).length;
  return {
    dryRun: !!dryRun,
    total: results.length,
    success,
    failed: results.length - success,
    created,
    results,
    errors: results.filter((x) => !x.ok).map((x) => `第 ${x.row} 行 ${x.username || '(空)'}：${x.error}`),
  };
}

module.exports = {
  COLUMNS,
  EXAMPLE_ROWS,
  ROLE_ALIAS,
  buildTemplateBuffer,
  parseRows,
  validateRow,
  importTeachers,
};
