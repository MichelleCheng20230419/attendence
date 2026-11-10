// 计划触发场次时间回归测试：场次 start_time/deadline 必须等于计划设定时间
// 直接调用导出的 triggerDuePlans / repairActivePlans（无需等待 60 秒调度周期）
const path = require('path');
const attendanceRouter = require(path.join(__dirname, 'src', 'routes', 'attendance'));
const { triggerDuePlans, repairActivePlans } = attendanceRouter;
const { Pool } = require('pg');
const routerPool = require(path.join(__dirname, 'src', 'db')); // 结束它，避免退出时句柄告警
const BASE = 'http://localhost:3000';

const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

const pad = (n) => String(n).padStart(2, '0');
function todayStr(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function hm(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function minutesAgo(m) { return new Date(Date.now() - m * 60000); }

const createdPlans = [];
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const fmtTs = (d) => d ? new Date(d).toISOString() : null;

async function login(u, p) {
  // admin 的密码可能被管理员改过 → 用环境变量 DSH_ADMIN_PW（默认 123456）；夹具账号固定 123456
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: pw }),
  });
  const setc = res.headers.get('set-cookie') || '';
  const m = setc.match(/connect\.sid=([^;]+)/);
  return m ? 'connect.sid=' + m[1] : null;
}
async function statusApi(cookie) {
  const res = await fetch(BASE + '/api/attendance/status', { headers: { Cookie: cookie } });
  let data = null; try { data = await res.json(); } catch (_) {}
  return data;
}
async function addPlan({ startTime, duration, status = 'pending' }) {
  // 唯一约束 (plan_date, start_time, COALESCE(class_id,0))：真实库里可能已有同时间计划
  // （例如某班 07:25/08:00 的计划）→ 插入前逐分钟错开，避免撞唯一键
  const slotTaken = async (time) => {
    const q = await pg.query(
      `SELECT count(*)::int n FROM attendance_plans
        WHERE plan_date = $1::date AND start_time = $2::time AND COALESCE(class_id, 0) = 1`,
      [todayStr(), time]
    );
    return q.rows[0].n > 0;
  };
  const [hh, mm] = startTime.split(':').map(Number);
  let t = startTime;
  for (let i = 0; i < 180 && (hh * 60 + mm + i) < 1440; i++) {
    const mins = hh * 60 + mm + i;
    t = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    if (!(await slotTaken(t))) break;
  }
  const r = await pg.query(
    `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, class_id, status, session_id)
     VALUES ($1, $2, $3, 1, $4, NULL) RETURNING id`,
    [todayStr(), t, duration, status]
  );
  createdPlans.push(r.rows[0].id);
  return r.rows[0].id;
}
async function planRow(id) {
  const r = await pg.query('SELECT id, plan_date, start_time, duration_minutes, status, session_id FROM attendance_plans WHERE id = $1', [id]);
  return r.rows[0] || null;
}
async function sessRow(id) {
  if (!id) return null;
  const r = await pg.query('SELECT id, start_time, deadline, status FROM attendance_sessions WHERE id = $1', [id]);
  return r.rows[0] || null;
}
async function dropSession(sessionId) {
  if (!sessionId) return;
  await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [sessionId]).catch(() => {});
  await pg.query('DELETE FROM attendance_sessions WHERE id = $1', [sessionId]).catch(() => {});
}

