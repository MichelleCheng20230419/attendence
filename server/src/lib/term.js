// ============================================================
// 学期设置（系统管理 → 学年管理 → 学期设置）
//   存储：system_settings key/value
//     term_first_start / term_first_end / term_second_start / term_second_end / current_term
//   用途：所有「本学期」口径的筛选（考勤分析 / 课堂表现 / 巡查面板 / 巡堂统计导出）
//         统一走 resolveTermRange()，不再各页各自按月份硬编码。
//   未配置时：回退到内置默认口径（上学期 9/1~次年 1/31，下学期 2/1~7/15），
//         并把 configured=false 返回给前端用于提示。
// ============================================================
const pool = require('../db');

const KEYS = {
  firstStart: 'term_first_start',
  firstEnd: 'term_first_end',
  secondStart: 'term_second_start',
  secondEnd: 'term_second_end',
  currentTerm: 'current_term',
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TERM_LABEL = { first: '上学期', second: '下学期' };
const CURRENT_TERM_VALUES = ['first', 'second'];

function pad(n) { return String(n).padStart(2, '0'); }
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { const d = new Date(); d.setHours(0, 0, 0, 0); return fmt(d); }

// 严格校验 YYYY-MM-DD：既要格式对，也要真实存在（拒绝 2026-02-30）
function strictDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return fmt(d) === s ? s : null;
}
function isValidTerm(v) { return CURRENT_TERM_VALUES.includes(String(v || '')); }
function termLabel(v) { return TERM_LABEL[isValidTerm(v) ? String(v) : 'first']; }

// 学年起点年份：9~12 月属本年开始的学年；1 月和 2~8 月属上一年开始的学年
function schoolYearStart(date) {
  const m = date.getMonth() + 1;
  return m >= 9 ? date.getFullYear() : date.getFullYear() - 1;
}

// 内置默认口径（未配置学期起止日期时使用）
//   上学期：y-09-01 ~ y+1-01-31    下学期：y+1-02-01 ~ y+1-07-15
function defaultTermSettings(date = new Date()) {
  const y = schoolYearStart(date);
  return {
    firstStart: `${y}-09-01`,
    firstEnd: `${y + 1}-01-31`,
    secondStart: `${y + 1}-02-01`,
    secondEnd: `${y + 1}-07-15`,
  };
}
// 按今天所在月份推断当前学期（默认口径下）
function defaultCurrentTerm(date = new Date()) {
  const m = date.getMonth() + 1;
  return (m >= 9 || m === 1) ? 'first' : 'second';
}

// 读取原始配置
async function getTermSettings() {
  const { rows } = await pool.query(
    `SELECT key, value FROM system_settings WHERE key = ANY($1)`,
    [Object.values(KEYS)]
  );
  const map = {};
  for (const r of rows) map[r.key] = String(r.value == null ? '' : r.value).trim();
  const firstStart = strictDate(map[KEYS.firstStart]) || '';
  const firstEnd = strictDate(map[KEYS.firstEnd]) || '';
  const secondStart = strictDate(map[KEYS.secondStart]) || '';
  const secondEnd = strictDate(map[KEYS.secondEnd]) || '';
  const currentTerm = isValidTerm(map[KEYS.currentTerm]) ? map[KEYS.currentTerm] : 'first';
  const okRange = (s, e) => !!s && !!e && s <= e;
  const firstConfigured = okRange(firstStart, firstEnd);
  const secondConfigured = okRange(secondStart, secondEnd);
  // 判定「已配置」的口径 = **当前学期**的起止日期已配全：
  //   管理员通常只需要先把当前学期（如上学期）填上，「本学期」筛选就能按设置走，
  //   另一个学期可以稍后再补（否则会出现"填了上学期却一直提示未设置"的困惑）。
  const configured = currentTerm === 'first' ? firstConfigured : secondConfigured;
  return {
    firstStart,
    firstEnd,
    secondStart,
    secondEnd,
    currentTerm,
    currentTermLabel: termLabel(currentTerm),
    firstConfigured,
    secondConfigured,
    bothConfigured: firstConfigured && secondConfigured,
    configured,
    // 尚未配置起止日期的学期（设置页据此提醒）
    missingTerms: [!firstConfigured ? 'first' : null, !secondConfigured ? 'second' : null].filter(Boolean),
  };
}

