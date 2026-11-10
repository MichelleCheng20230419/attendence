-- ============================================================
-- 迁移 v35：每天自动生成「早/晚 2 次签到」场次（不限时 · 默认全签 · 只取消未到）
--
-- 背景（老师需求 · 路线 B）：
--   签到参照"作业录入"的逻辑改造 ——
--     · 系统每天 0 点自动为每个班生成 2 条签到场次（早自习 / 晚自修）
--     · 不再受"签到时间窗口"限制（班长/班主任随时录入，不显示倒计时/截止时间）
--     · 进页面默认"全员已签到"，只点掉没来的人；点「保存」把整场状态落库
--   与"每日作业"（v32 起，homework_tasks.is_daily + 0 点定时任务）同一套模式：
--   系统自动生成 + 幂等 + 启动补发 + 次日收口。
--
-- 设计要点：
--   1. `auto_generated boolean NOT NULL DEFAULT false`
--      —— **必须是 false**：现有 43 个场次（plan 34 / manual 9）都是老模型，标成 true 会
--         让它们被"次日收口/不限时"逻辑接管，与"已存在记录保持不变、新逻辑从明天生效"冲突。
--      —— 它是"新模型行为开关"：服务端据此豁免窗口校验与懒终局(finalizeAbsent)。
--   2. `slot varchar(10)`：morning=早自习 / evening=晚自修（老场次为 NULL）。
--      `session_date date`：归属日期（老行回填 start_time::date）。
--      —— 之所以要这两列：0 点定时任务必须**幂等**（每天跑、可能重启补发、多实例），
--         靠"班级+日期+时段"唯一索引兜底，而不是靠"查有没有 active 场次"（会与计划场次打架）。
--   3. `start_time` 用**生成时刻**（0 点），不用 07:30/19:00 ——
--         考勤分析只统计 `s.start_time <= now()` 的场次（analysis.js），若把早自习设成 07:30，
--         当天早晨的分析/明细会看不到它；"早/晚"用 slot 表达并在界面/导出显示为「早自习/晚自修」。
--      `deadline` 列 NOT NULL 保留，自动场次填当天 23:59（仅为兼容与展示，**不做任何签到限制**）。
--   4. `ck_sessions_source` 白名单加入 'auto'（来源审计用；与 auto_generated 由测试守护一致性）。
--   5. 唯一索引为**部分索引**（WHERE auto_generated），不影响任何老场次与既有"一天多场"能力。
--      `test_multisession.js` 已证明一天多场次的数据模型本身成立，本迁移只加约束不改语义。
--
-- 生效方式：本迁移只加列/约束，不生成任何数据；生成由服务端定时任务完成，
--   且受系统设置 `daily_sessions_enabled`（默认 '0' 关闭）控制 —— 阶段 1 可先上线不生效，
--   等前端与统计口径改造完成后置 '1' 再对班级生效（灰度试点友好）。
-- ============================================================
SET client_encoding = 'UTF8';

BEGIN;

-- ---------- 1) 场次表：新模型标记 + 时段 + 归属日期 ----------
ALTER TABLE attendance_sessions
  ADD COLUMN IF NOT EXISTS auto_generated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS slot           varchar(10),
  ADD COLUMN IF NOT EXISTS session_date   date;

COMMENT ON COLUMN attendance_sessions.auto_generated IS
  '是否系统每天 0 点自动生成的签到场次（早/晚 2 次）。true = 不限时 + 不自动补缺勤（缺勤=人工取消）；老场次一律 false。';
COMMENT ON COLUMN attendance_sessions.slot IS
  '自动场次的时段：morning=早自习 / evening=晚自修；老场次为 NULL。';
COMMENT ON COLUMN attendance_sessions.session_date IS
  '自动场次的归属日期（老行回填 start_time::date）。0 点任务按 (class_id, session_date, slot) 幂等生成。';

