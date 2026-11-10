-- ============================================================
-- 迁移 v34：班级绑定「选科组合」与「选科科目」
--
-- 背景 / 需求：
--   不同班级的选科组合不同（理科 / 文科 / 小理 / 小文 / 综合），各班开设的学科因此不同：
--     语文、数学、英语 = 所有班级默认都有（不进 elective_subjects）
--     物理、化学、生物、政治、历史、地理 = 由选科组合决定（存在 elective_subjects）
--   班级绑定选科后，该班每天自动生成的「今日作业」科目 = 语文+数学+英语 + 选科科目。
--
-- 设计：
--   · classes.stream             选科组合：理科 / 文科 / 小理 / 小文 / 综合（默认「综合」）
--   · classes.elective_subjects  选科科目数组（JSONB，默认 []）：只存 6 门选科，
--                                语文/数学/英语 隐含包含、不需要写入这里
--   · 与 v32 的 classes.daily_subjects（显式覆盖）关系：
--       每日作业科目取用优先级（见 server/src/lib/classSubjects.js）：
--         classes.daily_subjects（管理员显式覆盖，最高）
--           > classes.stream + classes.elective_subjects（本迁移新增，按选科组合推导）
--           > system_settings.daily_homework_subjects（全局默认）
--   · 沿用 JSONB 而非 JSON：可索引、可做包含查询，且与库内其它 JSON 列（operation_logs.detail）口径一致。
--
-- 安全：只新增两列 + 一个 CHECK 约束；已存在班级保持「综合 + 空数组」= 与迁移前行为完全一致
--       （每日作业仍走全局默认 6 科），不改动任何既有数据。可回滚（见文件末尾）。
-- ============================================================
SET client_encoding = 'UTF8';

BEGIN;

-- 1) 选科组合
ALTER TABLE classes ADD COLUMN IF NOT EXISTS stream VARCHAR(20) DEFAULT '综合';
COMMENT ON COLUMN classes.stream IS
  '班级选科组合：理科 / 文科 / 小理 / 小文 / 综合（默认综合=不自动推导科目，沿用全局默认）';

-- 2) 选科科目（只存物理/化学/生物/政治/历史/地理；语文/数学/英语 隐含包含）
ALTER TABLE classes ADD COLUMN IF NOT EXISTS elective_subjects JSONB DEFAULT '[]'::jsonb;
COMMENT ON COLUMN classes.elective_subjects IS
  '该班选科科目（JSONB 字符串数组，如 ["物理","化学","生物"]）；只含 6 门选科，语文/数学/英语 不写入这里';

-- 3) 约束：选科组合只能是约定值（NULL 视为综合，兼容历史行）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classes_stream_check') THEN
    ALTER TABLE classes ADD CONSTRAINT classes_stream_check
      CHECK (stream IS NULL OR stream IN ('理科', '文科', '小理', '小文', '综合'));
  END IF;
END $$;

-- 4) 历史行补齐默认值（与迁移前行为一致：综合 + 空选科 → 每日作业走全局默认）
UPDATE classes SET stream = '综合' WHERE stream IS NULL;
UPDATE classes SET elective_subjects = '[]'::jsonb WHERE elective_subjects IS NULL;

COMMIT;

-- ============================================================
-- 校验输出
-- ============================================================
\echo '=== classes.stream / classes.elective_subjects 已就位 ==='
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'classes' AND column_name IN ('stream', 'daily_subjects', 'elective_subjects')
 ORDER BY column_name;

\echo '=== 约束 ==='
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'classes_stream_check';

\echo '=== 班级选科分布（历史班级应全部为 综合 / 空选科，行为不变）==='
SELECT COALESCE(stream, '(NULL)') AS stream, count(*)::int AS n,
       count(*) FILTER (WHERE elective_subjects IS NOT NULL AND jsonb_array_length(elective_subjects) > 0)::int AS with_electives
  FROM classes GROUP BY 1 ORDER BY 1;

-- ============================================================
-- 反向回滚（如需）：
--   ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_stream_check;
--   ALTER TABLE classes DROP COLUMN IF EXISTS stream;
--   ALTER TABLE classes DROP COLUMN IF EXISTS elective_subjects;
-- ============================================================
