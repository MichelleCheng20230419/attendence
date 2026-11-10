// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 缺勤学生右键修改测试：修改为已签到 / 修改为请假
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

  // 1. 发起签到（管理员发起 = 校级发起 → 每个班各一场；本用例只操作【夹具学生所在班】那一场）
  const st = await api('/api/attendance/start', { method: 'POST', body: JSON.stringify({ deadlineMinutes: 60 }) });
  eq('发起签到', st.status, 201);
  const stj = await st.json();
  const sessionId = stj.session.id;
  const sessClassId = stj.session.classId || null;
  const createdSessionIds = (stj.sessions || [stj.session]).map((x) => x.id).filter((x) => Number.isInteger(x));
  const statusUrl = '/api/attendance/status?sessionId=' + sessionId;   // 钉住本场次（按班拆场后不要取"别班最新一场"）
  // 清空该场次记录，手动造 2 条 absent
  await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [sessionId]);
  await pg.query(
    `INSERT INTO attendance_records (session_id, student_id, status, leave_reason, checkin_time, check_in_method)
     SELECT $1, id, 'absent', NULL, now(), 'manual' FROM students WHERE student_no IN ('20240001','20240002')`,
    [sessionId]
  );

  // 2. 缺勤→已签到（forcePresent）
  const p = await api('/api/attendance/checkin', {
    method: 'POST',
    body: JSON.stringify({ studentId: 1, action: 'present', forcePresent: true, checkInMethod: 'manual' }),
  });
  const pd = await p.json();
  eq('缺勤改已签到 → 200', p.status, 200);
  eq('状态=present(绿)', pd.record.status, 'present');
  eq('签到方式=manual', pd.record.checkInMethod, 'manual');

  // 3. 缺勤→请假（leave 覆盖）
  const l = await api('/api/attendance/checkin', {
    method: 'POST',
    body: JSON.stringify({ studentId: 3, action: 'leave', leaveReason: 'sick' }),
  });
  const ld = await l.json();
  eq('缺勤改请假 → 200/201', [200, 201].includes(l.status), true);
  eq('状态=leave(橙)', ld.record.status, 'leave');
  eq('事由=sick', ld.record.leaveReason, 'sick');

  // 4. 无 forcePresent 的缺勤补签仍为迟到（保持原逻辑）
  await pg.query(
    `INSERT INTO attendance_records (session_id, student_id, status, leave_reason, checkin_time, check_in_method)
     SELECT $1, id, 'absent', NULL, now(), 'manual' FROM students WHERE student_no = '20240004'`,
    [sessionId]
  );
  const late = await api('/api/attendance/checkin', {
    method: 'POST',
    body: JSON.stringify({ studentId: 4, action: 'present' }),
  });
  const lated = await late.json();
  eq('普通缺勤补签=迟到(蓝)', lated.record.status, 'late');

  // 5. 统计验证（status 接口：钉住本场次，统计的就是本场的记录）
  const s1 = await (await api(statusUrl)).json();
  const st1 = s1.stats;
  console.log(`  统计: present=${st1.present} leave=${st1.leave} late=${st1.late} absent=${st1.absent}`);
  eq('present≥1', st1.present >= 1, true);
  eq('leave≥1', st1.leave >= 1, true);
  eq('late≥1', st1.late >= 1, true);

  // 6. 清理：删除本用例创建的场次与其记录（管理员发起会按班拆场 → 全部删除，避免残留）
  if (createdSessionIds.length) {
    await pg.query('DELETE FROM attendance_records WHERE session_id = ANY($1::int[])', [createdSessionIds]);
    await pg.query('DELETE FROM attendance_sessions WHERE id = ANY($1::int[])', [createdSessionIds]);
  } else {
    await pg.query('DELETE FROM attendance_records WHERE session_id = $1', [sessionId]);
  }
  await pg.end();
  console.log('测试记录已清理');
  console.log('');
  if (fail.length) { console.log('❌ 失败项:', fail.join(', ')); process.exit(1); }
  console.log('✅ 缺勤右键修改测试通过');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
