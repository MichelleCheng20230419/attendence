// 验证：学生档案扩展（PUT 编辑 / 导入模板扩展）
'use strict';
const BASE = 'http://127.0.0.1:3000';
const { Client } = require('pg');

async function main() {
  const pg = new Client({ host: '127.0.0.1', port: 5432, user: 'postgres', password: '#include123', database: 'testdb' });
  await pg.connect();
  // 登录 admin
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: (process.env.DSH_ADMIN_PW || '123456') }),
  });
  const loginData = await login.json();
  if (!login.ok) throw new Error('登录失败: ' + loginData.error);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  console.log('[1] 登录成功:', loginData.user.username);

  const api = (url, opts = {}) => fetch(BASE + url, {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    ...opts,
  });

  // 取一个班级（高三1班 id=1）
  const cls = await (await api('/api/classes')).json();
  const target = cls.classes.find((c) => c.className === '高三1班') || cls.classes[0];
  console.log('[2] 使用班级:', target.className, 'id=', target.id);

  // ---- A. 新建学生（含全部档案字段）----
  const no = '20999999';
  const created = await api('/api/students', {
    method: 'POST',
    body: JSON.stringify({
      studentNo: no,
      name: '测试档案生',
      classId: target.id,
      gender: '男',
      birthDate: '2008-05-01',
      idCard: '330106200805011234',
      nationality: '汉族',
      politicalStatus: '共青团员',
      enrollmentDate: '2024-09-01',
      phone: '13800138000',
      emergencyPhone: '13900139000',
      emergencyContact: '测试家长',
      address: '杭州市西湖区测试路1号',
      graduationSchool: '杭州市文澜中学',
      remarks: '测试备注',
    }),
  });
  if (!created.ok) throw new Error('创建失败: ' + (await created.json()).error);
  const sid = created.json ? (await created.json()).student.id : null;
  console.log('[3] 新建学生 id=', sid);

  // 校验 GET 返回档案字段
  const list1 = await (await api('/api/students?status=在读&classId=' + target.id)).json();
  const me = list1.students.find((s) => s.studentNo === no);
  const check = (label, got, want) => {
    const ok = String(got ?? '') === String(want ?? '');
    console.log(`    ${ok ? '✓' : '✗'} ${label}: ${got} (期望 ${want})`);
    if (!ok) throw new Error('字段校验失败: ' + label);
  };
  console.log('[4] GET /students 档案字段:');
  check('gender', me.gender, '男');
  check('birthDate', me.birthDate, '2008-05-01');
  check('idCard', me.idCard, '330106200805011234');
  check('nationality', me.nationality, '汉族');
  check('politicalStatus', me.politicalStatus, '共青团员');
  check('enrollmentDate', me.enrollmentDate, '2024-09-01');
  check('phone', me.phone, '13800138000');
  check('emergencyPhone', me.emergencyPhone, '13900139000');
  check('emergencyContact', me.emergencyContact, '测试家长');
  check('address', me.address, '杭州市西湖区测试路1号');
  check('graduationSchool', me.graduationSchool, '杭州市文澜中学');
  check('remarks', me.remarks, '测试备注');

  // ---- B. PUT 编辑：改姓名/班级 + 若干档案字段 ----
  const upd = await api('/api/students/' + sid, {
    method: 'PUT',
    body: JSON.stringify({
      name: '测试档案生改',
      classId: target.id,
      gender: '女',
      phone: '13700137000',
      graduationSchool: '杭州市十三中',
      remarks: '更新后的备注',
    }),
  });
  if (!upd.ok) throw new Error('编辑失败: ' + (await upd.json()).error);
  console.log('[5] PUT 编辑成功');
  const list2 = await (await api('/api/students?status=在读&classId=' + target.id)).json();
  const me2 = list2.students.find((s) => s.studentNo === no);
  check('name', me2.name, '测试档案生改');
  check('gender', me2.gender, '女');
  check('phone', me2.phone, '13700137000');
  check('graduationSchool', me2.graduationSchool, '杭州市十三中');
  check('remarks', me2.remarks, '更新后的备注');
  check('birthDate(未改应保留)', me2.birthDate, '2008-05-01');
  check('idCard(未改应保留)', me2.idCard, '330106200805011234');

  // ---- C. 导入扩展模板（15列）----
  const no2 = '20999998';
  const imp = await api('/api/students/import', {
    method: 'POST',
    body: JSON.stringify({
      students: [{
        studentNo: no2,
        name: '测试导入生',
        className: target.className,
        gender: '女',
        birthDate: '2008-06-15',
        idCard: '330106200806150123',
        nationality: '满族',
        politicalStatus: '群众',
        phone: '13600136000',
        address: '杭州市拱墅区测试路2号',
        enrollmentDate: '2024-09-01',
        graduationSchool: '杭州市采荷中学',
        emergencyContact: '导入家长',
        emergencyPhone: '13500135000',
        remarks: '导入备注',
      }],
    }),
  });
  const impData = await imp.json();
  if (!imp.ok) throw new Error('导入失败: ' + impData.error);
  console.log('[6] 导入结果:', JSON.stringify(impData));
  const list3 = await (await api('/api/students?status=在读&classId=' + target.id)).json();
  const impStu = list3.students.find((s) => s.studentNo === no2);
  check('导入-name', impStu.name, '测试导入生');
  check('导入-gender', impStu.gender, '女');
  check('导入-birthDate', impStu.birthDate, '2008-06-15');
  check('导入-nationality', impStu.nationality, '满族');
  check('导入-politicalStatus', impStu.politicalStatus, '群众');
  check('导入-phone', impStu.phone, '13600136000');
  check('导入-address', impStu.address, '杭州市拱墅区测试路2号');
  check('导入-graduationSchool', impStu.graduationSchool, '杭州市采荷中学');
  check('导入-emergencyContact', impStu.emergencyContact, '导入家长');
  check('导入-emergencyPhone', impStu.emergencyPhone, '13500135000');
  check('导入-remarks', impStu.remarks, '导入备注');

  // ---- D. 清理测试数据 ----
  //    注意：接口 DELETE /api/students/:id 自 P0 起是【软删除】（保留历史，is_active=false），
  //    测试夹具必须用 SQL 物理删除，否则会在真实数据里留下残留行。
  const d1 = await api('/api/students/' + sid, { method: 'DELETE' });
  const d2 = await api('/api/students/' + impStu.id, { method: 'DELETE' });
  if (!d1.ok || !d2.ok) throw new Error('清理失败');
  for (const id of [sid, impStu.id]) {
    await pg.query('DELETE FROM attendance_records WHERE student_id = $1', [id]);
    await pg.query('DELETE FROM homework_submissions WHERE student_id = $1', [id]);
    await pg.query('DELETE FROM student_likes WHERE student_id = $1', [id]);
    await pg.query('DELETE FROM student_transfers WHERE student_id = $1', [id]);
    await pg.query('DELETE FROM students WHERE id = $1', [id]);
  }
  const left = await pg.query('SELECT count(*)::int n FROM students WHERE id = ANY($1::int[])', [[sid, impStu.id]]);
  console.log('[7] 测试数据已清理（夹具残留学生 = ' + left.rows[0].n + '）');
  await pg.end();

  console.log('\n✅ 全部通过');
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e.message);
  process.exit(1);
});
