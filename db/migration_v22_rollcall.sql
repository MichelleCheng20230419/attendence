-- ============================================================
-- 迁移 v22：班长端「随机点名」记录表
--   rollcall_records：每次随机点名的学生、时间、范围、操作者
--     scope      all=全班 / absent=仅未签到学生
--     session_id 关联当时的签到场次（便于"同一节课不重复"与课堂追溯，可为空）
--   picked_by_name 冗余保存操作者姓名（账号被删后记录仍可读）
-- ============================================================

CREATE TABLE IF NOT EXISTS rollcall_records (
  id SERIAL PRIMARY KEY,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES attendance_sessions(id) ON DELETE SET NULL,
  scope VARCHAR(10) NOT NULL DEFAULT 'all',
  picked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  picked_by_name VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rollcall_class_time ON rollcall_records(class_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rollcall_student ON rollcall_records(student_id);
CREATE INDEX IF NOT EXISTS idx_rollcall_session ON rollcall_records(session_id);

-- 核对
SELECT count(*) AS rollcall_rows FROM rollcall_records;
