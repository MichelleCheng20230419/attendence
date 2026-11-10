// ============================================================
// 计划管理筛选测试（功能优化：默认只看「签到中 + 待签到」，已结束默认隐藏）
//   GET /api/plans?status=open            → 待签到 + 签到中（页面默认）
//   GET /api/plans?status=               → 全部
//   GET /api/plans?status=pending|active|ended / pending,active
//   排序：签到中最前 → 待签到按日期时间升序 → 已结束按日期时间倒序
// 夹具：3 个临时计划（未来 pending ×2、当前 active、过去 ended），结束后清理并断言真实数据未变
// ============================================================
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

const pad = (n) => String(n).padStart(2, '0');
const d0 = new Date();
const DAY = (off) => {
  const x = new Date(d0.getTime() + off * 86400000);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
};

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

const ids = { pendingA: null, pendingB: null, active: null, ended: null, session: null };

async function cleanup() {
  const list = Object.values(ids).filter((x) => Number.isInteger(x));
  if (list.length) {
    await pg.query('DELETE FROM attendance_records WHERE session_id = ANY($1::int[])', [list]).catch(() => {});
    await pg.query('DELETE FROM attendance_plans WHERE id = ANY($1::int[])', [list]).catch(() => {});
    await pg.query('DELETE FROM attendance_sessions WHERE id = ANY($1::int[])', [list]).catch(() => {});
  }
}

