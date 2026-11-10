// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// ============================================================
// 考勤分析「场次归属」测试（BUG 修复：统计某班时把别班专属场次/全校场次都算了进来）
//   规则（方案 A / v33 统一口径）：场次归属 = attendance_sessions.class_id（不再从来源计划推导）
//     · class_id IS NULL（全校场次，如历史"全部班级"计划 / 校级发起）→ 所有班级都计入
//     · class_id = 本班 → 只有该班计入（别班专属不再计入）
//   另外返回"本班无签到记录的场次"（已计入应到，但该场本班未录入）
// 夹具：2 个临时年级/班级 + 学生 + 4 个场次（全校/本班专属/别班专属/全校未录入）+ 对应计划，
//       放在一个"没有真实签到数据的历史月份"里，测完清理并断言真实数据未变
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
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data, setc: res.headers.get('set-cookie') || '' };
}
async function login(u, p) {
  // admin 的密码可能被管理员改过 → 用环境变量 DSH_ADMIN_PW（默认 123456）；夹具账号固定 123456
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('login ' + u + ' failed: ' + r.status);
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}

const TAG = String(Date.now()).slice(-6);
const G1 = '范围测试年级A' + TAG;
const G2 = '范围测试年级B' + TAG;
const C1 = '范围测试A班' + TAG;
const C2 = '范围测试B班' + TAG;
const created = { gradeIds: [], classIds: [], studentIds: [], sessionIds: [], planIds: [] };
let RANGE = null; // { startDate, endDate, date }

async function cleanup() {
  if (created.sessionIds.length) {
    await pg.query('DELETE FROM attendance_records WHERE session_id = ANY($1::int[])', [created.sessionIds]).catch(() => {});
  }
  if (created.studentIds.length) {
    await pg.query('DELETE FROM attendance_records WHERE student_id = ANY($1::int[])', [created.studentIds]).catch(() => {});
  }
  if (created.planIds.length) await pg.query('DELETE FROM attendance_plans WHERE id = ANY($1::int[])', [created.planIds]).catch(() => {});
  if (created.sessionIds.length) await pg.query('DELETE FROM attendance_sessions WHERE id = ANY($1::int[])', [created.sessionIds]).catch(() => {});
  if (created.studentIds.length) await pg.query('DELETE FROM students WHERE id = ANY($1::int[])', [created.studentIds]).catch(() => {});
  if (created.classIds.length) await pg.query('SELECT purge_class(id) FROM classes WHERE id = ANY($1::int[])', [created.classIds]).catch(() => {});
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name = ANY($1::text[])', [[C1, C2]]).catch(() => {});
  if (created.gradeIds.length) await pg.query('DELETE FROM grades WHERE id = ANY($1::int[])', [created.gradeIds]).catch(() => {});
  await pg.query('DELETE FROM grades WHERE grade_name = ANY($1::text[])', [[G1, G2]]).catch(() => {});
}

