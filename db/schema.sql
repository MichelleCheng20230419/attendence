-- ============================================================
-- 课堂签到管理系统（第一版）——数据库建表脚本
-- 目标数据库：testdb（PostgreSQL 17）
-- 说明：本脚本可重复执行（幂等），已存在的表不会重复创建。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 学生表 students
--    存放班级学生名单（预置名单，后续可按实际名单替换种子数据）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
    id          SERIAL PRIMARY KEY,              -- 学生ID（自增）
    student_no  VARCHAR(20) UNIQUE NOT NULL,     -- 学号（唯一）
    name        VARCHAR(50)  NOT NULL,           -- 姓名
    is_active   BOOLEAN      NOT NULL DEFAULT true, -- 是否有效（软删除标记）
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()  -- 创建时间
);

-- ------------------------------------------------------------
-- 2. 签到场次表 attendance_sessions
--    教师每点击一次"发起签到"就生成一个场次，
--    记录签到开始时间与截止时间（默认30分钟后）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_sessions (
    id          SERIAL PRIMARY KEY,              -- 场次ID（自增）
    start_time  TIMESTAMPTZ  NOT NULL DEFAULT now(),  -- 签到开始时间
    deadline    TIMESTAMPTZ  NOT NULL,                -- 签到截止时间
    status      VARCHAR(20)  NOT NULL DEFAULT 'active', -- 场次状态：active(进行中) | closed(已结束)
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 3. 请假事由表 leave_reasons
--    预置三种事由：病假、事假、公假
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leave_reasons (
    id     SERIAL PRIMARY KEY,                   -- 事由ID
    code   VARCHAR(20) UNIQUE NOT NULL,          -- 事由代码：sick | personal | official
    name   VARCHAR(50) NOT NULL                  -- 事由名称：病假 | 事假 | 公假
);

-- ------------------------------------------------------------
-- 4. 签到记录表 attendance_records
--    每个学生在每个场次下最多一条记录（UNIQUE 约束保证）
--    状态取值：
--      present  = 已签到（绿色）
--      leave    = 请假（橙色）
--      late     = 迟到（蓝色）
--      absent   = 缺勤（红色）
--    灰色（未签到）= 该场次下尚无记录
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_records (
    id            SERIAL PRIMARY KEY,            -- 记录ID（自增）
    session_id    INT NOT NULL
                  REFERENCES attendance_sessions(id) ON DELETE CASCADE,  -- 所属场次
    student_id    INT NOT NULL
                  REFERENCES students(id) ON DELETE CASCADE,             -- 学生
    status        VARCHAR(20) NOT NULL,          -- present | leave | late | absent
    leave_reason  VARCHAR(20),                   -- 请假事由代码（status=leave 时必填）
    checkin_time  TIMESTAMPTZ,                   -- 签到/请假发生时间
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, student_id)              -- 同一场次下每个学生只有一条记录
);

-- 常用查询索引
CREATE INDEX IF NOT EXISTS idx_attendance_sessions_status
    ON attendance_sessions(status);
CREATE INDEX IF NOT EXISTS idx_attendance_records_session
    ON attendance_records(session_id);

-- ============================================================
-- 种子数据
-- ============================================================

-- 请假事由（固定三种）
INSERT INTO leave_reasons (code, name) VALUES
    ('sick',     '病假'),
    ('personal', '事假'),
    ('official', '公假')
ON CONFLICT (code) DO NOTHING;

-- 示例学生名单（正式名单待用户提供后替换）
INSERT INTO students (student_no, name) VALUES
    ('20240001', '张伟'),
    ('20240002', '王芳'),
    ('20240003', '李娜'),
    ('20240004', '刘洋'),
    ('20240005', '陈静'),
    ('20240006', '杨磊'),
    ('20240007', '赵敏'),
    ('20240008', '黄强'),
    ('20240009', '周婷'),
    ('20240010', '吴昊'),
    ('20240011', '徐丽'),
    ('20240012', '孙杰')
ON CONFLICT (student_no) DO NOTHING;

-- ============================================================
-- 结构扩展 v2：教师 / 班级 / 课程（幂等）
-- ============================================================

-- 教师表
CREATE TABLE IF NOT EXISTS teachers (
    id SERIAL PRIMARY KEY,
    teacher_no VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(50) NOT NULL,
    phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 班级表（含 (class_name, grade) 唯一约束，供 ON CONFLICT 使用）
CREATE TABLE IF NOT EXISTS classes (
    id SERIAL PRIMARY KEY,
    class_name VARCHAR(50) NOT NULL,
    grade VARCHAR(20),
    teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classes_class_name_grade_key') THEN
    ALTER TABLE classes ADD CONSTRAINT classes_class_name_grade_key UNIQUE (class_name, grade);
  END IF;
END $$;

-- 课程表
CREATE TABLE IF NOT EXISTS courses (
    id SERIAL PRIMARY KEY,
    course_name VARCHAR(100) NOT NULL,
    course_code VARCHAR(20) UNIQUE NOT NULL,
    teacher_id INTEGER REFERENCES teachers(id) ON DELETE CASCADE,
    class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- students 增加班级字段 class_id
ALTER TABLE students ADD COLUMN IF NOT EXISTS class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE;

-- v2 基础数据
INSERT INTO teachers (teacher_no, name)
VALUES ('T001', '王老师')
ON CONFLICT (teacher_no) DO NOTHING;

INSERT INTO classes (class_name, grade, teacher_id)
SELECT v.class_name, v.grade, t.id
FROM (VALUES ('三年级一班', '三年级'), ('三年级二班', '三年级')) AS v(class_name, grade)
CROSS JOIN (SELECT id FROM teachers WHERE teacher_no = 'T001') t
ON CONFLICT (class_name, grade) DO NOTHING;

UPDATE students SET class_id = 1 WHERE class_id IS NULL;

INSERT INTO courses (course_name, course_code, teacher_id, class_id)
SELECT '数学课', v.course_code, t.id, c.id
FROM (VALUES ('MATH301', '三年级一班'), ('MATH302', '三年级二班')) AS v(course_code, class_name)
CROSS JOIN (SELECT id FROM teachers WHERE teacher_no = 'T001') t
JOIN classes c ON c.class_name = v.class_name AND c.grade = '三年级'
ON CONFLICT (course_code) DO NOTHING;

-- ============================================================
-- 结构扩展 v4：签到计划表 attendance_plans（自动触发）
-- 状态：pending(待签到) | active(签到中) | ended(已结束)
-- ============================================================
CREATE TABLE IF NOT EXISTS attendance_plans (
    id               SERIAL PRIMARY KEY,
    plan_date        DATE NOT NULL,
    start_time       TIME NOT NULL,
    duration_minutes INT  NOT NULL DEFAULT 10,
    status           VARCHAR(20) NOT NULL DEFAULT 'pending',
    session_id       INT REFERENCES attendance_sessions(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (plan_date, start_time)
);
CREATE INDEX IF NOT EXISTS idx_attendance_plans_status
    ON attendance_plans(status);

-- ============================================================
-- 验证查询（建表后可用于检查）
-- ============================================================
-- SELECT COUNT(*) FROM students;              -- 应返回 12（+后续导入）
-- SELECT * FROM leave_reasons;                -- 应返回 3 行
-- SELECT COUNT(*) FROM teachers;              -- 应返回 1
-- SELECT COUNT(*) FROM classes;               -- 应返回 2
-- SELECT COUNT(*) FROM courses;               -- 应返回 2
