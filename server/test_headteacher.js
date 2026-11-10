// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 正副班主任功能测试
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

  // 1. 创建教师无真实姓名 → 400
  console.log('[1] 账号管理-教师真实姓名必填:');
  const r1 = await api('/api/users', { method: 'POST', body: JSON.stringify({ username: 't_norn_999', password: '123456', role: 'teacher', classId: 1 }) });
  eq('无真实姓名 → 400', r1.status, 400);
  const r1b = await api('/api/users', { method: 'POST', body: JSON.stringify({ username: 't_norn_999', password: '123456', role: 'teacher', classId: 1, realName: '王老师' }) });
  const tid = (await r1b.json()).user.id;
  eq('有真实姓名 → 201', r1b.status, 201);
  const users = (await (await api('/api/users')).json()).users;
  const created = users.find((u) => u.id === tid);
  eq('realName 保存', created.realName, '王老师');

  // 2. 设置正副班主任
  console.log('[2] 班级管理-正副班主任:');
  const r2 = await api('/api/classes/1', { method: 'PUT', body: JSON.stringify({ className: '高三1班', headTeacherId: tid, deputyTeacherId: 15 }) });
  eq('设置正副班主任 → 200', r2.status, 200);
  const manage = (await (await api('/api/classes/manage')).json()).classes;
  const cls1 = manage.find((c) => c.id === 1);
  eq('正班主任名(真实姓名)', cls1.head_teacher_name, '王老师');
  eq('副班主任名', !!cls1.deputy_teacher_name, true);
  console.log(`  班级1: 正=${cls1.head_teacher_name} 副=${cls1.deputy_teacher_name}`);

  // 3. 双向同步：正班主任 users.class_id → 1
  const u1 = (await (await api('/api/users')).json()).users.find((u) => u.id === tid);
  eq('正班主任 class_id 同步到高三1班', u1.classId, 1);

  // 4. 冲突：把已有正班主任的班级换人 → 409 needConfirm
  const r4 = await api('/api/classes/1', { method: 'PUT', body: JSON.stringify({ className: '高三1班', headTeacherId: 6 }) });
  eq('更换正班主任 → 409 需确认', r4.status, 409);

  // 5. /auth/me 返回 realName；教师显示名
  console.log('[3] 教师显示名:');
  const login2 = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 't_norn_999', password: '123456' }),
  });
  const me = await (await fetch(BASE + '/api/auth/me', { headers: { Cookie: login2.headers.get('set-cookie').split(';')[0] } })).json();
  eq('/auth/me realName', me.user.realName, '王老师');

  // 6. 清理（先解除班级引用，再删账号）
  await pg.query("UPDATE classes SET head_teacher_id=NULL, deputy_teacher_id=NULL WHERE id=1");
  await api('/api/users/' + tid, { method: 'DELETE' });
  await pg.end();
  console.log('测试数据已清理');

  console.log('');
  if (fail.length) { console.log('❌ 失败项:', fail.join(', ')); process.exit(1); }
  console.log('✅ 正副班主任功能测试通过');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
