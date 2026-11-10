// ============================================================
// 作业模块路由（v3：任课老师 / 班主任 / 班长 / 管理员 角色模型）
// 角色（users.roles JSON：admin | head_teacher | subject_teacher | monitor）
//   任课老师 subject_teacher：发布作业（所带班级）、查看/导出【自己发布】作业的提交情况
//   班主任   head_teacher  ：任课老师全部权限 + 查看/导出【本班全部科目】作业（含其他老师发布）
//   班长     monitor       ：查看本班全部作业（按截止时间排序）+ 录入提交情况（座位表）
//   管理员   admin         ：只读全部班级 + 导出（不可发布、不可录入）
// 教师所带班级：teacher_classes(teacher_id, class_id, is_head_teacher)
// 数据：
//   homework_tasks(id, class_id, subject, title, date, deadline, remark, created_by, created_at)
//   homework_submissions(id, task_id, student_id, is_submitted, updated_at)
// ============================================================
const express = require('express');
const pool = require('../db');
const XLSX = require('xlsx');
const classSubjects = require('../lib/classSubjects');   // 班级选科 → 开设学科（v34）

const router = express.Router();

const HW_SUBJECTS = new Set([
  '语文', '数学', '英语', '物理', '化学', '生物',
  '政治', '历史', '地理', '科学', '信息', '体育', '音乐', '美术', '其他',
]);

// ------------------------------------------------------------
// 每日固定科目作业（班长端每天自动生成；班主任端查看各科提交情况）
//   需求：班主任不需要知道每科具体作业是什么，只要知道学生今天各科交没交。
//   数据形态：homework_tasks 里 title='今日作业' + is_daily=true + created_by=NULL 的普通任务
//            （提交情况沿用 homework_submissions，"录入"即勾选/取消勾选学生）
//   科目来源（v34 起，三级优先）：
//     1) classes.daily_subjects（管理员在「每日作业科目配置」里对该班的显式覆盖）
//     2) 班级选科：语文+数学+英语 + classes.elective_subjects（理科→物化生 / 文科→政史地 / 小理·小文·综合 按勾选）
//     3) system_settings.daily_homework_subjects（全局默认）
//   → 科目数量随班级实际开设学科动态变化（可能多于或少于 6 科）
//   幂等：唯一索引 (class_id, subject, title, date) → 每班每科每天只会有一条
// ------------------------------------------------------------
const DEFAULT_DAILY_SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物'];
const DAILY_TITLE = '今日作业';
const DAILY_SUBJECTS_KEY = 'daily_homework_subjects';
// 每日作业的默认截止时间（当天 HH:MM，可配置：system_settings.daily_homework_deadline）
const DAILY_DEADLINE_KEY = 'daily_homework_deadline';
const DEFAULT_DAILY_DEADLINE = '23:59';

// 读取"每日作业截止时间"配置（HH:MM）；非法/缺失 → 默认 23:59
async function getDailyDeadlineTime(client = pool) {
  try {
    const r = await client.query('SELECT value FROM system_settings WHERE key = $1', [DAILY_DEADLINE_KEY]);
    return normalizeDeadlineTime(r.rows[0] && r.rows[0].value) || DEFAULT_DAILY_DEADLINE;
  } catch (_) { return DEFAULT_DAILY_DEADLINE; }
}
// 'HH:MM' 校验（24 小时制）
function normalizeDeadlineTime(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  return String(m[1]).padStart(2, '0') + ':' + m[2];
}

function parseSubjectList(raw) {
  if (!raw) return [];
  return [...new Set(String(raw).split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean))];
}

// 读取生效科目：{ global, classSubjects, effective, source }
//   优先级（v34 起）：classes.daily_subjects（管理员显式覆盖）> 班级选科推导 > 全局默认
//   「班级选科推导」= 语文+数学+英语 + 选科科目（理科→物化生 / 文科→政史地 / 小理·小文·综合 按勾选）
//   → 班长端每日作业不再固定 6 科，而是按该班实际开设学科生成（可能多于或少于 6 科）
async function getDailySubjectConfig(classId) {
  const g = await pool.query('SELECT value FROM system_settings WHERE key = $1', [DAILY_SUBJECTS_KEY]);
  const global = parseSubjectList(g.rows[0] && g.rows[0].value);
  const effectiveGlobal = global.length ? global : DEFAULT_DAILY_SUBJECTS.slice();
  let classRow = null;
  if (Number.isInteger(Number(classId)) && Number(classId) > 0) {
    const r = await pool.query(
      'SELECT id, class_name, stream, elective_subjects, daily_subjects FROM classes WHERE id = $1',
      [Number(classId)]
    );
    classRow = r.rows[0] || null;
  }
  const resolved = classSubjects.resolveDailySubjects(classRow, effectiveGlobal);
  const sc = classSubjects.readClassStream(classRow);
  const classOverride = (resolved.source === 'class_override') ? resolved.subjects : null;
  return {
    global: effectiveGlobal,
    globalConfigured: global.length > 0,
    // 兼容字段：classSubjects = 管理员为该班显式配置的覆盖（没有则 null）
    classSubjects: classOverride,
    effective: resolved.subjects,
    // source: 'class_override' | 'class_stream' | 'global'（旧前端只认 class/global，这里同时给出兼容值）
    source: resolved.source === 'class_override' ? 'class' : (resolved.source === 'class_stream' ? 'class_stream' : 'global'),
    sourceDetail: resolved.detail,
    // 班级选科信息（管理端「每日作业科目配置」卡片展示"为什么是这几科"）
    className: classRow ? classRow.class_name : null,
    stream: sc.stream,
    electiveSubjects: sc.electiveSubjects,
    classEffectiveSubjects: classSubjects.effectiveSubjects(sc),
  };
}

// 幂等生成某班某天的每日作业；返回 { subjects, source, created, deadlineTime }
//   截止时间 = 该天 + 配置的 HH:MM（默认 23:59）
async function ensureDailyTasks(classId, dateStr) {
  const cfg = await getDailySubjectConfig(classId);
  const deadlineTime = await getDailyDeadlineTime();
  const created = [];
  for (const subject of cfg.effective) {
    const r = await pool.query(
      `INSERT INTO homework_tasks (class_id, subject, title, date, deadline, created_by, is_daily)
       VALUES ($1, $2, $3, $4::date, ($4::date + $5::time), NULL, true)
       ON CONFLICT (class_id, subject, title, date) DO NOTHING
       RETURNING id`,
      [classId, subject, DAILY_TITLE, dateStr, deadlineTime]
    );
    if (r.rowCount > 0) created.push({ id: r.rows[0].id, subject });
  }
  return { subjects: cfg.effective, source: cfg.source, created, deadlineTime };
}

// ------------------------------------------------------------
// 每天 0 点自动发布：为【每个班】生成当天的「每日作业」条目（定时任务）
//   · 为什么需要：此前条目是"打开页面时按需生成"（班长/老师打开作业统计才出现），
//     导致班主任当天一上班看不到各科条目。现在由定时任务在 00:00 统一生成；
//   · 幂等：唯一索引 (class_id, subject, title, date) → 重复执行不会产生重复条目；
//   · 兜底：服务在 00:00 未运行（关机/重启）→ 启动时补一次当天（catch-up），
//     页面上的按需生成仍然保留（双保险，不影响任何既有行为）。
// ------------------------------------------------------------
async function generateDailyForAllClasses(dateStr) {
  const date = validDateStr(dateStr) ? dateStr : todayStr();
  // 只给"有在读学生的在读班级"生成（归档班级不生成）
  const classes = (await pool.query(
    `SELECT c.id, c.class_name FROM classes c
      WHERE c.status IS DISTINCT FROM 'archived'
        AND EXISTS (SELECT 1 FROM students s
                     WHERE s.class_id = c.id AND s.is_active = true AND s.status = '在读')
      ORDER BY c.id`
  )).rows;
  const out = { date, classes: classes.length, created: 0, createdByClass: [], subjectsByClass: [], skipped: 0 };
  for (const c of classes) {
    const r = await ensureDailyTasks(c.id, date);
    out.subjectsByClass.push({ classId: c.id, className: c.class_name, subjects: r.subjects, source: r.source });
    if (r.created.length) {
      out.created += r.created.length;
      out.createdByClass.push({ classId: c.id, className: c.class_name, count: r.created.length });
    } else {
      out.skipped += 1;
    }
  }
  return out;
}

// 距下一个本地 00:00 的毫秒数（+offsetMs 偏移，避免恰好卡在边界）
function msUntilNextMidnight(now = new Date(), offsetMs = 5000) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(1000, next.getTime() - now.getTime() + offsetMs);
}

