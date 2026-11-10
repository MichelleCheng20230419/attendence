-- ============================================================
-- 迁移 v19：教师带班角色改为【班级级】
--   同一个老师可以在不同班级担任不同角色：
--     张老师 → 高三1班 → head_teacher（班主任）
--     张老师 → 高三2班 → subject_teacher（任课老师）
-- teacher_classes 新增：
--   role_in_class  该班角色：head_teacher | subject_teacher
--   subject        在该班所教学科（可选；空则回退到 users.subject）
-- 兼容：保留 is_head_teacher 列，并始终与 role_in_class 保持一致（应用层双写 + 本次回填）
-- ============================================================

ALTER TABLE teacher_classes ADD COLUMN IF NOT EXISTS role_in_class VARCHAR(20);
ALTER TABLE teacher_classes ADD COLUMN IF NOT EXISTS subject VARCHAR(20);

-- 回填：由旧的 is_head_teacher 推导
UPDATE teacher_classes
   SET role_in_class = CASE WHEN is_head_teacher THEN 'head_teacher' ELSE 'subject_teacher' END
 WHERE role_in_class IS NULL OR role_in_class NOT IN ('head_teacher', 'subject_teacher');

-- 任课记录补齐学科（取教师账号的所教学科）
UPDATE teacher_classes tc
   SET subject = u.subject
  FROM users u
 WHERE tc.teacher_id = u.id
   AND tc.role_in_class = 'subject_teacher'
   AND tc.subject IS NULL
   AND u.subject IS NOT NULL;

-- 约束与索引
ALTER TABLE teacher_classes ALTER COLUMN role_in_class SET DEFAULT 'subject_teacher';
ALTER TABLE teacher_classes ALTER COLUMN role_in_class SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teacher_classes_role ON teacher_classes(teacher_id, role_in_class);

-- 保持 is_head_teacher 与 role_in_class 一致
UPDATE teacher_classes SET is_head_teacher = (role_in_class = 'head_teacher');

-- 核对
SELECT tc.id, u.username, c.class_name, tc.role_in_class, tc.is_head_teacher, tc.subject
  FROM teacher_classes tc
  JOIN users u ON u.id = tc.teacher_id
  JOIN classes c ON c.id = tc.class_id
 ORDER BY u.username, c.class_name;
SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE role_in_class = 'head_teacher') AS head_rows,
       count(*) FILTER (WHERE role_in_class = 'subject_teacher') AS subject_rows
  FROM teacher_classes;
