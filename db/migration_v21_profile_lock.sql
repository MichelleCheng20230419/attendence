-- ============================================================
-- 迁移 v21：教师教学设置「首次确认后锁定」
--   users.profile_locked
--     false → 未锁定：教师首次登录需确认所教学科与所带班级（首次可自行设置）
--     true  → 已锁定：教师端只读，仅管理员可在账号管理中修改
-- 回填策略：
--   已有教师账号视为「已配置」，一律置为 true（避免老账号被强制走首次确认流程）；
--   新建教师账号默认 false（由教师在首次登录时确认，避免管理员配错）。
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_locked BOOLEAN;
UPDATE users SET profile_locked = false WHERE profile_locked IS NULL;
ALTER TABLE users ALTER COLUMN profile_locked SET DEFAULT false;
ALTER TABLE users ALTER COLUMN profile_locked SET NOT NULL;

-- 已有教师账号 → 已锁定（含历史配置齐全的账号）
UPDATE users SET profile_locked = true WHERE role = 'teacher' AND profile_locked = false;

-- 核对
SELECT role, profile_locked, count(*) AS cnt
  FROM users GROUP BY role, profile_locked ORDER BY role, profile_locked;
SELECT count(*) AS teachers_unlocked FROM users WHERE role = 'teacher' AND profile_locked = false;
