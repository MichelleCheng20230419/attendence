// 未来场次过滤对比测试（新增未来场次不改变统计，新增过去场次增加统计）
'use strict';
const BASE = 'http://127.0.0.1:3000';
const { Client } = require('pg');

async function main() {
  const pg = new Client({ host: '127.0.0.1', port: 5432, user: 'postgres', password: '#include123', database: 'testdb' });
  await pg.connect();
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: (process.env.DSH_ADMIN_PW || '123456') }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = (url) => fetch(BASE + url, { headers: { Cookie: cookie } });
  const fail = [];
  const eq = (l, g, w) => { const ok = String(g) === String(w); console.log(`  ${ok ? '✓' : '✗'} ${l}: ${g} (期望 ${w})`); if (!ok) fail.push(l); };

  const today = (await pg.query("SELECT to_char(now(), 'YYYY-MM-DD') AS d")).rows[0].d;

  // 1. 初始：今天已发生（且已结束）的场次数（数据库现状）
  //    注：只数 closed —— 考勤分析也只统计 closed；每天自动签到的场次当天是 active，
  //        打开开关后"今天已发生场次数"必然大于分析场次数，用旧口径会误报"不一致"
  const baseCnt = (await pg.query("SELECT count(*)::int AS n FROM attendance_sessions WHERE start_time >= date_trunc('day', now()) AND start_time <= now() AND status = 'closed'")).rows[0].n;
  const baseOv = await (await api(`/api/attendance/analysis/overview?startDate=${today}&endDate=${today}`)).json();
  console.log('[1] 初始今天已发生场次:', baseCnt, '| 分析场次:', baseOv.totalSessions);
  eq('初始一致', baseOv.totalSessions, baseCnt);

  // 2. 插入未来场次（今天 23:59）→ 分析不变
  console.log('[2] 插入未来场次(今天23:59):');
  const f = await pg.query(
    `INSERT INTO attendance_sessions (start_time, deadline, status)
     VALUES ((($1 || ' 23:59:00')::timestamptz), (($1 || ' 23:59:10')::timestamptz), 'active') RETURNING id`,
    [today]
  );
  const futId = f.rows[0].id;
  await pg.query(`INSERT INTO attendance_records (session_id, student_id, status, checkin_time) VALUES ($1, 1, 'present', now())`, [futId]);
  const afterFuture = await (await api(`/api/attendance/analysis/overview?startDate=${today}&endDate=${today}`)).json();
  eq('未来场次不计入(场次不变)', afterFuture.totalSessions, baseOv.totalSessions);
  eq('未来场次记录不计入实到', afterFuture.attended, baseOv.attended);
  eq('未来场次确实在库中', (await pg.query('SELECT count(*)::int AS n FROM attendance_sessions WHERE id=$1', [futId])).rows[0].n, 1);

  // 3. 插入过去场次（今天 06:00）→ 分析 +1
  console.log('[3] 插入过去场次(今天06:00):');
  const p = await pg.query(
    `INSERT INTO attendance_sessions (start_time, deadline, status)
     VALUES ((($1 || ' 06:00:00')::timestamptz), (($1 || ' 06:10:00')::timestamptz), 'closed') RETURNING id`,
    [today]
  );
  const pastId = p.rows[0].id;
  await pg.query(`INSERT INTO attendance_records (session_id, student_id, status, checkin_time) VALUES ($1, 3, 'present', now())`, [pastId]);
  const afterPast = await (await api(`/api/attendance/analysis/overview?startDate=${today}&endDate=${today}`)).json();
  eq('过去场次计入(场次+1)', afterPast.totalSessions, baseOv.totalSessions + 1);
  eq('过去场次记录计入实到(+1)', afterPast.attended, baseOv.attended + 1);

  // 4. 清理
  await pg.query('DELETE FROM attendance_records WHERE session_id IN ($1,$2)', [futId, pastId]);
  await pg.query('DELETE FROM attendance_sessions WHERE id IN ($1,$2)', [futId, pastId]);
  await pg.end();
  console.log('测试数据已清理');

  console.log('');
  if (fail.length) { console.log('❌ 失败项:', fail.join(', ')); process.exitCode = 1; }
  console.log('✅ 未来场次过滤对比测试通过');
}

main().catch((e) => { console.error('❌', e.message); process.exitCode = 1; });
