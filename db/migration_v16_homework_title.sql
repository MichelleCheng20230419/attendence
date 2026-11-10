-- ============================================================
-- 迁移 v16：作业统计 - 支持同一学科多份作业（作业标题）
-- homework_tasks 增加 title（作业标题，必填，如"背诵《劝学》"）
-- 唯一约束调整：(class_id, subject, date) → (class_id, subject, title, date)
--   同一天、同一学科下作业标题不能重复
-- ============================================================

ALTER TABLE homework_tasks ADD COLUMN IF NOT EXISTS title VARCHAR(100);

-- 历史数据兜底（若无标题则填默认值）
UPDATE homework_tasks SET title = '作业' WHERE title IS NULL OR title = '';

ALTER TABLE homework_tasks ALTER COLUMN title SET NOT NULL;

-- 唯一约束：旧的 (class_id, subject, date) → 新的 (class_id, subject, title, date)
DROP INDEX IF EXISTS uq_homework_tasks_class_subject_date;

CREATE UNIQUE INDEX IF NOT EXISTS uq_homework_tasks_class_subject_title_date
  ON homework_tasks(class_id, subject, title, date);
