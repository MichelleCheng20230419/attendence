// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 座位表优化 API 测试：seatConfig 保存/读取 + 座位保存
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

async function main() {
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: (process.env.DSH_ADMIN_PW || '123456') }),
  });
  if (!login.ok) throw new Error('登录失败');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = (url, opts = {}) => fetch(BASE + url, {
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...opts,
  });

  // 1. GET /classes 应返回 seatConfig 字段
  const cls = await (await api('/api/classes')).json();
  console.log('[1] GET /classes seatConfig:', JSON.stringify(cls.classes[0].seatConfig));

  // 2. 保存座位 + 布局配置（左右分列 4列）
  const stu = await (await api('/api/students?status=在读&classId=1')).json();
  const seats = stu.students.slice(0, 8).map((s, i) => ({
    studentId: s.id, row: Math.floor(i / 4) + 1, col: (i % 4) + 1,
  }));
  const save = await api('/api/students/seats', {
    method: 'POST',
    body: JSON.stringify({
      classId: 1, seats,
      seatConfig: { cols: 4, mode: '左右分列' },
    }),
  });
  const sd = await save.json();
  if (!save.ok) throw new Error('保存失败: ' + sd.error);
  console.log('[2] 保存座位+配置:', JSON.stringify(sd));

  // 3. 校验读取
  const cls2 = await (await api('/api/classes')).json();
  const c1 = cls2.classes.find((c) => c.id === 1);
  console.log('[3] 读取 seatConfig:', JSON.stringify(c1.seatConfig));
  if (!c1.seatConfig || c1.seatConfig.mode !== '左右分列' || c1.seatConfig.cols !== 4) throw new Error('seatConfig 读取失败');

  // 4. 非法配置应 400
  const bad = await api('/api/students/seats', {
    method: 'POST',
    body: JSON.stringify({ classId: 1, seats: [], seatConfig: { cols: 9, mode: '标准' } }),
  });
  console.log('[4] 非法列数(cols=9) → HTTP', bad.status, '(期望 400)');
  if (bad.status !== 400) throw new Error('非法配置未拒绝');
  const bad2 = await api('/api/students/seats', {
    method: 'POST',
    body: JSON.stringify({ classId: 1, seats: [], seatConfig: { cols: 4, mode: '不存在' } }),
  });
  console.log('[5] 非法模式 → HTTP', bad2.status, '(期望 400)');
  if (bad2.status !== 400) throw new Error('非法模式未拒绝');

  // 6. 清理：座位清 0 + 配置清空
  const clear = await api('/api/students/seats', {
    method: 'POST',
    body: JSON.stringify({
      classId: 1,
      seats: stu.students.map((s) => ({ studentId: s.id, row: 0, col: 0 })),
      seatConfig: { cols: 4, mode: '标准' },
    }),
  });
  console.log('[6] 清理:', JSON.stringify(await clear.json()));

  console.log('\n✅ 座位配置 API 全部通过');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
