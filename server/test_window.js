// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 签到时间窗口控制测试
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

  // 1. 发起签到（60 分钟）
  const st = await api('/api/attendance/start', { method: 'POST', body: JSON.stringify({ deadlineMinutes: 60 }) });
  const stj = await st.json();
  const sessionId = stj.session.id;
  // 管理员发起 = 校级发起（按班拆场 → 每班一条）：记录全部场次，收尾一并清理
  const createdSessionIds = (stj.sessions || [stj.session]).map((x) => x.id).filter((x) => Number.isInteger(x));
  const sessClassId = stj.session.classId || null;
  console.log('[1] 发起签到 session=' + sessionId + '（classId=' + sessClassId + '，共 ' + createdSessionIds.length + ' 场）');

  // 2. 窗口内签到 → 成功
  await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [sessionId]);
  const r1 = await api('/api/attendance/checkin', {
    method: 'POST', body: JSON.stringify({ studentId: 1, action: 'present' }),
  });
  eq('[2] 窗口内签到(期望201/200)', [200, 201].includes(r1.status), true);

  // 3. 把 deadline 改为过去 → 签到被拒
  await pg.query("UPDATE attendance_sessions SET deadline = now() - interval '1 minute' WHERE id = $1", [sessionId]);
  const r2 = await api('/api/attendance/checkin', {
    method: 'POST', body: JSON.stringify({ studentId: 3, action: 'present' }),
  });
  const d2 = await r2.json();
  eq('[3] 截止后签到 → 400', r2.status, 400);
  eq('[3] 错误信息=签到窗口已关闭', d2.error, '签到窗口已关闭');

  // 4. 截止后批量签到 → 400
  //    管理员批量签到现在必须指明班级（按班拆场后没有"全校唯一场次"）；这里用本场次所属班级
  const b = await api('/api/attendance/batch-checkin', {
    method: 'POST', body: JSON.stringify({ mode: 'all', classId: sessClassId || 1 }),
  });
  const bd = await b.json();
  eq('[4] 截止后批量签到 → 400', b.status, 400);
  eq('[4] 错误信息=签到窗口已关闭', bd.error, '签到窗口已关闭');

  // 5. 截止后取消签到（纠错）→ 允许
  const r5 = await api('/api/attendance/checkin', {
    method: 'POST', body: JSON.stringify({ studentId: 1, action: 'cancel' }),
  });
  eq('[5] 截止后取消签到 → 200(纠错允许)', r5.status, 200);

  // 6. 清理：恢复 deadline + 删除记录 + 关闭场次（管理员发起会按班拆场 → 全部场次一起收尾）
  await pg.query('UPDATE attendance_sessions SET deadline = now() + interval \'60 minutes\' WHERE id = $1', [sessionId]);
  const delIds = createdSessionIds.length ? createdSessionIds : [sessionId];
  await pg.query('DELETE FROM attendance_records WHERE session_id = ANY($1::int[])', [delIds]);
  await pg.query('DELETE FROM attendance_sessions WHERE id = ANY($1::int[])', [delIds]);
  await pg.end();
  console.log('测试数据已清理');

  console.log('');
  if (fail.length) { console.log('❌ 失败项:', fail.join(', ')); process.exit(1); }
  console.log('✅ 签到窗口控制测试通过');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