-- 老场次回填归属日期（auto_generated 保持 false，不受新逻辑影响）
UPDATE attendance_sessions SET session_date = start_time::date WHERE session_date IS NULL;

-- ---------- 2) 约束 ----------
-- 时段白名单（允许 NULL：老场次）
ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS ck_sessions_slot;
ALTER TABLE attendance_sessions
  ADD CONSTRAINT ck_sessions_slot
  CHECK (slot IS NULL OR slot IN ('morning', 'evening'));

-- 自动场次必须有 时段 + 归属日期（否则幂等键不成立）
ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS ck_sessions_auto_shape;
ALTER TABLE attendance_sessions
  ADD CONSTRAINT ck_sessions_auto_shape
  CHECK (auto_generated = false OR (slot IS NOT NULL AND session_date IS NOT NULL AND class_id IS NOT NULL));

-- 来源白名单加 'auto'（审计/筛选用；与 auto_generated 一致性由服务端 + 用例守护）
ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS ck_sessions_source;
ALTER TABLE attendance_sessions
  ADD CONSTRAINT ck_sessions_source
  CHECK (start_source::text = ANY (ARRAY['plan','manual','makeup','auto']::text[]));

-- ---------- 3) 幂等键：同一班 + 同一天 + 同一时段 只允许一条自动场次 ----------
CREATE UNIQUE INDEX IF NOT EXISTS uniq_session_auto_slot
  ON attendance_sessions (class_id, session_date, slot)
  WHERE auto_generated = true;

-- 收口/查询用（次日收口：按 session_date 扫未结束的自动场次）
CREATE INDEX IF NOT EXISTS idx_sessions_auto_date
  ON attendance_sessions (session_date)
  WHERE auto_generated = true;

COMMIT;

-- ============================================================
-- 校验输出
-- ============================================================
\echo '=== attendance_sessions 新列 ==='
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'attendance_sessions'
   AND column_name IN ('auto_generated', 'slot', 'session_date')
 ORDER BY column_name;

\echo '=== 新约束 ==='
SELECT conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
 WHERE conrelid = 'attendance_sessions'::regclass AND conname IN ('ck_sessions_slot','ck_sessions_auto_shape','ck_sessions_source')
 ORDER BY conname;

\echo '=== 部分唯一索引 ==='
SELECT indexname, indexdef FROM pg_indexes
 WHERE tablename = 'attendance_sessions' AND indexname IN ('uniq_session_auto_slot','idx_sessions_auto_date')
 ORDER BY indexname;

\echo '=== 基线复核（只加列，行数不变；老场次 auto_generated 必须全为 false）==='
SELECT count(*) AS sessions_total,
       count(*) FILTER (WHERE auto_generated) AS auto_total,
       count(*) FILTER (WHERE session_date IS NULL) AS date_missing,
       count(*) FILTER (WHERE start_source = 'auto') AS source_auto
  FROM attendance_sessions;
SELECT 'records' AS t, count(*)::text AS n FROM attendance_records
UNION ALL SELECT 'plans', count(*)::text FROM attendance_plans
ORDER BY 1;

-- ============================================================
-- 反向回滚（如需）：
--   BEGIN;
--   DROP INDEX IF EXISTS uniq_session_auto_slot;
--   DROP INDEX IF EXISTS idx_sessions_auto_date;
--   ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS ck_sessions_auto_shape;
--   ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS ck_sessions_slot;
--   ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS ck_sessions_source;
--   ALTER TABLE attendance_sessions
--     ADD CONSTRAINT ck_sessions_source
--     CHECK (start_source::text = ANY (ARRAY['plan','manual','makeup']::text[]));
--   ALTER TABLE attendance_sessions
--     DROP COLUMN IF EXISTS auto_generated,
--     DROP COLUMN IF EXISTS slot,
--     DROP COLUMN IF EXISTS session_date;
--   COMMIT;
--   （注意：若有 auto 场次数据，请先 DELETE FROM attendance_sessions WHERE auto_generated; 再回滚。）
-- ============================================================
