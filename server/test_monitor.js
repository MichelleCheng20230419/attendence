// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 班长签到模式后端测试：账号/权限/批量签到/日志/改密
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

async function loginAs(u, p = '123456') {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  const d = await r.json();
  return { ok: r.ok, cookie: r.ok ? r.headers.get('set-cookie').split(';')[0] : null, data: d, status: r.status };
}

async function main() {
  const fail = [];
  const eq = (label, got, want) => {
    const ok = String(got) === String(want);
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${got} (期望 ${want})`);
    if (!ok) fail.push(label);
  };

  // 1. 创建班长账号
  const adminLogin = await loginAs('admin', process.env.DSH_ADMIN_PW || '123456');
  const admin = adminLogin.cookie;
  const api = (cookie, url, opts = {}) => fetch(BASE + url, {
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...opts,
  });
  console.log('[1] 创建班长账号:');
  const cr = await api(admin, '/api/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'monitor_test', password: '123456', role: 'monitor', classId: 1 }),
  });
  const crd = await cr.json();
  eq('创建班长', cr.status, 201);
  // 每班限 1：再创建同班班长 → 409
  const cr2 = await api(admin, '/api/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'monitor_test2', password: '123456', role: 'monitor', classId: 1 }),
  });
  eq('同班第二个班长 → 409', cr2.status, 409);
  // 班长未绑班级 → 400
  const cr3 = await api(admin, '/api/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'monitor_test3', password: '123456', role: 'monitor' }),
  });
  eq('班长未绑班级 → 400', cr3.status, 400);

  // 2. 班长登录：mustChangePassword=true
  console.log('[2] 班长登录:');
  const mLogin = await loginAs('monitor_test');
  eq('登录成功', mLogin.ok, true);
  eq('mustChangePassword=true', mLogin.data.user.mustChangePassword, true);
  const mCookie = mLogin.cookie;

  // 3. 页面权限
  console.log('[3] 页面权限:');
  const pStudents = await fetch(BASE + '/students', { headers: { Cookie: mCookie }, redirect: 'manual' });
  eq('班长访问 /students → 302', pStudents.status, 302);
  const pAnalysis = await fetch(BASE + '/attendance-analysis', { headers: { Cookie: mCookie }, redirect: 'manual' });
  eq('班长访问 /attendance-analysis → 302', pAnalysis.status, 302);
  const pDash = await fetch(BASE + '/dashboard', { headers: { Cookie: mCookie }, redirect: 'manual' });
  eq('班长访问 /dashboard → 200', pDash.status, 200);
  // 发起签到禁止
  const startR = await api(mCookie, '/api/attendance/start', {
    method: 'POST', body: JSON.stringify({ deadlineMinutes: 30 }),
  });
  eq('班长发起签到 → 403', startR.status, 403);

  // 4. 强制改密
  console.log('[4] 强制改密:');
  const bad = await api(mCookie, '/api/auth/change-password', {
    method: 'POST', body: JSON.stringify({ oldPassword: 'wrong', newPassword: 'abcdef' }),
  });
  eq('原密码错误 → 400', bad.status, 400);
  const chg = await api(mCookie, '/api/auth/change-password', {
    method: 'POST', body: JSON.stringify({ oldPassword: '123456', newPassword: 'monitor123' }),
  });
  eq('改密成功 → 200', chg.status, 200);
  const mLogin2 = await loginAs('monitor_test', 'monitor123');
  eq('新密码登录成功', mLogin2.ok, true);
  eq('mustChangePassword=false', mLogin2.data.user.mustChangePassword, false);

  // 5. 批量签到（需先发起签到）
  console.log('[5] 批量签到:');
  const startAdmin = await api(admin, '/api/attendance/start', {
    method: 'POST', body: JSON.stringify({ deadlineMinutes: 60 }),
  });
  if (!startAdmin.ok) throw new Error('发起签到失败: ' + (await startAdmin.json()).error);
  const m2 = mLogin2.cookie;
  // 先清掉该场次已有记录（避免统计干扰）——保留，直接批量全员
  const allR = await api(m2, '/api/attendance/batch-checkin', {
    method: 'POST', body: JSON.stringify({ mode: 'all', checkInMethod: 'batch_all' }),
  });
  const allD = await allR.json();
  eq('全员签到 → 200', allR.status, 200);
  console.log(`    全员签到 updated=${allD.updated}`);
  // 验证记录带 check_in_method
  const status1 = await (await api(m2, '/api/attendance/status')).json();
  const rec0 = status1.records[Object.keys(status1.records)[0]];
  eq('记录 checkInMethod=batch_all', rec0.checkInMethod, 'batch_all');
  // 单个取消
  const oneSid = Object.keys(status1.records)[0];
  const cancelR = await api(m2, '/api/attendance/checkin', {
    method: 'POST', body: JSON.stringify({ studentId: Number(oneSid), action: 'cancel' }),
  });
  eq('取消签到 → 200', cancelR.status, 200);
  const status2 = await (await api(m2, '/api/attendance/status')).json();
  eq('取消后无记录', status2.records[oneSid], undefined);
  // 单个再签（manual）
  const singleR = await api(m2, '/api/attendance/checkin', {
    method: 'POST', body: JSON.stringify({ studentId: Number(oneSid), action: 'present', checkInMethod: 'manual' }),
  });
  eq('单个签到 → 201', singleR.status, 201);
  // 备注
  const remarkR = await api(m2, '/api/attendance/remark', {
    method: 'POST', body: JSON.stringify({ studentId: Number(oneSid), remark: '测试备注' }),
  });
  eq('备注 → 200', remarkR.status, 200);
  // 按列签到（把张伟所在列？用 column=1 试）
  const colR = await api(m2, '/api/attendance/batch-checkin', {
    method: 'POST', body: JSON.stringify({ mode: 'column', columnIndex: 1, checkInMethod: 'batch_column' }),
  });
  const colD = await colR.json();
  eq('按列签到 → 200', colR.status, 200);
  console.log(`    按列签到 updated=${colD.updated} columnIndex=${colD.columnIndex}`);

  // 6. 操作日志
  console.log('[6] 操作日志:');
  const logs = await (await api(admin, '/api/users')).json(); // 无日志API，直接查库？用 psql 验证（脚本外）
  console.log('    (日志表写入由 psql 验证)');

  // 7. 清理：删除测试班长账号 + 关闭场次（等 deadline 自动关，或直接删记录）
  const del = await api(admin, '/api/users/' + crd.user.id, { method: 'DELETE' });
  eq('删除测试班长 → 200', del.status, 200);
  // 清理测试签到记录（场次保留，记录删掉避免污染统计）
  // 通过 SQL 清理（脚本外）

  console.log('');
  if (fail.length) { console.log('❌ 失败项:', fail.join(', ')); process.exit(1); }
  console.log('✅ 班长功能后端测试通过');
}

main().catch((e) => { console.error('❌ 执行失败:', e.message); process.exit(1); });
