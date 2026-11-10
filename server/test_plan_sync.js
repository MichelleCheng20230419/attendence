// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接在真实库上创建"计划 + 场次"，
//    运行会写入真实场次表。因此本文件已做收敛改造（2026-09-26）：
//      · 只操作【本用例自己创建的计划与场次】（按 planId / sessionId 精确记录）
//      · try/finally 保证任何中途失败都会清理，不再留下残留场次
//      · 不再"关闭全库所有 active 场次"（旧实现会误伤真实课堂）
//      · 若当前已有进行中的场次（真实课堂），直接跳过，绝不干扰
// 计划同步修复验证：惰性触发 + 异常修复
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
  const fail = [];
  const eq = (l, g, w) => { const ok = String(g) === String(w); console.log(`  ${ok ? '✓' : '✗'} ${l}: ${g} (期望 ${w})`); if (!ok) fail.push(l); };
  const createdSessions = new Set();
  let planId = null;

  const cleanup = async () => {
    try {
      if (planId) await pg.query('DELETE FROM attendance_plans WHERE id = $1', [planId]);
      const ids = [...createdSessions].filter((x) => Number.isInteger(x) && x > 0);
      if (ids.length) {
        await pg.query('DELETE FROM attendance_records WHERE session_id = ANY($1::int[])', [ids]);
        await pg.query('DELETE FROM attendance_sessions WHERE id = ANY($1::int[])', [ids]);
      }
    } catch (e) { console.log('  · 清理异常：' + e.message); }
  };

  try {
    // ===== 安全前置：有进行中的场次（真实课堂）→ 跳过，避免误关闭 =====
    const pre = await (await api('/api/attendance/status')).json();
    if (pre.session && !pre.session.ended) {
      console.log('  – 跳过：当前已有进行中的场次（' + (pre.session.createdByName || '未知发起人') + '），不干扰真实课堂');
      await cleanup();
      await pg.end();
      // 用 exitCode + return 结束（不要 process.exit：Windows/Node24 下会触发 libuv 断言崩溃 → 被当成 FAIL）
      process.exitCode = 0;
      return;
    }

    // ===== 场景1：到点计划 → status 惰性触发（不等 scheduler）=====
    console.log('[场景1] 惰性触发:');
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const planDate = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    const startTime = `${p(now.getHours())}:${p(now.getMinutes())}`;
    const cr = await api('/api/plans', { method: 'POST', body: JSON.stringify({ planDate, startTime, durationMinutes: 8 }) });
    const crd = await cr.json().catch(() => null);
    console.log(`  创建计划 ${planDate} ${startTime} → HTTP ${cr.status}`);
    planId = (crd && (crd.id || (crd.plan && crd.plan.id))) || null;
    if (!planId) {
      // 兜底：按 (日期, 时间, 全校计划) 精确查库（同一分钟只会有本用例这一条）
      const r = await pg.query(
        `SELECT id FROM attendance_plans
          WHERE plan_date = $1::date AND start_time = $2::time AND class_id IS NULL
          ORDER BY id DESC LIMIT 1`, [planDate, startTime]
      );
      planId = r.rows[0] && r.rows[0].id;
    }
    eq('创建计划拿到 planId', !!planId, true);

    // 立即调 status（不等待 scheduler）→ 应触发创建 session
    const st1 = await (await api('/api/attendance/status')).json();
    if (st1.session && Number.isInteger(st1.session.id)) createdSessions.add(st1.session.id);
    console.log(`  session id=${st1.session && st1.session.id} deadline=${st1.session && st1.session.deadline}`);

    // 读到本计划名下的全部场次（方案 A：全校计划会**按班拆成多场**，attendance_plan_sessions 是权威 1:N；
    //   plans.session_id 只是"代表场次"。全部登记，收尾一并删除，避免每跑一次就漏掉几个班）
    const linkRows = (await pg.query('SELECT session_id FROM attendance_plan_sessions WHERE plan_id = $1', [planId])).rows;
    for (const r of linkRows) if (Number.isInteger(r.session_id)) createdSessions.add(r.session_id);

    // 读库确认【本计划】的状态（不受其它活跃场次干扰）
    const prow = (await pg.query('SELECT status, session_id FROM attendance_plans WHERE id = $1', [planId])).rows[0];
    if (prow && Number.isInteger(prow.session_id)) createdSessions.add(prow.session_id);
    eq('计划已 active', prow && prow.status, 'active');
    eq('计划关联 session', !!(prow && prow.session_id), true);
    eq('全校计划按班拆场（每个有在读学生的班各一场）', linkRows.length > 1, true);
    eq('status 返回的场次 ∈ 本计划的场次（多场取最新一场）',
      !!(st1.session && linkRows.some((r) => r.session_id === st1.session.id)), true);

    // ===== 场景2：异常状态修复（计划 active 但 session 被关闭）=====
    console.log('[场景2] 异常修复:');
    const pid = planId;
    const sid = prow && prow.session_id;
    if (!sid) throw new Error('场景1 未产生场次，跳过异常修复场景');
    // 制造异常：关闭 session，计划仍 active
    await pg.query(`UPDATE attendance_sessions SET status='closed' WHERE id=$1`, [sid]);
    await pg.query(`UPDATE attendance_plans SET session_id = NULL WHERE id=$1`, [pid]);
    // 等待 scheduler（≤70s）修复
    console.log('  制造异常完成，等待 scheduler 修复（≤70s）...');
    let repaired = false;
    for (let i = 0; i < 7; i++) {
      await sleep(10000);
      const r = await pg.query('SELECT p.status, p.session_id, s.status AS ss FROM attendance_plans p LEFT JOIN attendance_sessions s ON s.id=p.session_id WHERE p.id=$1', [pid]);
      if (r.rows[0].session_id && r.rows[0].ss === 'active') {
        repaired = true;
        if (Number.isInteger(r.rows[0].session_id)) createdSessions.add(r.rows[0].session_id);
        break;
      }
    }
    eq('计划会话被重建且 active', repaired, true);
    const r2 = await pg.query('SELECT p.session_id, s.status AS ss, s.deadline FROM attendance_plans p JOIN attendance_sessions s ON s.id=p.session_id WHERE p.id=$1', [pid]);
    if (r2.rows[0]) {
      console.log(`  重建后 session_id=${r2.rows[0].session_id} status=${r2.rows[0].ss} deadline=${r2.rows[0].deadline.toISOString()}`);
      if (Number.isInteger(r2.rows[0].session_id)) createdSessions.add(r2.rows[0].session_id);
    }
    // 签到页可用
    const st2 = await (await api('/api/attendance/status')).json();
    eq('修复后签到页有 session', !!st2.session, true);
    if (st2.session && Number.isInteger(st2.session.id)) createdSessions.add(st2.session.id);
  } catch (e) {
    fail.push('异常：' + e.message);
    console.log('  ✗ 异常：' + e.message);
  } finally {
    await cleanup();
    const leftPlan = planId ? (await pg.query('SELECT count(*)::int n FROM attendance_plans WHERE id=$1', [planId])).rows[0].n : 0;
    const ids = [...createdSessions].filter((x) => Number.isInteger(x) && x > 0);
    const leftSess = ids.length ? (await pg.query('SELECT count(*)::int n FROM attendance_sessions WHERE id = ANY($1::int[])', [ids])).rows[0].n : 0;
    if (leftPlan === 0 && leftSess === 0) {
      console.log('  ✓ 清理：本用例计划/场次无残留（场次 ' + ids.join(',') + '）');
    } else {
      fail.push('清理残留');
      console.log('  ✗ 清理：仍有残留 计划=' + leftPlan + ' 场次=' + leftSess + ' ids=' + ids.join(','));
    }
    await pg.end();
    console.log('测试数据已清理');
  }

  console.log('');
  if (fail.length) { console.log('❌ 失败项:', fail.join(', ')); process.exitCode = 1; }
  console.log('✅ 计划同步修复测试通过');
}

main().catch((e) => { console.error('❌', e.message); process.exitCode = 1; });
