-- ============================================================
-- 迁移 v32：每日固定科目作业录入（班主任/班长端，无需老师先发布）
--
-- 背景 / 需求：
--   班主任不需要知道每科具体作业是什么，只要知道学生今天各科交没交。
--   因此班长端每天自动生成若干科目（默认 6 科：语文/数学/英语/物理/化学/生物）的「今日作业」条目，
--   班长直接录入提交情况（勾选未交学生）即可；班主任端只看各科已交/总数/提交率/未交名单。
--
-- 设计（复用现有作业表，方案 A）：
--   · 每日作业 = homework_tasks 里的普通任务（title='今日作业'，deadline=当天 23:59，
--     created_by 为 NULL 表示"系统自动生成、非某位老师发布"），提交情况沿用 homework_submissions；
--     现有唯一索引 uq_homework_tasks_class_subject_title_date 保证「每班每科每天一条」→ 重复生成幂等。
--   · 新增 is_daily 标记：区分"系统每日条目"与"老师发布的具体作业"，前端可分别展示（两者共存）。
--   · 科目配置：
--       - 全局默认：system_settings 键 daily_homework_subjects（逗号分隔，默认 6 科）
--       - 班级覆盖：classes.daily_subjects（TEXT[]，NULL = 用全局默认）
--
-- 安全：只新增列/一行配置，不改动任何既有数据；可回滚（见文件末尾）。
-- ============================================================
SET client_encoding = 'UTF8';

BEGIN;

-- 1) 标记"每日作业"条目（老师发布的具体作业保持 false）
ALTER TABLE homework_tasks ADD COLUMN IF NOT EXISTS is_daily BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN homework_tasks.is_daily IS
  '是否由"每日固定科目作业"自动生成（true=系统生成，title 固定为「今日作业」，created_by 为 NULL）；老师发布的具体作业为 false';

-- 2) 班级级科目覆盖（NULL = 使用全局默认科目列表）
ALTER TABLE classes ADD COLUMN IF NOT EXISTS daily_subjects TEXT[];
COMMENT ON COLUMN classes.daily_subjects IS
  '该班"每日作业"科目列表；NULL 或空数组 = 使用全局默认（system_settings.daily_homework_subjects）';

-- 3) 全局默认科目（已存在则不覆盖，尊重管理员的现有配置）
INSERT INTO system_settings (key, value)
VALUES ('daily_homework_subjects', '语文,数学,英语,物理,化学,生物')
ON CONFLICT (key) DO NOTHING;

-- 便于按天/按标记查询每日作业
CREATE INDEX IF NOT EXISTS idx_homework_tasks_daily ON homework_tasks(date) WHERE is_daily = true;

COMMIT;

-- ============================================================
-- 校验输出
-- ============================================================
\echo '=== homework_tasks.is_daily / classes.daily_subjects 已就位 ==='
SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE (table_name = 'homework_tasks' AND column_name = 'is_daily')
    OR (table_name = 'classes' AND column_name = 'daily_subjects');

\echo '=== 全局默认科目 ==='
SELECT key, value FROM system_settings WHERE key = 'daily_homework_subjects';

\echo '=== 索引 ==='
SELECT indexname FROM pg_indexes WHERE tablename = 'homework_tasks' ORDER BY 1;

\echo '=== 基线复核（应与迁移前一致：没有凭空多出作业）==='
SELECT 'homework_tasks' t, count(*)::text n FROM homework_tasks
UNION ALL SELECT 'daily_tasks', count(*)::text FROM homework_tasks WHERE is_daily = true
UNION ALL SELECT 'classes_with_override', count(*)::text FROM classes WHERE daily_subjects IS NOT NULL;

-- ============================================================
-- 反向回滚（如需）：
--   DROP INDEX IF EXISTS idx_homework_tasks_daily;
--   ALTER TABLE homework_tasks DROP COLUMN IF EXISTS is_daily;
--   ALTER TABLE classes DROP COLUMN IF EXISTS daily_subjects;
--   DELETE FROM system_settings WHERE key = 'daily_homework_subjects';
-- ============================================================