let dailyTimer = null;
async function runDailyAutoPublish(tag) {
  try {
    const r = await generateDailyForAllClasses(todayStr());
    console.log(`[每日作业自动发布${tag ? '·' + tag : ''}] ${r.date}：${r.classes} 个班，新建 ${r.created} 条，已存在跳过 ${r.skipped} 个班`);
    if (r.created > 0) {
      await pool.query(
        `INSERT INTO operation_logs (user_id, user_name, role, action, detail)
         VALUES (NULL, '系统', 'system', 'daily_homework_auto', $1)`,
        [JSON.stringify({ date: r.date, classes: r.classes, created: r.created, createdByClass: r.createdByClass })]
      ).catch(() => {});
    }
    return r;
  } catch (e) {
    console.error('[每日作业自动发布失败]', e.message);
    return null;
  }
}
function scheduleNextDailyRun() {
  const wait = msUntilNextMidnight();
  dailyTimer = setTimeout(async () => {
    await runDailyAutoPublish('0点定时');
    scheduleNextDailyRun();          // 重新排到下一天
  }, wait);
  if (dailyTimer.unref) dailyTimer.unref();   // 不阻止进程退出（测试/脚本友好）
  const at = new Date(Date.now() + wait);
  console.log(`[每日作业自动发布] 下次执行：${at.toLocaleString('zh-CN')}（每天 0 点）`);
}
function startDailyHomeworkScheduler() {
  // 启动即补一次当天（服务在 0 点没运行时也能有当天条目；幂等）
  runDailyAutoPublish('启动补发').then(() => scheduleNextDailyRun());
  return { msUntilNextMidnight };
}

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) {
  if (!d) return null;
  if (d instanceof Date) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const s = String(d);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}
