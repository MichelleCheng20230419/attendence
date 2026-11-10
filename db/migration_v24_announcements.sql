-- ============================================================
-- 迁移 v24：叫号系统（announcements）
--   教师发布"请某班某学生到某地（某时间）"，班长端接收、语音播报并标记已处理
--   teacher_name / processed_by_name 冗余保存，账号删除后记录仍可读
--   is_played：是否已语音播报（班长端只播报未播报过的，避免刷新重复播）
-- ============================================================

CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  teacher_name VARCHAR(50),
  location VARCHAR(100) NOT NULL,
  scheduled_time TIMESTAMP,
  note TEXT,
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  is_played BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP,
  processed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  processed_by_name VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_ann_class_time ON announcements(class_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ann_teacher_time ON announcements(teacher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ann_class_status ON announcements(class_id, status);
CREATE INDEX IF NOT EXISTS idx_ann_scheduled ON announcements(scheduled_time);

-- 核对
SELECT count(*) AS announcement_rows FROM announcements;
