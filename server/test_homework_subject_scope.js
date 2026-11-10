// ⚠️ 真实数据告警（2026-09-17 补注）：本套件直接使用真实班级/学生数据（如 class 1 / class 2，非独立夹具），
//    运行会写入真实场次/签到记录/座位/异动等数据，且部分断言依赖会变化的真实数据（真实数据一变即误报）。
//    运行前请先备份数据库；改造建议：参照 server/test_transfer_perm.js —— 年级/班级/学生/账号全部自建夹具并在结尾清理，
//    并断言真实表行数测试前后一致。
// 任课老师学科权限隔离测试
//   纯任课老师（非班主任）：作业范围锁定为【个人中心绑定的所教学科】，不能查看其他学科
//   班主任：本班全部学科可见；管理员：全部班级全部学科
// 夹具：临时教师（数学/语文各一，任教 class2）+ 临时班主任（class2 班主任）；结束后清理
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

const pad = (n) => String(n).padStart(2, '0');
const today = new Date();
const TODAY = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function api(path, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ctype = res.headers.get('content-type') || '';
  let data = null;
  if (ctype.includes('application/json')) { try { data = await res.json(); } catch (_) {} }
  else { try { data = { bufLen: (await res.arrayBuffer()).byteLength }; } catch (_) {} }
  return { status: res.status, data, ctype, setc: res.headers.get('set-cookie') || '' };
}
async function login(u, p) {
  // admin 的密码可能被管理员改过 → 用环境变量 DSH_ADMIN_PW（默认 123456）；夹具账号固定 123456
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('login ' + u + ' failed: ' + r.status);
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}
async function mkUser(username, role, subject, roles) {
  const r = await pg.query(
    `INSERT INTO users (username, password, role, class_id, real_name, display_name, roles, subject, must_change_password, is_active)
     VALUES ($1, '123456', $2, NULL, $1, $1, $3::json, $4, false, true) RETURNING id`,
    [username, role, roles, subject]
  );
  return r.rows[0].id;
}
const NAMES = ['tcs_math', 'tcs_chinese', 'tcs_head', 'tcs_nosub'];

