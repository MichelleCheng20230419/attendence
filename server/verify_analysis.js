// 考勤分析修复验证：独立 SQL 手动计算预期值（人-天口径） vs API 返回
// 运行：node verify_analysis.js  （需登录 admin）
'use strict';
const { Client } = require('pg');
const BASE = 'http://127.0.0.1:3000';

const EXPECTED_SQL = `
WITH scoped AS (
  SELECT r.student_id, r.status, s.start_time::date AS d
  FROM attendance_records r
  JOIN attendance_sessions s ON s.id = r.session_id
  WHERE s.start_time >= $1 AND s.start_time <= $2
    AND r.student_id IN (SELECT id FROM students WHERE is_active = true AND status = '在读')
),
person_day AS (
  SELECT student_id, d,
         MAX(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS attended,
         MAX(CASE WHEN status = 'leave' THEN 1 ELSE 0 END) AS has_leave
  FROM scoped GROUP BY student_id, d
)
SELECT
  (SELECT count(DISTINCT d) FROM scoped)::int AS days,
  (SELECT count(*) FROM students WHERE is_active = true AND status = '在读')::int AS students,
  (SELECT count(DISTINCT d) FROM scoped)::int * (SELECT count(*) FROM students WHERE is_active = true AND status = '在读')::int AS expected,
  COALESCE(sum(attended),0)::int AS attended,
  COALESCE(sum(CASE WHEN has_leave = 1 AND attended = 0 THEN 1 ELSE 0 END),0)::int AS leave
FROM person_day;
`;

const CLASS_SQL = `
WITH scoped AS (
  SELECT r.student_id, r.status, s.start_time::date AS d
  FROM attendance_records r
  JOIN attendance_sessions s ON s.id = r.session_id
  WHERE s.start_time >= $1 AND s.start_time <= $2
    AND r.student_id IN (SELECT id FROM students WHERE is_active = true AND status = '在读')
),
person_day AS (
  SELECT student_id, d,
         MAX(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS attended,
         MAX(CASE WHEN status = 'leave' THEN 1 ELSE 0 END) AS has_leave
  FROM scoped GROUP BY student_id, d
)
SELECT c.id AS class_id, c.class_name,
       count(DISTINCT pd.d)::int AS days,
       (SELECT count(*) FROM students WHERE is_active = true AND status = '在读' AND class_id = c.id)::int AS stu_cnt,
       COALESCE(count(*) FILTER (WHERE pd.attended = 1),0)::int AS attended,
       COALESCE(count(*) FILTER (WHERE pd.has_leave = 1 AND pd.attended = 0),0)::int AS leave
FROM classes c
LEFT JOIN students s ON s.class_id = c.id AND s.is_active = true AND s.status = '在读'
LEFT JOIN person_day pd ON pd.student_id = s.id
GROUP BY c.id, c.class_name ORDER BY c.id;
`;

