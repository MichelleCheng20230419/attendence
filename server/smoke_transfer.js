// 学生异动页 UI 冒烟测试（只读，不写数据）
'use strict';
const BASE = 'http://127.0.0.1:3000';

async function main() {
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  if (!login.ok) throw new Error('登录失败');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  console.log('[1] 登录 OK');

  const api = (url) => fetch(BASE + url, { headers: { Cookie: cookie } });

  const me = await (await api('/api/auth/me')).json();
  console.log('[2] /auth/me 操作人:', me.user.displayName || me.user.username);

  const cls = await (await api('/api/classes')).json();
  console.log('[3] /classes 当前学年:', cls.currentAcademicYear, '| 班级数:', cls.classes.length);

  const stu = await (await api('/api/students?classId=1')).json();
  const first = stu.students[0];
  console.log('[4] /students 字段:', first ? `学号${first.studentNo} ${first.name} 状态=${first.status} 电话=${first.phone || '空'}` : '空');

  const now = new Date();
  const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const tr = await (await api(`/api/transfers?startDate=${from}&endDate=${to}`)).json();
  console.log('[5] /transfers 本月条数:', tr.transfers.length);
  if (tr.transfers[0]) {
    const r = tr.transfers[0];
    console.log('    示例:', r.studentName, r.transferType, r.fromClass, '→', r.toClass, '操作人:', r.operatorName);
  }

  const trAll = await (await api('/api/transfers')).json();
  console.log('[6] /transfers 全部条数:', trAll.transfers.length);

  // 静态页可达性
  for (const p of ['/admin/student-transfer', '/student-transfer.js', '/student-transfer.html']) {
    const r = await fetch(BASE + p, { headers: { Cookie: cookie } });
    console.log(`[7] ${p} → HTTP ${r.status}`);
  }

  console.log('\n✅ 冒烟测试通过');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
