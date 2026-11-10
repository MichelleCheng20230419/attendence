// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 计划适用范围测试
'use strict';
const BASE = 'http://127.0.0.1:3000';
const { Client } = require('pg');

async function main() {
  const pg = new Client({ host: '127.0.0.1', port: 5432, user: 'postgres', password: '#include123', database: 'testdb' });
  await pg.connect();
  const L = async (u, p = '123456') => {
    const r = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
    return r.ok ? r.headers.get('set-cookie').split(';')[0] : null;
  };
  const admin = await L('admin', process.env.DSH_ADMIN_PW || '123456');
  const teacher = await L('test1'); // 高三1班？查 test1 class_id
  const api = (c, url, o = {}) => fetch(BASE + url, {
    headers: { 'Content-Type': 'application/json', Cookie: c }, ...o,
  });
  const fail = [];
  const eq = (l, g, w) => { const ok = String(g) === String(w); console.log(`  ${ok ? '✓' : '✗'} ${l}: ${g} (期望 ${w})`); if (!ok) fail.push(l); };

  // 教师所属班级
  const me = await (await api(teacher, '/api/auth/me')).json();
  const teacherClassId = me.user.classId;
  console.log('[0] 教师 test1 班级:', teacherClassId);

  // 1. 管理员创建全校计划 + 指定班级计划
  console.log('[1] 管理员创建计划:');
  const r1 = await api(admin, '/api/plans', { method: 'POST', body: JSON.stringify({ planDate: '2099-01-01', startTime: '07:30', durationMinutes: 10 }) });
  eq('全校计划 → 201', r1.status, 201);
  const r1b = await api(admin, '/api/plans', { method: 'POST', body: JSON.stringify({ planDate: '2099-01-02', startTime: '07:30', durationMinutes: 10, classId: 1 }) });
  eq('指定高三1班计划 → 201', r1b.status, 201);

  // 2. 教师创建计划 → 强制本班
  console.log('[2] 教师创建计划:');
  const r2 = await api(teacher, '/api/plans', { method: 'POST', body: JSON.stringify({ planDate: '2099-01-03', startTime: '07:30', durationMinutes: 10, classId: 8 }) });
  eq('教师传其他班classId → 仍201(强制本班)', r2.status, 201);

  // 3. 列表过滤
  console.log('[3] 列表过滤:');
  const tPlans = (await (await api(teacher, '/api/plans?status=pending')).json()).plans.filter((p) => p.planDate.startsWith('2099'));
  const aPlans = (await (await api(admin, '/api/plans?status=pending')).json()).plans.filter((p) => p.planDate.startsWith('2099'));
  console.log(`  管理员看到 ${aPlans.length} 条；教师看到 ${tPlans.length} 条`);
  const myPlan = tPlans.find((p) => p.planDate === '2099-01-03');
  eq('教师计划 classId=自己班', myPlan && myPlan.classId, teacherClassId);
  eq('教师能看到全校计划(07-01)', !!tPlans.find((p) => p.planDate === '2099-01-01'), true);
  eq('教师看不到高三1班计划(07-02)', !tPlans.find((p) => p.planDate === '2099-01-02'), true);
  eq('管理员能看到高三1班计划', !!aPlans.find((p) => p.planDate === '2099-01-02' && p.className === '高三1班'), true);

  // 4. 教师删除：只能删自己班计划
  console.log('[4] 删除权限:');
  const otherPlan = aPlans.find((p) => p.planDate === '2099-01-02'); // 高三1班计划
  const del1 = await api(teacher, '/api/plans/' + otherPlan.id, { method: 'DELETE' });
  eq('教师删高三1班计划 → 404(无权)', del1.status, 404);
  const del2 = await api(teacher, '/api/plans/' + myPlan.id, { method: 'DELETE' });
  eq('教师删自己班计划 → 200', del2.status, 200);

  // 5. 清理
  await pg.query("DELETE FROM attendance_plans WHERE plan_date >= '2099-01-01' AND plan_date < '2099-01-31'");
  await pg.end();
  console.log('测试数据已清理');

  console.log('');
  if (fail.length) { console.log('❌ 失败项:', fail.join(', ')); process.exit(1); }
  console.log('✅ 计划适用范围测试通过');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
