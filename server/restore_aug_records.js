// 从备份恢复 attendance_records（8月历史记录），保留现有记录
'use strict';
const fs = require('fs');
const { Client } = require('pg');

async function main() {
  const backup = fs.readFileSync('E:/AI教育应用/AttendanceSystem/db/backup/testdb_2026-08-31.sql', 'utf8');
  // 提取 attendance_records 的 COPY 块
  const startMarker = 'COPY public.attendance_records ';
  const i = backup.indexOf(startMarker);
  if (i < 0) throw new Error('备份中未找到 attendance_records');
  const lineEnd = backup.indexOf('\n', i);
  const dataStart = lineEnd + 1;
  const dataEnd = backup.indexOf('\n\\.\n', dataStart);
  const block = backup.slice(dataStart, dataEnd);

  const rows = [];
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    const un = (v) => (v === '\\N' ? null : v);
    rows.push({
      sessionId: Number(cols[1]),
      studentId: Number(cols[2]),
      status: un(cols[3]),
      leaveReason: un(cols[4]),
      checkinTime: un(cols[5]),
    });
  }
  console.log('备份中记录数:', rows.length);

  const pg = new Client({ host: '127.0.0.1', port: 5432, user: 'postgres', password: '#include123', database: 'testdb' });
  await pg.connect();
  let inserted = 0, skipped = 0;
  for (const r of rows) {
    const res = await pg.query(
      `INSERT INTO attendance_records (session_id, student_id, status, leave_reason, checkin_time)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id, student_id) DO NOTHING`,
      [r.sessionId, r.studentId, r.status, r.leaveReason, r.checkinTime]
    );
    if (res.rowCount > 0) inserted += 1;
    else skipped += 1;
  }
  // 校验恢复后的记录分布
  const cnt = await pg.query(
    `SELECT count(*)::int AS n FROM attendance_records r JOIN attendance_sessions s ON s.id=r.session_id
      WHERE s.start_time >= '2026-08-01' AND s.start_time < '2026-09-01'`
  );
  console.log('8月记录恢复后:', cnt.rows[0].n, '条');
  await pg.end();
  console.log(`恢复完成：新增 ${inserted} 条，跳过 ${skipped} 条`);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
