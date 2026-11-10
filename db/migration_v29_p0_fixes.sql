-- ============================================================
-- 迁移 v29：P0 最小集修复（数据库设计评估的立即项）
--   问题二 班主任信息冗余：遗留列 classes.teacher_id 与权威来源对齐 + 外键改 SET NULL
--   问题四 场次来源：start_source 已存在 → 补枚举约束（plan / manual / makeup）
--   问题六 级联删除与历史保留（第 1 步）：学生软删除标记 + 部分索引
--
--   本迁移只做「加列 / 改约束 / 数据校正」，不改任何删除级联（CASCADE → RESTRICT 是第 2 步，
--   需同步改测试与 UI 删除流程），可安全回滚（见文件末尾反向语句注释）。
-- ============================================================
SET client_encoding = 'UTF8';

BEGIN;

-- ---------- 问题二：teacher_classes 为准，遗留列对齐 ----------
-- 1) head_teacher_id 是查询用字段、teacher_classes 是权威关系；
--    历史上 teacher_id 与 head_teacher_id 出现"一个有值一个为空"的漂移（实测 2 个班）
--    → 以 head_teacher_id 为准回填 teacher_id，任何仍读遗留列的代码都不会再看到"假空"
UPDATE classes c
   SET teacher_id = c.head_teacher_id
 WHERE c.head_teacher_id IS NOT NULL
   AND c.teacher_id IS DISTINCT FROM c.head_teacher_id;

-- 2) 班主任/副班主任外键由 NO ACTION 改为 SET NULL：
--    此前删除教师账号会直接被外键挡住（"删除账号失败"），改为删除账号后班级字段自动置空
ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_head_teacher_id_fkey;
ALTER TABLE classes
  ADD CONSTRAINT classes_head_teacher_id_fkey
  FOREIGN KEY (head_teacher_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_deputy_teacher_id_fkey;
ALTER TABLE classes
  ADD CONSTRAINT classes_deputy_teacher_id_fkey
  FOREIGN KEY (deputy_teacher_id) REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN classes.teacher_id IS
  '【遗留兼容】默认班主任。权威来源 = teacher_classes（带班关系）+ classes.head_teacher_id（查询用）；新代码不要单独写入本列';

-- ---------- 问题四：场次来源枚举约束（列已存在，仅补约束与枚举） ----------
-- 现有取值只有 plan / manual，全部满足约束；新增 makeup 供"补签场次"使用
ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS ck_sessions_source;
ALTER TABLE attendance_sessions
  ADD CONSTRAINT ck_sessions_source CHECK (start_source IN ('plan', 'manual', 'makeup'));

COMMENT ON COLUMN attendance_sessions.start_source IS
  '场次来源：plan=计划生成 / manual=手动发起 / makeup=补签（补签目前落在 attendance_records.check_in_method，不产生场次）';

-- ---------- 问题六（第 1 步）：学生软删除标记 ----------
ALTER TABLE students ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_students_active ON students (is_active, status);
COMMENT ON COLUMN students.deleted_at IS
  '软删除时间（NULL = 未删除）。删除学生只做软删除（is_active=false, status=deleted），
   考勤/作业/点名/点赞等历史一律保留；重新导入同一学号会自动复活（is_active=true, status=在读, deleted_at=NULL）';

COMMIT;

-- ============================================================
-- 校验输出
-- ============================================================
\echo '=== 班主任三处来源是否一致（期望：不一致 0）==='
SELECT count(*) AS 班级数,
       count(*) FILTER (WHERE teacher_id IS DISTINCT FROM head_teacher_id) AS 遗留列不一致,
       count(*) FILTER (WHERE head_teacher_id IS NOT NULL) AS 有班主任,
       (SELECT count(*) FROM teacher_classes
         WHERE COALESCE(role_in_class, CASE WHEN is_head_teacher THEN 'head_teacher' ELSE 'subject_teacher' END) = 'head_teacher') AS 带班记录班主任数
FROM classes;

\echo '=== 场次来源取值（约束已生效）==='
SELECT start_source, count(*) FROM attendance_sessions GROUP BY start_source ORDER BY 1;

\echo '=== students 新列与索引 ==='
SELECT column_name, data_type, is_nullable FROM information_schema.columns
 WHERE table_name = 'students' AND column_name = 'deleted_at';
SELECT indexname FROM pg_indexes WHERE tablename = 'students' ORDER BY 1;

\echo '=== 外键删除规则（班主任/副班主任 = SET NULL）==='
SELECT conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
 WHERE conrelid = 'classes'::regclass AND contype = 'f' ORDER BY conname;

-- ============================================================
-- 反向回滚（如需）：按顺序执行
-- ------------------------------------------------------------
-- ALTER TABLE students DROP COLUMN IF EXISTS deleted_at;
-- DROP INDEX IF EXISTS idx_students_active;
-- ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS ck_sessions_source;
-- ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_head_teacher_id_fkey;
-- ALTER TABLE classes ADD CONSTRAINT classes_head_teacher_id_fkey
--   FOREIGN KEY (head_teacher_id) REFERENCES users(id);           -- 原为 NO ACTION
-- ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_deputy_teacher_id_fkey;
-- ALTER TABLE classes ADD CONSTRAINT classes_deputy_teacher_id_fkey
--   FOREIGN KEY (deputy_teacher_id) REFERENCES users(id);         -- 原为 NO ACTION
-- （teacher_id 的数据回填无需回滚；如需回到旧值请从 db/backup 快照恢复）
-- ============================================================
