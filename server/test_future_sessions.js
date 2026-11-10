// 未来场次不计入应到测试
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
  const api = (url, o = {}) => fetch(BASE + url, {
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...o,
  });
  const fail = [];
  const eq = (l, g, w) => { const ok = String(g) === String(w); console.log(`  ${ok ? '✓' : '✗'} ${l}: ${g} (期望 ${w})`); if (!ok) fail.push(l); };

  // 1. 当前已发生场次数（本周范围）
  const now = await pg.query("SELECT now()::date AS d");
  const today = now.rows[0].d;
  console.log('[1] 当前日期:', today.toISOString().slice(0, 10));
  const before = (await (await api(`/api/attendance/analysis/overview?startDate=2026-09-01&endDate=2026-09-30`)).json());
  console.log('  修复前应到场次:', before.totalSessions, '(不含未来)');

  // 2. 造一个未来场次（明天）+ 记录
  console.log('[2] 插入未来场次:');
  await pg.query(
    `INSERT INTO attendance_sessions (start_time, deadline, status)
     VALUES (now() + interval '1 day', now() + interval '1 day 10 minutes', 'closed') RETURNING id`
  ).then((r) => {
    console.log('  未来场次 id=', r.rows[0].id);
    return pg.query(
      `INSERT INTO attendance_records (session_id, student_id, status, checkin_time)
       SELECT $1, id, 'present', now() FROM students WHERE id = 1`,
      [r.rows[0].id]
    );
  });

  // 3. 分析应不包含未来场次
  const after = (await (await api(`/api/attendance/analysis/overview?startDate=2026-09-01&endDate=2026-09-30`)).json());
  console.log('  插入未来后 totalSessions:', after.totalSessions);
  eq('未来场次不计入(场次数不变)', after.totalSessions, before.totalSessions);

  // 4. 直接查库确认未来场次存在（证明是过滤逻辑生效而非场次缺失）
  const futureCnt = (await pg.query("SELECT count(*)::int AS n FROM attendance_sessions WHERE start_time > now()")).rows[0].n;
  eq('未来场次确实存在于库中', futureCnt >= 1, true);

  // 5. 清理未来场次
  await pg.query("DELETE FROM attendance_records WHERE session_id IN (SELECT id FROM attendance_sessions WHERE start_time > now())");
  await pg.query("DELETE FROM attendance_sessions WHERE start_time > now()");
  await pg.end();
  console.log('测试数据已清理');

  console.log('');
  if (fail.length) { console.log('❌ 失败项:', fail.join(', ')); process.exit(1); }
  console.log('✅ 未来场次过滤测试通过');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
