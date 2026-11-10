-- ============================================================
-- 课堂签到管理系统 - 结构扩展 v4
-- 新增：attendance_plans（签到计划表，自动触发）
-- 状态：pending(待签到) | active(签到中) | ended(已结束)
-- 同一 (plan_date, start_time) 只允许一个计划（自动触发去重）
-- ============================================================
CREATE TABLE IF NOT EXISTS attendance_plans (
    id               SERIAL PRIMARY KEY,              -- 计划ID
    plan_date        DATE NOT NULL,                   -- 计划日期
    start_time       TIME NOT NULL,                   -- 签到开始时间（默认 08:00）
    duration_minutes INT  NOT NULL DEFAULT 10,        -- 签到时长（分钟，默认10）
    status           VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | active | ended
    session_id       INT REFERENCES attendance_sessions(id) ON DELETE SET NULL, -- 触发后关联的场次
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (plan_date, start_time)
);

-- 常用索引：按状态与触发时间查询
CREATE INDEX IF NOT EXISTS idx_attendance_plans_status
    ON attendance_plans(status);

-- 验证
-- SELECT id, plan_date, start_time, duration_minutes, status, session_id FROM attendance_plans;
