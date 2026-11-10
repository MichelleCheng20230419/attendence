// ============================================================
// 年级/班级下拉数据源一致性测试（BUG 修复：添加教师账号的年级下拉未读取年级管理数据）
//   年级下拉：GET /api/grades?academicYear=当前学年      （与「年级管理」同一接口）
//   班级下拉：GET /api/classes?gradeId=xx&academicYear=xx（选中年级后按年级+学年拉取）
// 重点：年级管理里新增、但**还没有班级**的年级必须能被下拉读到；非当前学年的年级不出现
// 夹具：当前学年 空年级 + 有班级年级、其他学年 年级+班级；结束后清理并断言真实数据未变
// ============================================================
const { Pool } = require('pg');
const BASE = 'http://localhost:3000';
const pg = new Pool({ host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: '#include123' });

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
  // admin 的密码可能被管理员改过 → 用环境变量 DSH_ADMIN_PW（默认 123456）；夹具账号固定 123456
  const pw = p || (u === 'admin' ? (process.env.DSH_ADMIN_PW || '123456') : '123456');
  const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: pw } });
  if (r.status !== 200) throw new Error('login ' + u + ' failed: ' + r.status);
  return 'connect.sid=' + r.setc.match(/connect\.sid=([^;]+)/)[1];
}

const TAG = String(Date.now()).slice(-6);
const G_EMPTY = '源测试空年级' + TAG;     // 当前学年，无班级（原 BUG 场景）
const G_FULL = '源测试有班级年级' + TAG;  // 当前学年，有班级
const G_OTHER = '源测试其它学年年级' + TAG; // 非当前学年
const OTHER_YEAR = '2019-2020';
const created = { grades: [], classes: [] };

async function cleanup() {
  if (created.classes.length) {
    await pg.query('SELECT purge_class(id) FROM classes WHERE id = ANY($1::int[])', [created.classes]).catch(() => {});
  }
  await pg.query('SELECT purge_class(id) FROM classes WHERE class_name LIKE $1', ['源测试班%' + TAG]).catch(() => {});
  await pg.query('DELETE FROM grades WHERE grade_name LIKE $1', ['源测试%' + TAG]).catch(() => {});
}

