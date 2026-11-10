// 班长端作业统计默认筛选（今天/昨天/本周/自定义）+ 已收/待收 状态 验证
// 夹具：临时班长(class2) + 临时任课老师(class2)，今天/昨天/前天各一条作业；结束后清理
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = new Date();
const yest = new Date(today); yest.setDate(yest.getDate() - 1);
const before = new Date(today); before.setDate(before.getDate() - 2);
const T = fmt(today), Y = fmt(yest), B = fmt(before);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function api(path, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data, setc: res.headers.get('set-cookie') || '' };
}
async function login(u, p) {
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
  if (r.status !== 200) throw new Error('login ' + u + ' failed: ' + r.status);
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}
const NAMES = ['tchd_monitor', 'tchd_teacher'];

(async () => {
  try {
    for (const n of NAMES) {
      await pg.query('DELETE FROM homework_tasks WHERE created_by IN (SELECT id FROM users WHERE username=$1)', [n]).catch(() => {});
      await pg.query('DELETE FROM users WHERE username=$1', [n]).catch(() => {});
    }
    await pg.query(
      `INSERT INTO users (username, password, role, class_id, real_name, display_name, roles, must_change_password, is_active)
       VALUES ('tchd_monitor','123456','monitor',2,'默认筛选班长','默认筛选班长','["monitor"]'::json,false,true)`
    );
    await pg.query(
      `INSERT INTO users (username, password, role, class_id, real_name, display_name, roles, subject, must_change_password, is_active)
       VALUES ('tchd_teacher','123456','teacher',NULL,'默认筛选老师','默认筛选老师','["subject_teacher"]'::json,'语文',false,true)`
    );
    const tId = (await pg.query("SELECT id FROM users WHERE username='tchd_teacher'")).rows[0].id;
    await pg.query('INSERT INTO teacher_classes (teacher_id, class_id, is_head_teacher) VALUES ($1, 2, false)', [tId]);

    const cT = await login('tchd_teacher', '123456');
    const cM = await login('tchd_monitor', '123456');

    // 三条作业：今天 / 昨天 / 前天（截止时间分别当天 23:59）
    for (const [d, title] of [[T, '今天作业'], [Y, '昨天作业'], [B, '前天作业']]) {
      const r = await api('/api/homework/tasks', {
        method: 'POST', cookie: cT,
        body: { classIds: [2], subject: '语文', title, deadline: `${d} 23:59` },
      });
      if (r.status !== 201) throw new Error('publish failed: ' + JSON.stringify(r.data));
    }
    console.log(`夹具：今天=${T} 昨天=${Y} 前天=${B}`);

    // 说明：本套件用真实班级 class2（高三2班）做夹具，而 00:00 定时任务会为每个班自动生成
    //   当天的「每日作业」（is_daily=true / created_by=NULL）。因此凡"夹具作业条数"类断言，
    //   一律先 filter(t => !t.isDaily) 只数手动作业；每日作业单独用专门的断言覆盖。

    // 1) 默认（date=今天）只返回今天的作业
    let r = await api(`/api/homework/tasks?date=${T}`, { cookie: cM });
    const todayManual = (r.data.tasks || []).filter((x) => !x.isDaily);
    check('1) 按今天筛选 → 手动作业只有 1 条且为"今天作业"',
      r.status === 200 && todayManual.length === 1 && todayManual[0].title === '今天作业',
      r.data.tasks.map((x) => x.title + (x.isDaily ? '(每日)' : '')));
    check('1) 班长端同样能看到今天的「每日作业」行（系统自动发布）',
      (r.data.tasks || []).filter((x) => x.isDaily).every((x) => x.title === '今日作业' && x.teacherName === null && !!x.deadlineText),
      (r.data.tasks || []).filter((x) => x.isDaily).map((x) => x.subject + '/' + x.title));
    check('1) 回显筛选条件 date=今天', r.data.filter && r.data.filter.date === T, r.data.filter);

    // 2) 昨天
    r = await api(`/api/homework/tasks?date=${Y}`, { cookie: cM });
    const yestManual = (r.data.tasks || []).filter((x) => !x.isDaily);
    check('2) 按昨天筛选 → 手动作业只有"昨天作业"',
      yestManual.length === 1 && yestManual[0].title === '昨天作业', r.data.tasks.map((x) => x.title));

    // 3) 本周（周一~周日范围）→ 本周内的夹具作业都应出现（周一当天则只有"今天作业"）
    const dow = (today.getDay() + 6) % 7;
    const mon = new Date(today); mon.setDate(today.getDate() - dow);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const inWeek = [[T, '今天作业'], [Y, '昨天作业'], [B, '前天作业']]
      .filter(([d]) => d >= fmt(mon) && d <= fmt(sun)).map(([, t]) => t);
    r = await api(`/api/homework/tasks?from=${fmt(mon)}&to=${fmt(sun)}`, { cookie: cM });
    const titles = (r.data.tasks || []).filter((x) => !x.isDaily).map((x) => x.title);
    check('3) 本周范围 = 本周内的夹具作业（' + inWeek.join('/') + '）',
      inWeek.every((t) => titles.includes(t)) && titles.length === inWeek.length, { titles, inWeek, mon: fmt(mon), sun: fmt(sun) });
    check('3) 本周按截止时间升序', (() => {
      const ts = r.data.tasks.map((x) => new Date(x.deadline).getTime());
      return ts.every((v, i) => i === 0 || ts[i - 1] <= v);
    })(), r.data.tasks.map((x) => x.deadlineText));

    // 4) 自定义范围（前天~昨天）
    r = await api(`/api/homework/tasks?from=${B}&to=${Y}`, { cookie: cM });
    check('4) 自定义范围 前天~昨天 → 手动作业 2 条',
      (r.data.tasks || []).filter((x) => !x.isDaily).length === 2, r.data.tasks.map((x) => x.title));

    // 5) 已收/待收：未录入 → 待收；录入后 → 已收（用手动作业验证，避开每日作业的既有录入）
    r = await api(`/api/homework/tasks?date=${T}`, { cookie: cM });
    const task = (r.data.tasks || []).filter((x) => !x.isDaily)[0];
    check('5) 未录入时 recorded=false（待收）', !!task && task.recorded === false && task.recordedCount === 0, { recorded: task && task.recorded, c: task && task.recordedCount });
    const detail = await api('/api/homework/tasks/' + task.id, { cookie: cM });
    const sid = detail.data.students[0].id;
    const sv = await api('/api/homework/submissions/batch', {
      method: 'POST', cookie: cM, body: { taskId: task.id, updates: [{ studentId: sid, isSubmitted: true }] },
    });
    check('5) 班长录入提交情况 → ok', sv.status === 200 && sv.data.updated === 1, sv.data);
    r = await api(`/api/homework/tasks?date=${T}`, { cookie: cM });
    const after = (r.data.tasks || []).find((x) => x.id === task.id);
    check('5) 录入后 recorded=true（已收）', !!after && after.recorded === true && after.recordedCount === 1,
      { recorded: after && after.recorded, c: after && after.recordedCount });
    const yAfter = ((await api(`/api/homework/tasks?date=${Y}`, { cookie: cM })).data.tasks || []).filter((x) => !x.isDaily)[0];
    check('5) 昨天的作业仍未收（待收）', !!yAfter && yAfter.recorded === false);

    // 6) 不影响老师/班主任端：老师列表仍可查自己的作业（mine=1 不带日期）
    r = await api('/api/homework/tasks?mine=1', { cookie: cT });
    check('6) 任课老师"我的作业"不受影响（3 条）', r.status === 200 && r.data.tasks.length === 3, r.data.tasks.length);
    r = await api(`/api/homework/tasks?date=${T}`, { cookie: cT });
    check('6) 老师按日期筛选也正常（手动作业 1 条）',
      (r.data.tasks || []).filter((x) => !x.isDaily).length === 1,
      r.data.tasks.map((x) => x.subject + '/' + x.title));

    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  } catch (e) {
    console.error('测试异常:', e);
    fail++;
  } finally {
    await pg.query(`DELETE FROM homework_tasks WHERE created_by IN (SELECT id FROM users WHERE username LIKE 'tchd\_%' ESCAPE '\\')`).catch(() => {});
    await pg.query(`DELETE FROM teacher_classes WHERE teacher_id IN (SELECT id FROM users WHERE username LIKE 'tchd\_%' ESCAPE '\\')`).catch(() => {});
    await pg.query(`DELETE FROM users WHERE username LIKE 'tchd\_%' ESCAPE '\\'`).catch(() => {});
    await pg.end().catch(() => {});
    console.log('清理完成');
  }
  process.exitCode = fail ? 1 : 0;
})();
