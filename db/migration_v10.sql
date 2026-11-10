-- ============================================================
-- 迁移 v10：签到座位表模式（方案A：座位字段放 students 表）
-- students 表新增 seat_row / seat_col（0 表示未排座）
-- ============================================================
ALTER TABLE students ADD COLUMN IF NOT EXISTS seat_row INT DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS seat_col INT DEFAULT 0;
