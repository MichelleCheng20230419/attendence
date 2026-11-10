-- ============================================================
-- 课堂签到管理系统 - 结构扩展 v8（后台管理升级 + 学生异动）
-- 核心原则：年级/班级带学年属性；ID 终身不变；历史数据按 班级+学年 归属
-- ============================================================

-- 1. 年级表 grades（带学年）
CREATE TABLE IF NOT EXISTS grades (
    id            SERIAL PRIMARY KEY,
    grade_name    VARCHAR(50)  NOT NULL,          -- 年级名称（一年级/二年级...）
    grade_code    VARCHAR(20),                    -- 年级代码（G1/G2...）
    academic_year VARCHAR(9)   NOT NULL,          -- 学年（2026-2027）
    sort_order    INT          NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (grade_name, academic_year)
);

-- 2. classes 表扩展（学年 / 年级ID / 状态）
ALTER TABLE classes ADD COLUMN IF NOT EXISTS academic_year VARCHAR(9);
ALTER TABLE classes ADD COLUMN IF NOT EXISTS grade_id INT REFERENCES grades(id) ON DELETE SET NULL;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'; -- active(活跃)/archived(归档)

-- 3. students 表扩展（入学学年 / 状态 / 状态更新时间）
ALTER TABLE students ADD COLUMN IF NOT EXISTS academic_year VARCHAR(9);
ALTER TABLE students ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT '在读'; -- 在读/休学/转学/退学/毕业
ALTER TABLE students ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ;

-- 4. users 表扩展（学年 / 真实姓名；class_id 已存在）
ALTER TABLE users ADD COLUMN IF NOT EXISTS academic_year VARCHAR(9);
ALTER TABLE users ADD COLUMN IF NOT EXISTS real_name VARCHAR(50);

-- 5. 学生异动记录表 student_transfers
CREATE TABLE IF NOT EXISTS student_transfers (
    id             SERIAL PRIMARY KEY,
    student_id     INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    from_class_id  INT REFERENCES classes(id) ON DELETE SET NULL,   -- 原班级（NULL=入学）
    to_class_id    INT REFERENCES classes(id) ON DELETE SET NULL,   -- 新班级（NULL=离校）
    from_status    VARCHAR(20),
    to_status      VARCHAR(20),
    transfer_type  VARCHAR(20) NOT NULL,           -- 转班/休学/复学/转学/退学
    reason         VARCHAR(200),
    effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
    operator_id    INT REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_student_transfers_student ON student_transfers(student_id);
CREATE INDEX IF NOT EXISTS idx_student_transfers_date ON student_transfers(effective_date);

-- 6. 系统设置表（当前学年等）
CREATE TABLE IF NOT EXISTS system_settings (
    key        VARCHAR(50) PRIMARY KEY,
    value      VARCHAR(200),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO system_settings (key, value) VALUES ('current_academic_year', '2026-2027')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 约束与数据回填（幂等）
-- ============================================================

-- classes 唯一约束：旧 (class_name, grade) → 新 (class_name, grade_id, academic_year)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classes_class_name_grade_key') THEN
    ALTER TABLE classes DROP CONSTRAINT classes_class_name_grade_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classes_class_name_grade_id_academic_year_key') THEN
    ALTER TABLE classes ADD CONSTRAINT classes_class_name_grade_id_academic_year_key
      UNIQUE (class_name, grade_id, academic_year);
  END IF;
END $$;

-- 从现有班级反推年级（当前学年 2026-2027）
INSERT INTO grades (grade_name, grade_code, academic_year, sort_order)
SELECT t.grade, 'G' || row_number() OVER (ORDER BY t.grade)::text, '2026-2027', row_number() OVER (ORDER BY t.grade)::int
FROM (SELECT DISTINCT grade FROM classes WHERE grade IS NOT NULL AND grade <> '') t
ON CONFLICT (grade_name, academic_year) DO NOTHING;

-- 回填：班级 → 关联年级 + 学年
UPDATE classes c
SET grade_id = g.id, academic_year = '2026-2027'
FROM grades g
WHERE c.grade = g.grade_name
  AND g.academic_year = '2026-2027'
  AND (c.grade_id IS NULL OR c.academic_year IS NULL);

-- 回填：学生 → 入学学年 + 在读状态
UPDATE students
SET academic_year = '2026-2027', status = '在读', status_updated_at = now()
WHERE academic_year IS NULL;

-- 回填：用户 → 学年 + 真实姓名
UPDATE users
SET academic_year = '2026-2027',
    real_name = COALESCE(NULLIF(real_name,''), NULLIF(display_name,''), username)
WHERE academic_year IS NULL OR real_name IS NULL;

-- ============================================================
-- 验证
-- ============================================================
-- SELECT id, grade_name, grade_code, academic_year, sort_order FROM grades;
-- SELECT id, class_name, grade, grade_id, academic_year, status FROM classes;
-- SELECT id, student_no, name, class_id, academic_year, status FROM students;
-- SELECT id, username, role, class_id, academic_year, real_name FROM users;
