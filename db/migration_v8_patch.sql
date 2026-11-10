-- ============================================================
-- 结构扩展 v8-补丁：classes.teacher_id 改指向 users（教师账号）
-- 原指向 teachers 表（已弃用），班主任应关联账号体系
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classes_teacher_id_fkey' AND conrelid = 'classes'::regclass) THEN
    ALTER TABLE classes DROP CONSTRAINT classes_teacher_id_fkey;
  END IF;
END $$;
ALTER TABLE classes
  ADD CONSTRAINT classes_teacher_id_fkey
  FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE SET NULL;

-- 验证
-- SELECT id, class_name, teacher_id FROM classes;
