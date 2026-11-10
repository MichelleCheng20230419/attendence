-- ============================================================
-- 课堂签到管理系统 - 结构扩展 v2
-- 新增：teachers / classes / courses，students 增加 class_id
-- 说明：对原 SQL 做了两处必要修正（见文件内注释），表结构完全一致
-- ============================================================

-- 1. 教师表
CREATE TABLE IF NOT EXISTS teachers (
    id SERIAL PRIMARY KEY,
    teacher_no VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(50) NOT NULL,
    phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. 班级表
-- 修正①：补充 (class_name, grade) 唯一约束，否则下方的 ON CONFLICT 会报错
--        （注意：PostgreSQL 的 ADD CONSTRAINT 不支持 IF NOT EXISTS，用 DO 块判断）
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

-- 3. 课程表
CREATE TABLE IF NOT EXISTS courses (
    id SERIAL PRIMARY KEY,
    course_name VARCHAR(100) NOT NULL,
    course_code VARCHAR(20) UNIQUE NOT NULL,
    teacher_id INTEGER REFERENCES teachers(id) ON DELETE CASCADE,
    class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. students 增加 class_id（班级），并确保学号唯一约束存在
ALTER TABLE students ADD COLUMN IF NOT EXISTS class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'students_student_no_key') THEN
    ALTER TABLE students ADD CONSTRAINT students_student_no_key UNIQUE (student_no);
  END IF;
END $$;

-- ============================================================
-- 基础数据（使用子查询关联，不硬编码自增 ID）
-- ============================================================

-- 教师：王老师
INSERT INTO teachers (teacher_no, name)
VALUES ('T001', '王老师')
ON CONFLICT (teacher_no) DO NOTHING;

-- 班级：三年级一班 / 三年级二班（班主任为王老师）
INSERT INTO classes (class_name, grade, teacher_id)
SELECT v.class_name, v.grade, t.id
FROM (VALUES ('三年级一班', '三年级'), ('三年级二班', '三年级')) AS v(class_name, grade)
CROSS JOIN (SELECT id FROM teachers WHERE teacher_no = 'T001') t
ON CONFLICT (class_name, grade) DO NOTHING;

-- 已有学生默认分到三年级一班（按你的要求）
UPDATE students SET class_id = 1 WHERE class_id IS NULL;

-- 课程：数学课（两个班各一条）
-- 修正②：course_code 唯一，两条记录用不同代码，避免第二条被静默跳过
INSERT INTO courses (course_name, course_code, teacher_id, class_id)
SELECT '数学课', v.course_code, t.id, c.id
FROM (VALUES ('MATH301', '三年级一班'), ('MATH302', '三年级二班')) AS v(course_code, class_name)
CROSS JOIN (SELECT id FROM teachers WHERE teacher_no = 'T001') t
JOIN classes c ON c.class_name = v.class_name AND c.grade = '三年级'
ON CONFLICT (course_code) DO NOTHING;
