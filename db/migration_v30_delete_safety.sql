-- ============================================================
-- 迁移 v30：P0 第 2 步 —— 删除安全网（级联改 RESTRICT + 班级彻底删除收敛到一个显式入口）
--
-- 背景（数据库设计评估 问题六 第 2 步）：
--   此前 students.student_id 的 6 个外键、students.class_id、以及班级级数据
--   （作业/点名/点赞/叫号/带班/遗留 courses）全是 ON DELETE CASCADE。
--   后果：任何一句 `DELETE FROM classes WHERE ...` 或 `DELETE FROM students WHERE ...`
--   都会把考勤、作业提交、点名、点赞、异动等历史**静默清空**，且不可恢复。
--
-- 本迁移做两件事：
--   1) 把这些"历史数据"外键改为 ON DELETE RESTRICT —— 数据库层面直接拒绝误删；
--   2) 提供唯一显式入口函数 purge_class(class_id)：按正确顺序彻底删除"一个班及其全部数据"，
--      供管理员接口（DELETE /api/classes/:id）与测试/运维清理脚本调用。
--   保留的 SET NULL 语义（不动）：users.class_id、inspection_issues.class_id、
--      student_transfers.from/to_class_id、classes.grade_id —— 这些是"引用方保留、指向置空"，不是历史数据。
--
-- 安全：本迁移只改约束/新增函数，不删任何行；可回滚（见文件末尾反向语句）。
-- ============================================================
SET client_encoding = 'UTF8';

BEGIN;

-- ---------- 1) 学生历史：6 个 CASCADE → RESTRICT ----------
-- 说明：应用层删除学生一律走「软删除」（is_active=false / status=deleted / deleted_at），
--      硬删除只允许通过 purge_class() 显式执行。
ALTER TABLE announcements         DROP CONSTRAINT IF EXISTS announcements_student_id_fkey;
ALTER TABLE announcements         ADD  CONSTRAINT announcements_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;

ALTER TABLE attendance_records    DROP CONSTRAINT IF EXISTS attendance_records_student_id_fkey;
ALTER TABLE attendance_records    ADD  CONSTRAINT attendance_records_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;

ALTER TABLE homework_submissions  DROP CONSTRAINT IF EXISTS homework_submissions_student_id_fkey;
ALTER TABLE homework_submissions  ADD  CONSTRAINT homework_submissions_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;

ALTER TABLE rollcall_records      DROP CONSTRAINT IF EXISTS rollcall_records_student_id_fkey;
ALTER TABLE rollcall_records      ADD  CONSTRAINT rollcall_records_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;

ALTER TABLE student_likes         DROP CONSTRAINT IF EXISTS student_likes_student_id_fkey;
ALTER TABLE student_likes         ADD  CONSTRAINT student_likes_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;

ALTER TABLE student_transfers     DROP CONSTRAINT IF EXISTS student_transfers_student_id_fkey;
ALTER TABLE student_transfers     ADD  CONSTRAINT student_transfers_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;

-- ---------- 2) 班级级历史：CASCADE → RESTRICT ----------
-- students.class_id：删班级不再"顺手"删学生（否则一个班的历史全没）
ALTER TABLE students              DROP CONSTRAINT IF EXISTS students_class_id_fkey;
ALTER TABLE students              ADD  CONSTRAINT students_class_id_fkey
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;

ALTER TABLE announcements         DROP CONSTRAINT IF EXISTS announcements_class_id_fkey;
ALTER TABLE announcements         ADD  CONSTRAINT announcements_class_id_fkey
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;

ALTER TABLE homework_tasks        DROP CONSTRAINT IF EXISTS homework_tasks_class_id_fkey;
ALTER TABLE homework_tasks        ADD  CONSTRAINT homework_tasks_class_id_fkey
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;

ALTER TABLE rollcall_records      DROP CONSTRAINT IF EXISTS rollcall_records_class_id_fkey;
ALTER TABLE rollcall_records      ADD  CONSTRAINT rollcall_records_class_id_fkey
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;

ALTER TABLE student_likes         DROP CONSTRAINT IF EXISTS student_likes_class_id_fkey;
ALTER TABLE student_likes         ADD  CONSTRAINT student_likes_class_id_fkey
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;

ALTER TABLE teacher_classes       DROP CONSTRAINT IF EXISTS teacher_classes_class_id_fkey;
ALTER TABLE teacher_classes       ADD  CONSTRAINT teacher_classes_class_id_fkey
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;

-- 遗留表 courses（代码已不再使用，但表内仍有数据）→ 同样保护
ALTER TABLE courses               DROP CONSTRAINT IF EXISTS courses_class_id_fkey;
ALTER TABLE courses               ADD  CONSTRAINT courses_class_id_fkey
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;

