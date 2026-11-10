// ============================================================
// 班级「选科组合 / 选科科目 → 开设学科」统一口径（迁移 v34）
//
//   为什么单独抽一个模块：班级开设学科被三处用到，必须同一个口径，否则又会出现"各处算法不一致"：
//     · 班级管理（增/改/导入）：写入与回显 stream + elective_subjects
//     · 每日作业（班长端自动生成「今日作业」）：按该班实际开设学科生成条目
//     · 管理端「每日作业科目配置」卡片：展示"该班为什么是这几科"
//
//   规则（需求原文）：
//     语文、数学、英语 = 所有班级默认都有（不需要配置，也不写入 elective_subjects）
//     物理、化学、生物、政治、历史、地理 = 由选科组合决定
//       · 理科 → 物理/化学/生物（自动勾选）
//       · 文科 → 政治/历史/地理（自动勾选）
//       · 小理 / 小文 / 综合 → 手动勾选
//     班级开设学科 = 语文 + 数学 + 英语 + 选科科目
//
//   每日作业科目优先级（从高到低）：
//     1) classes.daily_subjects        管理员在「每日作业科目配置」里的显式覆盖（v32，最高优先）
//     2) classes.stream + electives    本模块按选科组合推导（v34）
//     3) system_settings.daily_homework_subjects  全局默认（v32）
// ============================================================
'use strict';

const CORE_SUBJECTS = Object.freeze(['语文', '数学', '英语']);

// 可选选科科目（顺序即展示顺序）
const ELECTIVE_SUBJECTS = Object.freeze(['物理', '化学', '生物', '政治', '历史', '地理']);

// 选科组合
const STREAMS = Object.freeze(['理科', '文科', '小理', '小文', '综合']);
const DEFAULT_STREAM = '综合';

// 选科组合 → 预设选科科目（空数组 = 手动勾选；「综合」不预设）
const STREAM_PRESETS = Object.freeze({
  理科: Object.freeze(['物理', '化学', '生物']),
  文科: Object.freeze(['政治', '历史', '地理']),
  小理: Object.freeze([]),
  小文: Object.freeze([]),
  综合: Object.freeze([]),
});

const ELECTIVE_SET = new Set(ELECTIVE_SUBJECTS);

// 宽松解析"科目串"：数组 或 "物理,化学、生物 地理" 之类的字符串 → 去重数组（保持出现顺序）
function parseSubjectList(raw) {
  if (raw === null || raw === undefined) return [];
  let list = [];
  if (Array.isArray(raw)) list = raw.map((x) => String(x == null ? '' : x).trim());
  else if (typeof raw === 'string') list = raw.split(/[,，、;；\s|]+/).map((x) => x.trim());
  else list = [String(raw).trim()];
  const out = [];
  for (const s of list) {
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

// 选科科目校验 + 归一（按 ELECTIVE_SUBJECTS 的固定顺序输出，保证列表/作业顺序稳定）
//   返回 { subjects } 或 { error }
function normalizeElectives(raw) {
  const list = parseSubjectList(raw);
  for (const s of list) {
    if (!ELECTIVE_SET.has(s)) {
      return { error: `选科科目无效：${s}（可选：${ELECTIVE_SUBJECTS.join('、')}）` };
    }
  }
  const subjects = ELECTIVE_SUBJECTS.filter((s) => list.includes(s));
  return { subjects };
}

// 选科组合校验 + 归一；空值 → 默认「综合」
function normalizeStream(raw) {
  const v = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!v) return { stream: DEFAULT_STREAM };
  if (!STREAMS.includes(v)) return { error: `选科组合无效：${v}（可选：${STREAMS.join(' / ')}）` };
  return { stream: v };
}

// 选科组合对应的预设科目（返回副本；小理/小文/综合 = 空，需手动勾选）
function streamPreset(stream) {
  const s = STREAMS.includes(stream) ? stream : DEFAULT_STREAM;
  return STREAM_PRESETS[s].slice();
}

// 该班开设学科 = 语文 + 数学 + 英语 + 选科科目（按固定顺序、去重）
function effectiveSubjects({ stream, electiveSubjects } = {}) {
  const electives = normalizeElectives(electiveSubjects).subjects || [];
  const preset = (!electives.length && STREAM_PRESETS[stream] && STREAM_PRESETS[stream].length)
    ? STREAM_PRESETS[stream].slice()      // 只写了选科组合、还没勾科目 → 用组合预设（理科/文科）
    : electives;
  return [...CORE_SUBJECTS, ...ELECTIVE_SUBJECTS.filter((s) => preset.includes(s))];
}

// 从数据库行（classes.stream / classes.elective_subjects）取值
function readClassStream(row) {
  if (!row) return { stream: DEFAULT_STREAM, electiveSubjects: [] };
  const stream = STREAMS.includes(row.stream) ? row.stream : DEFAULT_STREAM;
  let arr = row.elective_subjects;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (_) { arr = []; } }
  const subjects = normalizeElectives(arr).subjects || [];
  return { stream, electiveSubjects: subjects };
}

// 每日作业科目解析（三级优先，见文件头）
//   classRow：至少包含 daily_subjects / stream / elective_subjects（可为 null → 只看全局）
//   globalSubjects：全局默认（已解析的数组）
//   返回 { subjects, source, detail }
//     source: 'class_override' | 'class_stream' | 'global'
function resolveDailySubjects(classRow, globalSubjects) {
  const global = parseSubjectList(globalSubjects);
  const override = parseSubjectList(classRow && classRow.daily_subjects);
  if (override.length) {
    return { subjects: override, source: 'class_override', detail: '管理员为该班单独配置的科目' };
  }
  if (classRow) {
    const { stream, electiveSubjects } = readClassStream(classRow);
    if (electiveSubjects.length || (STREAM_PRESETS[stream] && STREAM_PRESETS[stream].length)) {
      return {
        subjects: effectiveSubjects({ stream, electiveSubjects }),
        source: 'class_stream',
        detail: `按班级选科推导（${stream}${electiveSubjects.length ? '：' + electiveSubjects.join('、') : ''}）`,
      };
    }
  }
  return { subjects: global, source: 'global', detail: '全局默认科目' };
}

module.exports = {
  CORE_SUBJECTS,
  ELECTIVE_SUBJECTS,
  STREAMS,
  DEFAULT_STREAM,
  STREAM_PRESETS,
  parseSubjectList,
  normalizeElectives,
  normalizeStream,
  streamPreset,
  effectiveSubjects,
  readClassStream,
  resolveDailySubjects,
};
