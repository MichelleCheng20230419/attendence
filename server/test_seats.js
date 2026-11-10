// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 座位表后端 API 测试
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
  console.log('[1] 登录 OK');

  const api = (url, opts = {}) => fetch(BASE + url, {
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...opts,
  });

  // 2. GET /students 应返回 seatRow/seatCol
  const stu = await (await api('/api/students?status=在读&classId=1')).json();
  const first = stu.students[0];
  console.log('[2] GET /students 座位字段:', first ? `id=${first.id} ${first.name} seatRow=${first.seatRow} seatCol=${first.seatCol}` : '空');
  if (!('seatRow' in first) || !('seatCol' in first)) throw new Error('缺少座位字段');

  // 3. 保存座位：把前 4 名学生排成 2x2
  const sids = stu.students.slice(0, 4);
  const seats = sids.map((s, i) => ({ studentId: s.id, row: Math.floor(i / 2) + 1, col: (i % 2) + 1 }));
  const save = await api('/api/students/seats', {
    method: 'POST',
    body: JSON.stringify({ classId: 1, seats }),
  });
  const saveData = await save.json();
  if (!save.ok) throw new Error('保存失败: ' + saveData.error);
  console.log('[3] 保存座位:', JSON.stringify(saveData));

  // 4. 校验保存结果
  const stu2 = await (await api('/api/students?status=在读&classId=1')).json();
  const ok1 = stu2.students.find((s) => s.id === sids[0].id);
  const ok4 = stu2.students.find((s) => s.id === sids[3].id);
  console.log(`[4] 校验: ${ok1.name} → (${ok1.seatRow},${ok1.seatCol}) | ${ok4.name} → (${ok4.seatRow},${ok4.seatCol})`);
  if (ok1.seatRow !== 1 || ok1.seatCol !== 1 || ok4.seatRow !== 2 || ok4.seatCol !== 2) throw new Error('座位保存校验失败');

  // 5. 非法坐标应被拒绝
  const bad = await api('/api/students/seats', {
    method: 'POST',
    body: JSON.stringify({ classId: 1, seats: [{ studentId: sids[0].id, row: -1, col: 1 }] }),
  });
  console.log('[5] 非法坐标(row=-1) → HTTP', bad.status, '(期望 400)');
  if (bad.status !== 400) throw new Error('非法坐标未被拒绝');

  // 6. 越权学生（属于 class 2 的）不应被更新
  const stuCls2 = await (await api('/api/students?status=在读&classId=2')).json();
  if (stuCls2.students.length) {
    const other = stuCls2.students[0];
    await api('/api/students/seats', {
      method: 'POST',
      body: JSON.stringify({ classId: 1, seats: [{ studentId: other.id, row: 5, col: 5 }] }),
    });
    const chk = await (await api('/api/students?status=在读&classId=2')).json();
    const after = chk.students.find((s) => s.id === other.id);
    console.log(`[6] 越权写入防护: ${other.name} seatRow=${after.seatRow} (期望保持 0)`);
    if (after.seatRow !== 0) throw new Error('越权写入未拦截');
  }

  // 7. 清理：把座位清 0（模拟重置）
  const clear = await api('/api/students/seats', {
    method: 'POST',
    body: JSON.stringify({ classId: 1, seats: sids.map((s) => ({ studentId: s.id, row: 0, col: 0 })) }),
  });
  console.log('[7] 清理座位:', JSON.stringify(await clear.json()));

  console.log('\n✅ 座位 API 全部通过');
}

main().catch((e) => { console.error('❌ 测试失败:', e.message); process.exit(1); });
