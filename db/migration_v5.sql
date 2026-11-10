-- ============================================================
-- 课堂签到管理系统 - 结构扩展 v5
-- 新增：users（用户/账号表，登录功能）
-- 密码暂为明文存储（后续版本改为哈希加密）
-- 角色：admin(管理员) | teacher(教师) | student(学生)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id           SERIAL PRIMARY KEY,
    username     VARCHAR(50) UNIQUE NOT NULL,   -- 用户名（唯一）
    password     VARCHAR(100) NOT NULL,          -- 密码（明文，后续哈希）
    role         VARCHAR(20) NOT NULL DEFAULT 'teacher', -- admin | teacher | student
    display_name VARCHAR(50),                    -- 显示名称
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 系统初始化：默认管理员账号 admin / 123456
INSERT INTO users (username, password, role, display_name)
VALUES ('admin', '123456', 'admin', '系统管理员')
ON CONFLICT (username) DO NOTHING;

-- 验证
-- SELECT id, username, role, display_name FROM users;