-- ---------- 3) 唯一显式入口：彻底删除一个班及其全部数据 ----------
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

  -- 3.1 学生相关历史（外键为 RESTRICT，必须先删；顺序无关，覆盖 student_id 与 class_id 两条线）
  DELETE FROM attendance_records   WHERE student_id = ANY(v_students);
  DELETE FROM homework_submissions WHERE student_id = ANY(v_students);
  DELETE FROM rollcall_records     WHERE student_id = ANY(v_students) OR class_id = p_class_id;
  DELETE FROM student_likes        WHERE student_id = ANY(v_students) OR class_id = p_class_id;
  DELETE FROM announcements        WHERE student_id = ANY(v_students) OR class_id = p_class_id;
  DELETE FROM student_transfers    WHERE student_id = ANY(v_students)
                                      OR from_class_id = p_class_id OR to_class_id = p_class_id;

  -- 3.2 班级级数据（homework_submissions 随 task 级联删除）
  DELETE FROM homework_tasks     WHERE class_id = p_class_id;
  DELETE FROM attendance_plans   WHERE class_id = p_class_id;
  DELETE FROM teacher_classes    WHERE class_id = p_class_id;
  DELETE FROM courses            WHERE class_id = p_class_id;

  -- 3.3 学生本体（含已软删除的学生行）
  DELETE FROM students WHERE class_id = p_class_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- 3.4 班级本体
  DELETE FROM classes WHERE id = p_class_id;

  RETURN jsonb_build_object('classId', p_class_id, 'studentsRemoved', v_n);
END;
$$;

COMMENT ON FUNCTION purge_class(integer) IS
  '彻底删除一个班级及其全部数据（学生 + 考勤 + 作业提交 + 点名 + 点赞 + 叫号 + 异动 + 计划 + 带班关系）。
   这是唯一的班级硬删除入口：DELETE /api/classes/:id（管理员）内部调用本函数。
   注意：调用方需自行校验"班内是否还有在读学生"（接口层默认拦截，force=1 才放行）。';

COMMIT;

-- ============================================================
-- 校验输出
-- ============================================================
\echo '=== students 相关外键（期望全部 RESTRICT，学生历史不再被静默删除）==='
SELECT c.conname, c.conrelid::regclass AS tbl,
       CASE c.confdeltype WHEN 'r' THEN 'RESTRICT' WHEN 'a' THEN 'NO ACTION'
            WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' END AS rule
  FROM pg_constraint c
 WHERE c.contype = 'f' AND c.confrelid = 'students'::regclass ORDER BY 1;

\echo '=== classes 相关外键（历史类=RESTRICT；users/inspection/transfers/grade 保持 SET NULL）==='
SELECT c.conname, c.conrelid::regclass AS tbl,
       CASE c.confdeltype WHEN 'r' THEN 'RESTRICT' WHEN 'a' THEN 'NO ACTION'
            WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' END AS rule
  FROM pg_constraint c
 WHERE c.contype = 'f' AND c.confrelid = 'classes'::regclass ORDER BY 2, 1;

\echo '=== purge_class 函数已创建 ==='
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.provolatile
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.proname = 'purge_class' AND n.nspname = current_schema();

\echo '=== 基线复核（应与迁移前一致）==='
SELECT 'classes' t, count(*)::text n FROM classes
UNION ALL SELECT 'students', count(*)::text FROM students
UNION ALL SELECT 'attendance_records', count(*)::text FROM attendance_records
UNION ALL SELECT 'homework_submissions', count(*)::text FROM homework_submissions
UNION ALL SELECT 'rollcall_records', count(*)::text FROM rollcall_records
UNION ALL SELECT 'student_likes', count(*)::text FROM student_likes
ORDER BY 1;

-- ============================================================
-- 反向回滚（如需）：
--   DROP FUNCTION IF EXISTS purge_class(integer);
--   然后把上面 13 条外键按原规则重建（CASCADE）：
--     ALTER TABLE <tbl> DROP CONSTRAINT IF EXISTS <name>;
--     ALTER TABLE <tbl> ADD CONSTRAINT <name> FOREIGN KEY (<col>) REFERENCES <ref>(id) ON DELETE CASCADE;
--   涉及：announcements(student_id,class_id)、attendance_records(student_id)、
--         homework_submissions(student_id)、rollcall_records(student_id,class_id)、
--         student_likes(student_id,class_id)、student_transfers(student_id)、
--         students(class_id)、homework_tasks(class_id)、teacher_classes(class_id)、courses(class_id)
--   （attendance_plans.class_id 原为 NO ACTION、inspection_issues/student_transfers/users 的
--     class_id 原为 SET NULL，本迁移未改动，无需回滚）
-- ============================================================
