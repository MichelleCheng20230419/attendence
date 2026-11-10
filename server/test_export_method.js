// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 导出验证：fields 含 method → Excel 含"签到方式"列
'use strict';
const BASE = 'http://127.0.0.1:3000';
const XLSX = require('xlsx');

async function main() {
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: (process.env.DSH_ADMIN_PW || '123456') }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  // 先发起签到并批量签到（制造 batch_all 记录）
  await fetch(BASE + '/api/attendance/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ deadlineMinutes: 60 }),
  });
  await fetch(BASE + '/api/attendance/batch-checkin', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ mode: 'all', classId: 1, checkInMethod: 'batch_all' }),
  });

  // 导出（本月）
  const now = new Date();
  const s = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const e = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const r = await fetch(`${BASE}/api/attendance/analysis/export?startDate=${s}&endDate=${e}&classId=1&fields=student,status,time,method`, {
    headers: { Cookie: cookie },
  });
  if (!r.ok) throw new Error('导出失败 HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const header = rows[0];
  console.log('表头:', header.join(' | '));
  const hasMethod = header.includes('签到方式');
  console.log(hasMethod ? '✓ 含"签到方式"列' : '✗ 缺少"签到方式"列');
  const sample = rows.slice(1, 4);
  for (const row of sample) console.log('  样本:', row.join(' | '));

  // 清理：删除本场次记录（测试数据）+ 关闭场次
  const { Client } = require('pg');
  const pg = new Client({ host: '127.0.0.1', port: 5432, user: 'postgres', password: '#include123', database: 'testdb' });
  await pg.connect();
  await pg.query(`DELETE FROM attendance_records WHERE session_id IN (SELECT id FROM attendance_sessions WHERE status='active')`);
  await pg.query(`DELETE FROM operation_logs WHERE action IN ('batch_all_checkin')`);
  await pg.end();
  console.log('测试记录已清理');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
