-- ============================================================
-- 迁移 v25：发起签到 / 签到计划的「发起人追溯」
--   背景：attendance_sessions 原本只有 id/start_time/deadline/status/created_at，
--         POST /api/attendance/start 也不写操作日志 → 手动发起的场次无法追溯是谁发起的。
--   （实测案例：场次 347 于 18:44:44 被手动发起、并在 19:14 对全校补缺勤，
--     但数据库里查不到发起人。）
--   本迁移：
--     1) attendance_sessions 增加 created_by / created_by_name / created_by_role /
--        start_source(manual|plan) / deadline_minutes
--     2) attendance_plans 增加 created_by / created_by_name / created_by_role
--     3) 历史数据回填：有计划关联的场次 → start_source='plan'；其余 → 'manual'
-- ============================================================

ALTER TABLE attendance_sessions
  ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(50),
  ADD COLUMN IF NOT EXISTS created_by_role VARCHAR(20),
  ADD COLUMN IF NOT EXISTS start_source VARCHAR(20) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS deadline_minutes INTEGER;

ALTER TABLE attendance_plans
  ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(50),
  ADD COLUMN IF NOT EXISTS created_by_role VARCHAR(20);

-- 历史回填：由计划触发的场次标记来源（发起人无法回溯，保持 NULL，不做猜测）
UPDATE attendance_sessions s
   SET start_source = 'plan'
  FROM attendance_plans p
 WHERE p.session_id = s.id
   AND s.start_source <> 'plan';

-- 历史回填：截止时长（deadline - start_time，分钟）
UPDATE attendance_sessions
   SET deadline_minutes = GREATEST(1, round(extract(epoch FROM (deadline - start_time)) / 60)::int)
 WHERE deadline_minutes IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_creator ON attendance_sessions(created_by);
CREATE INDEX IF NOT EXISTS idx_plans_creator ON attendance_plans(created_by);

-- 核对
SELECT
  (SELECT count(*) FROM attendance_sessions) AS session_rows,
  (SELECT count(*) FROM attendance_sessions WHERE start_source = 'plan') AS from_plan,
  (SELECT count(*) FROM attendance_sessions WHERE start_source = 'manual') AS manual,
  (SELECT count(*) FROM attendance_sessions WHERE created_by IS NULL) AS unknown_creator,
  (SELECT count(*) FROM attendance_plans) AS plan_rows;
