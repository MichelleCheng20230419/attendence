-- ============================================================
-- 迁移 v20：teacher_classes 的 role_in_class 与 is_head_teacher 双向自动同步
-- 背景：v19 给 role_in_class 设了 DEFAULT 'subject_teacher'，
--       导致旧代码/脚本只写 is_head_teacher=true 时，role_in_class 仍被填成 subject_teacher，
--       两条记录互相矛盾（班主任身份丢失）。
-- 方案：去掉默认值，改用触发器做唯一事实来源的归一化：
--   · INSERT：role_in_class 为空 → 由 is_head_teacher 推导；否则以 role_in_class 为准
--   · UPDATE：谁被显式修改就以谁为准，未修改的一方保持同步
-- ============================================================

ALTER TABLE teacher_classes ALTER COLUMN role_in_class DROP DEFAULT;

CREATE OR REPLACE FUNCTION trg_teacher_classes_sync_role() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.role_in_class IS NULL THEN
      NEW.role_in_class := CASE WHEN NEW.is_head_teacher THEN 'head_teacher' ELSE 'subject_teacher' END;
    ELSE
      NEW.role_in_class := CASE WHEN NEW.role_in_class = 'head_teacher' THEN 'head_teacher' ELSE 'subject_teacher' END;
      NEW.is_head_teacher := (NEW.role_in_class = 'head_teacher');
    END IF;
  ELSE
    IF NEW.role_in_class IS DISTINCT FROM OLD.role_in_class THEN
      NEW.role_in_class := CASE WHEN NEW.role_in_class = 'head_teacher' THEN 'head_teacher' ELSE 'subject_teacher' END;
      NEW.is_head_teacher := (NEW.role_in_class = 'head_teacher');
    ELSIF NEW.is_head_teacher IS DISTINCT FROM OLD.is_head_teacher THEN
      NEW.role_in_class := CASE WHEN NEW.is_head_teacher THEN 'head_teacher' ELSE 'subject_teacher' END;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_teacher_classes_sync_role ON teacher_classes;
CREATE TRIGGER trg_teacher_classes_sync_role
  BEFORE INSERT OR UPDATE ON teacher_classes
  FOR EACH ROW EXECUTE FUNCTION trg_teacher_classes_sync_role();

-- 核对：不得存在 role_in_class 与 is_head_teacher 不一致的记录
SELECT count(*) AS inconsistent_rows
  FROM teacher_classes
 WHERE is_head_teacher <> (role_in_class = 'head_teacher');
