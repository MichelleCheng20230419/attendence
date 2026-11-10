// 教师视角 + 学生明细验证
'use strict';
const BASE = 'http://127.0.0.1:3000';

async function loginAs(u, p) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  return r.ok ? r.headers.get('set-cookie').split(';')[0] : null;
}

async function main() {
  // admin 学生明细（高三1班）
  const cookie = await loginAs('admin', '123456');
  if (!cookie) throw new Error('admin 登录失败');
  const api = (url) => fetch(BASE + url, { headers: { Cookie: cookie } });
  const d = await (await api('/api/attendance/analysis/student-detail?startDate=2026-08-01&endDate=2026-08-31&classId=1')).json();
  console.log('[1] 高三1班学生明细（应到=3天/人）:');
  let sum = { attended: 0, leave: 0, absent: 0 };
  for (const r of d.rows.slice(0, 5)) {
    console.log(`    ${r.studentNo} ${r.name}: 应到${r.expected} 实到${r.attended} 请假${r.leave} 缺勤${r.absent} 率${r.rate}%`);
    sum.attended += r.attended; sum.leave += r.leave; sum.absent += r.absent;
  }
  for (const r of d.rows) { sum.attended += 0; }
  const tAll = d.rows.reduce((s, r) => ({ attended: s.attended + r.attended, leave: s.leave + r.leave, absent: s.absent + r.absent }), { attended: 0, leave: 0, absent: 0 });
  console.log(`    合计: 实到${tAll.attended} 请假${tAll.leave} 缺勤${tAll.absent}（应=54-3-0→51?）`);
  const okDetail = d.rows.every((r) => r.attended + r.leave <= r.expected && r.absent === r.expected - r.attended - r.leave);
  console.log('    逐行约束检查:', okDetail ? '✓' : '✗');

  // 教师视角
  const tCookie = await loginAs('test1', '123456');
  if (!tCookie) { console.log('[2] test1/123456 登录失败（可能密码不同）'); return; }
  const tApi = (url) => fetch(BASE + url, { headers: { Cookie: tCookie } });
  const ov = await (await tApi('/api/attendance/analysis/overview?startDate=2026-08-01&endDate=2026-08-31')).json();
  console.log('[2] 教师 test1 overview（本班=高三1班）:', JSON.stringify(ov));
  const sd = await (await tApi('/api/attendance/analysis/student-detail?startDate=2026-08-01&endDate=2026-08-31')).json();
  console.log('[3] 教师 student-detail 行数:', sd.rows.length);

  // 前端页面可达性
  const page = await fetch(BASE + '/attendance-analysis', { headers: { Cookie: tCookie } });
  console.log('[4] /attendance-analysis → HTTP', page.status);
  console.log('\n✅ 教师视角验证完成');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
