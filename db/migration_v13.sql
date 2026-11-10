-- ============================================================
-- 迁移 v13：正副班主任
-- 1. classes 表：head_teacher_id（正班主任）/ deputy_teacher_id（副班主任）
-- 2. 迁移旧 teacher_id → head_teacher_id
-- 3. users.real_name 已存在（v8），补充默认值
-- ============================================================
ALTER TABLE classes ADD COLUMN IF NOT EXISTS head_teacher_id INT REFERENCES users(id);
ALTER TABLE classes ADD COLUMN IF NOT EXISTS deputy_teacher_id INT REFERENCES users(id);

-- 历史数据迁移：旧 teacher_id → head_teacher_id
UPDATE classes SET head_teacher_id = teacher_id
WHERE head_teacher_id IS NULL AND teacher_id IS NOT NULL;

-- real_name 默认值（历史数据由应用层回填：空则用 username 展示）
ALTER TABLE users ALTER COLUMN real_name SET DEFAULT '';