async function main() {
  const pg = new Client({ host: '127.0.0.1', port: 5432, user: 'postgres', password: '#include123', database: 'testdb' });
  await pg.connect();

  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  if (!login.ok) throw new Error('登录失败');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  console.log('[1] 登录 OK\n');

  const START = '2026-08-01', END = '2026-08-31';
  const api = (url) => fetch(BASE + url, { headers: { Cookie: cookie } });

  // ---- 预期值（SQL 独立计算）----
  const exp = (await pg.query(EXPECTED_SQL, [START, END + ' 23:59:59'])).rows[0];
  const expClasses = (await pg.query(CLASS_SQL, [START, END + ' 23:59:59'])).rows;
  console.log('[2] SQL 手动计算预期（人-天口径）:');
  console.log(`    签到日=${exp.days} 在读=${exp.students} 应到=${exp.expected} 实到=${exp.attended} 请假=${exp.leave} 缺勤=${exp.expected - exp.attended - exp.leave}`);
  for (const c of expClasses) {
    console.log(`    ${c.class_name}: 在读${c.stu_cnt}×${c.days}天=应到${c.stu_cnt * c.days} 实到${c.attended} 请假${c.leave} 缺勤${c.stu_cnt * c.days - c.attended - c.leave}`);
  }
  console.log('');

  // ---- API 实际值 ----
  const ov = await (await api('/api/attendance/analysis/overview?startDate=' + START + '&endDate=' + END)).json();
  const rk = await (await api('/api/attendance/analysis/ranking?startDate=' + START + '&endDate=' + END)).json();
  const tr = await (await api('/api/attendance/analysis/trend?startDate=' + START + '&endDate=' + END)).json();
  console.log('[3] API overview:', JSON.stringify({ totalSessions: ov.totalSessions, totalDays: ov.totalDays, totalStudents: ov.totalStudents, expected: ov.expected, attended: ov.attended, leave: ov.leave, absent: ov.absent, rate: ov.rate, warning: ov.warning }));
  console.log('[4] API ranking:');
  for (const r of rk.rows) {
    console.log(`    ${r.className}: 应到${r.expected} 实到${r.attended} 请假${r.leave} 缺勤${r.absent} 率${r.rate}% 警告=${!!r.warning}`);
  }
  console.log('[5] API trend days:', tr.points.map((p) => `${p.date}(应到${p.expected}实到${p.attended}率${p.rate}%)`).join(' '));

  // ---- 断言 ----
  const fail = [];
  const eq = (label, got, want) => { if (got !== want) fail.push(`${label}: API=${got} 期望=${want}`); };

  eq('overview.totalDays', ov.totalDays, exp.days);
  eq('overview.totalStudents', ov.totalStudents, exp.students);
  eq('overview.expected', ov.expected, exp.expected);
  eq('overview.attended', ov.attended, exp.attended);
  eq('overview.leave', ov.leave, exp.leave);
  eq('overview.absent', ov.absent, exp.expected - exp.attended - exp.leave);

  // 卡片 = 班级汇总
  const sumExp = rk.rows.reduce((s, r) => s + r.expected, 0);
  const sumAtt = rk.rows.reduce((s, r) => s + r.attended, 0);
  const sumLeave = rk.rows.reduce((s, r) => s + r.leave, 0);
  const sumAbsent = rk.rows.reduce((s, r) => s + r.absent, 0);
  eq('卡片应到=Σ班级应到', sumExp, ov.expected);
  eq('卡片实到=Σ班级实到', sumAtt, ov.attended);
  eq('卡片请假=Σ班级请假', sumLeave, ov.leave);
  eq('卡片缺勤=Σ班级缺勤', sumAbsent, ov.absent);

  // 每班：实到+请假 <= 应到；缺勤 = 应到-实到-请假
  for (const r of rk.rows) {
    if (r.attended + r.leave > r.expected) fail.push(`约束违反 ${r.className}: 实到${r.attended}+请假${r.leave}>应到${r.expected}`);
    if (r.absent !== r.expected - r.attended - r.leave) fail.push(`缺勤公式错误 ${r.className}: ${r.absent} != ${r.expected}-${r.attended}-${r.leave}`);
  }
  // 与 SQL 预期逐班比对
  for (const c of expClasses) {
    const apiRow = rk.rows.find((r) => r.className === c.class_name);
    if (!apiRow) { fail.push(`班级缺失: ${c.class_name}`); continue; }
    eq(`应到(${c.class_name})`, apiRow.expected, c.stu_cnt * c.days);
    eq(`实到(${c.class_name})`, apiRow.attended, c.attended);
    eq(`请假(${c.class_name})`, apiRow.leave, c.leave);
    eq(`缺勤(${c.class_name})`, apiRow.absent, c.stu_cnt * c.days - c.attended - c.leave);
  }

  console.log('');
  if (fail.length) {
    console.log('❌ 校验失败:');
    fail.forEach((f) => console.log('   - ' + f));
    process.exit(1);
  }
  console.log('✅ 全部校验通过：卡片与班级明细一致，实到+请假<=应到，缺勤=应到-实到-请假');
  await pg.end();
}

main().catch((e) => { console.error('❌ 执行失败:', e.message); process.exit(1); });
