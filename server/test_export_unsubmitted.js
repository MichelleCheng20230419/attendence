// ============================================================
// 班主任端「导出未交统计」（某学科 × 日期范围 → Excel）—— 服务端测试
//   需求：班主任选学科 + 日期范围后导出 Excel：
//     第一列 学生姓名 → 中间列 日期范围内每一天（MM-DD 横向）→ 最后一列 未提交总次数
//     ✅ 已提交 / ❌ 未提交 / — 当天没有该学科作业（或该天未录入，不计入次数）
//     按未交次数降序；底部一行「全班未交人数」；文件名 班级-学科-未交统计-起至止.xlsx
//   验证点：按钮接口存在 / 参数与权限 / 表格结构 / 符号与排序 / 无作业日期为 — / 文件名正确
//   夹具：1 年级 + 2 班（甲 4 人 / 乙 1 人）+ 班主任 + 任课老师(数学) + 班长 + 学生；测完自愈清理
// 用法：node test_export_unsubmitted.js（需服务已启动；管理员密码取 DSH_ADMIN_PW）
// ============================================================
'use strict';
const { Pool } = require('pg');
const XLSX = require('xlsx');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + p, { method, headers, redirect: 'manual', body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('application/json')) { try { data = await res.json(); } catch (_) {} }
  return { status: res.status, data, ctype: ct, cd: res.headers.get('content-disposition') || '', setc: res.headers.get('set-cookie') || '' };
}
async function apiBuf(p, cookie) {
  const res = await fetch(BASE + p, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
  const buf = res.headers.get('content-type') && res.headers.get('content-type').includes('spreadsheet')
    ? Buffer.from(await res.arrayBuffer()) : null;
  return { status: res.status, ctype: res.headers.get('content-type') || '', cd: res.headers.get('content-disposition') || '', buf };
}
function sheetAoa(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}
async function login(u, p) {
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('登录失败 ' + u + ': ' + r.status);
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}
const n1 = async (sql, params = []) => (await pg.query(sql, params)).rows[0].n;

const TAG = String(Date.now()).slice(-6);
const GRADE = '未交年级' + TAG;
const CA = '未交甲班' + TAG, CB = '未交乙班' + TAG;
const PRE = 'uns_' + TAG + '_';
const created = { gradeId: null, classIds: [], userIds: [], studentIds: [], taskIds: [] };
const today = new Date();
const dstr = (offsetDays) => {
  const d = new Date(today.getTime() + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// 固定 7 天窗口（含今天）：D0=6 天前 … D6=今天
const D = [-6, -5, -4, -3, -2, -1, 0].map(dstr);
const FROM = D[0], TO = D[6];

async function cleanup() {
  const cids = (await pg.query('SELECT id FROM classes WHERE class_name = ANY($1::text[])', [[CA, CB]])).rows.map((r) => r.id);
  if (cids.length) {
    await pg.query('DELETE FROM homework_submissions WHERE task_id IN (SELECT id FROM homework_tasks WHERE class_id = ANY($1::int[]))', [cids]).catch(() => {});
    await pg.query('DELETE FROM homework_tasks WHERE class_id = ANY($1::int[])', [cids]).catch(() => {});
  }
  const uids = (await pg.query('SELECT id FROM users WHERE username LIKE $1', [PRE + '%'])).rows.map((r) => r.id);
  if (uids.length) {
    await pg.query('UPDATE classes SET head_teacher_id = NULL, teacher_id = NULL WHERE head_teacher_id = ANY($1::int[]) OR teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM teacher_classes WHERE teacher_id = ANY($1::int[])', [uids]).catch(() => {});
    await pg.query('DELETE FROM users WHERE id = ANY($1::int[])', [uids]).catch(() => {});
  }
  await pg.query("DELETE FROM students WHERE student_no LIKE 'UNS%'").catch(() => {});
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name = ANY($1::text[])', [[CA, CB]]).catch(() => {});
  await pg.query('DELETE FROM grades WHERE grade_name = $1', [GRADE]).catch(() => {});
}

(async () => {
  try {
    await cleanup();
    const base = { tasks: await n1('SELECT count(*)::int n FROM homework_tasks'), subs: await n1('SELECT count(*)::int n FROM homework_submissions') };
    const admin = await login('admin');

    // ---------- 夹具 ----------
    const year = (await api('/api/settings', { cookie: admin })).data.currentAcademicYear;
    created.gradeId = (await api('/api/grades', { method: 'POST', cookie: admin, body: { gradeName: GRADE, gradeCode: 'UNS', academicYear: year } })).data.id;
    const mkClass = async (name) => (await api('/api/classes', { method: 'POST', cookie: admin, body: { className: name, gradeName: GRADE, academicYear: year } })).data.id;
    const ca = await mkClass(CA), cb = await mkClass(CB);
    created.classIds = [ca, cb];
    const mkStudents = async (classId, n, prefix) => {
      const out = [];
      for (let i = 1; i <= n; i += 1) {
        const r = await api('/api/students', { method: 'POST', cookie: admin, body: { studentNo: prefix + TAG + String(i).padStart(2, '0'), name: prefix + '同学' + i, classId, status: '在读' } });
        const id = r.data && (r.data.student ? r.data.student.id : r.data.id);
        if (id) { out.push(id); created.studentIds.push(id); }
      }
      return out;
    };
    const A = await mkStudents(ca, 4, 'UNSA');   // 甲班 4 人
    const B = await mkStudents(cb, 1, 'UNSB');   // 乙班 1 人
    const mkUser = async (uname, role, realName, classId, extra = {}) => {
      const r = await api('/api/users', { method: 'POST', cookie: admin, body: { username: uname, password: '123456', role, realName, classId, mustChangePassword: false, profileLocked: true, force: true, ...extra } });
      if (r.status !== 201) throw new Error('创建账号失败 ' + uname + ': ' + JSON.stringify(r.data));
      created.userIds.push(r.data.user.id);
      return r.data.user.id;
    };
    const headId = await mkUser(PRE + 'head', 'teacher', '未交班主任', ca, { subject: '数学', teachingClasses: [{ classId: ca, roleInClass: 'head_teacher' }] });
    await mkUser(PRE + 'subj', 'teacher', '未交任课', ca, { subject: '数学', teachingClasses: [{ classId: ca, roleInClass: 'subject_teacher' }] });
    await mkUser(PRE + 'other', 'teacher', '未交他科', ca, { subject: '语文', teachingClasses: [{ classId: ca, roleInClass: 'subject_teacher' }] });
    await mkUser(PRE + 'mon', 'monitor', '未交班长', ca);
    const stuId = await mkUser(PRE + 'stu', 'student', '未交学生', ca);
    await pg.query('UPDATE classes SET head_teacher_id = $2 WHERE id = $1', [ca, headId]);
    const head = await login(PRE + 'head'), subj = await login(PRE + 'subj'), other = await login(PRE + 'other');
    const mon = await login(PRE + 'mon'), stu = await login(PRE + 'stu');
    check('0) 夹具就绪（甲 4 人 / 乙 1 人；班主任+数学任课+语文任课+班长+学生）',
      A.length === 4 && B.length === 1 && !!head && !!subj && !!other && !!mon && !!stu, { a: A.length, b: B.length });

    // ---------- 1) 造数据：数学作业 7 天（D0..D6），其中 D2 无作业、D4 未录入 ----------
    //   提交矩阵（甲班 4 人；✅=已交 ❌=未交；想验证降序排序与 ⚠ 标记）
    //   A1: 全交（0 次）           A2: D1/D3 未交（2 次）
    //   A3: D0/D1/D3 未交（3 次→⚠） A4: 1 次
    const mkTask = async (classId, subject, title, date, createdBy) => {
      const r = await pg.query(
        `INSERT INTO homework_tasks (class_id, subject, title, date, deadline, created_by, is_daily)
         VALUES ($1, $2, $3, $4::date, ($4::date + time '23:59'), $5, false) RETURNING id`,
        [classId, subject, title, date, createdBy]
      );
      created.taskIds.push(r.rows[0].id);
      return r.rows[0].id;
    };
    const noTaskDays = new Set([D[2]]);          // D2 没有数学作业
    const unrecordedDays = new Set([D[4]]);      // D4 有作业但未录入
    const subMatrix = { 0: [true, true, false, true], 1: [true, false, false, true], 2: null, 3: [true, false, false, true], 4: null, 5: [true, true, false, true], 6: [true, true, true, true] };
    const taskByDay = {};
    for (let i = 0; i < D.length; i += 1) {
      if (noTaskDays.has(D[i])) continue;
      const tid = await mkTask(ca, '数学', '今日作业', D[i], headId);
      taskByDay[D[i]] = tid;
      if (unrecordedDays.has(D[i])) continue;    // 未录入：不写任何提交记录
      for (let k = 0; k < A.length; k += 1) {
        await pg.query(
          `INSERT INTO homework_submissions (task_id, student_id, is_submitted) VALUES ($1, $2, $3)
           ON CONFLICT (task_id, student_id) DO UPDATE SET is_submitted = EXCLUDED.is_submitted`,
          [tid, A[k], subMatrix[i][k]]
        );
      }
    }
    // 乙班也造一条数学作业（用于验证"别班数据不出现在甲班导出里"）
    const tB = await mkTask(cb, '数学', '今日作业', D[6], headId);
    await pg.query('INSERT INTO homework_submissions (task_id, student_id, is_submitted) VALUES ($1, $2, false)', [tB, B[0]]);
    check('1) 夹具数据就绪（甲班 6 天数学作业：1 天无作业、1 天未录入；乙班 1 天）',
      Object.keys(taskByDay).length === 6 && !!tB, Object.keys(taskByDay).length);

    // ---------- 2) 权限 ----------
    console.log('2) 权限与参数校验:');
    const q = `classId=${ca}&subject=${encodeURIComponent('数学')}&from=${FROM}&to=${TO}`;
    check('2) 班长导出 → 403（与作业导出口径一致：仅老师/管理员）', (await api('/api/homework/export-unsubmitted?' + q, { cookie: mon })).status === 403);
    check('2) 学生导出 → 403', (await api('/api/homework/export-unsubmitted?' + q, { cookie: stu })).status === 403);
    check('2) 未登录 → 401', (await api('/api/homework/export-unsubmitted?' + q)).status === 401);
    check('2) 老师导出别班 → 403', (await api(`/api/homework/export-unsubmitted?classId=${cb}&subject=${encodeURIComponent('数学')}&from=${FROM}&to=${TO}`, { cookie: head })).status === 403);
    check('2) 任课老师导出非本学科（语文老师导数学）→ 403',
      (await api('/api/homework/export-unsubmitted?' + q, { cookie: other })).status === 403);
    check('2) 任课老师导出本学科（数学）→ 200',
      (await api('/api/homework/export-unsubmitted?' + q, { cookie: subj })).status === 200);
    check('2) 缺少班级 → 400', (await api(`/api/homework/export-unsubmitted?subject=${encodeURIComponent('数学')}&from=${FROM}&to=${TO}`, { cookie: head })).status === 400);
    check('2) 缺少学科 → 400', (await api(`/api/homework/export-unsubmitted?classId=${ca}&from=${FROM}&to=${TO}`, { cookie: head })).status === 400);
    check('2) 学科无效 → 400', (await api(`/api/homework/export-unsubmitted?classId=${ca}&subject=不存在&from=${FROM}&to=${TO}`, { cookie: head })).status === 400);
    check('2) 日期格式错误 → 400', (await api(`/api/homework/export-unsubmitted?classId=${ca}&subject=${encodeURIComponent('数学')}&from=2026-13-45&to=${TO}`, { cookie: head })).status === 400);
    check('2) 起止颠倒 → 400', (await api(`/api/homework/export-unsubmitted?classId=${ca}&subject=${encodeURIComponent('数学')}&from=${TO}&to=${FROM}`, { cookie: head })).status === 400);
    check('2) 范围超过 120 天 → 400', (await api(`/api/homework/export-unsubmitted?classId=${ca}&subject=${encodeURIComponent('数学')}&from=2020-01-01&to=${TO}`, { cookie: head })).status === 400);
    check('2) 兼容 class_id / start_date / end_date 参数名',
      (await api(`/api/homework/export-unsubmitted?class_id=${ca}&subject=${encodeURIComponent('数学')}&start_date=${FROM}&end_date=${TO}`, { cookie: head })).status === 200);

    // ---------- 3) 导出内容 ----------
    console.log('3) 导出内容:');
    const r = await apiBuf('/api/homework/export-unsubmitted?' + q, head);
    check('3) 返回 xlsx（content-type 正确）', r.status === 200 && r.ctype.includes('spreadsheet'), { status: r.status, ctype: r.ctype });
    const fnameWant = `${CA}-数学-未交统计-${FROM}至${TO}.xlsx`;
    check('3) 文件名 = 班级-学科-未交统计-起至止.xlsx',
      decodeURIComponent(r.cd).includes(fnameWant), r.cd);
    const aoa = sheetAoa(r.buf);
    const header = aoa[2] || [];
    check('3) 第 1 列 = 学生姓名；中间列 = 所选范围内的每一天（MM-DD，共 7 天）；最后一列 = 未提交总次数',
      header[0] === '学生姓名' && header[header.length - 1] === '未提交总次数' &&
      header.length === 1 + D.length + 1 &&
      JSON.stringify(header.slice(1, -1)) === JSON.stringify(D.map((d) => d.slice(5))),
      header);
    check('3) 标题行含「班级-学科-未交统计」', new RegExp(`${CA}-数学-未交统计`).test(String(aoa[0][0])), aoa[0]);
    const dataRows = aoa.slice(3).filter((row) => row[0] && !/全班未交人数|图例|未交次数/.test(String(row[0])));
    check('3) 数据行 = 本班 4 名学生（不含乙班学生）',
      dataRows.length === 4 && !dataRows.some((row) => String(row[0]).includes('UNSB')), dataRows.map((x) => x[0]));
    const missOf = (row) => Number(String(row[row.length - 1]).replace(/[^\d]/g, ''));
    // 夹具矩阵：A3 未交 4 次（D0/D1/D3/D5）、A2 未交 2 次（D1/D3）、A1/A4 全交
    check('3) 按未交次数降序：' + dataRows.map((x) => `${x[0]}:${missOf(x)}`).join(' '),
      missOf(dataRows[0]) === 4 && missOf(dataRows[1]) === 2 && missOf(dataRows[2]) === 0 && missOf(dataRows[3]) === 0,
      dataRows.map((x) => [x[0], missOf(x)]));
    check('3) 未交 ≥3 的用 ⚠ 标记', /⚠/.test(String(dataRows[0][dataRows[0].length - 1])), dataRows[0]);
    // 逐格核对：未交次数 = ❌ 的个数
    const gridOK = dataRows.every((row) => {
      const cells = row.slice(1, -1);
      const marks = cells.filter((c) => c === '❌').length;
      return marks === missOf(row) && cells.every((c) => ['✅', '❌', '—'].includes(String(c)));
    });
    check('3) 每格只有 ✅/❌/—，且"未交次数" = ❌ 个数', gridOK, dataRows.map((x) => [x[0], x.slice(1, -1)]));
    // "没有作业记录的那一天" → —
    const noTaskCol = header.indexOf(D[2].slice(5));
    check('3) 没有该学科作业的那一天（' + D[2].slice(5) + '）全部显示 —',
      noTaskCol > 0 && dataRows.every((row) => row[noTaskCol] === '—'),
      { col: noTaskCol, cells: dataRows.map((row) => row[noTaskCol]) });
    // 未录入的那一天 → —
    const unrecCol = header.indexOf(D[4].slice(5));
    check('3) 有作业但未录入的那一天（' + D[4].slice(5) + '）显示 — 且不计入未交次数',
      unrecCol > 0 && dataRows.every((row) => row[unrecCol] === '—') &&
      dataRows.every((row) => missOf(row) === (row.filter ? row.slice(1, -1).filter((c) => c === '❌').length : 0)),
      { col: unrecCol, cells: dataRows.map((row) => row[unrecCol]) });
    // 合计行：每天全班未交人数
    const totalRow = aoa.find((row) => String(row[0]) === '全班未交人数');
    const expectTotals = D.map((d, i) => {
      if (noTaskDays.has(d) || unrecordedDays.has(d)) return '—';
      return subMatrix[i].filter((x) => x === false).length;
    });
    check('3) 底部有「全班未交人数」合计行，数值与提交矩阵一致（' + expectTotals.join(',') + '）',
      !!totalRow && JSON.stringify(D.map((d) => totalRow[header.indexOf(d.slice(5))])) === JSON.stringify(expectTotals),
      totalRow && D.map((d) => totalRow[header.indexOf(d.slice(5))]));
    check('3) 表内有图例（✅/❌/— 含义）',
      aoa.some((row) => /图例/.test(String(row[0])) && /已提交/.test(String(row[0]))), aoa.slice(-2));

    // ---------- 4) 边界：范围内没有该学科作业 ----------
    console.log('4) 边界:');
    const r2 = await apiBuf(`/api/homework/export-unsubmitted?classId=${ca}&subject=${encodeURIComponent('化学')}&from=${FROM}&to=${TO}`, head);
    check('4) 该学科范围内没有作业 → 仍返回可用表（日期列全为 —、未交次数 0）',
      r2.status === 200 && (() => {
        const a = sheetAoa(r2.buf);
        const h = a[2] || [];
        const rows = a.slice(3).filter((row) => row[0] && !/全班未交人数|图例|未交次数/.test(String(row[0])));
        return h[0] === '学生姓名' && h[h.length - 1] === '未提交总次数' && h.length === 1 + D.length + 1 &&
          rows.length === 4 && rows.every((row) => row.slice(1, -1).every((c) => c === '—') && Number(String(row[row.length - 1]).replace(/[^\d]/g, '')) === 0);
      })(),
      r2.status);
    const r3 = await apiBuf(`/api/homework/export-unsubmitted?classId=${ca}&subject=${encodeURIComponent('数学')}&from=${D[6]}&to=${D[6]}`, head);
    check('4) 单日范围（只有今天）→ 1 个日期列',
      r3.status === 200 && (() => { const a = sheetAoa(r3.buf); return (a[2] || []).length === 3 && a[2][0] === '学生姓名' && a[2][2] === '未提交总次数'; })(), r3.status);
    check('4) 写入操作日志 homework_export_unsubmitted',
      (await n1("SELECT count(*)::int n FROM operation_logs WHERE action = 'homework_export_unsubmitted'")) >= 1);

    // ---------- 5) 清理与基线 ----------
    console.log('5) 清理与基线核对:');
    await cleanup();
    const after = { tasks: await n1('SELECT count(*)::int n FROM homework_tasks'), subs: await n1('SELECT count(*)::int n FROM homework_submissions') };
    check('5) 真实数据行数回到用例前（作业/提交）', base.tasks === after.tasks && base.subs === after.subs, { base, after });
    check('5) 夹具已清理（账号/班级/学生/作业）',
      (await n1('SELECT count(*)::int n FROM users WHERE username LIKE $1', [PRE + '%'])) === 0 &&
      (await n1('SELECT count(*)::int n FROM classes WHERE class_name = ANY($1::text[])', [[CA, CB]])) === 0 &&
      (await n1("SELECT count(*)::int n FROM students WHERE student_no LIKE 'UNS%'")) === 0);
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
