-- ============================================================
-- 迁移 v23：随机点名带上学科 + 新增点赞表
--   rollcall_records：等价于需求中的 call_records（点名记录），本次增加 subject 字段
--     记录该次点名所属学科（班长在点名页选择，默认沿用本班上次所用学科）
--   student_likes：点赞记录（班长在点名结果上点"👍 点赞"）
--     subject      该次点赞所属学科
--     operator_id  操作人（班长）账号 id
--     operator_name 操作人姓名（冗余保存，账号删除后记录仍可读）
--     like_count   本次点赞数（默认 1，便于将来做连点累加）
-- ============================================================

ALTER TABLE rollcall_records ADD COLUMN IF NOT EXISTS subject VARCHAR(20);

CREATE TABLE IF NOT EXISTS student_likes (
  id SERIAL PRIMARY KEY,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  subject VARCHAR(20),
  operator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  operator_name VARCHAR(50),
  like_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rollcall_subject_time ON rollcall_records(class_id, subject, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_likes_class_subject_time ON student_likes(class_id, subject, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_likes_student ON student_likes(student_id);
CREATE INDEX IF NOT EXISTS idx_likes_class_time ON student_likes(class_id, created_at DESC);

-- 核对
SELECT count(*) AS rollcall_rows,
       count(*) FILTER (WHERE subject IS NOT NULL) AS with_subject
  FROM rollcall_records;
SELECT count(*) AS likes_rows FROM student_likes;
