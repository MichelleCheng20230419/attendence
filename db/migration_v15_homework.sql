-- ============================================================
-- 迁移 v15：作业统计模块（座位表联动）
-- homework_tasks：每日每班每科目一条作业任务
--   - 唯一约束 (class_id, subject, date)：同班同日同科目只有一条
-- homework_submissions：每个学生的提交状态
--   - 唯一约束 (task_id, student_id)
-- ============================================================

CREATE TABLE IF NOT EXISTS homework_tasks (
  id          SERIAL PRIMARY KEY,
  class_id    INT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  date        DATE NOT NULL,
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_homework_tasks_class_subject_date
  ON homework_tasks(class_id, subject, date);

CREATE TABLE IF NOT EXISTS homework_submissions (
  id           SERIAL PRIMARY KEY,
  task_id      INT NOT NULL REFERENCES homework_tasks(id) ON DELETE CASCADE,
  student_id   INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  is_submitted BOOLEAN NOT NULL DEFAULT false,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_homework_submissions_task_student UNIQUE (task_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_homework_submissions_task ON homework_submissions(task_id);
