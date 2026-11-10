// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接在真实库上创建"计划 + 场次"并尝试一次签到，
//    运行会写入真实场次/签到记录。已做收敛改造（2026-09-26）：
//      · 只操作【本用例自己创建的计划与场次】（按 planId 精确记录），try/finally 保证清理
//      · 等待上限由 90s 提到 150s（计划本身是"1 分钟后"，再加 scheduler 一个 tick ≤60s，90s 会偶发误报）
//      · 失败时以非 0 退出码结束（旧实现打印 ❌ 却仍返回 0，会被批量回归误判为通过）
// 复现：计划 → 会话自动转换
'use strict';
const BASE = 'http://127.0.0.1:3000';
const { Client } = require('pg');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pg = new Client({ host: '127.0.0.1', port: 5432, user: 'postgres', password: '#include123', database: 'testdb' });
  await pg.connect();
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: (process.env.DSH_ADMIN_PW || '123456') }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = (url, o = {}) => fetch(BASE + url, {
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...o,
  });

  let planId = null;
  let sessionId = null;
  let failed = false;

  const cleanup = async () => {
    try {
      if (planId) await pg.query('DELETE FROM attendance_plans WHERE id = $1', [planId]);
      if (sessionId) {
        await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [sessionId]);
        await pg.query('DELETE FROM attendance_sessions WHERE id = $1', [sessionId]);
      }
    } catch (e) { console.log('    · 清理异常：' + e.message); }
  };

  try {
    // 1. 创建 1 分钟后的计划
    const now = new Date(Date.now() + 60000);
    const p = (n) => String(n).padStart(2, '0');
    const planDate = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    const startTime = `${p(now.getHours())}:${p(now.getMinutes())}`;
    const cr = await api('/api/plans', {
      method: 'POST',
      body: JSON.stringify({ planDate, startTime, durationMinutes: 5 }),
    });
    const crd = await cr.json();
    console.log('[1] 创建计划:', planDate, startTime, '→', cr.status, 'inserted=', crd.inserted);
    // 记录自己的计划 id（全校计划：class_id IS NULL + 该分钟唯一）
    const own = await pg.query(
      `SELECT id FROM attendance_plans
        WHERE plan_date = $1::date AND start_time = $2::time AND class_id IS NULL
        ORDER BY id DESC LIMIT 1`, [planDate, startTime]
    );
    planId = own.rows[0] && own.rows[0].id;
    console.log('    本用例计划 id =', planId);

    // 2. 等待 scheduler 触发（计划时间是"1 分钟后"，再加一个 tick ≤60s → 上限给 150s）
    console.log('[2] 等待 scheduler 触发（最多 150s）...');
    let plan = null;
    for (let i = 0; i < 15; i++) {
      await sleep(10000);
      const row = planId
        ? (await pg.query('SELECT id, status, session_id FROM attendance_plans WHERE id = $1', [planId])).rows[0]
        : null;
      if (row && row.session_id) {
        plan = { id: row.id, status: row.status, sessionId: row.session_id };
        break;
      }
      console.log(`    ...${(i + 1) * 10}s 后仍未触发`);
    }
    if (!plan) {
      const all = (await (await api('/api/plans')).json()).plans;
      console.log('    当前全部计划:', all.map((x) => `${x.planDate} ${x.startTime} ${x.status} session=${x.sessionId}`).join('; '));
      console.log('    ❌ 计划未自动触发');
      failed = true;
      return;
    }
    sessionId = plan.sessionId;
    console.log('[3] 计划已触发:', plan.status, 'sessionId=', plan.sessionId);

    // 3. 检查 session 状态 + 签到页
    const sess = await pg.query('SELECT id, start_time, deadline, status FROM attendance_sessions WHERE id = $1', [plan.sessionId]);
    console.log('[4] session 记录:', JSON.stringify(sess.rows[0] && {
      id: sess.rows[0].id, status: sess.rows[0].status,
      start: sess.rows[0].start_time.toISOString(), deadline: sess.rows[0].deadline.toISOString(),
    }));
    const st = await (await api('/api/attendance/status')).json();
    console.log('[5] 签到页 session:', st.session ? `id=${st.session.id} status=${st.session.status} deadline=${st.session.deadline}` : 'NULL（无法签到！）');

    // 4. 尝试签到
    const chk = await api('/api/attendance/checkin', {
      method: 'POST', body: JSON.stringify({ studentId: 1, action: 'present' }),
    });
    const chkd = await chk.json();
    console.log('[6] 签到尝试:', chk.status, chkd.error || 'OK');
  } catch (e) {
    failed = true;
    console.log('    ❌ 异常：' + e.message);
  } finally {
    await cleanup();
    const leftPlan = planId ? (await pg.query('SELECT count(*)::int n FROM attendance_plans WHERE id = $1', [planId])).rows[0].n : 0;
    const leftSess = sessionId ? (await pg.query('SELECT count(*)::int n FROM attendance_sessions WHERE id = $1', [sessionId])).rows[0].n : 0;
    if (leftPlan === 0 && leftSess === 0) {
      console.log('[7] 测试数据已清理（计划 ' + planId + ' / 场次 ' + (sessionId || '未产生') + '）');
    } else {
      failed = true;
      console.log('[7] ❌ 清理残留：计划=' + leftPlan + ' 场次=' + leftSess);
    }
    await pg.end();
  }
  if (failed) process.exit(1);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
