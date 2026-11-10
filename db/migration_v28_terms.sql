-- ============================================================
-- 迁移 v28：学期设置（系统管理 → 学年管理 → 学期设置）
--   目的：让「本学期」筛选不再靠脚本里的硬编码月份推算，而是按管理员配置的
--         上下学期起止日期统计。
--
--   说明：本库不存在 academic_years 表——学年的唯一真相是
--         system_settings.current_academic_year + grades/classes/students.academic_year，
--         因此学期设置沿用同一张 key/value 表（system_settings），而不是新造一张
--         只被学期设置使用的表，避免出现第二处「学年真相」。
--
--   key 约定：
--     term_first_start   上学期开始日期 YYYY-MM-DD（空 = 未配置）
--     term_first_end     上学期结束日期
--     term_second_start  下学期开始日期
--     term_second_end    下学期结束日期
--     current_term       当前学期 first 上学期 / second 下学期（默认 first）
--
--   初值留空 = 未配置：此时「本学期」按内置默认口径统计（上学期 9/1~次年 1/31、
--   下学期 2/1~7/15，按今天所在月份判断），并在页面上给出「请先设置学期起止日期」提示。
-- ============================================================

SET client_encoding = 'UTF8';

BEGIN;

INSERT INTO system_settings (key, value, updated_at) VALUES
  ('term_first_start',  '', now()),
  ('term_first_end',    '', now()),
  ('term_second_start', '', now()),
  ('term_second_end',   '', now()),
  ('current_term',      'first', now())
ON CONFLICT (key) DO NOTHING;

COMMIT;
