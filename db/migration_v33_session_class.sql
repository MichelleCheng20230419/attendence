-- ============================================================
-- 迁移 v33：签到场次加「班级」维度（方案 A 第 1 步）
--
-- 背景（为什么必须加这一列）：
--   attendance_sessions **没有 class_id** —— 班级归属只能"推导"（有计划看计划、
--   手动发起看发起人班级），于是每新增一个入口就要重新推一次，隔离问题反复出现：
--   ② 计划场次 → ③ 记录宽松判定 → ⑦ 手动发起场次，三次修复都只补了一个来源。
--
-- 本迁移做四件事（只加列/加表 + 回填，不删任何数据）：
--   1) attendance_sessions.class_id：语义 `NULL = 全校场次`，非空 = 该班专属场次；
--   2) 回填历史：
--        · 有计划且计划指定了班级 → 该班
--        · 有计划但计划是"全部班级"(class_id IS NULL) → 保持 NULL（全校）
--        · 无计划（手动发起）→ 发起人的 users.class_id（管理员/无班级 → NULL=全校）
--   3) attendance_plan_sessions：计划 ↔ 场次 1:N 关联
--        （"全部班级"计划今后会**按班拆成多场**，一个计划对应多场次）
--   4) purge_class() 同步纳入：删除班级时先删该班的场次与关联（class_id 是 RESTRICT）
--
-- 回滚：
--   DROP TABLE IF EXISTS attendance_plan_sessions;
--   DROP INDEX IF EXISTS idx_sessions_class_start;
--   ALTER TABLE attendance_sessions DROP COLUMN IF EXISTS class_id;
--   并按 migration_v32 的定义重建 purge_class（不含本表/本列的删除语句）。
-- ============================================================
SET client_encoding = 'UTF8';

BEGIN;

-- ---------- 1) 场次的班级列 ----------
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS class_id INTEGER;
COMMENT ON COLUMN attendance_sessions.class_id IS
  '场次归属班级：NULL = 全校场次（历史"全部班级"计划/管理员发起）；非空 = 该班专属场次。班级隔离的唯一真源。';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendance_sessions_class_id_fkey'
  ) THEN
    ALTER TABLE attendance_sessions
      ADD CONSTRAINT attendance_sessions_class_id_fkey
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_class_start ON attendance_sessions(class_id, start_time DESC);

-- ---------- 2) 回填历史场次归属 ----------
-- 2.1 有计划且计划指定了班级 → 取该班（同点多计划取最小 class_id，稳定）
UPDATE attendance_sessions s
   SET class_id = sub.cid
  FROM (
    SELECT p.session_id, MIN(p.class_id) AS cid
      FROM attendance_plans p
     WHERE p.session_id IS NOT NULL AND p.class_id IS NOT NULL
     GROUP BY p.session_id
  ) sub
 WHERE s.id = sub.session_id AND s.class_id IS NULL;

-- 2.2 无计划的手动场次 → 发起人的班级（管理员/无班级 → 保持 NULL=全校）
UPDATE attendance_sessions s
   SET class_id = u.class_id
  FROM users u
 WHERE s.created_by = u.id
   AND s.class_id IS NULL
   AND s.created_by_role <> 'admin'
   AND u.class_id IS NOT NULL;