(async () => {
  try {
    await cleanup();
    const base = {
      sessions: (await pg.query('SELECT count(*)::int n FROM attendance_sessions')).rows[0].n,
      plans: (await pg.query('SELECT count(*)::int n FROM attendance_plans')).rows[0].n,
      records: (await pg.query('SELECT count(*)::int n FROM attendance_records')).rows[0].n,
      students: (await pg.query('SELECT count(*)::int n FROM students')).rows[0].n,
    };
    const cAdmin = await login('admin');

    // 选一个"没有任何真实场次"的历史月份放夹具，避免真实数据干扰计数
    let picked = null;
    for (const m of ['01', '02', '03', '04', '05', '06']) {
      const mm = `2026-${m}`;
      const n = (await pg.query(
        "SELECT count(*)::int n FROM attendance_sessions WHERE start_time >= $1::date AND start_time < ($1::date + interval '1 month')",
        [mm + '-01']
      )).rows[0].n;
      if (n === 0) { picked = mm; break; }
    }
    if (!picked) throw new Error('找不到无历史场次的月份用于夹具');
    RANGE = { ym: picked, startDate: picked + '-01', endDate: picked + '-28', date: picked + '-10' };
    console.log(`  · 夹具月份：${RANGE.ym}（该月无真实场次）`);

    // 夹具：两个年级/班级 + 学生
    const mkGrade = async (name) => {
      const r = await pg.query('INSERT INTO grades (grade_name, grade_code, academic_year) VALUES ($1,$2,$3) RETURNING id', [name, 'SCP', '2025-2026']);
      created.gradeIds.push(r.rows[0].id);
      return r.rows[0].id;
    };
    const g1 = await mkGrade(G1);
    const g2 = await mkGrade(G2);
    const mkClass = async (name, gradeId, gradeName) => {
      const r = await pg.query('INSERT INTO classes (class_name, grade, grade_id, academic_year, status) VALUES ($1,$2,$3,$4,$5) RETURNING id', [name, gradeName, gradeId, '2025-2026', 'active']);
      created.classIds.push(r.rows[0].id);
      return r.rows[0].id;
    };
    const c1 = await mkClass(C1, g1, G1);
    const c2 = await mkClass(C2, g2, G2);
    const mkStudent = async (no, name, classId) => {
      const r = await pg.query(
        "INSERT INTO students (student_no, name, class_id, status, is_active) VALUES ($1,$2,$3,'在读',true) RETURNING id",
        [no, name, classId]
      );
      created.studentIds.push(r.rows[0].id);
      return r.rows[0].id;
    };
    const a1 = await mkStudent('SCP' + TAG + '01', '范围甲一', c1);
    const a2 = await mkStudent('SCP' + TAG + '02', '范围甲二', c1);
    const b1 = await mkStudent('SCP' + TAG + '03', '范围乙一', c2);
    check('1) 夹具创建完成（2 班级 3 学生）', !!(c1 && c2 && a1 && a2 && b1));

    // 夹具：3 个已结束场次（方案 A / v33：场次归属的唯一真源 = attendance_sessions.class_id）
    //   S_shared  class_id IS NULL（全校） → A/B 都应计入（A 班有记录）
    //   S_own     class_id = 甲班        → 只有 A 计入（A 有记录）
    //   S_other   class_id = 乙班        → 只有 B 计入（A 不应计入）
    //   S_miss    class_id IS NULL（全校）→ A 班无任何记录（用于"未录入场次"提示）
    const mkSession = async (time, durMin, classId = null) => {
      const r = await pg.query(
        `INSERT INTO attendance_sessions (start_time, deadline, status, class_id)
         VALUES ($1::date + $2::time, $1::date + $2::time + ($3 || ' minutes')::interval, 'closed', $4) RETURNING id`,
        [RANGE.date, time, String(durMin), classId]
      );
      created.sessionIds.push(r.rows[0].id);
      return r.rows[0].id;
    };
    const mkPlan = async (classId, time, durMin, sessionId) => {
      const r = await pg.query(
        `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, status, session_id, class_id)
         VALUES ($1::date, $2::time, $3, 'ended', $4, $5) RETURNING id`,
        [RANGE.date, time, durMin, sessionId, classId]
      );
      created.planIds.push(r.rows[0].id);
      return r.rows[0].id;
    };
    const sShared = await mkSession('08:00', 10, null);
    await mkPlan(null, '08:00', 10, sShared);
    const sOwn = await mkSession('09:00', 10, c1);
    await mkPlan(c1, '09:00', 10, sOwn);
    const sOther = await mkSession('10:00', 10, c2);
    await mkPlan(c2, '10:00', 10, sOther);
    const sMiss = await mkSession('11:00', 10, null);
    await mkPlan(null, '11:00', 10, sMiss);

    const mkRec = async (sessionId, studentId, status) => {
      await pg.query('INSERT INTO attendance_records (session_id, student_id, status) VALUES ($1,$2,$3)', [sessionId, studentId, status]);
    };
    await mkRec(sShared, a1, 'present');
    await mkRec(sShared, a2, 'present');
    await mkRec(sShared, b1, 'present');
    await mkRec(sOwn, a1, 'present');
    await mkRec(sOwn, a2, 'present');
    await mkRec(sOther, b1, 'present');
    // S_miss 故意不给 A 班任何记录
    check('2) 场次与记录夹具创建完成（共享/本班专属/别班专属/本班未录入）', created.sessionIds.length === 4);

    const q = (extra) => `/api/attendance/analysis/overview?startDate=${RANGE.startDate}&endDate=${RANGE.endDate}${extra}`;

    // 3) A 班：只算 共享 + 本班专属（3 场：shared/own/miss），不含别班专属
    let r = await api(q('&classId=' + c1), { cookie: cAdmin });
    check('3) A 班场次 = 共享 + 本班专属（不含 B 班专属）→ 3 场',
      r.status === 200 && r.data.totalSessions === 3, r.data);
    check('3) A 班学生数 = 2、应到 = 3×2 = 6', r.data.totalStudents === 2 && r.data.expected === 6,
      { s: r.data.totalStudents, e: r.data.expected });
    check('3) A 班实到 = 共享 2 条 + 本班专属 2 条 = 4', r.data.attended === 4, r.data.attended);
    check('3) A 班「本班无记录场次」= 1（11:00 那场）',
      r.data.sessionsWithoutRecords === 1 && r.data.sessionsWithRecords === 2 &&
      r.data.missingSessions.length === 1 && r.data.missingSessions[0].at.endsWith('11:00'),
      { miss: r.data.sessionsWithoutRecords, list: r.data.missingSessions });

    // 4) B 班：共享 2 场（08:00 有记录 + 11:00 未录入）+ B 班专属 1 场，不含 A 班专属
    r = await api(q('&classId=' + c2), { cookie: cAdmin });
    check('4) B 班场次 = 共享 2 场 + 本班专属 1 场（不含 A 班专属）→ 3 场',
      r.status === 200 && r.data.totalSessions === 3, r.data);
    check('4) B 班学生数=1、应到=3、实到=2、缺勤=1',
      r.data.totalStudents === 1 && r.data.expected === 3 && r.data.attended === 2 && r.data.absent === 1, r.data);
    check('4) B 班本班无记录场次 = 1（11:00 共享场次，B 也未录入）',
      r.data.sessionsWithoutRecords === 1 && r.data.missingSessions[0].at.endsWith('11:00'), r.data.missingSessions);

    // 5) 年级筛选：A 年级 → 与 A 班一致
    r = await api(q('&grade=' + encodeURIComponent(G1)), { cookie: cAdmin });
    check('5) 年级筛选（A 年级）场次 = 3，学生 = 2', r.data.totalSessions === 3 && r.data.totalStudents === 2, r.data);

    // 6) 管理员不限班级：共享 2 + A 专属 + B 专属 = 4 场
    r = await api(q(''), { cookie: cAdmin });
    check('6) 不限班级（管理员）场次 = 4（全部夹具场次）', r.data.totalSessions === 4, r.data);

    // 7) 真实数据回归：班级 1（高三1班）场次口径 = "本班专属 + 全部班级"，学生数取自库内当前真实值
    //    （原断言把学生数写死为 16，真实数据一变即误报 —— 改为与库内口径比对，断言仍然有效）
    r = await api('/api/attendance/analysis/overview?startDate=2026-09-01&endDate=2026-09-30&classId=1', { cookie: cAdmin });
    const real1 = r.data;
    const expect1 = (await pg.query(
      `SELECT count(*)::int n FROM attendance_sessions s
        WHERE s.status='closed' AND s.start_time >= '2026-09-01' AND s.start_time < '2026-10-01' AND s.start_time <= now()
          AND (s.class_id IS NULL OR s.class_id = 1)`
    )).rows[0].n;
    const expectStu1 = (await pg.query(
      "SELECT count(*)::int n FROM students WHERE class_id = 1 AND is_active = true AND status = '在读'"
    )).rows[0].n;
    check('7) 真实数据：高三1班场次 = 本班专属 + 全部班级（' + expect1 + ' 场）',
      real1.totalSessions === expect1, { api: real1.totalSessions, db: expect1 });
    check('7) 真实数据：高三1班在读学生 ' + expectStu1 + ' 人、应到 = 场次×学生数',
      real1.totalStudents === expectStu1 && real1.expected === real1.totalSessions * expectStu1,
      { s: real1.totalStudents, expectStu: expectStu1, e: real1.expected });
    check('7) 真实数据：返回"本班无记录场次"数量与明细',
      typeof real1.sessionsWithoutRecords === 'number' && Array.isArray(real1.missingSessions) &&
      real1.sessionsWithRecords + real1.sessionsWithoutRecords === real1.totalSessions, real1.missingSessions);

    // ---------- 清理与真实数据核对 ----------
    await cleanup();
    const after = {
      sessions: (await pg.query('SELECT count(*)::int n FROM attendance_sessions')).rows[0].n,
      plans: (await pg.query('SELECT count(*)::int n FROM attendance_plans')).rows[0].n,
      records: (await pg.query('SELECT count(*)::int n FROM attendance_records')).rows[0].n,
      students: (await pg.query('SELECT count(*)::int n FROM students')).rows[0].n,
    };
    check('8) 真实数据未变（sessions/plans/records/students）',
      base.sessions === after.sessions && base.plans === after.plans && base.records === after.records && base.students === after.students,
      { base, after });
    check('8) 夹具已清理（无残留班级/学生/场次）',
      (await pg.query('SELECT count(*)::int n FROM classes WHERE class_name = ANY($1::text[])', [[C1, C2]])).rows[0].n === 0 &&
      (await pg.query('SELECT count(*)::int n FROM students WHERE student_no LIKE $1', ['SCP' + TAG + '%'])).rows[0].n === 0 &&
      (await pg.query('SELECT count(*)::int n FROM attendance_sessions WHERE id = ANY($1::int[])', [created.sessionIds])).rows[0].n === 0);
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
