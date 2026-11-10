-- ============================================================
-- 迁移 v18（仅新增，不修改现有结构与逻辑）
--  1) users.subject：教师所教学科
--  2) teacher_classes：教师所带班级（多对多）
--     —— 该表在 v17 已创建（含 is_head_teacher 等扩展列），此处 IF NOT EXISTS 保证存在
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS subject VARCHAR(20) DEFAULT NULL;

CREATE TABLE IF NOT EXISTS teacher_classes (
  id         SERIAL PRIMARY KEY,
  teacher_id INT REFERENCES users(id) ON DELETE CASCADE,
  class_id   INT REFERENCES classes(id) ON DELETE CASCADE,
  UNIQUE(teacher_id, class_id)
);

-- 核对
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'users' AND column_name = 'subject';
SELECT count(*) AS teacher_classes_rows FROM teacher_classes;
