-- ============================================================
-- 课堂签到管理系统 - 结构扩展 v9
-- students 表新增字段（学生档案扩展）
-- ============================================================
ALTER TABLE students ADD COLUMN IF NOT EXISTS gender           VARCHAR(10);   -- 性别（男/女）
ALTER TABLE students ADD COLUMN IF NOT EXISTS birth_date       DATE;          -- 出生日期
ALTER TABLE students ADD COLUMN IF NOT EXISTS id_card          VARCHAR(18);   -- 身份证号
ALTER TABLE students ADD COLUMN IF NOT EXISTS nationality      VARCHAR(20);   -- 民族
ALTER TABLE students ADD COLUMN IF NOT EXISTS political_status VARCHAR(20);   -- 政治面貌
ALTER TABLE students ADD COLUMN IF NOT EXISTS phone            VARCHAR(20);   -- 家长电话
ALTER TABLE students ADD COLUMN IF NOT EXISTS address          VARCHAR(200);  -- 家庭住址
ALTER TABLE students ADD COLUMN IF NOT EXISTS enrollment_date  DATE;          -- 入学日期
ALTER TABLE students ADD COLUMN IF NOT EXISTS graduation_school VARCHAR(100); -- 初中毕业学校
ALTER TABLE students ADD COLUMN IF NOT EXISTS emergency_contact VARCHAR(50);  -- 紧急联系人
ALTER TABLE students ADD COLUMN IF NOT EXISTS emergency_phone  VARCHAR(20);   -- 紧急联系人电话
ALTER TABLE students ADD COLUMN IF NOT EXISTS remarks          TEXT;          -- 备注

-- 验证
-- SELECT column_name FROM information_schema.columns WHERE table_name='students' ORDER BY ordinal_position;
