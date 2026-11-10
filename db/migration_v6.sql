-- ============================================================
-- 课堂签到管理系统 - 结构扩展 v6
-- users 表扩展：个人资料字段 + 登录追踪
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_no  VARCHAR(50);   -- 工号（只读）
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization VARCHAR(100);  -- 工作单位
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone        VARCHAR(20);   -- 手机号
ALTER TABLE users ADD COLUMN IF NOT EXISTS email        VARCHAR(100);  -- 邮箱
ALTER TABLE users ADD COLUMN IF NOT EXISTS class_id     INT REFERENCES classes(id) ON DELETE SET NULL; -- 所带班级
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;  -- 上次登录时间
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(50);  -- 上次登录IP

-- admin 默认工号
UPDATE users SET employee_no = 'T001' WHERE username = 'admin' AND (employee_no IS NULL OR employee_no = '');

-- 验证
-- SELECT id, username, employee_no, organization, phone, email, class_id, last_login_at, last_login_ip FROM users;
