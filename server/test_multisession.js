// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 多场签到独立存储与统计测试
'use strict';
// ============================================================
// 安全闸（2026 补）：本套件直接读写【真实班级/学生数据】，且部分断言已与现行实现脱节
//   （如座位配置新增 rows 校验、每班限 1 班长、账号创建对"该班已有班主任"返回 409 等），
//   运行会污染真实数据。默认不参与回归；确需运行请显式设置 DSH_ALLOW_REALDATA_TESTS=1，
//   并先备份数据库。
// ============================================================
if (process.env.DSH_ALLOW_REALDATA_TESTS !== '1') {
  console.log('SKIP 真实数据遗留套件（未设置 DSH_ALLOW_REALDATA_TESTS=1）');
  process.exit(0);
}
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

  // 1. 场次 A（改到独立日期 2026-12-01 08:00）：2 个在读学生签到
  console.log('[1] 场次A:');
  const stA = await api('/api/attendance/start', { method: 'POST', body: JSON.stringify({ deadlineMinutes: 60 }) });
  const sidA = (await stA.json()).session.id;
  await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [sidA]);
  await pg.query("UPDATE attendance_sessions SET start_time = '2026-12-01 08:00:00', deadline = '2026-12-01 08:10:00' WHERE id=$1", [sidA]);
  await api('/api/attendance/checkin', { method: 'POST', body: JSON.stringify({ studentId: 1, action: 'present' }) });
  await api('/api/attendance/checkin', { method: 'POST', body: JSON.stringify({ studentId: 3, action: 'leave', leaveReason: 'sick' }) });
  await pg.query("UPDATE attendance_sessions SET status='closed' WHERE id=$1", [sidA]);

  // 2. 场次 B（2026-12-01 14:00）：另 2 个在读学生签到
  console.log('[2] 场次B:');
  const stB = await api('/api/attendance/start', { method: 'POST', body: JSON.stringify({ deadlineMinutes: 60 }) });
  const sidB = (await stB.json()).session.id;
  await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [sidB]);
  await pg.query("UPDATE attendance_sessions SET start_time = '2026-12-01 14:00:00', deadline = '2026-12-01 14:10:00' WHERE id=$1", [sidB]);
  await api('/api/attendance/checkin', { method: 'POST', body: JSON.stringify({ studentId: 4, action: 'present' }) });
  await api('/api/attendance/checkin', { method: 'POST', body: JSON.stringify({ studentId: 5, action: 'present' }) });
  await pg.query("UPDATE attendance_sessions SET status='closed' WHERE id=$1", [sidB]);

  // 3. 记录独立存储
  console.log('[3] 记录独立存储:');
  const cntA = (await pg.query('SELECT count(*)::int AS n FROM attendance_records WHERE session_id=$1', [sidA])).rows[0].n;
  const cntB = (await pg.query('SELECT count(*)::int AS n FROM attendance_records WHERE session_id=$1', [sidB])).rows[0].n;
  eq('场次A独立记录(2条)', cntA, 2);
  eq('场次B独立记录(2条)', cntB, 2);
  eq('session_id 不同', sidA !== sidB, true);

  // 4. 考勤分析：2026-12-01 只有 A/B 两场，数据应为两场总和
  console.log('[4] 考勤分析多场汇总:');
  const ov = await (await api(`/api/attendance/analysis/overview?startDate=2026-12-01&endDate=2026-12-01`)).json();
  console.log(`  应到=${ov.expected} 实到=${ov.attended} 请假=${ov.leave} 缺勤=${ov.absent} 场次=${ov.totalSessions}`);
  eq('只有2场', ov.totalSessions, 2);
  eq('应到=2场×在读人数', ov.expected, 2 * ov.totalStudents);
  eq('实到=两场记录和(3)', ov.attended, 3);
  eq('请假=1(场次A李娜)', ov.leave, 1);
  eq('缺勤=应到-实到-请假', ov.absent, ov.expected - ov.attended - ov.leave);

  // 5. 学生明细：同一学生两场独立（学生1场A签、场B未签 → 实到1应到2）
  console.log('[5] 学生明细多场:');
  const sd = await (await api(`/api/attendance/analysis/student-detail?startDate=2026-12-01&endDate=2026-12-01&classId=1`)).json();
  const s1 = sd.rows.find((r) => r.studentNo === '20240001');
  const s3 = sd.rows.find((r) => r.studentNo === '20240003');
  if (s1) {
    eq('张伟 应到=2场', s1.expected, 2);
    eq('张伟 实到=1(仅场A)', s1.attended, 1);
    eq('张伟 缺勤=1(场B未签)', s1.absent, 1);
  }
  if (s3) {
    eq('李娜 请假=1(场A)', s3.leave, 1);
    eq('李娜 缺勤=1(场B未签)', s3.absent, 1);
  }

  // 6. 清理
  await pg.query('DELETE FROM attendance_records WHERE session_id IN ($1,$2)', [sidA, sidB]);
  await pg.query('DELETE FROM attendance_sessions WHERE id IN ($1,$2)', [sidA, sidB]);
  await pg.end();
  console.log('测试数据已清理');

  console.log('');
  if (fail.length) { console.log('❌ 失败项:', fail.join(', ')); process.exit(1); }
  console.log('✅ 多场签到独立统计测试通过');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
