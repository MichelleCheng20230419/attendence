-- ============================================================
-- 迁移 v11：座位表布局配置
-- classes 表新增 seat_config JSONB，存储：{"cols": 4, "mode": "左右分列"}
-- ============================================================
ALTER TABLE classes ADD COLUMN IF NOT EXISTS seat_config JSONB;