(async () => {
  try {
    for (const n of NAMES) {
      await pg.query('DELETE FROM homework_tasks WHERE created_by IN (SELECT id FROM users WHERE username=$1)', [n]).catch(() => {});
      await pg.query('DELETE FROM teacher_classes WHERE teacher_id IN (SELECT id FROM users WHERE username=$1)', [n]).catch(() => {});
      await pg.query('DELETE FROM users WHERE username=$1', [n]).catch(() => {});
    }

    // 夹具：数学老师 / 语文老师（class2 任教，非班主任）；班主任（class2 班主任，兼数学）；未绑定学科的老师
    const mathT = await mkUser('tcs_math', 'teacher', '数学', '["subject_teacher"]');
    const chineseT = await mkUser('tcs_chinese', 'teacher', '语文', '["subject_teacher"]');
    const headT = await mkUser('tcs_head', 'teacher', '数学', '["head_teacher"]');
    const noSubT = await mkUser('tcs_nosub', 'teacher', null, '["subject_teacher"]');
    for (const [tid, isHead] of [[mathT, false], [chineseT, false], [headT, true], [noSubT, false]]) {
      await pg.query('INSERT INTO teacher_classes (teacher_id, class_id, is_head_teacher) VALUES ($1, 2, $2)', [tid, isHead]);
    }

    const cMath = await login('tcs_math');
    const cChinese = await login('tcs_chinese');
    const cHead = await login('tcs_head');
    const cNoSub = await login('tcs_nosub');
    const cAdmin = await login('admin');

    // 两位老师各发布一份作业（class2）
    let r = await api('/api/homework/tasks', {
      method: 'POST', cookie: cMath,
      body: { classIds: [2], subject: '数学', title: '数学-权限隔离测试', deadline: `${TODAY} 23:59` },
    });
    check('0) 数学老师发布数学作业 → 201', r.status === 201 && r.data.created.length === 1, r.data);
    const mathTaskId = r.data.created[0].id;
    r = await api('/api/homework/tasks', {
      method: 'POST', cookie: cChinese,
      body: { classIds: [2], subject: '语文', title: '语文-权限隔离测试', deadline: `${TODAY} 23:59` },
    });
    check('0) 语文老师发布语文作业 → 201', r.status === 201 && r.data.created.length === 1, r.data);
    const chineseTaskId = r.data.created[0].id;

    // 1) 数学老师：列表只看到数学
    r = await api(`/api/homework/tasks?mine=1&date=${TODAY}`, { cookie: cMath });
    check('1) 数学老师列表仅数学作业', r.status === 200 && r.data.tasks.length === 1 && r.data.tasks[0].subject === '数学',
      r.data.tasks.map((t) => t.subject + '/' + t.title));
    check('1) 返回 subjectLocked=true 且 mySubject=数学',
      r.data.subjectLocked === true && r.data.mySubject === '数学', { l: r.data.subjectLocked, s: r.data.mySubject });

    // 2) 数学老师显式请求语文 → 403
    r = await api(`/api/homework/tasks?mine=1&subject=${encodeURIComponent('语文')}`, { cookie: cMath });
    check('2) 数学老师请求语文 → 403', r.status === 403, r.data);

    // 3) 作业详情：语文作业不可见，数学作业可见
    r = await api('/api/homework/tasks/' + chineseTaskId, { cookie: cMath });
    check('3) 数学老师查看语文作业详情 → 403', r.status === 403, r.data);
    r = await api('/api/homework/tasks/' + mathTaskId, { cookie: cMath });
    check('3) 数学老师查看自己数学作业详情 → 200', r.status === 200, r.data && r.data.task);

    // 4) 导出范围：只含数学
    r = await api(`/api/homework/export?date=${TODAY}`, { cookie: cMath });
    check('4) 数学老师导出 → xlsx 非空', r.status === 200 && r.data.bufLen > 500, r.status);
    r = await api(`/api/homework/export?date=${TODAY}&subject=${encodeURIComponent('语文')}`, { cookie: cMath });
    check('4) 数学老师导出语文 → 403', r.status === 403, r.data);

    // 5) 按学生查看：只含数学作业
    const stu = await pg.query("SELECT id FROM students WHERE class_id = 2 AND is_active = true AND status = '在读' ORDER BY student_no LIMIT 1");
    const sid = stu.rows[0].id;
    r = await api(`/api/homework/student/${sid}`, { cookie: cMath });
    check('5) 数学老师按学生查看 → 仅数学记录',
      r.status === 200 && r.data.records.length === 1 && r.data.records[0].subject === '数学',
      r.data && r.data.records.map((x) => x.subject));

    // 6) 班主任：本班全部学科可见，未锁定
    r = await api(`/api/homework/tasks?classId=2&date=${TODAY}`, { cookie: cHead });
    const subs = (r.data.tasks || []).map((t) => t.subject);
    check('6) 班主任可见本班全部学科（数学+语文）', r.status === 200 && subs.includes('数学') && subs.includes('语文'), subs);
    check('6) 班主任 subjectLocked=false', r.data.subjectLocked === false && r.data.mySubject === '数学', { l: r.data.subjectLocked });
    r = await api('/api/homework/tasks/' + chineseTaskId, { cookie: cHead });
    check('6) 班主任可查看语文作业详情 → 200', r.status === 200, r.status);

    // 7) 管理员：全部可见、未锁定
    r = await api(`/api/homework/tasks?date=${TODAY}`, { cookie: cAdmin });
    check('7) 管理员可见全部班级全部学科', r.status === 200 && r.data.tasks.length >= 2, r.data.tasks.length);
    check('7) 管理员 subjectLocked=false', r.data.subjectLocked === false, r.data.subjectLocked);

    // 8) 未绑定学科的任课老师：提示绑定，不返回作业
    r = await api(`/api/homework/tasks?mine=1&date=${TODAY}`, { cookie: cNoSub });
    check('8) 未绑定学科 → needSubject=true 且无作业',
      r.status === 200 && r.data.needSubject === true && r.data.tasks.length === 0, { n: r.data.needSubject, t: r.data.tasks.length });
    r = await api(`/api/homework/tasks?mine=1&subject=${encodeURIComponent('数学')}`, { cookie: cNoSub });
    check('8) 未绑定学科请求数学 → 仍为 needSubject（不含数据）', r.data.needSubject === true && r.data.tasks.length === 0, r.data);

    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  } catch (e) {
    console.error('测试异常:', e);
    fail++;
  } finally {
    for (const n of NAMES) {
      await pg.query('DELETE FROM homework_tasks WHERE created_by IN (SELECT id FROM users WHERE username=$1)', [n]).catch(() => {});
      await pg.query('DELETE FROM teacher_classes WHERE teacher_id IN (SELECT id FROM users WHERE username=$1)', [n]).catch(() => {});
      await pg.query('DELETE FROM users WHERE username=$1', [n]).catch(() => {});
    }
    await pg.end().catch(() => {});
    console.log('清理完成');
  }
  process.exitCode = fail ? 1 : 0;
})();