-- ---------- 3) 计划 ↔ 场次 关联表（1:N） ----------
CREATE TABLE IF NOT EXISTS attendance_plan_sessions (
  id         SERIAL PRIMARY KEY,
  plan_id    INTEGER NOT NULL REFERENCES attendance_plans(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  class_id   INTEGER REFERENCES classes(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attendance_plan_sessions_plan_session_key UNIQUE (plan_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_plan_sessions_plan ON attendance_plan_sessions(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_sessions_session ON attendance_plan_sessions(session_id);
COMMENT ON TABLE attendance_plan_sessions IS
  '"全部班级"计划按班拆成多场后，一个计划对应多个场次；attendance_plans.session_id 仍保留"代表场次"（第一个）以兼容旧逻辑与页面。';

-- 回填：旧数据一个计划只有一个场次
INSERT INTO attendance_plan_sessions (plan_id, session_id, class_id)
SELECT p.id, p.session_id, s.class_id
  FROM attendance_plans p
  JOIN attendance_sessions s ON s.id = p.session_id
 WHERE p.session_id IS NOT NULL
ON CONFLICT (plan_id, session_id) DO NOTHING;

-- ---------- 4) purge_class：纳入"该班的场次 + 关联" ----------
CREATE OR REPLACE FUNCTION purge_class(p_class_id integer)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_students integer[];
  v_sessions integer[];
  v_n        integer := 0;
  v_s        integer := 0;
BEGIN
  IF p_class_id IS NULL THEN
    RAISE EXCEPTION 'purge_class：班级 ID 不能为空';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM classes WHERE id = p_class_id) THEN
    RAISE EXCEPTION 'purge_class：班级 #% 不存在', p_class_id;
  END IF;

  SELECT COALESCE(array_agg(id), ARRAY[]::integer[]) INTO v_students
    FROM students WHERE class_id = p_class_id;
  SELECT COALESCE(array_agg(id), ARRAY[]::integer[]) INTO v_sessions
    FROM attendance_sessions WHERE class_id = p_class_id;

  -- 4.1 该班专属场次（v33 新增的 class_id 归属）及其记录
  IF array_length(v_sessions, 1) IS NOT NULL THEN
    DELETE FROM attendance_plan_sessions WHERE session_id = ANY(v_sessions) OR class_id = p_class_id;
    DELETE FROM attendance_records      WHERE session_id = ANY(v_sessions);
    DELETE FROM attendance_sessions     WHERE id = ANY(v_sessions);
    GET DIAGNOSTICS v_s = ROW_COUNT;
  END IF;
  DELETE FROM attendance_plan_sessions WHERE class_id = p_class_id;

  -- 4.2 学生相关历史（外键为 RESTRICT，必须先删）
  DELETE FROM attendance_records   WHERE student_id = ANY(v_students);
  DELETE FROM student_day_leaves   WHERE student_id = ANY(v_students);
  DELETE FROM homework_submissions WHERE student_id = ANY(v_students);
  DELETE FROM rollcall_records     WHERE student_id = ANY(v_students) OR class_id = p_class_id;
  DELETE FROM student_likes        WHERE student_id = ANY(v_students) OR class_id = p_class_id;
  DELETE FROM announcements        WHERE student_id = ANY(v_students) OR class_id = p_class_id;
  DELETE FROM student_transfers    WHERE student_id = ANY(v_students)
                                      OR from_class_id = p_class_id OR to_class_id = p_class_id;

  -- 4.3 班级级数据（homework_submissions 随 task 级联删除）
  DELETE FROM homework_tasks     WHERE class_id = p_class_id;
  DELETE FROM attendance_plans   WHERE class_id = p_class_id;
  DELETE FROM teacher_classes    WHERE class_id = p_class_id;
  DELETE FROM courses            WHERE class_id = p_class_id;

  -- 4.4 学生本体（含已软删除的学生行）
  DELETE FROM students WHERE class_id = p_class_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- 4.5 班级本体
  DELETE FROM classes WHERE id = p_class_id;

  RETURN jsonb_build_object('classId', p_class_id, 'studentsRemoved', v_n, 'sessionsRemoved', v_s);
END;
$$;

COMMIT;

-- ============================================================
-- 校验输出
-- ============================================================
\echo '=== 1) class_id 列与索引 ==='
SELECT column_name, data_type, is_nullable FROM information_schema.columns
 WHERE table_name = 'attendance_sessions' AND column_name = 'class_id';
SELECT indexname FROM pg_indexes WHERE tablename = 'attendance_sessions' ORDER BY 1;

\echo '=== 2) 回填结果：全校(NULL) vs 各班 ==='
SELECT COALESCE(c.class_name, '(全校场次)') AS 归属, count(*) AS 场次数
  FROM attendance_sessions s LEFT JOIN classes c ON c.id = s.class_id
 GROUP BY 1 ORDER BY 2 DESC;

\echo '=== 3) 逐场次核对（最近 12 场）==='
SELECT s.id, s.start_time, s.status, s.start_source, s.created_by_name,
       COALESCE(c.class_name, '(全校)') AS class_name,
       (SELECT count(*) FROM attendance_records r WHERE r.session_id = s.id) AS records
  FROM attendance_sessions s LEFT JOIN classes c ON c.id = s.class_id
 ORDER BY s.id DESC LIMIT 12;

\echo '=== 4) 关联表回填 ==='
SELECT (SELECT count(*) FROM attendance_plans WHERE session_id IS NOT NULL) AS plans_with_session,
       (SELECT count(*) FROM attendance_plan_sessions) AS link_rows;

\echo '=== 5) 基线复核（应与迁移前一致）==='
SELECT 'sessions' t, count(*)::text n FROM attendance_sessions
UNION ALL SELECT 'records', count(*)::text FROM attendance_records
UNION ALL SELECT 'plans', count(*)::text FROM attendance_plans
ORDER BY 1;
