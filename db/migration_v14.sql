-- ============================================================
-- 迁移 v14：计划适用范围（班级）
-- attendance_plans 新增 class_id：NULL=全部班级（管理员创建），具体班级=仅该班生效
-- 唯一约束调整：同一(日期,时间,班级)只保留一个计划；NULL(全校)用 COALESCE 参与唯一
-- ============================================================
ALTER TABLE attendance_plans ADD COLUMN IF NOT EXISTS class_id INT REFERENCES classes(id);

-- 替换唯一约束：(plan_date, start_time) → (plan_date, start_time, class_id)
ALTER TABLE attendance_plans DROP CONSTRAINT IF EXISTS attendance_plans_plan_date_start_time_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_plans_date_time_class
    ON attendance_plans(plan_date, start_time, COALESCE(class_id, 0));
