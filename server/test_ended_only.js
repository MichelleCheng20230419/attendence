// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 只统计已结束场次测试
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

  const today = (await pg.query("SELECT to_char(now(), 'YYYY-MM-DD') AS d")).rows[0].d;

  // 1. 发起签到（active）→ 分析今天应不含它（只含 closed）
  console.log('[1] active 场次不计入:');
  const st = await api('/api/attendance/start', { method: 'POST', body: JSON.stringify({ deadlineMinutes: 60 }) });
  const stj = await st.json();
  const activeId = stj.session.id;
  // 管理员发起 = 校级发起（按班拆场）→ 记录全部场次，收尾一并删除，避免残留
  const createdSessionIds = (stj.sessions || [stj.session]).map((x) => x.id).filter((x) => Number.isInteger(x));
  await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [activeId]);
  await api('/api/attendance/checkin', { method: 'POST', body: JSON.stringify({ studentId: 1, action: 'present' }) });
  // 统计 closed 场次数（库中）
  const closedCnt = (await pg.query("SELECT count(*)::int AS n FROM attendance_sessions WHERE status='closed' AND start_time >= date_trunc('day', now()) AND start_time <= now()")).rows[0].n;
  const ov1 = await (await api(`/api/attendance/analysis/overview?startDate=${today}&endDate=${today}`)).json();
  eq('分析场次=仅closed', ov1.totalSessions, closedCnt);
  console.log(`  closed=${closedCnt} active(未计入) 分析=${ov1.totalSessions}`);

  // 2. active 场次截止（改 deadline 过去）→ status 触发自动 closed → 计入
  console.log('[2] 截止后自动纳入:');
  await pg.query("UPDATE attendance_sessions SET deadline = now() - interval '1 minute' WHERE id = $1", [activeId]);
  await api('/api/attendance/status?sessionId=' + activeId); // 钉住本场次触发懒关闭（按班拆场后不能取"最新一场"）
  const sessStatus = (await pg.query('SELECT status FROM attendance_sessions WHERE id=$1', [activeId])).rows[0].status;
  eq('active 已自动变 closed', sessStatus, 'closed');
  const closedCnt2 = (await pg.query("SELECT count(*)::int AS n FROM attendance_sessions WHERE status='closed' AND start_time >= date_trunc('day', now()) AND start_time <= now()")).rows[0].n;
  const ov2 = await (await api(`/api/attendance/analysis/overview?startDate=${today}&endDate=${today}`)).json();
  eq('closed 场次计入(+1)', ov2.totalSessions, closedCnt + 1);
  eq('该场记录计入实到', ov2.attended >= ov1.attended + 1, true);

  // 3. 清理
  const delIds = createdSessionIds.length ? createdSessionIds : [activeId];
  await pg.query('DELETE FROM attendance_records WHERE session_id = ANY($1::int[])', [delIds]);
  await pg.query('DELETE FROM attendance_sessions WHERE id = ANY($1::int[])', [delIds]);
  await pg.end();
  console.log('测试数据已清理');

  console.log('');
  if (fail.length) { console.log('❌ 失败项:', fail.join(', ')); process.exit(1); }
  console.log('✅ 只统计已结束场次测试通过');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