(async () => {
  try {
    // 保护：若当前有进行中的场次，测试会触发"关闭旧场次"逻辑，先中止以免影响真实签到
    const act = await pg.query("SELECT id FROM attendance_sessions WHERE status = 'active'");
    if (act.rowCount > 0) {
      console.log(`当前存在进行中的场次 #${act.rows[0].id}，请等其结束后再运行本测试（已中止）`);
      await pg.end().catch(() => {});
      await routerPool.end().catch(() => {});
      process.exitCode = 0;
      return;
    }

    // ========== 用例 1：窗口内触发 → 场次时间 = 计划时间，状态 active ==========
    const t1 = minutesAgo(2);
    const planA = await addPlan({ startTime: hm(t1), duration: 10 });
    await triggerDuePlans();
    const pA = await planRow(planA);
    const sA = await sessRow(pA.session_id);
    check('1) 计划A 已触发为 active', pA.status === 'active' && !!pA.session_id, pA);
    check('1) 场次 start_time = 计划时间',
      !!sA && fmtTs(sA.start_time) === fmtTs(`${todayStr()}T${hm(t1)}:00`),
      { sess: sA && fmtTs(sA.start_time), plan: hm(t1) });
    check('1) 场次 deadline = 计划时间 + 10 分钟',
      !!sA && (new Date(sA.deadline).getTime() - new Date(sA.start_time).getTime()) === 10 * 60000,
      sA && fmtTs(sA.deadline));
    check('1) 场次状态 active', !!sA && sA.status === 'active', sA && sA.status);

    // 签到操作台（/api/attendance/status）显示的时间应与计划一致
    const admin = await login('admin');
    const st = await statusApi(admin);
    check('1) 操作台会话开始时间 = 计划时间',
      !!st && !!st.session && fmtTs(st.session.startTime) === fmtTs(sA.start_time),
      st && st.session);
    check('1) 操作台截止时间 = 计划时间 + 时长',
      !!st && !!st.session && fmtTs(st.session.deadline) === fmtTs(sA.deadline));

    // 清理用例1（避免影响后续触发逻辑）
    await dropSession(pA.session_id);
    await pg.query('DELETE FROM attendance_plans WHERE id = $1', [planA]);

    // ========== 用例 2：窗口已过（晚触发）→ 按计划时间补建 closed 场次 ==========
    const t2 = minutesAgo(30);
    const t3 = minutesAgo(5 * 60); // 超宽限期
    const planB = await addPlan({ startTime: hm(t2), duration: 5 });
    const planC = await addPlan({ startTime: hm(t3), duration: 10 });
    const sessBefore2 = (await pg.query('SELECT count(*)::int AS n FROM attendance_sessions')).rows[0].n;
    await triggerDuePlans();
    const pB = await planRow(planB);
    const sB = await sessRow(pB.session_id);
    // 行为变更（2026-09-28，修"场次抖动/全体缺勤"）：窗口已过的计划【不再补建 closed 场次】，
    // 只把计划标记 ended —— 旧实现会按计划时间补建一场并写入全校缺勤，导致签到台出现
    // "我明明签到了却显示全体缺勤"的假数据。
    check('2) 计划B 窗口已过 → 不补建场次（session_id 为空）', pB.session_id === null && !sB, { plan: hm(t2), session: pB.session_id });
    check('2) 计划B 状态 ended', pB.status === 'ended', pB.status);
    check('2) 触发前后场次总数不变（没有"幽灵场次"）',
      (await pg.query('SELECT count(*)::int AS n FROM attendance_sessions')).rows[0].n === sessBefore2,
      { before: sessBefore2, after: (await pg.query('SELECT count(*)::int AS n FROM attendance_sessions')).rows[0].n });

    const pC = await planRow(planC);
    check('2) 计划C 超宽限期不补发起（无场次、ended）', pC.status === 'ended' && pC.session_id === null, pC);

    // 幂等：重复调度不改变结果（既不产生场次，也不改变计划状态）
    const sessCountBefore = (await pg.query('SELECT count(*)::int AS n FROM attendance_sessions')).rows[0].n;
    await triggerDuePlans();
    const pB2 = await planRow(planB);
    check('2) 重复调度幂等（计划状态不变、未新建场次）',
      pB2.status === 'ended' && pB2.session_id === null
      && (await pg.query('SELECT count(*)::int AS n FROM attendance_sessions')).rows[0].n === sessCountBefore,
      { status: pB2.status, session: pB2.session_id });

    // 清理用例2
    await pg.query('DELETE FROM attendance_plans WHERE id = ANY($1::int[])', [[planB, planC]]);

    // ========== 用例 3：repairActivePlans 重建场次也使用计划时间 ==========
    const t4 = minutesAgo(3);
    const planD = await addPlan({ startTime: hm(t4), duration: 30, status: 'active' });
    await repairActivePlans();
    const pD = await planRow(planD);
    const sD = await sessRow(pD.session_id);
    check('3) active 计划缺失场次已重建', !!sD, pD);
    check('3) 重建场次 start_time = 计划时间',
      !!sD && fmtTs(sD.start_time) === fmtTs(`${todayStr()}T${hm(t4)}:00`),
      { sess: sD && fmtTs(sD.start_time), plan: hm(t4) });
    check('3) 重建场次 deadline = 计划时间 + 30 分钟',
      !!sD && (new Date(sD.deadline).getTime() - new Date(sD.start_time).getTime()) === 30 * 60000,
      sD && fmtTs(sD.deadline));

    // 清理用例3
    await dropSession(pD.session_id);
    await pg.query('DELETE FROM attendance_plans WHERE id = $1', [planD]);
    createdPlans.length = 0;

    const leftActive = await pg.query("SELECT count(*)::int AS n FROM attendance_sessions WHERE status = 'active'");
    check('清理后无遗留进行中场次', leftActive.rows[0].n === 0, leftActive.rows[0].n);

    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  } catch (e) {
    console.error('测试异常:', e);
    fail++;
  } finally {
    for (const id of createdPlans) {
      const p = await planRow(id).catch(() => null);
      if (p && p.session_id) await dropSession(p.session_id);
      await pg.query('DELETE FROM attendance_plans WHERE id = $1', [id]).catch(() => {});
    }
    await pg.end().catch(() => {});
    await routerPool.end().catch(() => {});
    console.log('清理完成');
  }
  process.exitCode = fail ? 1 : 0;
})();
