// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 2026-09-29 起：与其它真实数据套件一致，默认不参与回归（需显式 DSH_ALLOW_REALDATA_TESTS=1）。
//    原因：它会发起"全校场次"并写入真实学生记录；同时"当天全天请假"（批量请假）会自动同步进新场次，
//    使"请假人数=1"这类绝对断言随真实使用而失效（已改为按学生断言）。
// 签到结束后自动标记缺勤测试
'use strict';
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

  // 1. 发起签到（截止 60 分钟），部分学生签到
  console.log('[1] 发起签到:');
  const st = await api('/api/attendance/start', { method: 'POST', body: JSON.stringify({ deadlineMinutes: 60 }) });
  const sessionId = (await st.json()).session.id;
  await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [sessionId]);
  await api('/api/attendance/checkin', { method: 'POST', body: JSON.stringify({ studentId: 1, action: 'present' }) });
  await api('/api/attendance/checkin', { method: 'POST', body: JSON.stringify({ studentId: 3, action: 'leave', leaveReason: 'sick' }) });

  // 2. 把 deadline 改为过去 → 调 status → 自动补缺勤
  console.log('[2] 截止后自动缺勤:');
  await pg.query("UPDATE attendance_sessions SET deadline = now() - interval '1 minute' WHERE id = $1", [sessionId]);
  const s1 = await (await api('/api/attendance/status')).json();
  const absentCnt = Object.values(s1.records).filter((r) => r.status === 'absent').length;
  console.log(`  记录: present=${s1.stats.present} leave=${s1.stats.leave} absent=${s1.stats.absent} 总数=${s1.stats.total}`);
  eq('未签学生自动补缺席(absent>0)', s1.stats.absent > 0, true);
  eq('已签学生保持present', s1.stats.present, 1);
  // 注意：请假人数按【学生】断言，而不是"总数=1" —— 真实库里可能有"当天全天请假"（批量请假）登记，
  //       那份登记会被自动同步进新场次，使总请假数 >1（这是预期行为）
  eq('请假学生保持leave', (s1.records['3'] || {}).status, 'leave');
  eq('缺勤+已签+请假=总人数', s1.stats.absent + s1.stats.present + s1.stats.leave, s1.stats.total);

  // 3. 模拟计划结束：scheduler 关闭 session → status 回退最近 closed 场次
  console.log('[3] 计划结束后回退展示:');
  await pg.query("UPDATE attendance_sessions SET status='closed' WHERE id = $1", [sessionId]);
  const s2 = await (await api('/api/attendance/status')).json();
  eq('回退返回已结束场次(ended=true)', s2.session && s2.session.ended, true);
  const absent2 = Object.values(s2.records).filter((r) => r.status === 'absent').length;
  eq('回退后仍显示缺勤', absent2 > 0, true);
  eq('回退后已签仍显示', Object.values(s2.records).filter((r) => r.status === 'present').length, 1);

  // 4. 考勤分析缺勤人次正确（自洽：缺勤=应到-实到-请假）
  console.log('[4] 考勤分析:');
  const today = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const d0 = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  const ov = await (await api(`/api/attendance/analysis/overview?startDate=${d0}&endDate=${d0}`)).json();
  eq('分析缺勤=应到-实到-请假', ov.absent, ov.expected - ov.attended - ov.leave);
  eq('分析缺勤>0', ov.absent > 0, true);
  console.log(`  分析: 应到${ov.expected} 实到${ov.attended} 请假${ov.leave} 缺勤${ov.absent}`);

  // 5. 清理：删除本套件发起的场次（含记录）
  await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [sessionId]);
  await pg.query('DELETE FROM attendance_sessions WHERE id = $1', [sessionId]);
  await pg.end();
  console.log('测试数据已清理');

  console.log('');
  if (fail.length) { console.log('❌ 失败项:', fail.join(', ')); process.exitCode = 1; return; }
  console.log('✅ 自动缺勤测试通过');
}

main().catch((e) => { console.error('❌', e.message); process.exitCode = 1; });
