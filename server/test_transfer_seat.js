// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 异动联动测试：学生转班后座位字段应清空
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
  const api = (url, opts = {}) => fetch(BASE + url, {
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...opts,
  });

  // 1. 创建临时学生（高三1班 id=1）
  const no = '20999997';
  const cr = await api('/api/students', {
    method: 'POST',
    body: JSON.stringify({ studentNo: no, name: '座位测试生', classId: 1 }),
  });
  const crd = await cr.json();
  const sid = crd.student.id;
  console.log('[1] 创建临时学生 id=', sid);

  // 2. 设置座位 (2,2)
  await api('/api/students/seats', {
    method: 'POST',
    body: JSON.stringify({ classId: 1, seats: [{ studentId: sid, row: 2, col: 2 }] }),
  });
  let s = (await (await api('/api/students?classId=1')).json()).students.find((x) => x.id === sid);
  console.log('[2] 设座后 seat =', s.seatRow + ',' + s.seatCol);

  // 3. 转班到高三2班（id=2）→ 座位应清 0
  const tr = await api('/api/transfers', {
    method: 'POST',
    body: JSON.stringify({ studentId: sid, transferType: '转班', toClassId: 2, reason: '座位联动测试', effectiveDate: '2026-08-31' }),
  });
  if (!tr.ok) throw new Error('转班失败: ' + (await tr.json()).error);
  s = (await (await api('/api/students?classId=2')).json()).students.find((x) => x.id === sid);
  console.log('[3] 转班后 seat =', s.seatRow + ',' + s.seatCol, s.seatRow === 0 && s.seatCol === 0 ? '✓ 已清空' : '✗ 未清空');

  // 4. 清理：硬删除学生 + 其异动记录
  //    注意：接口 DELETE /api/students/:id 自 P0 起是【软删除】（保留历史，is_active=false），
  //    测试夹具必须用 SQL 物理删除，否则会在真实数据里留下残留行。
  const del = await api('/api/students/' + sid, { method: 'DELETE' });
  console.log('[4] 软删除接口 HTTP', del.status, '（随后 SQL 物理清理夹具）');
  await pg.query('DELETE FROM student_transfers WHERE student_id = $1', [sid]);
  await pg.query('DELETE FROM attendance_records WHERE student_id = $1', [sid]);
  await pg.query('DELETE FROM students WHERE id = $1', [sid]);
  const left = await pg.query('SELECT count(*)::int n FROM students WHERE id = $1', [sid]);
  console.log('[4] 夹具残留学生 =', left.rows[0].n, left.rows[0].n === 0 ? '✓ 已物理清除' : '✗ 仍有残留');
  await pg.end();
  console.log(s.seatRow === 0 && s.seatCol === 0 ? '\n✅ 异动联动验证通过' : '\n❌ 验证失败');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
