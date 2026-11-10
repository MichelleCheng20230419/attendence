-- ============================================================
-- 课堂签到管理系统 - 结构扩展 v3
-- students 增加 is_active（软删除）：删除学生=标记不可用，
-- 历史签到记录保留（外键仍指向该学生行，姓名不丢失）
-- ============================================================
ALTER TABLE students ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- 验证
-- SELECT id, student_no, name, is_active FROM students ORDER BY id LIMIT 5;