// 解析「本学期」筛选区间
//   已配置（当前学期起止已填）：按配置的当前学期起止日期（结束日期若晚于今天则截到今天 = 本学期至今）
//   未配置：按内置默认口径，source='default'
async function resolveTermRange(date = new Date()) {
  const s = await getTermSettings();
  const fallback = defaultTermSettings(date);
  const defTerm = defaultCurrentTerm(date);
  const d = {
    firstStart: s.firstStart || fallback.firstStart,
    firstEnd: s.firstEnd || fallback.firstEnd,
    secondStart: s.secondStart || fallback.secondStart,
    secondEnd: s.secondEnd || fallback.secondEnd,
  };
  // 当前学期已配置 → 用管理员选定的当前学期；
  // 未配置但已经填过日期/选过学期（说明管理员确实在用它）→ 仍尊重他选的当前学期（日期缺的用默认值补上）；
  // 完全没配过 → 按今天所在月份推断（默认口径更好用）
  const anyDateFilled = !!(s.firstStart || s.firstEnd || s.secondStart || s.secondEnd);
  const currentTerm = s.configured || anyDateFilled ? s.currentTerm : defTerm;
  const rawStart = currentTerm === 'first' ? d.firstStart : d.secondStart;
  const rawEnd = currentTerm === 'first' ? d.firstEnd : d.secondEnd;
  const today = todayStr();
  // 结束日期取「学期结束日」与「今天」中较早者：学期未结束就是"本学期至今"
  const clipped = !!rawEnd && rawEnd > today;
  const endDate = clipped ? today : rawEnd;
  const startDate = rawStart && rawStart > endDate ? endDate : rawStart; // 防御：起始晚于结束时收敛
  return {
    configured: s.configured,
    source: s.configured ? 'configured' : 'default',
    currentTerm,
    currentTermLabel: termLabel(currentTerm),
    startDate,
    endDate,
    // 配置的原始学期区间 + 是否被"截到今天"（设置页展示用）
    rawStartDate: rawStart,
    rawEndDate: rawEnd,
    clipped,
    label: `${termLabel(currentTerm)}（${rawStart} ~ ${rawEnd}）`,
    today,
    // 四项日期一并返回，便于设置页和前端展示
    firstStart: d.firstStart,
    firstEnd: d.firstEnd,
    secondStart: d.secondStart,
    secondEnd: d.secondEnd,
    firstConfigured: s.firstConfigured,
    secondConfigured: s.secondConfigured,
    bothConfigured: s.bothConfigured,
    missingTerms: s.missingTerms,
  };
}

// 保存（管理员）。返回 { error } 或 { term, resolved }
async function saveTermSettings(body = {}) {
  const raw = {
    firstStart: String(body.firstStart == null ? '' : body.firstStart).trim(),
    firstEnd: String(body.firstEnd == null ? '' : body.firstEnd).trim(),
    secondStart: String(body.secondStart == null ? '' : body.secondStart).trim(),
    secondEnd: String(body.secondEnd == null ? '' : body.secondEnd).trim(),
  };
  const clean = {};
  for (const k of Object.keys(raw)) {
    if (raw[k] === '') { clean[k] = ''; continue; }
    const v = strictDate(raw[k]);
    if (!v) return { error: `日期格式无效：${raw[k]}（应为 YYYY-MM-DD）`, status: 400 };
    clean[k] = v;
  }
  // 起止成对填写
  const pairs = [['firstStart', 'firstEnd', '上学期'], ['secondStart', 'secondEnd', '下学期']];
  for (const [sk, ek, label] of pairs) {
    const hasS = !!clean[sk];
    const hasE = !!clean[ek];
    if (hasS !== hasE) return { error: `${label}的起止日期需同时填写（或都留空表示未配置）`, status: 400 };
    if (hasS && hasE && clean[sk] > clean[ek]) return { error: `${label}的开始日期不能晚于结束日期`, status: 400 };
  }
  const currentTerm = isValidTerm(body.currentTerm) ? String(body.currentTerm) : 'first';

  const entries = [
    [KEYS.firstStart, clean.firstStart],
    [KEYS.firstEnd, clean.firstEnd],
    [KEYS.secondStart, clean.secondStart],
    [KEYS.secondEnd, clean.secondEnd],
    [KEYS.currentTerm, currentTerm],
  ];
  for (const [k, v] of entries) {
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [k, v]
    );
  }
  return { term: await getTermSettings(), resolved: await resolveTermRange() };
}

module.exports = {
  KEYS,
  TERM_LABEL,
  CURRENT_TERM_VALUES,
  termLabel,
  strictDate,
  defaultTermSettings,
  defaultCurrentTerm,
  getTermSettings,
  resolveTermRange,
  saveTermSettings,
};
