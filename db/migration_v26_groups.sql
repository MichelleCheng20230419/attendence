-- ============================================================
-- 迁移 v26：小组管理（灵活的权限配置系统）
--   目标：管理员可在后台创建"小组"并勾选该小组可访问的页面/操作权限，
--         用户加入小组后即获得对应权限（多个小组取并集）。
--         以后出现新角色（教务组、巡堂组、德育组…）管理员自己配置即可，无需改代码。
--
--   groups
--     name        小组名称（唯一）
--     description 小组描述
--     permissions JSONB：{"pages":["inspection",...], "actions":["create_issue",...]}
--                 · pages   页面/菜单权限（签到操作 / 考勤管理 / 教学工具 / 数据统计 / 巡堂记录 / 系统管理）
--                 · actions 操作权限（如巡堂记录下的 创建问题 / 添加反馈 / 上传照片）
--   user_groups   用户-小组关联（一个用户可属于多个小组；同一小组同一用户只允许一条）
--
--   兼容策略：现有角色（管理员/班主任/任课老师/班长/学生）保持原样，
--             小组权限是【叠加】的：不属于小组的用户菜单与现在完全一致。
-- ============================================================

CREATE TABLE IF NOT EXISTS groups (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  description VARCHAR(200),
  permissions JSONB NOT NULL DEFAULT '{"pages": [], "actions": []}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 小组名称唯一（忽略大小写与首尾空格，避免"教务组 / 教务组 "重复建）
CREATE UNIQUE INDEX IF NOT EXISTS uq_groups_name ON groups (lower(btrim(name)));

CREATE TABLE IF NOT EXISTS user_groups (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_user_groups UNIQUE (user_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_user_groups_user ON user_groups (user_id);
CREATE INDEX IF NOT EXISTS idx_user_groups_group ON user_groups (group_id);

-- 核对
SELECT
  (SELECT count(*) FROM groups) AS group_rows,
  (SELECT count(*) FROM user_groups) AS user_group_rows;
