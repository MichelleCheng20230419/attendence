-- ============================================================
-- 课堂签到管理系统 - 结构扩展 v7
-- users 表增加 is_active（账号启用/禁用）
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- 验证
-- SELECT id, username, role, is_active, class_id FROM users ORDER BY id;
