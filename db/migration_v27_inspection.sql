-- ============================================================
-- 迁移 v27：巡堂记录业务（问题 / 照片 / 反馈）
--   基于已打通的小组权限：页面权限 inspection + 操作权限
--     create_issue（记录问题）/ add_feedback（添加反馈）/ upload_photo（上传照片）
--
--   inspection_issues     巡堂问题
--     issue_date   巡堂日期（创建表单里的"日期"，默认当天）
--     class_id     涉及班级
--     description  问题描述
--     category     问题类型：hygiene 卫生 / discipline 纪律 / equipment 设备 / teaching 教学 / other 其他
--     priority     紧急程度：normal 普通 / urgent 紧急
--     status       状态：pending 待处理 / processing 处理中 / resolved 已解决
--     created_by   创建人（users.id）+ created_by_name 冗余（账号删除后仍可读）
--   inspection_photos     问题照片（文件落盘 public/uploads/inspection/，库里存路径）
--   inspection_feedbacks  反馈记录
--     feedback_status 反馈选择：processing 处理中 / resolved 已解决 / unresolved 未解决
--                     （is_resolved 为需求中的布尔字段 = feedback_status='resolved'，保留兼容）
-- ============================================================

CREATE TABLE IF NOT EXISTS inspection_issues (
  id SERIAL PRIMARY KEY,
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  category VARCHAR(20) NOT NULL DEFAULT 'other',
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name VARCHAR(50),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_insp_issues_date ON inspection_issues (issue_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_insp_issues_status ON inspection_issues (status);
CREATE INDEX IF NOT EXISTS idx_insp_issues_class ON inspection_issues (class_id);

CREATE TABLE IF NOT EXISTS inspection_photos (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES inspection_issues(id) ON DELETE CASCADE,
  file_path VARCHAR(300) NOT NULL,
  file_name VARCHAR(200),
  file_size INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_insp_photos_issue ON inspection_photos (issue_id);

CREATE TABLE IF NOT EXISTS inspection_feedbacks (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES inspection_issues(id) ON DELETE CASCADE,
  is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  feedback_status VARCHAR(20) NOT NULL DEFAULT 'processing',
  solution TEXT,
  feedback_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  feedback_by_name VARCHAR(50),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_insp_fb_issue ON inspection_feedbacks (issue_id, created_at);

-- 核对
SELECT
  (SELECT count(*) FROM inspection_issues) AS issues,
  (SELECT count(*) FROM inspection_photos) AS photos,
  (SELECT count(*) FROM inspection_feedbacks) AS feedbacks;