(async () => {
  try {
    await cleanup();
    const base = {
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
      classes: (await pg.query('SELECT count(*)::int n FROM classes')).rows[0].n,
      grades: (await pg.query('SELECT count(*)::int n FROM grades')).rows[0].n,
    };
    const cAdmin = await login('admin');

    // 当前学年（来自 /api/settings，与页面下拉同源）
    let r = await api('/api/settings', { cookie: cAdmin });
    const YEAR = r.data.currentAcademicYear;
    check('1) /api/settings 返回当前学年', r.status === 200 && /^\d{4}-\d{4}$/.test(YEAR), YEAR);

    // 夹具：当前学年 空年级 / 有班级年级（含 1 个班级）；其他学年 年级 + 班级
    const mkGrade = async (name, year) => {
      const g = await pg.query(
        'INSERT INTO grades (grade_name, grade_code, academic_year) VALUES ($1,$2,$3) RETURNING id',
        [name, 'SRC' + TAG, year]
      );
      created.grades.push(g.rows[0].id);
      return g.rows[0].id;
    };
    const gEmpty = await mkGrade(G_EMPTY, YEAR);
    const gFull = await mkGrade(G_FULL, YEAR);
    const gOther = await mkGrade(G_OTHER, OTHER_YEAR);
    const mkClass = async (name, gradeId, gradeName, year) => {
      const c = await pg.query(
        'INSERT INTO classes (class_name, grade, grade_id, academic_year, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [name, gradeName, gradeId, year, 'active']
      );
      created.classes.push(c.rows[0].id);
      return c.rows[0].id;
    };
    const cFull = await mkClass('源测试班A' + TAG, gFull, G_FULL, YEAR);
    const cOther = await mkClass('源测试班B' + TAG, gOther, G_OTHER, OTHER_YEAR);
    check('2) 夹具创建完成（空年级 / 有班级年级 / 其它学年）',
      !!(gEmpty && gFull && gOther && cFull && cOther));

    // 3) 年级下拉数据源：与「年级管理」同一接口，按当前学年过滤
    r = await api('/api/grades?academicYear=' + encodeURIComponent(YEAR), { cookie: cAdmin });
    const names = (r.data.grades || []).map((g) => g.grade_name);
    check('3) 年级下拉包含"当前学年无班级的新年级"（原 BUG 场景）',
      r.status === 200 && names.includes(G_EMPTY), names.slice(-3));
    check('3) 年级下拉包含当前学年有班级的年级', names.includes(G_FULL));
    check('3) 年级下拉不包含其他学年的年级', !names.includes(G_OTHER), names.slice(-3));
    check('3) 空年级的 class_count = 0', ((r.data.grades || []).find((g) => g.grade_name === G_EMPTY) || {}).class_count === 0);
    check('3) 空年级仍带有 id / academic_year（下拉可用 id 作为 value）',
      await (async () => {
        const g = (r.data.grades || []).find((x) => x.grade_name === G_EMPTY) || {};
        return g.id === gEmpty && g.academic_year === YEAR;
      })());
    // 兼容 snake_case 传参（文档中的写法）
    r = await api('/api/grades?academic_year=' + encodeURIComponent(YEAR), { cookie: cAdmin });
    check('3) 参数别名 academic_year 同样生效',
      (r.data.grades || []).map((g) => g.grade_name).includes(G_EMPTY), (r.data.grades || []).length);

    // 4) 班级下拉：按 gradeId + academicYear 联动
    r = await api('/api/classes?gradeId=' + gFull + '&academicYear=' + encodeURIComponent(YEAR), { cookie: cAdmin });
    check('4) 选择年级 → 只返回该年级的班级',
      r.status === 200 && (r.data.classes || []).length === 1 && r.data.classes[0].id === cFull,
      r.data.classes);
    check('4) 班级项含 className / grade / gradeId / academicYear',
      await (async () => {
        const c = (r.data.classes || [])[0] || {};
        return c.className === '源测试班A' + TAG && c.grade === G_FULL && c.gradeId === gFull && c.academicYear === YEAR;
      })(), (r.data.classes || [])[0]);
    r = await api('/api/classes?gradeId=' + gEmpty + '&academicYear=' + encodeURIComponent(YEAR), { cookie: cAdmin });
    check('4) 空年级 → 返回空数组（页面提示"该年级暂无班级"）',
      r.status === 200 && (r.data.classes || []).length === 0, r.data.classes);
    r = await api('/api/classes?grade_id=' + gFull + '&academic_year=' + encodeURIComponent(YEAR), { cookie: cAdmin });
    check('4) 参数别名 grade_id / academic_year 同样生效',
      (r.data.classes || []).length === 1 && r.data.classes[0].id === cFull, r.data.classes);

    // 5) 未过滤时仍能看到全部（学生/班长"所属班级"下拉不能因此丢班级）
    r = await api('/api/classes', { cookie: cAdmin });
    const allIds = (r.data.classes || []).map((c) => c.id);
    check('5) 不带参数时返回全部班级（含其他学年）',
      allIds.includes(cFull) && allIds.includes(cOther), allIds.length);
    check('5) /api/classes 返回当前学年（页面据此过滤）', !!(r.data && r.data.currentAcademicYear), r.data && r.data.currentAcademicYear);

    // 6) 用"新年级 + 新班级"创建教师带班记录 → 保存后年级/班级绑定正确
    const uname = 'src_t_' + TAG;
    await pg.query('DELETE FROM users WHERE username = $1', [uname]).catch(() => {});
    r = await api('/api/users', {
      method: 'POST', cookie: cAdmin,
      body: {
        username: uname, password: '123456', role: 'teacher', realName: '源测试教师', subject: '物理',
        teachingClasses: [{ classId: cFull, roleInClass: 'subject_teacher' }],
      },
    });
    const tid = r.data && r.data.user && r.data.user.id;
    check('6) 用新年级的班级创建教师 → 201', r.status === 201, r.data);
    const tRow = (r.data.user.teachingClasses || [])[0] || {};
    check('6) 带班记录返回正确的年级与班级名',
      tRow.classId === cFull && tRow.className === '源测试班A' + TAG && tRow.grade === G_FULL, tRow);
    r = await api('/api/users/teacher-classes?teacherId=' + tid, { cookie: cAdmin });
    check('6) 单独查询带班记录同样带年级',
      ((r.data.teacherClasses || [])[0] || {}).grade === G_FULL, r.data.teacherClasses);
    // 清理临时教师
    await pg.query('DELETE FROM teacher_classes WHERE teacher_id = $1', [tid]).catch(() => {});
    await pg.query('DELETE FROM users WHERE id = $1', [tid]).catch(() => {});
    check('6) 清理临时教师账号',
      (await pg.query('SELECT count(*)::int n FROM users WHERE username = $1', [uname])).rows[0].n === 0);

    // ---------- 清理与真实数据核对 ----------
    await cleanup();
    const after = {
      users: (await pg.query('SELECT count(*)::int n FROM users')).rows[0].n,
      classes: (await pg.query('SELECT count(*)::int n FROM classes')).rows[0].n,
      grades: (await pg.query('SELECT count(*)::int n FROM grades')).rows[0].n,
    };
    check('7) 真实数据未变（users/classes/grades）',
      base.users === after.users && base.classes === after.classes && base.grades === after.grades, { base, after });
    check('7) 夹具已清理（无残留年级/班级）',
      (await pg.query('SELECT count(*)::int n FROM grades WHERE grade_name LIKE $1', ['源测试%' + TAG])).rows[0].n === 0 &&
      (await pg.query('SELECT count(*)::int n FROM classes WHERE class_name LIKE $1', ['源测试班%' + TAG])).rows[0].n === 0);
  } catch (e) {
    fail++;
    console.log('  ✘ 异常：', e.message);
    try { await cleanup(); } catch (_) {}
  } finally {
    await pg.end();
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
