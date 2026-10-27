-- Writer (unchanged):
--   portal.dim_user: ingestion
-- Directory sync owns manager evidence through ingestion; metrics cannot establish resolution.
-- Existing relationships are preserved without inferring successful manager checks.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF COL_LENGTH(N'portal.dim_user', N'manager_resolved') IS NULL
ALTER TABLE portal.dim_user ADD manager_resolved BIT NOT NULL
  CONSTRAINT DF_dim_user_manager_resolved DEFAULT (0);
GO
IF COL_LENGTH(N'portal.dim_user', N'manager_checked_at') IS NULL
ALTER TABLE portal.dim_user ADD manager_checked_at DATETIME2(0) NULL;
GO