function todayStr() { return fmtDate(new Date()); }
function validDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
// 解析截止时间：支持 'YYYY-MM-DD HH:MM' / 'YYYY-MM-DDTHH:MM' / ISO
function parseDeadline(v) {
  if (!v) return null;
  const s = String(v).trim().replace(' ', 'T');
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d;
}
function fmtDateTime(d) {
  if (!d) return '';
  const x = new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

async function logOperation(req, action, detail = {}) {
  try {
    const u = req.session.user;
    await pool.query(
      `INSERT INTO operation_logs (user_id, user_name, role, action, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [u.id, u.displayName || u.username, u.role, action, JSON.stringify(detail)]
    );
  } catch (_) { /* 日志失败不影响主流程 */ }
}

// ------------------------------------------------------------
// 读取当前操作者（角色 + 所带班级）
// ------------------------------------------------------------
async function loadActor(req) {
  const su = req.session && req.session.user;
  if (!su) return null;
  const r = await pool.query(
    `SELECT id, role, class_id, roles, subject, COALESCE(real_name, display_name, username) AS display_name
       FROM users WHERE id = $1`,
    [su.id]
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  let roles = row.roles;
  if (typeof roles === 'string') { try { roles = JSON.parse(roles); } catch (_) { roles = []; } }
  if (!Array.isArray(roles)) roles = [];

  let teachClassIds = [];
  let headClassIds = [];
  const classRoles = new Map(); // classId -> { role: 'head_teacher'|'subject_teacher', subject }
  if (row.role === 'teacher' || row.role === 'admin') {
    const tc = await pool.query(
      `SELECT class_id,
              COALESCE(role_in_class, CASE WHEN is_head_teacher THEN 'head_teacher' ELSE 'subject_teacher' END) AS role_in_class,
              subject
         FROM teacher_classes WHERE teacher_id = $1`,
      [row.id]
    );
    for (const x of tc.rows) {
      classRoles.set(x.class_id, { role: x.role_in_class, subject: x.subject || null });
    }
    teachClassIds = tc.rows.map((x) => x.class_id);
    // 班主任判断改为【班级级】：该班 role_in_class = head_teacher
    headClassIds = tc.rows.filter((x) => x.role_in_class === 'head_teacher').map((x) => x.class_id);
  }
  const a = {
    id: row.id,
    role: row.role,
    classId: row.class_id || null,
    roles,
    subject: row.subject || null,   // 个人中心绑定的所教学科（账号级默认学科）
    name: row.display_name,
    isAdmin: row.role === 'admin' || roles.includes('admin'),
    isMonitor: row.role === 'monitor',
    isStudent: row.role === 'student',
    isTeacher: row.role === 'teacher',
    teachClassIds,
    headClassIds,
    classRoles,
    teaches: (cid) => teachClassIds.includes(Number(cid)),
    isHeadOf: (cid) => headClassIds.includes(Number(cid)),
    roleInClass: (cid) => {
      const c = classRoles.get(Number(cid));
      return c ? c.role : null;
    },
    subjectForClass: (cid) => {
      const c = classRoles.get(Number(cid));
      return (c && c.subject) || row.subject || null;
    },
  };
  a.isHeadTeacher = a.isTeacher && headClassIds.length > 0;
  // 纯任课老师（没有任何班主任班级）：作业范围锁定为【所教学科】
  a.subjectLocked = a.isTeacher && headClassIds.length === 0;
  return a;
}

// 是否可写（录入）：仅班长
function canRecord(a) { return !!a && a.isMonitor; }
// 是否可发布：任课老师/班主任
function canPublish(a) { return !!a && (a.isTeacher || a.isAdmin); }
// 是否可导出：教师（任课/班主任）与管理员
function canExport(a) { return !!a && (a.isTeacher || a.isAdmin); }

// ------------------------------------------------------------
// 教师（任课/班主任）的班级+发布者范围
//   班主任：所带【班主任班级】可看全部科目/全部发布老师；
//           仅在【任教但非班主任】的班级，只能看自己发布的作业
//   mine=1 时强制只看自己发布的
// 返回 null 表示已写入 where；{error}/{empty} 表示需短路
// ------------------------------------------------------------
// 解析多班级参数（年级联动筛选用）：classIds=1,2,3
//   仅用于「选了年级但班级=全部班级」的场景；单个 classId 仍走原参数
function parseClassIdsParam(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const ids = [...new Set(String(raw).split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isInteger(n) && n > 0))];
  return ids.length ? ids : null;
}

function applyTeacherScope(a, classIdParam, push, where, { mine = false, classIds = null, includeDaily = false } = {}) {
  // includeDaily=1：除"我发布的作业"外，还带上【这些班级的每日作业】(is_daily=true)。
  //   为什么需要：班主任在「作业管理」页要同时看到"系统自动发布的每日作业 + 自己（或其他老师）手动发布的作业"。
  //   纯任课老师：额外带上"我所教班级 + 我所教学科"的每日作业（与自己发布的本学科作业并列，不越权看别科）。
  //   实现：把"我发布的"那一支，扩成 `(我发布的) OR (每日作业 且 同样的班级/学科条件)`。
  const mineOrDaily = (classCond, subjCond) => {
    const mineConds = [classCond, `t.created_by = ${push(a.id)}`];
    if (subjCond) mineConds.push(subjCond);
    if (!includeDaily) return '(' + mineConds.join(' AND ') + ')';
    const dailyConds = [classCond, 't.is_daily = true'];
    if (subjCond) dailyConds.push(subjCond);
    return '((' + mineConds.join(' AND ') + ') OR (' + dailyConds.join(' AND ') + '))';
  };
  if (classIds && classIds.length) {
    // 多班范围（年级筛选）：逐班按【该班角色】收敛，与单选逻辑完全一致；
    // 只要有班级不在自己范围内 → 403（与单选一致，不静默忽略）
    const foreign = classIds.filter((cid) => !a.roleInClass(cid));
    if (foreign.length) return { error: '无权访问该班级作业' };
    const groups = [];
    for (const cid of classIds) {
      const roleInClass = a.roleInClass(cid);
      if (!roleInClass) continue;
      const classCond = `t.class_id = ${push(cid)}`;
      if (roleInClass === 'head_teacher') {
        groups.push(classCond);
      } else {
        const subj = a.subjectForClass(cid);
        groups.push(mineOrDaily(classCond, subj ? `t.subject = ${push(subj)}` : null));
      }
    }
    if (groups.length === 0) return { empty: true };
    where.push('(' + groups.join(' OR ') + ')');
    if (mine && !includeDaily) where.push(`t.created_by = ${push(a.id)}`);
    return null;
  }
  if (classIdParam) {
    // 单个班级：按【该班的角色】判定 —— 班主任看全班全部科目；任课老师只看自己发布的本学科
    const roleInClass = a.roleInClass(classIdParam);
    if (!roleInClass) return { error: '无权访问该班级作业' };
    const classCond = `t.class_id = ${push(classIdParam)}`;
    where.push(classCond);
    if (roleInClass !== 'head_teacher') {
      const subj = a.subjectForClass(classIdParam);
      where.push(mineOrDaily(classCond, subj ? `t.subject = ${push(subj)}` : null));
    }
  } else {
    const heads = a.headClassIds;                                  // 班主任班级：可看全部科目（含每日作业）
    const teachOnly = a.teachClassIds.filter((cid) => !heads.includes(cid)); // 仅任课班级：自己发布的本学科 + 本学科每日作业
    if (heads.length === 0 && teachOnly.length === 0) return { empty: true };
    const groups = [];
    if (heads.length > 0) groups.push(`t.class_id = ANY(${push(heads)}::int[])`);
    for (const cid of teachOnly) {
      const subj = a.subjectForClass(cid);
      const classCond = `t.class_id = ${push(cid)}`;
      groups.push(mineOrDaily(classCond, subj ? `t.subject = ${push(subj)}` : null));
    }
    // 任课班级那一支必须自带 class_id 条件（heads 为空时不能退化成"全库"）
    where.push('(' + groups.join(' OR ') + ')');
  }
  if (mine && !includeDaily) where.push(`t.created_by = ${push(a.id)}`);
  return null;
}

// 任务可见性（详情/单个操作）
async function loadTask(id) {
  const r = await pool.query(
    `SELECT t.id, t.class_id, t.subject, t.title, t.date, t.deadline, t.remark, t.created_by, t.created_at,
            t.is_daily,
            c.class_name, COALESCE(u.real_name, u.display_name, u.username) AS teacher_name,
            u.role AS teacher_role
       FROM homework_tasks t
       LEFT JOIN classes c ON c.id = t.class_id
       LEFT JOIN users u ON u.id = t.created_by
      WHERE t.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

function canViewTask(a, task) {
  if (!a || !task) return false;
  if (a.isAdmin) return true;
  if (a.isMonitor) return a.classId === task.class_id;
  if (a.isTeacher) {
    const roleInClass = a.roleInClass(task.class_id);
    // 该班班主任：可看本班全部科目
    if (roleInClass === 'head_teacher') return true;
    // 该班任课老师：只看自己发布的本学科
    const subj = a.subjectForClass(task.class_id);
    if (roleInClass === 'subject_teacher') {
      return task.created_by === a.id && (!subj || task.subject === subj);
    }
    // 该班没有带班记录：仅本人发布、且学科匹配（或本身不锁定学科）时可看
    if (task.created_by === a.id) {
      return !a.subjectLocked || (!!a.subject && task.subject === a.subject);
    }
    return false;
  }
  return false;
}

// ------------------------------------------------------------
// 列表统计（含发布老师、截止时间、未交名单）
// where 片段由调用方拼装（含 $ 占位符，params 顺序一致）
// ------------------------------------------------------------
async function buildTaskList(whereSql, params, orderSql) {
  const tasksRes = await pool.query(
    `SELECT t.id, t.class_id, t.subject, t.title, t.date, t.deadline, t.remark,
            t.created_by, t.created_at, t.is_daily, c.class_name,
            COALESCE(u.real_name, u.display_name, u.username) AS teacher_name,
            u.role AS teacher_role
       FROM homework_tasks t
       LEFT JOIN classes c ON c.id = t.class_id
       LEFT JOIN users u ON u.id = t.created_by
      ${whereSql}
      ${orderSql || 'ORDER BY t.deadline ASC, t.id ASC'}`,
    params
  );
  const tasks = tasksRes.rows;
  const empty = {
    tasks: [],
    stats: { taskCount: 0, studentSlots: 0, submittedCount: 0, notSubmittedCount: 0, avgRate: 0 },
    bySubject: [],
  };
  if (tasks.length === 0) return empty;

  const classIds = [...new Set(tasks.map((t) => t.class_id))];
  const stuRes = await pool.query(
    `SELECT id, student_no, name, class_id
       FROM students
      WHERE is_active = true AND status = '在读' AND class_id = ANY($1::int[])
      ORDER BY student_no`,
    [classIds]
  );
  const studentsByClass = new Map();
  for (const s of stuRes.rows) {
    if (!studentsByClass.has(s.class_id)) studentsByClass.set(s.class_id, []);
    studentsByClass.get(s.class_id).push({ id: s.id, studentNo: s.student_no, name: s.name });
  }

  const subRes = await pool.query(
    'SELECT task_id, student_id, is_submitted FROM homework_submissions WHERE task_id = ANY($1::int[])',
    [tasks.map((t) => t.id)]
  );
  const subByTask = new Map();
  const subCountByTask = new Map(); // 已录入（存在提交记录）的人数 → 用于"已收/待收"状态
  for (const r of subRes.rows) {
    if (!subByTask.has(r.task_id)) subByTask.set(r.task_id, new Map());
    subByTask.get(r.task_id).set(r.student_id, r.is_submitted);
    subCountByTask.set(r.task_id, (subCountByTask.get(r.task_id) || 0) + 1);
  }

  const bySubjectMap = new Map();
  let totalTasks = 0, totalSlots = 0, totalSubmitted = 0, totalNotSubmitted = 0;
  const out = tasks.map((t) => {
    const students = studentsByClass.get(t.class_id) || [];
    const subs = subByTask.get(t.id) || new Map();
    let submitted = 0;
    const notSubmitted = [];
    for (const s of students) {
      if (subs.get(s.id) === true) submitted += 1;
      else notSubmitted.push(s);
    }
    const total = students.length;
    totalTasks += 1;
    totalSlots += total;
    totalSubmitted += submitted;
    totalNotSubmitted += notSubmitted.length;
    if (!bySubjectMap.has(t.subject)) bySubjectMap.set(t.subject, { subject: t.subject, total: 0, submitted: 0 });
    const bs = bySubjectMap.get(t.subject);
    bs.total += total;
    bs.submitted += submitted;
    return {
      id: t.id,
      classId: t.class_id,
      className: t.class_name || null,
      subject: t.subject,
      title: t.title,
      date: fmtDate(t.date),
      deadline: t.deadline ? new Date(t.deadline).toISOString() : null,
      deadlineText: fmtDateTime(t.deadline),
      remark: t.remark || null,
      teacherId: t.created_by,
      teacherName: t.teacher_name || null,
      // 管理员发布的作业：前端标注「管理员发布」（管理员可模拟任课老师发布用于测试）
      publisherIsAdmin: t.teacher_role === 'admin',
      // 每日固定科目作业（系统自动生成，无需老师先发布）：前端标注「每日作业」
      isDaily: t.is_daily === true,
      createdAt: t.created_at,
      total,
      submitted,
      // 已收/待收：班长是否已录入该作业的提交情况（存在提交记录即视为已收）
      recordedCount: subCountByTask.get(t.id) || 0,
      recorded: (subCountByTask.get(t.id) || 0) > 0,
      notSubmitted: notSubmitted.map((s) => ({ id: s.id, name: s.name, studentNo: s.studentNo })),
    };
  });

  const bySubject = [...bySubjectMap.values()].map((b) => ({
    subject: b.subject,
    total: b.total,
    submitted: b.submitted,
    rate: b.total > 0 ? Math.round((b.submitted / b.total) * 1000) / 10 : 0,
  }));

  return {
    tasks: out,
    stats: {
      taskCount: totalTasks,
      studentSlots: totalSlots,
      submittedCount: totalSubmitted,
      notSubmittedCount: totalNotSubmitted,
      avgRate: totalSlots > 0 ? Math.round((totalSubmitted / totalSlots) * 1000) / 10 : 0,
    },
    bySubject,
  };
}

// ------------------------------------------------------------
// GET /api/homework/daily-subjects?classId=xx
//   每日作业科目配置：全局默认 + 班级覆盖 + 生效列表（登录的作业相关角色可读）
// ------------------------------------------------------------
router.get('/homework/daily-subjects', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (a.isStudent) return res.status(403).json({ error: '无权限：学生不能查看作业设置' });
    let classId = req.query.classId ? Number(req.query.classId) : null;
    if (!Number.isInteger(classId) || classId <= 0) classId = a.classId || null;
    if (classId && !a.isAdmin) {
      const ok = classId === a.classId || a.isHeadOf(classId) || a.teaches(classId);
      if (!ok) return res.status(403).json({ error: '无权限：该班级不在你的范围内' });
    }
    const cfg = await getDailySubjectConfig(classId);
    res.json({
      classId: classId || null,
      isAdmin: a.isAdmin,
      canEdit: a.isAdmin,
      allSubjects: [...HW_SUBJECTS],
      defaults: DEFAULT_DAILY_SUBJECTS.slice(),
      title: DAILY_TITLE,
      // 每日作业截止时间（可配置，默认 23:59）+ 自动发布时间说明（每天 0 点由定时任务生成）
      deadlineTime: await getDailyDeadlineTime(),
      deadlineDefault: DEFAULT_DAILY_DEADLINE,
      autoPublishAt: '每天 00:00（定时任务）',
      ...cfg,
    });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------
// PUT /api/homework/daily-subjects —— 管理员配置每日作业科目（仅管理员）
//   body: { classId: null|number, subjects: ['语文', ...] }
//     classId 为空 → 改全局默认；带 classId → 只覆盖该班
//     subjects 传空数组 → 该班恢复"使用全局默认"
// ------------------------------------------------------------
router.put('/homework/daily-subjects', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!a.isAdmin) return res.status(403).json({ error: '无权限：仅管理员可配置每日作业科目' });
    const body = req.body || {};
    // 可选：同时更新"每日作业截止时间"（HH:MM，默认 23:59）——与科目配置同一个卡片提交
    if (body.deadlineTime !== undefined && body.deadlineTime !== null && String(body.deadlineTime).trim() !== '') {
      const t = normalizeDeadlineTime(body.deadlineTime);
      if (!t) return res.status(400).json({ error: '截止时间格式应为 HH:MM（24 小时制，如 23:59）' });
      await pool.query(
        `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [DAILY_DEADLINE_KEY, t]
      );
      await logOperation(req, 'daily_deadline_update', { deadlineTime: t });
    }
    const raw = Array.isArray(body.subjects) ? body.subjects : null;
    if (!raw) {
      if (body.deadlineTime !== undefined) {
        // 只改截止时间的调用：返回最新配置即可
        const cid = Number(body.classId) > 0 ? Number(body.classId) : null;
        return res.json({ deadlineTime: await getDailyDeadlineTime(), ...(await getDailySubjectConfig(cid)) });
      }
      return res.status(400).json({ error: 'subjects 必须是数组' });
    }
    const subjects = [];
    for (const s of raw) {
      const v = String(s == null ? '' : s).trim();
      if (!v) continue;
      if (!HW_SUBJECTS.has(v)) return res.status(400).json({ error: `学科无效：${v}` });
      if (!subjects.includes(v)) subjects.push(v);
    }
    if (subjects.length > 15) return res.status(400).json({ error: '科目最多 15 个' });
    let classId = (body.classId === null || body.classId === undefined || body.classId === '') ? null : Number(body.classId);
    if (classId !== null && (!Number.isInteger(classId) || classId <= 0)) {
      return res.status(400).json({ error: '班级参数无效' });
    }
    if (classId === null) {
      if (subjects.length === 0) return res.status(400).json({ error: '全局默认科目不能为空' });
      await pool.query(
        `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [DAILY_SUBJECTS_KEY, subjects.join(',')]
      );
      await logOperation(req, 'daily_subjects_update', { scope: 'global', subjects });
    } else {
      const cls = await pool.query('SELECT id FROM classes WHERE id = $1', [classId]);
      if (cls.rowCount === 0) return res.status(400).json({ error: '所选班级不存在' });
      await pool.query('UPDATE classes SET daily_subjects = $2 WHERE id = $1', [classId, subjects.length ? subjects : null]);
      await logOperation(req, 'daily_subjects_update', { scope: 'class', classId, subjects });
    }
    const cfg = await getDailySubjectConfig(classId);
    res.json({ classId, deadlineTime: await getDailyDeadlineTime(), ...cfg });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------
// POST /api/homework/daily/ensure —— 生成"当天"的每日作业（幂等）
//   body: { classId?, date? }（date 只允许当天；不传=今天）
//   权限：班长（本班）/ 教师（所带班级）/ 管理员（须指定班级）
//   返回：该班当天每日作业条目（含已交/未交名单，供班长端与班主任端直接渲染）
// ------------------------------------------------------------
router.post('/homework/daily/ensure', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (a.isStudent) return res.status(403).json({ error: '无权限：学生不能查看作业统计' });
    const today = todayStr();
    const date = String((req.body && req.body.date) || today);
    if (!validDateStr(date)) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
    if (date !== today) return res.status(400).json({ error: `只能生成当天的每日作业（今天：${today}）` });

    let classId = (req.body && req.body.classId) ? Number(req.body.classId) : null;
    if (!Number.isInteger(classId) || classId <= 0) classId = a.classId || null;
    if (!Number.isInteger(classId) || classId <= 0) {
      return res.status(400).json({ error: '缺少班级参数（该账号未绑定班级）' });
    }
    if (!a.isAdmin) {
      const ok = classId === a.classId || a.isHeadOf(classId) || a.teaches(classId);
      if (!ok) return res.status(403).json({ error: '无权限：该班级不在你的范围内' });
    }
    const r = await ensureDailyTasks(classId, date);
    const list = await buildTaskList(
      'WHERE t.class_id = $1 AND t.date = $2::date AND t.is_daily = true',
      [classId, date, r.subjects],
      'ORDER BY array_position($3::text[], t.subject), t.id ASC'   // 按配置的科目顺序展示
    );
    res.json({
      classId,
      date,
      subjects: r.subjects,
      source: r.source,
      createdCount: r.created.length,
      created: r.created,
      tasks: list.tasks,
      stats: list.stats,
    });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------
// GET /api/homework/tasks
// 列表（角色范围自动收敛）：
//   admin          全部班级（可 classId 过滤）
//   head_teacher   本班（班主任班级；多个则全部）——含全部科目/全部发布老师
//   subject_teacher仅【自己发布】的作业（可 mine=0 查看所带班级全部？——按需求不给，见下方参数）
//   monitor        本班全部作业（按截止时间排序）
// 参数：date | from,to | subject | classId | classIds（多班，年级联动用）| teacherId | mine=1
// ------------------------------------------------------------
router.get('/homework/tasks', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (a.isStudent) return res.status(403).json({ error: '无权限：学生不能查看作业统计' });

    const where = [];
    const params = [];
    const push = (v) => { params.push(v); return '$' + params.length; };

    // ---- 班级范围 ----
    const classIdParam = req.query.classId ? Number(req.query.classId) : null;
    const classIdsParam = classIdParam ? null : parseClassIdsParam(req.query.classIds);
    const mineFlag = String(req.query.mine || '') === '1';
    // includeDaily=1：除"我发布的"之外，还带上【本班/我所带班级的每日作业】（系统自动发布）
    //   用于「作业管理」页：班主任要同时看到自动作业 + 手动作业
    const includeDaily = String(req.query.includeDaily || '') === '1';
    if (a.isAdmin) {
      if (classIdParam) where.push(`t.class_id = ${push(classIdParam)}`);
      else if (classIdsParam) where.push(`t.class_id = ANY(${push(classIdsParam)}::int[])`);
    } else if (a.isMonitor) {
      if (!a.classId) return res.status(400).json({ error: '当前班长账号未绑定班级' });
      if (classIdParam && classIdParam !== a.classId) {
        return res.status(403).json({ error: '无权查看其他班级作业' });
      }
      if (classIdsParam && classIdsParam.some((cid) => cid !== a.classId)) {
        return res.status(403).json({ error: '无权查看其他班级作业' });
      }
      where.push(`t.class_id = ${push(a.classId)}`);
      if (mineFlag) {
        const meId = push(a.id);
        where.push(includeDaily ? `(t.created_by = ${meId} OR t.is_daily = true)` : `t.created_by = ${meId}`);
      }
    } else if (a.isTeacher) {
      const scoped = applyTeacherScope(a, classIdParam, push, where, { mine: mineFlag, classIds: classIdsParam, includeDaily });
      if (scoped && scoped.error) return res.status(403).json({ error: scoped.error });
      if (scoped && scoped.empty) {
        return res.json({
          tasks: [], stats: { taskCount: 0, studentSlots: 0, submittedCount: 0, notSubmittedCount: 0, avgRate: 0 },
          bySubject: [], role: a.roles, isHeadTeacher: a.isHeadTeacher, canPublish: false,
          canRecord: false, headClassIds: [], teachClassIds: [],
        });
      }
    } else {
      return res.status(403).json({ error: '无权限' });
    }

    // ---- 其他筛选 ----
    const date = String(req.query.date || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    if (date) {
      if (!validDateStr(date)) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
      where.push(`t.date = ${push(date)}`);
    } else {
      if (from) {
        if (!validDateStr(from)) return res.status(400).json({ error: '起始日期格式应为 YYYY-MM-DD' });
        where.push(`t.date >= ${push(from)}`);
      }
      if (to) {
        if (!validDateStr(to)) return res.status(400).json({ error: '结束日期格式应为 YYYY-MM-DD' });
        where.push(`t.date <= ${push(to)}`);
      }
    }
    const subject = String(req.query.subject || '').trim();
    // 纯任课老师：学科锁定为个人中心绑定的所教学科（不能查看其他学科）
    if (a.subjectLocked) {
      if (!a.subject) {
        // 未绑定学科：不返回任何作业，并提示前端去个人中心绑定
        return res.json({
          tasks: [], stats: { taskCount: 0, studentSlots: 0, submittedCount: 0, notSubmittedCount: 0, avgRate: 0 },
          bySubject: [], filter: { date: date || null, from: from || null, to: to || null, subject: null },
          role: a.roles, isHeadTeacher: false, canPublish: false, canRecord: false,
          headClassIds: [], teachClassIds: a.teachClassIds,
          subjectLocked: true, mySubject: null, needSubject: true,
        });
      }
      if (subject && subject !== a.subject) {
        return res.status(403).json({ error: `任课老师只能查看自己任教的学科（${a.subject}）` });
      }
      where.push(`t.subject = ${push(a.subject)}`);
    } else if (subject) {
      where.push(`t.subject = ${push(subject)}`);
    }
    if (req.query.teacherId) {
      const tid = Number(req.query.teacherId);
      if (Number.isInteger(tid)) where.push(`t.created_by = ${push(tid)}`);
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const data = await buildTaskList(whereSql, params);
    res.json({
      ...data,
      filter: { date: date || null, from: from || null, to: to || null, subject: a.subjectLocked ? a.subject : (subject || null) },
      role: a.roles,
      isHeadTeacher: a.isHeadTeacher,
      subjectLocked: !!a.subjectLocked,
      mySubject: a.subject,
      // 学科筛选唯一事实来源：教师=绑定学科（不可改）；其他角色=当前筛选值（可改）
      subjectFilter: a.isTeacher ? a.subject : (subject || null),
      subjectEditable: !a.isTeacher,
      needSubject: false,
      canPublish: canPublish(a),
      canRecord: canRecord(a),
      headClassIds: a.headClassIds,
      teachClassIds: a.teachClassIds,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// POST /api/homework/tasks —— 发布作业（任课老师/班主任，可多班级）
// body: { classIds: [..], subject, title, deadline, remark? }
// ------------------------------------------------------------
router.post('/homework/tasks', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!canPublish(a)) {
      return res.status(403).json({
        error: a.isMonitor ? '无权限：班长不能发布作业（由任课老师发布）'
          : '无权限：仅任课老师/班主任/管理员可发布作业',
      });
    }
    const subject = String(req.body.subject || '').trim();
    const title = String(req.body.title || '').trim();
    const remark = String(req.body.remark || '').trim();
    const deadline = parseDeadline(req.body.deadline);
    let classIds = Array.isArray(req.body.classIds) ? req.body.classIds : [];
    classIds = [...new Set(classIds.map(Number).filter((x) => Number.isInteger(x) && x > 0))];

    if (classIds.length === 0) return res.status(400).json({ error: '请选择要发布的班级' });
    if (classIds.length > 20) return res.status(400).json({ error: '单次最多发布到 20 个班级' });
    if (!HW_SUBJECTS.has(subject)) return res.status(400).json({ error: '请选择有效的学科' });
    if (!title) return res.status(400).json({ error: '作业标题不能为空' });
    if (title.length > 100) return res.status(400).json({ error: '作业标题不能超过 100 字' });
    if (!deadline) return res.status(400).json({ error: '请选择提交截止时间' });
    if (remark.length > 200) return res.status(400).json({ error: '备注不能超过 200 字' });

    // 班级范围：教师只能给自己所带班级发布；管理员可发布到任意班级（用于配置/测试）
    if (!a.isAdmin) {
      const notMine = classIds.filter((cid) => !a.teaches(cid) && !a.isHeadOf(cid));
      if (notMine.length > 0) {
        return res.status(403).json({ error: '只能给自己所带的班级发布作业', invalidClassIds: notMine });
      }
    } else {
      const exist = await pool.query('SELECT id FROM classes WHERE id = ANY($1::int[])', [classIds]);
      const valid = new Set(exist.rows.map((r) => r.id));
      const bad = classIds.filter((cid) => !valid.has(cid));
      if (bad.length > 0) return res.status(400).json({ error: '班级不存在', invalidClassIds: bad });
    }
    // 学科不可修改：教师只能发布"自己所教学科"的作业（前端学科字段只读，这里做后端兜底）
    if (a.isTeacher) {
      const bad = classIds.filter((cid) => a.subjectForClass(cid) !== subject);
      if (bad.length > 0) {
        const allowed = [...new Set(classIds.map((cid) => a.subjectForClass(cid)).filter(Boolean))];
        if (allowed.length === 0) {
          return res.status(400).json({ error: '请先到个人中心绑定所教学科', invalidClassIds: bad });
        }
        return res.status(403).json({
          error: `学科不可修改：你只能发布所教学科（${allowed.join('/')}）的作业`,
          mySubject: allowed.length === 1 ? allowed[0] : null,
          allowedSubjects: allowed,
          invalidClassIds: bad,
        });
      }
    }
    const date = fmtDate(deadline);
    const created = [];
    const skipped = [];
    for (const cid of classIds) {
      const ins = await pool.query(
        `INSERT INTO homework_tasks (class_id, subject, title, date, deadline, remark, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (class_id, subject, title, date) DO NOTHING
         RETURNING id, class_id, subject, title, date, deadline, remark`,
        [cid, subject, title, date, deadline, remark || null, a.id]
      );
      if (ins.rowCount > 0) created.push(ins.rows[0]);
      else skipped.push(cid);
    }
    await logOperation(req, 'homework_publish', {
      subject, title, deadline: fmtDateTime(deadline), classIds, createdCount: created.length, skipped,
    });
    res.status(201).json({
      created: created.map((t) => ({
        id: t.id, classId: t.class_id, subject: t.subject, title: t.title,
        date: fmtDate(t.date), deadlineText: fmtDateTime(t.deadline), remark: t.remark || null,
      })),
      skipped,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// PUT /api/homework/tasks/:id —— 修改自己发布的作业（标题/截止时间/备注）
// ------------------------------------------------------------
router.put('/homework/tasks/:id', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的作业ID' });
    const task = await loadTask(id);
    if (!task) return res.status(404).json({ error: '作业任务不存在' });
    if (task.created_by !== a.id) {
      return res.status(403).json({ error: '只能修改自己发布的作业' });
    }

    const sets = [];
    const params = [];
    if (req.body.title !== undefined) {
      const title = String(req.body.title || '').trim();
      if (!title) return res.status(400).json({ error: '作业标题不能为空' });
      if (title.length > 100) return res.status(400).json({ error: '作业标题不能超过 100 字' });
      params.push(title); sets.push(`title = $${params.length}`);
    }
    if (req.body.deadline !== undefined) {
      const dl = parseDeadline(req.body.deadline);
      if (!dl) return res.status(400).json({ error: '提交截止时间格式不正确' });
      params.push(dl); sets.push(`deadline = $${params.length}`);
      params.push(fmtDate(dl)); sets.push(`date = $${params.length}`);
    }
    if (req.body.remark !== undefined) {
      const remark = String(req.body.remark || '').trim();
      if (remark.length > 200) return res.status(400).json({ error: '备注不能超过 200 字' });
      params.push(remark || null); sets.push(`remark = $${params.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: '没有需要修改的内容' });

    params.push(id);
    try {
      const up = await pool.query(
        `UPDATE homework_tasks SET ${sets.join(', ')} WHERE id = $${params.length}
         RETURNING id, class_id, subject, title, date, deadline, remark`,
        params
      );
      const t = up.rows[0];
      await logOperation(req, 'homework_task_update', { taskId: id, title: t.title });
      res.json({
        task: {
          id: t.id, classId: t.class_id, subject: t.subject, title: t.title,
          date: fmtDate(t.date), deadlineText: fmtDateTime(t.deadline), remark: t.remark || null,
        },
      });
    } catch (e) {
      if (e && e.code === '23505') {
        return res.status(409).json({ error: '该班当天同一学科下已存在同名作业' });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// DELETE /api/homework/tasks/:id —— 删除自己发布的作业（级联删除提交记录）
// ------------------------------------------------------------
router.delete('/homework/tasks/:id', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的作业ID' });
    const task = await loadTask(id);
    if (!task) return res.status(404).json({ error: '作业任务不存在' });
    if (task.created_by !== a.id) {
      return res.status(403).json({ error: '只能删除自己发布的作业' });
    }
    await pool.query('DELETE FROM homework_tasks WHERE id = $1', [id]);
    await logOperation(req, 'homework_task_delete', { taskId: id, title: task.title });
    res.json({ deleted: true, id });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// GET /api/homework/tasks/:id —— 作业详情（提交情况）
// 可见：发布者 / 该班班主任 / 该班班长 / 管理员
// ------------------------------------------------------------
router.get('/homework/tasks/:id', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的作业ID' });
    const task = await loadTask(id);
    if (!task) return res.status(404).json({ error: '作业任务不存在' });
    if (!canViewTask(a, task)) return res.status(403).json({ error: '无权查看该作业' });

    const stuRes = await pool.query(
      `SELECT id, student_no, name, seat_row, seat_col
         FROM students
        WHERE class_id = $1 AND is_active = true AND status = '在读'
        ORDER BY student_no`,
      [task.class_id]
    );
    const students = stuRes.rows.map((r) => ({
      id: r.id, studentNo: r.student_no, name: r.name,
      seatRow: r.seat_row || 0, seatCol: r.seat_col || 0,
    }));
    const subRes = await pool.query(
      'SELECT student_id, is_submitted, updated_at FROM homework_submissions WHERE task_id = $1',
      [id]
    );
    const submissions = {};
    const updatedAt = {};
    for (const r of subRes.rows) {
      submissions[r.student_id] = r.is_submitted;
      updatedAt[r.student_id] = r.updated_at;
    }
    const submittedList = [];
    const notSubmittedList = [];
    for (const s of students) {
      if (submissions[s.id] === true) submittedList.push(s);
      else notSubmittedList.push(s);
    }
    const clsRes = await pool.query('SELECT seat_config FROM classes WHERE id = $1', [task.class_id]);
    const seatConfig = (clsRes.rows[0] && clsRes.rows[0].seat_config) || null;

    res.json({
      task: {
        id: task.id, classId: task.class_id, className: task.class_name || null,
        subject: task.subject, title: task.title, date: fmtDate(task.date),
        deadline: task.deadline ? new Date(task.deadline).toISOString() : null,
        deadlineText: fmtDateTime(task.deadline),
        remark: task.remark || null,
        teacherId: task.created_by, teacherName: task.teacher_name || null,
        publisherIsAdmin: task.teacher_role === 'admin',
        // 每日固定科目作业：录入界面默认"全部已交"（班长取消勾选=未交）
        isDaily: task.is_daily === true,
        createdAt: task.created_at,
      },
      students,
      submissions,
      updatedAt,
      seatConfig,
      submittedList,
      notSubmittedList,
      stats: {
        total: students.length,
        submitted: submittedList.length,
        notSubmitted: notSubmittedList.length,
        rate: students.length > 0 ? Math.round((submittedList.length / students.length) * 1000) / 10 : 0,
      },
      canRecord: canRecord(a) && a.classId === task.class_id,
      canExport: canExport(a),
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// POST /api/homework/submissions —— 单个学生提交状态（仅班长，本班）
// ------------------------------------------------------------
router.post('/homework/submissions', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!canRecord(a)) return res.status(403).json({ error: '无权限：仅班长可录入作业提交情况' });
    const taskId = Number(req.body.taskId);
    const studentId = Number(req.body.studentId);
    if (!Number.isInteger(taskId) || !Number.isInteger(studentId)) {
      return res.status(400).json({ error: 'taskId 和 studentId 必须是数字' });
    }
    const isSubmitted = req.body.isSubmitted === true || req.body.isSubmitted === 'true';
    const task = await loadTask(taskId);
    if (!task) return res.status(404).json({ error: '作业任务不存在' });
    if (task.class_id !== a.classId) return res.status(403).json({ error: '该作业不属于本班' });

    const stu = await pool.query(
      `SELECT id FROM students WHERE id = $1 AND is_active = true AND status = '在读' AND class_id = $2`,
      [studentId, a.classId]
    );
    if (stu.rowCount === 0) return res.status(404).json({ error: '学生不存在或不在本班在读名单中' });

    await pool.query(
      `INSERT INTO homework_submissions (task_id, student_id, is_submitted)
       VALUES ($1, $2, $3)
       ON CONFLICT (task_id, student_id) DO UPDATE
         SET is_submitted = EXCLUDED.is_submitted, updated_at = now()`,
      [taskId, studentId, isSubmitted]
    );
    await logOperation(req, 'homework_submission', { taskId, studentId, isSubmitted });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// POST /api/homework/submissions/batch —— 批量保存（录入界面"保存"）
// ------------------------------------------------------------
router.post('/homework/submissions/batch', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!canRecord(a)) return res.status(403).json({ error: '无权限：仅班长可录入作业提交情况' });
    const taskId = Number(req.body.taskId);
    const updates = Array.isArray(req.body.updates) ? req.body.updates : [];
    if (!Number.isInteger(taskId)) return res.status(400).json({ error: '缺少有效的 taskId' });
    const clean = [];
    for (const u of updates) {
      const sid = Number(u && u.studentId);
      if (Number.isInteger(sid) && sid > 0) {
        clean.push({ studentId: sid, isSubmitted: u.isSubmitted === true || u.isSubmitted === 'true' });
      }
    }
    if (clean.length === 0) return res.status(400).json({ error: '没有需要保存的修改' });
    if (clean.length > 500) return res.status(400).json({ error: '单次保存不能超过 500 条' });

    const task = await loadTask(taskId);
    if (!task) return res.status(404).json({ error: '作业任务不存在' });
    if (task.class_id !== a.classId) return res.status(403).json({ error: '该作业不属于本班' });

    const stuRes = await pool.query(
      `SELECT id FROM students
        WHERE id = ANY($1::int[]) AND is_active = true AND status = '在读' AND class_id = $2`,
      [clean.map((c) => c.studentId), a.classId]
    );
    const valid = new Set(stuRes.rows.map((r) => r.id));
    let updated = 0;
    for (const c of clean) {
      if (!valid.has(c.studentId)) continue;
      await pool.query(
        `INSERT INTO homework_submissions (task_id, student_id, is_submitted)
         VALUES ($1, $2, $3)
         ON CONFLICT (task_id, student_id) DO UPDATE
           SET is_submitted = EXCLUDED.is_submitted, updated_at = now()`,
        [taskId, c.studentId, c.isSubmitted]
      );
      updated += 1;
    }
    await logOperation(req, 'homework_submissions_batch', { taskId, count: updated });
    res.json({ ok: true, updated });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// POST /api/homework/submissions/column —— 按列批量（录入界面"第X列全选"）
// ------------------------------------------------------------
router.post('/homework/submissions/column', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!canRecord(a)) return res.status(403).json({ error: '无权限：仅班长可录入作业提交情况' });
    const taskId = Number(req.body.taskId);
    const column = Number(req.body.column);
    const isSubmitted = req.body.isSubmitted !== false && req.body.isSubmitted !== 'false';
    if (!Number.isInteger(taskId)) return res.status(400).json({ error: '缺少有效的 taskId' });
    if (!Number.isInteger(column) || column < 1 || column > 20) return res.status(400).json({ error: '列号无效' });

    const task = await loadTask(taskId);
    if (!task) return res.status(404).json({ error: '作业任务不存在' });
    if (task.class_id !== a.classId) return res.status(403).json({ error: '该作业不属于本班' });

    const stuRes = await pool.query(
      `SELECT id FROM students
        WHERE class_id = $1 AND is_active = true AND status = '在读' AND seat_col = $2 AND seat_row > 0`,
      [a.classId, column]
    );
    if (stuRes.rowCount === 0) return res.status(400).json({ error: `第 ${column} 列暂无已排座的在读学生` });
    let updated = 0;
    for (const r of stuRes.rows) {
      await pool.query(
        `INSERT INTO homework_submissions (task_id, student_id, is_submitted)
         VALUES ($1, $2, $3)
         ON CONFLICT (task_id, student_id) DO UPDATE
           SET is_submitted = EXCLUDED.is_submitted, updated_at = now()`,
        [taskId, r.id, isSubmitted]
      );
      updated += 1;
    }
    await logOperation(req, 'homework_submissions_column', { taskId, column, isSubmitted, count: updated });
    res.json({ ok: true, updated, column, isSubmitted });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// GET /api/homework/student/:studentId?from=&to=
// 按学生查看作业提交记录
//   班长：本班全部作业；班主任：所带班级全部作业；任课老师：自己发布的作业；管理员：全部
// ------------------------------------------------------------
router.get('/homework/student/:studentId', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (a.isStudent) return res.status(403).json({ error: '无权限：学生不能查看作业统计' });
    const studentId = Number(req.params.studentId);
    if (!Number.isInteger(studentId)) return res.status(400).json({ error: '无效的学生ID' });

    const stuRes = await pool.query('SELECT id, student_no, name, class_id FROM students WHERE id = $1', [studentId]);
    if (stuRes.rowCount === 0) return res.status(404).json({ error: '学生不存在' });
    const stu = stuRes.rows[0];

    const where = ['t.class_id = $2'];
    const params = [studentId, stu.class_id];
    const push = (v) => { params.push(v); return '$' + params.length; };

    if (a.isMonitor) {
      if (a.classId !== stu.class_id) return res.status(403).json({ error: '只能查看本班学生' });
    } else if (a.isTeacher) {
      const roleInClass = a.roleInClass(stu.class_id);
      if (roleInClass === 'head_teacher') {
        // 该班班主任：本班全部科目
      } else if (roleInClass === 'subject_teacher') {
        where.push(`t.created_by = ${push(a.id)}`); // 任课老师：仅自己发布的
        const subj = a.subjectForClass(stu.class_id);
        if (subj) where.push(`t.subject = ${push(subj)}`); // 并且只看本学科
      } else {
        return res.status(403).json({ error: '只能查看自己所带班级的学生' });
      }
    }
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    if (from && validDateStr(from)) where.push(`t.date >= ${push(from)}`);
    if (to && validDateStr(to)) where.push(`t.date <= ${push(to)}`);

    const recRes = await pool.query(
      `SELECT t.id AS task_id, t.subject, t.title, t.date, t.deadline, t.is_daily,
              COALESCE(u.real_name, u.display_name, u.username) AS teacher_name,
              COALESCE(s.is_submitted, false) AS is_submitted, s.updated_at
         FROM homework_tasks t
         LEFT JOIN users u ON u.id = t.created_by
         LEFT JOIN homework_submissions s ON s.task_id = t.id AND s.student_id = $1
        WHERE ${where.join(' AND ')}
        ORDER BY t.deadline DESC, t.id DESC`,
      params
    );
    const records = recRes.rows.map((r) => ({
      taskId: r.task_id,
      date: fmtDate(r.date),
      deadlineText: fmtDateTime(r.deadline),
      subject: r.subject,
      title: r.title,
      teacherName: r.teacher_name || null,
      // 每日作业（系统自动发布，created_by=NULL）：前端可据此显示「每日作业」标签，
      //   老师也不会把它误认为"某位老师发布的作业"
      isDaily: r.is_daily === true,
      isSubmitted: r.is_submitted,
      updatedAt: r.updated_at,
    }));
    const submittedCount = records.filter((r) => r.isSubmitted).length;
    // 各科提交情况（应交 = 该学科作业数；实交 = 该生已交数；提交率 = 实交/应交）
    //   排序：提交率低的排前面（需改进/需关注优先），便于老师一眼看到问题学科
    const subjMap = new Map();
    for (const r of records) {
      const key = r.subject || '未标学科';
      if (!subjMap.has(key)) subjMap.set(key, { subject: key, expected: 0, submitted: 0 });
      const it = subjMap.get(key);
      it.expected += 1;
      if (r.isSubmitted) it.submitted += 1;
    }
    const bySubject = [...subjMap.values()]
      .map((x) => ({
        subject: x.subject,
        expected: x.expected,
        submitted: x.submitted,
        notSubmitted: x.expected - x.submitted,
        rate: x.expected > 0 ? Math.round((x.submitted / x.expected) * 1000) / 10 : 0,
      }))
      .sort((a, b) => (a.rate - b.rate) || (b.expected - a.expected) || String(a.subject).localeCompare(String(b.subject), 'zh'));
    res.json({
      student: { id: stu.id, studentNo: stu.student_no, name: stu.name, classId: stu.class_id },
      range: { from: from || null, to: to || null },
      records,
      bySubject,
      stats: {
        total: records.length,
        submitted: submittedCount,
        notSubmitted: records.length - submittedCount,
        rate: records.length > 0 ? Math.round((submittedCount / records.length) * 1000) / 10 : 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// GET /api/homework/export-unsubmitted —— 导出「某学科 未交统计表」（班主任关注谁没交）
//   参数：classId（别名 class_id）| subject | from/to（别名 start_date/end_date、startDate/endDate）
//   表格：第一列 学生姓名 → 中间列 日期范围内每一天（MM-DD）→ 最后一列 未提交总次数
//         ✅ 已提交 / ❌ 未提交 / — 当天没有该学科的作业（或该天作业尚未录入，不参与统计）
//   排序：未交次数从高到低（同次数按学号）；底部一行「全班未交人数」合计
//   权限：与作业导出一致（任课老师/班主任/管理员）；教师只能导自己所带班级，任课老师限本学科
// ------------------------------------------------------------
router.get('/homework/export-unsubmitted', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!canExport(a)) return res.status(403).json({ error: '无权限：仅任课老师/班主任及管理员可导出作业统计' });

    const q = req.query || {};
    const classId = Number(q.classId || q.class_id);
    if (!Number.isInteger(classId) || classId <= 0) return res.status(400).json({ error: '缺少有效的班级参数（classId）' });
    const subject = String(q.subject || '').trim();
    if (!subject) return res.status(400).json({ error: '请选择学科' });
    if (!HW_SUBJECTS.has(subject)) return res.status(400).json({ error: '学科无效' });
    const from = String(q.from || q.startDate || q.start_date || '').trim();
    const to = String(q.to || q.endDate || q.end_date || '').trim();
    if (!validDateStr(from) || !validDateStr(to)) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
    if (from > to) return res.status(400).json({ error: '开始日期不能晚于结束日期' });
    const days = Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1;
    if (days > 120) return res.status(400).json({ error: '日期范围最多 120 天' });

    if (!a.isAdmin) {
      const ok = classId === a.classId || a.isHeadOf(classId) || a.teaches(classId);
      if (!ok) return res.status(403).json({ error: '无权导出该班级作业' });
    }
    if (a.subjectLocked) {
      if (!a.subject) return res.status(403).json({ error: '请先到个人中心绑定所教学科' });
      if (subject !== a.subject) return res.status(403).json({ error: `任课老师只能导出自己任教的学科（${a.subject}）` });
    }
    const clsRow = await pool.query('SELECT class_name FROM classes WHERE id = $1', [classId]);
    if (clsRow.rowCount === 0) return res.status(400).json({ error: '班级不存在' });
    const className = clsRow.rows[0].class_name || `班级#${classId}`;

    // 1) 该学科在范围内的作业（同一天可能多条：老师另发的同科目作业 → 交齐才算已提交）
    const taskRes = await pool.query(
      `SELECT id, date FROM homework_tasks
        WHERE class_id = $1 AND subject = $2 AND date BETWEEN $3::date AND $4::date
        ORDER BY date ASC, id ASC`,
      [classId, subject, from, to]
    );
    const tasks = taskRes.rows;
    const taskIds = tasks.map((t) => t.id);
    const taskDate = new Map(tasks.map((t) => [t.id, fmtDate(t.date)]));
    // 列 = 日期范围内的**每一天**（需求："中间列是所选日期范围内的每一天"；
    //      某天没有该学科作业 → 该列显示 —）
    const dates = [];
    for (let d = new Date(from + 'T00:00:00'); d.getTime() <= new Date(to + 'T00:00:00').getTime(); d.setDate(d.getDate() + 1)) {
      dates.push(fmtDate(d));
    }
    const daysWithTasks = [...new Set(tasks.map((t) => fmtDate(t.date)))];

    // 2) 提交情况 + 每天是否"已录入"（未录入的天按 — 显示，不参与统计，避免全班被误判成未交）
    const subByTask = new Map();
    if (taskIds.length) {
      const subRes = await pool.query(
        'SELECT task_id, student_id, is_submitted FROM homework_submissions WHERE task_id = ANY($1::int[])',
        [taskIds]
      );
      for (const r of subRes.rows) {
        if (!subByTask.has(r.task_id)) subByTask.set(r.task_id, new Map());
        subByTask.get(r.task_id).set(r.student_id, r.is_submitted);
      }
    }
    const dateRecorded = new Map();
    for (const t of tasks) {
      const d = taskDate.get(t.id);
      const n = subByTask.get(t.id) ? subByTask.get(t.id).size : 0;
      dateRecorded.set(d, (dateRecorded.get(d) || false) || n > 0);
    }
    const recordedDates = daysWithTasks.filter((d) => dateRecorded.get(d));

    // 3) 学生 + 逐日聚合
    const stuRes = await pool.query(
      `SELECT id, student_no, name FROM students
        WHERE class_id = $1 AND is_active = true AND status = '在读' ORDER BY student_no`,
      [classId]
    );
    const cellOf = (studentId, d) => {
      if (!dateRecorded.get(d)) return '—';
      const dayTasks = tasks.filter((t) => taskDate.get(t.id) === d);
      for (const t of dayTasks) {
        const subs = subByTask.get(t.id);
        if (!(subs && subs.get(studentId) === true)) return '❌';
      }
      return '✅';
    };
    const rows = stuRes.rows.map((s) => {
      const cells = dates.map((d) => cellOf(s.id, d));
      return { studentNo: s.student_no, name: s.name, cells, missing: cells.filter((c) => c === '❌').length };
    });
    rows.sort((x, y) => (y.missing - x.missing) || String(x.studentNo).localeCompare(String(y.studentNo), { numeric: true }));

    // 4) 工作表：标题 / 条件行 / 表头 / 数据 / 合计 / 图例
    const header = ['学生姓名', ...dates.map((d) => d.slice(5)), '未提交总次数'];
    const aoa = [];
    aoa.push([`${className}-${subject}-未交统计`]);
    aoa.push([`范围：${from} ~ ${to}（共 ${dates.length} 天）　|　其中 ${daysWithTasks.length} 天有该学科作业、${recordedDates.length} 天已录入`
      + (daysWithTasks.length > recordedDates.length ? `（${daysWithTasks.length - recordedDates.length} 天未录入，显示 — 且不计入次数）` : '')]);
    aoa.push(header);
    for (const r of rows) aoa.push([r.name, ...r.cells, r.missing >= 3 ? `${r.missing} ⚠` : r.missing]);
    if (rows.length) {
      const totals = dates.map((d, i) => (dateRecorded.get(d) ? rows.filter((r) => r.cells[i] === '❌').length : '—'));
      aoa.push(['全班未交人数', ...totals, rows.reduce((n, r) => n + r.missing, 0)]);
    }
    aoa.push(['图例：✅ 已提交　❌ 未提交　— 当天没有该学科作业（或该天尚未录入）']);
    aoa.push(['未交次数 ≥3 的用 "⚠" 标记，便于重点关注']);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 14 }, ...dates.map(() => ({ wch: 8 })), { wch: 14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '未交统计');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fname = `${className}-${subject}-未交统计-${from}至${to}.xlsx`;
    await logOperation(req, 'homework_export_unsubmitted', {
      classId, subject, from, to, days: dates.length, daysWithTasks: daysWithTasks.length,
      recordedDays: recordedDates.length, students: rows.length,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="unsubmitted.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// GET /api/homework/export?date=&from=&to=&subject=&classId=&classIds=&teacherId=
// 导出（任课老师：自己发布的；班主任：本班全部；管理员：全部；班长 403）
// ------------------------------------------------------------
router.get('/homework/export', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (!canExport(a)) {
      return res.status(403).json({ error: '无权限：仅任课老师/班主任及管理员可导出作业统计' });
    }
    const where = [];
    const params = [];
    const push = (v) => { params.push(v); return '$' + params.length; };

    const classIdParam = req.query.classId ? Number(req.query.classId) : null;
    const classIdsParam = classIdParam ? null : parseClassIdsParam(req.query.classIds);
    if (a.isAdmin) {
      if (classIdParam) where.push(`t.class_id = ${push(classIdParam)}`);
      else if (classIdsParam) where.push(`t.class_id = ANY(${push(classIdsParam)}::int[])`);
    } else {
      const scoped = applyTeacherScope(a, classIdParam, push, where, { classIds: classIdsParam });
      if (scoped && scoped.error) return res.status(403).json({ error: scoped.error });
      if (scoped && scoped.empty) return res.status(404).json({ error: '所选条件下没有可导出的作业数据' });
    }
    const date = String(req.query.date || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    if (date) {
      if (!validDateStr(date)) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
      where.push(`t.date = ${push(date)}`);
    } else {
      if (from && validDateStr(from)) where.push(`t.date >= ${push(from)}`);
      if (to && validDateStr(to)) where.push(`t.date <= ${push(to)}`);
    }
    const subject = String(req.query.subject || '').trim();
    // 纯任课老师：导出范围同样锁定为所教学科
    if (a.subjectLocked) {
      if (!a.subject) return res.status(403).json({ error: '请先到个人中心绑定所教学科' });
      if (subject && subject !== a.subject) {
        return res.status(403).json({ error: `任课老师只能导出自己任教的学科（${a.subject}）` });
      }
      where.push(`t.subject = ${push(a.subject)}`);
    } else if (subject) {
      where.push(`t.subject = ${push(subject)}`);
    }
    if (req.query.teacherId) {
      const tid = Number(req.query.teacherId);
      if (Number.isInteger(tid)) where.push(`t.created_by = ${push(tid)}`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const rowsRes = await pool.query(
      `SELECT t.id AS task_id, t.subject, t.title, t.date, t.deadline,
              c.class_name,
              COALESCE(u.real_name, u.display_name, u.username) AS teacher_name,
              st.student_no, st.name AS student_name,
              COALESCE(s.is_submitted, false) AS is_submitted, s.updated_at
         FROM homework_tasks t
         LEFT JOIN classes c ON c.id = t.class_id
         LEFT JOIN users u ON u.id = t.created_by
         JOIN students st ON st.class_id = t.class_id AND st.is_active = true AND st.status = '在读'
         LEFT JOIN homework_submissions s ON s.task_id = t.id AND s.student_id = st.id
         ${whereSql}
        ORDER BY c.class_name NULLS FIRST, t.deadline, t.id, st.student_no`,
      params
    );
    const data = rowsRes.rows.map((r) => ({
      '班级': r.class_name || '',
      '日期': fmtDate(r.date),
      '截止时间': fmtDateTime(r.deadline),
      '学科': r.subject,
      '作业标题': r.title,
      '发布老师': r.teacher_name || '',
      '学号': r.student_no,
      '学生姓名': r.student_name,
      '是否提交': r.is_submitted ? '已交' : '未交',
      '提交时间': r.updated_at ? new Date(r.updated_at).toLocaleString('zh-CN', { hour12: false }) : '',
    }));
    if (data.length === 0) return res.status(404).json({ error: '所选条件下没有可导出的作业数据' });

    const header = ['班级', '日期', '截止时间', '学科', '作业标题', '发布老师', '学号', '学生姓名', '是否提交', '提交时间'];
    const ws = XLSX.utils.json_to_sheet(data, { header });
    ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 8 }, { wch: 26 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '作业统计');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fname = `作业统计_${date || (from || '') + '~' + (to || '')}${subject ? '_' + subject : ''}.xlsx`;
    await logOperation(req, 'homework_export', { date: date || null, from: from || null, to: to || null, subject: subject || null, rows: data.length });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="homework.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// GET /api/homework/publishers —— 可选发布老师列表（班主任筛选用）
// ------------------------------------------------------------
router.get('/homework/publishers', async (req, res, next) => {
  try {
    const a = await loadActor(req);
    if (!a) return res.status(401).json({ error: '未登录' });
    if (a.isStudent || a.isMonitor) return res.status(403).json({ error: '无权限' });
    const params = [];
    let where = '';
    if (a.isTeacher && !a.isAdmin) {
      if (a.headClassIds.length === 0) return res.json({ publishers: [] });
      params.push(a.headClassIds);
      where = `WHERE t.class_id = ANY($1::int[])`;
    }
    const r = await pool.query(
      `SELECT DISTINCT t.created_by AS id, COALESCE(u.real_name, u.display_name, u.username) AS name
         FROM homework_tasks t LEFT JOIN users u ON u.id = t.created_by
         ${where} ${where ? 'AND' : 'WHERE'} t.created_by IS NOT NULL
        ORDER BY name`,
      params
    );
    res.json({ publishers: r.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
// 每日作业自动发布（每天 0 点定时任务；供 server/src/index.js 启动，测试也可直接调用）
module.exports.startDailyHomeworkScheduler = startDailyHomeworkScheduler;
module.exports.generateDailyForAllClasses = generateDailyForAllClasses;
module.exports.runDailyAutoPublish = runDailyAutoPublish;
module.exports.msUntilNextMidnight = msUntilNextMidnight;