(async () => {
  try {
    await cleanup();
    const base = {
      plans: (await pg.query('SELECT count(*)::int n FROM attendance_plans')).rows[0].n,
      sessions: (await pg.query('SELECT count(*)::int n FROM attendance_sessions')).rows[0].n,
      ended: (await pg.query("SELECT count(*)::int n FROM attendance_plans WHERE status = 'ended'")).rows[0].n,
    };
    const cAdmin = await login('admin');

    // 夹具：未来 pending ×2（不会触发）、当前 active（带进行中场次）、过去 ended
    // 注意：attendance_plans 有唯一约束 (plan_date, start_time, COALESCE(class_id,0))，
    //       真实库里可能已有同时间计划 → 插入前逐分钟错开，避免撞唯一键
    const slotTaken = async (dateStr, time) => {
      const r = await pg.query(
        `SELECT count(*)::int n FROM attendance_plans
          WHERE plan_date = $1::date AND start_time = $2::time AND COALESCE(class_id, 0) = 0`,
        [dateStr, time]
      );
      return r.rows[0].n > 0;
    };
    const freeSlot = async (dateStr, hhmm) => {
      const [h, m] = hhmm.split(':').map(Number);
      const base = h * 60 + m;
      for (let i = 0; i < 240 && base + i < 1440; i++) {
        const t = String(Math.floor((base + i) / 60)).padStart(2, '0') + ':' + String((base + i) % 60).padStart(2, '0');
        if (!(await slotTaken(dateStr, t))) return t;
      }
      throw new Error('找不到可用的计划时间槽（' + dateStr + ' ' + hhmm + '）');
    };
    const mkPlan = async (dateStr, time, dur, status, sessionId) => {
      const t = await freeSlot(dateStr, time);
      const r = await pg.query(
        `INSERT INTO attendance_plans (plan_date, start_time, duration_minutes, status, session_id, class_id)
         VALUES ($1::date, $2::time, $3, $4, $5, NULL) RETURNING id`,
        [dateStr, t, dur, status, sessionId]
      );
      return r.rows[0].id;
    };
    ids.pendingA = await mkPlan(DAY(3), '08:00', 12, 'pending', null);
    ids.pendingB = await mkPlan(DAY(5), '09:30', 12, 'pending', null);
    ids.ended = await mkPlan(DAY(-4), '08:00', 12, 'ended', null);
    const s = await pg.query(
      `INSERT INTO attendance_sessions (start_time, deadline, status)
       VALUES (now(), now() + interval '40 minutes', 'active') RETURNING id`
    );
    ids.session = s.rows[0].id;
    ids.active = await mkPlan(DAY(0), '07:00', 90, 'active', ids.session);

    const fixtureIds = [ids.pendingA, ids.pendingB, ids.active, ids.ended];

    // 1) 默认筛选：待签到 + 签到中（不含已结束）
    let r = await api('/api/plans?status=open', { cookie: cAdmin });
    const openIds = (r.data.plans || []).filter((p) => fixtureIds.includes(p.id)).map((p) => p.id).sort((a, b) => a - b);
    const openStatuses = [...new Set((r.data.plans || []).map((p) => p.status))].sort();
    check('1) ?status=open 返回 200 且不含任何已结束计划',
      r.status === 200 && !(r.data.plans || []).some((p) => p.status === 'ended'), openStatuses);
    check('1) ?status=open 含全部未结束夹具（2 pending + 1 active）',
      JSON.stringify(openIds) === JSON.stringify([ids.pendingA, ids.pendingB, ids.active].sort((a, b) => a - b)),
      openIds);
    check('1) ?status=open 不含 ended 夹具',
      !(r.data.plans || []).some((p) => p.id === ids.ended),
      (r.data.plans || []).map((p) => p.id));

    // 2) 全部：能看到已结束
    r = await api('/api/plans', { cookie: cAdmin });
    const allIds = (r.data.plans || []).map((p) => p.id);
    check('2) 不带 status（全部）能看到 ended 夹具', r.status === 200 && allIds.includes(ids.ended), allIds.length);
    check('2) 全部里同时含 pending / active 夹具',
      allIds.includes(ids.pendingA) && allIds.includes(ids.pendingB) && allIds.includes(ids.active));
    check('2) 全部条数 = 未结束 + 已结束（含真实数据）',
      allIds.length === (await pg.query('SELECT count(*)::int n FROM attendance_plans')).rows[0].n, allIds.length);

    // 3) 单状态筛选
    r = await api('/api/plans?status=ended', { cookie: cAdmin });
    const endedIds = (r.data.plans || []).map((p) => p.id);
    check('3) ?status=ended 只返回已结束计划',
      r.status === 200 && (r.data.plans || []).every((p) => p.status === 'ended') && endedIds.includes(ids.ended),
      endedIds.length);
    check('3) ?status=ended 不含未结束夹具',
      !endedIds.includes(ids.pendingA) && !endedIds.includes(ids.active));
    r = await api('/api/plans?status=pending', { cookie: cAdmin });
    check('3) ?status=pending 只返回待签到',
      (r.data.plans || []).every((p) => p.status === 'pending') && (r.data.plans || []).some((p) => p.id === ids.pendingA));
    r = await api('/api/plans?status=active', { cookie: cAdmin });
    check('3) ?status=active 只返回签到中',
      (r.data.plans || []).every((p) => p.status === 'active') && (r.data.plans || []).some((p) => p.id === ids.active));

    // 4) 兼容写法：pending,active 等价于 open
    r = await api('/api/plans?status=pending,active', { cookie: cAdmin });
    const multiIds = (r.data.plans || []).map((p) => p.id).sort((a, b) => a - b);
    check('4) ?status=pending,active 与 ?status=open 结果一致',
      JSON.stringify(multiIds) === JSON.stringify((await api('/api/plans?status=open', { cookie: cAdmin })).data.plans.map((p) => p.id).sort((a, b) => a - b)),
      multiIds.length);
    r = await api('/api/plans?status=不存在', { cookie: cAdmin });
    check('4) 非法 status 不报错（按全部处理）', r.status === 200 && (r.data.plans || []).length === allIds.length, (r.data.plans || []).length);

    // 5) 排序：签到中最前 → 待签到升序 → 已结束倒序
    const rank = (s) => (s === 'active' ? 0 : s === 'pending' ? 1 : 2);
    r = await api('/api/plans', { cookie: cAdmin });
    const list = r.data.plans || [];
    const ranks = list.map((p) => rank(p.status));
    check('5) 状态顺序单调不减（签到中 → 待签到 → 已结束）',
      ranks.every((v, i) => i === 0 || ranks[i - 1] <= v), list.map((p) => p.status));
    const pend = list.filter((p) => p.status === 'pending').map((p) => p.planDate + ' ' + p.startTime);
    check('5) 待签到按日期时间升序',
      pend.every((v, i) => i === 0 || pend[i - 1] <= v), pend);
    const endedSeq = list.filter((p) => p.status === 'ended').map((p) => p.planDate + ' ' + p.startTime);
    check('5) 已结束按日期时间倒序（最近的在前）',
      endedSeq.every((v, i) => i === 0 || endedSeq[i - 1] >= v), endedSeq.slice(0, 5));
    const firstActive = list.findIndex((p) => p.status === 'active');
    const firstPending = list.findIndex((p) => p.status === 'pending');
    check('5) 签到中的计划排在待签到之前',
      firstActive >= 0 && (firstPending < 0 || firstActive < firstPending), { firstActive, firstPending });

    // 6) 真实数据未变 + 清理
    await cleanup();
    const after = {
      plans: (await pg.query('SELECT count(*)::int n FROM attendance_plans')).rows[0].n,
      sessions: (await pg.query('SELECT count(*)::int n FROM attendance_sessions')).rows[0].n,
      ended: (await pg.query("SELECT count(*)::int n FROM attendance_plans WHERE status = 'ended'")).rows[0].n,
    };
    check('6) 真实计划/场次数量未变', base.plans === after.plans && base.sessions === after.sessions, { base, after });
    check('6) 真实已结束计划数量未变', base.ended === after.ended, { base: base.ended, after: after.ended });
    check('6) 夹具已清理',
      (await pg.query('SELECT count(*)::int n FROM attendance_plans WHERE id = ANY($1::int[])', [fixtureIds])).rows[0].n === 0);
    // 真实数据在默认筛选下也不应出现已结束计划
    r = await api('/api/plans?status=open', { cookie: cAdmin });
    check('6) 真实数据下 ?status=open 仍不含已结束计划',
      (r.data.plans || []).every((p) => p.status !== 'ended'), (r.data.plans || []).map((p) => p.status).slice(0, 5));
    if (base.ended > 0) {
      check('6) 真实数据下 ?status=ended 能看到已结束计划（' + base.ended + ' 条）',
        ((await api('/api/plans?status=ended', { cookie: cAdmin })).data.plans || []).length === base.ended);
    }
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
