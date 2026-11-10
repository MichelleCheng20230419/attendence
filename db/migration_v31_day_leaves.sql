-- ============================================================
-- 迁移 v31：批量请假（当天全天请假）—— 新表 student_day_leaves
--
-- 背景 / 需求：
--   签到操作台新增「📋 批量请假」按钮：一次给多个学生登记**当天全天**请假（病假/事假）。
--   登记后：
--     · 当天已有/后续的每个场次里，该学生都记为「请假」（卡片橙色），不再需要签到；
--     · 缺勤补写（finalizeAbsent）不得覆盖为缺勤；
--     · 考勤分析按「请假」统计（不计入缺勤），并按事由细分。
--   原「逐个学生右键请假」仍然保留（那是**当场次**请假），本表存的是**按天**的登记，
--   两者是同一个 attendance_records.status='leave' 的两种来源：
--     attendance_records.check_in_method = 'batch_leave' 表示由批量请假写入。
--
-- 设计要点：
--   · 唯一键 (student_id, leave_date)：一个学生一天只有一条登记 → 重复提交是幂等的"改事由"；
--   · 事由限定 sick(病假)/personal(事假)/official(公假)，与 leave_reasons 表口径一致；
--   · student_id 外键 RESTRICT：学生一律软删除，硬删除只能走 purge_class()（本迁移同步更新该函数）；
--   · created_by SET NULL：账号删除后登记仍可读（保留 created_by_name 冗余）。
--
-- 安全：本迁移只建表 + 重建 purge_class，不删任何行；可回滚（见文件末尾）。
-- ============================================================
SET client_encoding = 'UTF8';

BEGIN;

CREATE TABLE IF NOT EXISTS student_day_leaves (
  id              SERIAL PRIMARY KEY,
  student_id      INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  leave_date      DATE NOT NULL,
  reason          VARCHAR(10) NOT NULL,
  remark          VARCHAR(200),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name VARCHAR(50),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT student_day_leaves_reason_chk CHECK (reason IN ('sick', 'personal', 'official')),
  CONSTRAINT student_day_leaves_student_date_key UNIQUE (student_id, leave_date)
);

CREATE INDEX IF NOT EXISTS idx_student_day_leaves_date ON student_day_leaves(leave_date);
CREATE INDEX IF NOT EXISTS idx_student_day_leaves_student ON student_day_leaves(student_id);

COMMENT ON TABLE student_day_leaves IS
  '当天全天请假登记（签到操作台「批量请假」按钮写入）。一个学生一天一条；
   应用到 attendance_records 时写 status=leave + leave_reason=reason + check_in_method=batch_leave。';

-- ---------- purge_class：把新表纳入"彻底删除一个班"的顺序里 ----------
-- （student_day_leaves.student_id 是 RESTRICT，不先删会导致 purge_class 失败）
CREATE OR REPLACE FUNCTION purge_class(p_class_id integer)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_students integer[];
  v_n        integer := 0;
BEGIN
  IF p_class_id IS NULL THEN
    RAISE EXCEPTION 'purge_class：班级 ID 不能为空';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM classes WHERE id = p_class_id) THEN
    RAISE EXCEPTION 'purge_class：班级 #% 不存在', p_class_id;
  END IF;

  SELECT COALESCE(array_agg(id), ARRAY[]::integer[]) INTO v_students
    FROM students WHERE class_id = p_class_id;

  -- 学生相关历史（外键为 RESTRICT，必须先删）
  DELETE FROM attendance_records   WHERE student_id = ANY(v_students);
  DELETE FROM student_day_leaves   WHERE student_id = ANY(v_students);
  DELETE FROM homework_submissions WHERE student_id = ANY(v_students);
  DELETE FROM rollcall_records     WHERE student_id = ANY(v_students) OR class_id = p_class_id;
  DELETE FROM student_likes        WHERE student_id = ANY(v_students) OR class_id = p_class_id;
  DELETE FROM announcements        WHERE student_id = ANY(v_students) OR class_id = p_class_id;
  DELETE FROM student_transfers    WHERE student_id = ANY(v_students)
                                      OR from_class_id = p_class_id OR to_class_id = p_class_id;

  -- 班级级数据（homework_submissions 随 task 级联删除）
  DELETE FROM homework_tasks     WHERE class_id = p_class_id;
  DELETE FROM attendance_plans   WHERE class_id = p_class_id;
  DELETE FROM teacher_classes    WHERE class_id = p_class_id;
  DELETE FROM courses            WHERE class_id = p_class_id;

  -- 学生本体（含已软删除的学生行）
  DELETE FROM students WHERE class_id = p_class_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- 班级本体
  DELETE FROM classes WHERE id = p_class_id;

  RETURN jsonb_build_object('classId', p_class_id, 'studentsRemoved', v_n);
END;
$$;

COMMIT;

-- ============================================================
-- 校验输出
-- ============================================================
\echo '=== student_day_leaves 表结构 ==='
SELECT column_name, data_type, is_nullable FROM information_schema.columns
 WHERE table_name = 'student_day_leaves' ORDER BY ordinal_position;

\echo '=== 约束与索引 ==='
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'student_day_leaves'::regclass ORDER BY conname;
SELECT indexname FROM pg_indexes WHERE tablename = 'student_day_leaves' ORDER BY 1;

\echo '=== 表为空（新表，不影响历史数据）==='
SELECT count(*) AS day_leave_rows FROM student_day_leaves;

\echo '=== 基线复核（应与迁移前一致）==='
SELECT 'classes' t, count(*)::text n FROM classes
UNION ALL SELECT 'students', count(*)::text FROM students
UNION ALL SELECT 'attendance_records', count(*)::text FROM attendance_records
UNION ALL SELECT 'attendance_sessions', count(*)::text FROM attendance_sessions
ORDER BY 1;

-- ============================================================
-- 反向回滚（如需）：
--   DROP TABLE IF EXISTS student_day_leaves;
--   然后按 migration_v30_delete_safety.sql 里的定义重建 purge_class（不含本表那行 DELETE）。
-- ============================================================
