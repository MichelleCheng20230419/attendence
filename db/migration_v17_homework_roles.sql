-- ============================================================
-- 迁移 v17：作业模块角色模型（任课老师 / 班主任）+ 教师任课班级 + 截止时间
--  1) users.roles JSON：admin | head_teacher | subject_teacher | monitor
--     （班主任本身就是任课老师，head_teacher 已含任课权限，不叠加两个角色）
--  2) teacher_classes：教师所带班级（is_head_teacher 标记是否担任该班班主任）
--  3) homework_tasks.deadline：提交截止时间（日期+时间）；remark：备注
-- ============================================================

-- ---------- 1) users.roles ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS roles JSON DEFAULT '["subject_teacher"]';

-- 管理员 / 班长 / 学生
UPDATE users SET roles = '["admin"]'::json   WHERE role = 'admin';
UPDATE users SET roles = '["monitor"]'::json WHERE role = 'monitor';
UPDATE users SET roles = '[]'::json          WHERE role = 'student';

-- 教师：担任过（正/副）班主任 → head_teacher，否则 subject_teacher
UPDATE users u SET roles = '["head_teacher"]'::json
 WHERE u.role = 'teacher'
   AND EXISTS (
     SELECT 1 FROM classes c
      WHERE c.teacher_id = u.id OR c.head_teacher_id = u.id OR c.deputy_teacher_id = u.id
   );
UPDATE users u SET roles = '["subject_teacher"]'::json
 WHERE u.role = 'teacher' AND (u.roles IS NULL OR u.roles::text = '[]' OR u.roles::text = '["subject_teacher"]');

-- ---------- 2) teacher_classes ----------
CREATE TABLE IF NOT EXISTS teacher_classes (
  id              SERIAL PRIMARY KEY,
  teacher_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id        INT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  is_head_teacher BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_teacher_classes UNIQUE (teacher_id, class_id)
);

-- 回填：classes 上已有的（正/副）班主任与任课老师
INSERT INTO teacher_classes (teacher_id, class_id, is_head_teacher)
SELECT u.id, c.id, (c.head_teacher_id = u.id OR c.deputy_teacher_id = u.id OR c.teacher_id = u.id)
  FROM classes c
  JOIN users u ON u.id IN (c.teacher_id, c.head_teacher_id, c.deputy_teacher_id)
 WHERE u.role = 'teacher' AND u.id IS NOT NULL
ON CONFLICT (teacher_id, class_id) DO UPDATE SET is_head_teacher = true;

-- ---------- 3) homework_tasks.deadline / remark ----------
ALTER TABLE homework_tasks ADD COLUMN IF NOT EXISTS deadline TIMESTAMPTZ;
UPDATE homework_tasks SET deadline = (date::timestamp + time '23:59') WHERE deadline IS NULL;
ALTER TABLE homework_tasks ALTER COLUMN deadline SET NOT NULL;
ALTER TABLE homework_tasks ADD COLUMN IF NOT EXISTS remark VARCHAR(200);

CREATE INDEX IF NOT EXISTS idx_homework_tasks_deadline ON homework_tasks(deadline);

-- 核对
SELECT u.id, u.username, u.role, u.roles FROM users ORDER BY u.id;
SELECT tc.id, u.username, c.class_name, tc.is_head_teacher
  FROM teacher_classes tc JOIN users u ON u.id = tc.teacher_id JOIN classes c ON c.id = tc.class_id
 ORDER BY tc.id;
SELECT id, class_id, subject, title, date, deadline FROM homework_tasks ORDER BY id;
