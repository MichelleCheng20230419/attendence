-- ============================================================
-- 迁移 v12：班长签到模式（希沃白板专用）
-- 1. users 表：must_change_password（首次登录强制改密）
--    role 新增 'monitor'（班长）——VARCHAR 无需 DDL，应用层校验
-- 2. attendance_records 表：签到方式 + 按列签到列号
-- 3. operation_logs 表：操作日志（追溯班长操作）
-- ============================================================

-- 1. users.must_change_password
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. attendance_records 扩展
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_in_method VARCHAR(20) NOT NULL DEFAULT 'manual';
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS column_index INT;

-- 3. operation_logs 操作日志表
CREATE TABLE IF NOT EXISTS operation_logs (
    id         SERIAL PRIMARY KEY,
    user_id    INT,
    user_name  VARCHAR(50),
    role       VARCHAR(20),
    action     VARCHAR(50) NOT NULL,     -- batch_all_checkin / column_checkin / single_checkin / cancel_checkin / leave_checkin / remark
    detail     JSONB,                    -- 附加信息（如列号、人数、学生等）
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_operation_logs_user ON operation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_time ON operation_logs(created_at);
