-- Nullable restoration contract only; no source extraction, publication or historic backfill.
-- Writers (unchanged):
--   portal.stg_user_daily: ingestion
--   portal.fact_user_daily_usage: ingestion
--   portal.stg_user_breakdown: ingestion
--   portal.fact_usage_breakdown: ingestion
-- New INT counters use the existing activity-count range 0..2147483647; NULL means unavailable.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF COL_LENGTH(N'portal.stg_user_daily', N'ai_adoption_phase_version') IS NULL
ALTER TABLE portal.stg_user_daily ADD ai_adoption_phase_version VARCHAR(64) NULL;
GO
IF COL_LENGTH(N'portal.fact_user_daily_usage', N'ai_adoption_phase_version') IS NULL
ALTER TABLE portal.fact_user_daily_usage ADD ai_adoption_phase_version VARCHAR(64) NULL;
GO
IF COL_LENGTH(N'portal.stg_user_breakdown', N'prompt_count') IS NULL
ALTER TABLE portal.stg_user_breakdown ADD prompt_count INT NULL;
GO
IF COL_LENGTH(N'portal.stg_user_breakdown', N'total_user_messages') IS NULL
ALTER TABLE portal.stg_user_breakdown ADD total_user_messages INT NULL;
GO
IF COL_LENGTH(N'portal.fact_usage_breakdown', N'prompt_count') IS NULL
ALTER TABLE portal.fact_usage_breakdown ADD prompt_count INT NULL;
GO
IF COL_LENGTH(N'portal.fact_usage_breakdown', N'total_user_messages') IS NULL
ALTER TABLE portal.fact_usage_breakdown ADD total_user_messages INT NULL;
GO

IF OBJECT_ID(N'portal.CK_stg_breakdown_restoration_counts', N'C') IS NULL
ALTER TABLE portal.stg_user_breakdown ADD CONSTRAINT CK_stg_breakdown_restoration_counts
CHECK ((prompt_count IS NULL OR prompt_count >= 0) AND (total_user_messages IS NULL OR total_user_messages >= 0));
GO
IF OBJECT_ID(N'portal.CK_fact_breakdown_restoration_counts', N'C') IS NULL
ALTER TABLE portal.fact_usage_breakdown ADD CONSTRAINT CK_fact_breakdown_restoration_counts
CHECK ((prompt_count IS NULL OR prompt_count >= 0) AND (total_user_messages IS NULL OR total_user_messages >= 0));
GO
