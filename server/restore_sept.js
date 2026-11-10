// 紧急恢复：从备份恢复 9/1 的 sessions + records + 计划 session_id 关联
'use strict';
const fs = require('fs');
const { Client } = require('pg');

function parseCopy(backup, table) {
  const startMarker = 'COPY public.' + table + ' ';
  const i = backup.indexOf(startMarker);
  if (i < 0) return [];
  const lineEnd = backup.indexOf('\n', i);
  const dataEnd = backup.indexOf('\n\\.\n', lineEnd + 1);
  const block = backup.slice(lineEnd + 1, dataEnd);
  const rows = [];
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    rows.push(cols);
  }
  return rows;
}

async function main() {
  const backup = fs.readFileSync('E:/AI教育应用/AttendanceSystem/db/backup/testdb_20260901.sql', 'utf8');
  const pg = new Client({ host: '127.0.0.1', port: 5432, user: 'postgres', password: '#include123', database: 'testdb' });
  await pg.connect();

  // 1. 恢复 9/1 sessions
  const sessRows = parseCopy(backup, 'attendance_sessions');
  let sessRestored = 0;
  for (const cols of sessRows) {
    const [id, startTime, deadline, status] = cols;
    if (!startTime || !startTime.startsWith('2026-09-0')) continue;
    const res = await pg.query(
      `INSERT INTO attendance_sessions (id, start_time, deadline, status)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [Number(id), startTime.replace('+08', ''), deadline.replace('+08', ''), status]
    );
    if (res.rowCount > 0) sessRestored += 1;
  }
  console.log('恢复 9 月 sessions:', sessRestored);

  // 2. 恢复这些 session 的 records
  const recRows = parseCopy(backup, 'attendance_records');
  let recRestored = 0;
  for (const cols of recRows) {
    const [, sessionId, studentId, status, leaveReason, checkinTime] = cols;
    const sid = Number(sessionId);
    // 该 session 是否在 9 月恢复列表
    const inSept = sessRows.some((s) => Number(s[0]) === sid && s[1] && s[1].startsWith('2026-09-0'));
    if (!inSept) continue;
    const res = await pg.query(
      `INSERT INTO attendance_records (session_id, student_id, status, leave_reason, checkin_time)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id, student_id) DO NOTHING`,
      [sid, Number(studentId), status, leaveReason === '\\N' ? null : leaveReason, checkinTime.replace('+08', '')]
    );
    if (res.rowCount > 0) recRestored += 1;
  }
  console.log('恢复 9 月记录:', recRestored);

  // 3. 恢复计划 session_id 关联
  const planRows = parseCopy(backup, 'attendance_plans');
  let planFixed = 0;
  for (const cols of planRows) {
    // 列顺序需确认：id, plan_date, start_time, duration_minutes, status, session_id, ...
    const id = Number(cols[0]);
    const sessionId = cols.length > 5 && cols[5] && cols[5] !== '\\N' ? Number(cols[5]) : null;
    if (!sessionId) continue;
    // 仅更新当前 session_id 为空的计划（不覆盖已有）
    const res = await pg.query(
      'UPDATE attendance_plans SET session_id = $2 WHERE id = $1 AND session_id IS NULL',
      [id, sessionId]
    );
    if (res.rowCount > 0) planFixed += 1;
  }
  console.log('恢复计划 session 关联:', planFixed);

  // 4. 校验
  const chk = await pg.query(`SELECT count(*)::int AS n FROM attendance_sessions WHERE start_time >= '2026-09-01'`);
  const chk2 = await pg.query(`SELECT count(*)::int AS n FROM attendance_records r JOIN attendance_sessions s ON s.id=r.session_id WHERE s.start_time >= '2026-09-01'`);
  console.log('9 月 sessions:', chk.rows[0].n, '| 9 月记录:', chk2.rows[0].n);
  await pg.end();
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
