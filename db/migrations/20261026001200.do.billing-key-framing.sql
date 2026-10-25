-- Writers unchanged: ingestion owns stg_ai_credit_line, fact_ai_credit_line and agg_ai_credit_daily.
-- Rebuild persisted hashes using byte-length-prefixed NVARCHAR fields, not ambiguous delimiters.
-- NULL sku and empty sku remain the same key. Existing rows are rehashed; source replay is needed
-- to recover any rows rejected by the old delimiter-based unique keys.
-- Run in a maintenance window: persisted-column and clustered-key rebuilds lock and rewrite tables.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
SET XACT_ABORT ON;
SET LOCK_TIMEOUT 60000;

BEGIN TRY
    BEGIN TRANSACTION;

    IF EXISTS (SELECT 1 FROM sys.computed_columns
        WHERE object_id = OBJECT_ID(N'portal.stg_ai_credit_line') AND name = N'natural_key'
        AND definition NOT LIKE N'%datalength%')
    BEGIN
        DROP INDEX UX_stg_ai_credit_key ON portal.stg_ai_credit_line;
        ALTER TABLE portal.stg_ai_credit_line DROP COLUMN natural_key;
        EXEC(N'ALTER TABLE portal.stg_ai_credit_line ADD natural_key AS
          CONVERT(BINARY(32), HASHBYTES(''SHA2_256'', CONVERT(NVARCHAR(MAX), N'''') +
            CONVERT(NVARCHAR(10), DATALENGTH(organization)) + N'':'' + organization +
            CONVERT(NVARCHAR(10), DATALENGTH(username)) + N'':'' + username +
            CONVERT(NVARCHAR(10), DATALENGTH(model)) + N'':'' + model +
            CONVERT(NVARCHAR(10), DATALENGTH(cost_center_name)) + N'':'' + cost_center_name +
            CONVERT(NVARCHAR(10), DATALENGTH(repository)) + N'':'' + repository +
            CONVERT(NVARCHAR(10), DATALENGTH(app_client_id)) + N'':'' + app_client_id +
            CONVERT(NVARCHAR(10), DATALENGTH(ISNULL(sku, N''''))) + N'':'' + ISNULL(sku, N'''')))
          PERSISTED NOT NULL');
        EXEC(N'CREATE UNIQUE INDEX UX_stg_ai_credit_key
          ON portal.stg_ai_credit_line (run_id, usage_date, natural_key)');
    END;

    IF EXISTS (SELECT 1 FROM sys.computed_columns
        WHERE object_id = OBJECT_ID(N'portal.fact_ai_credit_line') AND name = N'natural_key'
        AND definition NOT LIKE N'%datalength%')
    BEGIN
        ALTER TABLE portal.fact_ai_credit_line DROP CONSTRAINT PK_fact_ai_credit_line;
        ALTER TABLE portal.fact_ai_credit_line DROP COLUMN natural_key;
        EXEC(N'ALTER TABLE portal.fact_ai_credit_line ADD natural_key AS
          CONVERT(BINARY(32), HASHBYTES(''SHA2_256'', CONVERT(NVARCHAR(MAX), N'''') +
            CONVERT(NVARCHAR(10), DATALENGTH(organization_login)) + N'':'' + organization_login +
            CONVERT(NVARCHAR(10), DATALENGTH(username)) + N'':'' + username +
            CONVERT(NVARCHAR(10), DATALENGTH(model)) + N'':'' + model +
            CONVERT(NVARCHAR(10), DATALENGTH(cost_center_name)) + N'':'' + cost_center_name +
            CONVERT(NVARCHAR(10), DATALENGTH(repository)) + N'':'' + repository +
            CONVERT(NVARCHAR(10), DATALENGTH(app_client_id)) + N'':'' + app_client_id +
            CONVERT(NVARCHAR(10), DATALENGTH(ISNULL(sku, N''''))) + N'':'' + ISNULL(sku, N'''')))
          PERSISTED NOT NULL');
        EXEC(N'ALTER TABLE portal.fact_ai_credit_line ADD CONSTRAINT PK_fact_ai_credit_line
          PRIMARY KEY (usage_date, natural_key)');
    END;

    IF EXISTS (SELECT 1 FROM sys.computed_columns
        WHERE object_id = OBJECT_ID(N'portal.agg_ai_credit_daily') AND name = N'natural_key'
        AND definition NOT LIKE N'%datalength%')
    BEGIN
        ALTER TABLE portal.agg_ai_credit_daily DROP CONSTRAINT PK_agg_ai_credit_daily;
        ALTER TABLE portal.agg_ai_credit_daily DROP COLUMN natural_key;
        EXEC(N'ALTER TABLE portal.agg_ai_credit_daily ADD natural_key AS
          CONVERT(BINARY(32), HASHBYTES(''SHA2_256'', CONVERT(NVARCHAR(MAX), N'''') +
            CONVERT(NVARCHAR(10), DATALENGTH(organization_login)) + N'':'' + organization_login +
            CONVERT(NVARCHAR(10), DATALENGTH(model)) + N'':'' + model +
            CONVERT(NVARCHAR(10), DATALENGTH(cost_center_name)) + N'':'' + cost_center_name))
          PERSISTED NOT NULL');
        EXEC(N'ALTER TABLE portal.agg_ai_credit_daily ADD CONSTRAINT PK_agg_ai_credit_daily
          PRIMARY KEY (usage_date, natural_key)');
    END;

    COMMIT;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    THROW;
END CATCH;
SET LOCK_TIMEOUT -1;
