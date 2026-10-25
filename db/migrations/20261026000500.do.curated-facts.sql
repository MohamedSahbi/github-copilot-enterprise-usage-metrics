-- Migration: curated facts (§6.3, §6.4, D-12).
--
-- Writers (one per table):
--   portal.fact_user_daily_usage: ingestion
--   portal.fact_usage_breakdown: ingestion
--   portal.fact_usage_family_count: ingestion
--   portal.fact_ai_credit_line: ingestion
--   portal.agg_daily_usage: ingestion
--   portal.agg_ai_credit_daily: ingestion
--
-- Retention (D-12), both configurable as deployment settings, never SQL rows:
--   retention.per_user_months  (default 13)        applies to fact_user_daily_usage, fact_usage_breakdown,
--                                                  fact_usage_family_count, fact_ai_credit_line
--   retention.aggregate_months (default unlimited) applies to agg_* tables
-- The ingestion purge job deletes per-user rows older than the window ONLY after the aggregate for that day is
-- published, so aggregates stay complete.
--
-- Lineage: every curated row carries run_id, source_artifact_id and transform_version, and aggregates carry the
-- metric_version they were computed with (portal.MetricDefinition).
-- Per-day replacement (§6.2 step 9): publish deletes all rows of the day for the run scope and inserts the new rows in
-- one transaction, holding the sp_getapplock described in 20261026000200.
-- Tenancy: one enterprise, several organizations; fact key is (organization_id, user_id, usage_day).

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID(N'portal.fact_user_daily_usage', N'U') IS NULL
CREATE TABLE portal.fact_user_daily_usage (
    organization_id BIGINT NOT NULL,
    user_id         BIGINT NOT NULL,
    usage_day       DATE   NOT NULL,
    interaction_count       INT    NOT NULL,
    code_generation_count   INT    NOT NULL,
    code_acceptance_count   INT    NOT NULL,
    loc_suggested_to_add    BIGINT NOT NULL,
    loc_suggested_to_delete BIGINT NOT NULL,
    loc_added               BIGINT NOT NULL,
    loc_deleted             BIGINT NOT NULL,
    used_agent               BIT NOT NULL,
    used_chat                BIT NOT NULL,
    used_cli                 BIT NOT NULL,
    used_coding_agent        BIT NOT NULL,
    used_cloud_agent         BIT NOT NULL,
    used_copilot_app         BIT NOT NULL,
    used_vscode_agent        BIT NOT NULL,
    used_code_review_active  BIT NOT NULL,
    used_code_review_passive BIT NOT NULL,
    ai_credits_used          DECIMAL(18, 9) NOT NULL,
    ai_adoption_phase_number TINYINT NULL,
    ai_adoption_phase        VARCHAR(64) NULL,
    extra_json               NVARCHAR(MAX) NULL,
    run_id              UNIQUEIDENTIFIER NOT NULL,
    source_artifact_id  BIGINT      NOT NULL,
    transform_version   VARCHAR(32) NOT NULL,
    loaded_at           DATETIME2(0) NOT NULL CONSTRAINT DF_fact_user_daily_loaded DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_fact_user_daily_usage PRIMARY KEY (organization_id, usage_day, user_id),
    CONSTRAINT CK_fact_user_daily_counts CHECK (
        interaction_count >= 0 AND code_generation_count >= 0 AND code_acceptance_count >= 0
        AND loc_suggested_to_add >= 0 AND loc_suggested_to_delete >= 0 AND loc_added >= 0 AND loc_deleted >= 0
        AND ai_credits_used >= 0),
    CONSTRAINT CK_fact_user_daily_extra CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1),
    CONSTRAINT FK_fact_user_daily_user FOREIGN KEY (user_id) REFERENCES portal.dim_user (user_id),
    CONSTRAINT FK_fact_user_daily_org FOREIGN KEY (organization_id) REFERENCES portal.dim_organization (organization_id),
    CONSTRAINT FK_fact_user_daily_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id),
    CONSTRAINT FK_fact_user_daily_artifact FOREIGN KEY (source_artifact_id) REFERENCES portal.SourceArtifact (artifact_id),
    CONSTRAINT FK_fact_user_daily_transform FOREIGN KEY (transform_version) REFERENCES portal.TransformVersion (transform_version)
);
GO
-- Query shape: organization + date range + user key (PK) and user + date range for detail pages.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_fact_user_daily_user' AND object_id = OBJECT_ID(N'portal.fact_user_daily_usage'))
CREATE INDEX IX_fact_user_daily_user ON portal.fact_user_daily_usage (user_id, usage_day) INCLUDE (organization_id, interaction_count, ai_credits_used);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_fact_user_daily_run' AND object_id = OBJECT_ID(N'portal.fact_user_daily_usage'))
CREATE INDEX IX_fact_user_daily_run ON portal.fact_user_daily_usage (run_id);
GO

-- breakdown_kind values match staging; key_2 is '' when unused.
IF OBJECT_ID(N'portal.fact_usage_breakdown', N'U') IS NULL
CREATE TABLE portal.fact_usage_breakdown (
    organization_id BIGINT NOT NULL,
    user_id         BIGINT NOT NULL,
    usage_day       DATE   NOT NULL,
    breakdown_kind  VARCHAR(24)   NOT NULL,
    key_1           NVARCHAR(128) NOT NULL,
    key_2           NVARCHAR(128) NOT NULL CONSTRAINT DF_fact_breakdown_key2 DEFAULT N'',
    interaction_count       INT    NOT NULL,
    code_generation_count   INT    NOT NULL,
    code_acceptance_count   INT    NOT NULL,
    loc_suggested_to_add    BIGINT NOT NULL,
    loc_suggested_to_delete BIGINT NOT NULL,
    loc_added               BIGINT NOT NULL,
    loc_deleted             BIGINT NOT NULL,
    session_count           INT    NULL,
    request_count           INT    NULL,
    prompt_tokens           BIGINT NULL,
    output_tokens           BIGINT NULL,
    version_info            NVARCHAR(1000) NULL,
    run_id              UNIQUEIDENTIFIER NOT NULL,
    source_artifact_id  BIGINT      NOT NULL,
    transform_version   VARCHAR(32) NOT NULL,
    CONSTRAINT PK_fact_usage_breakdown PRIMARY KEY (organization_id, usage_day, user_id, breakdown_kind, key_1, key_2),
    CONSTRAINT CK_fact_breakdown_kind CHECK (breakdown_kind IN
        ('ide', 'feature', 'language_feature', 'language_model', 'model_feature', 'client')),
    CONSTRAINT FK_fact_breakdown_daily FOREIGN KEY (organization_id, usage_day, user_id)
        REFERENCES portal.fact_user_daily_usage (organization_id, usage_day, user_id) ON DELETE CASCADE,
    CONSTRAINT FK_fact_breakdown_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_fact_breakdown_kind' AND object_id = OBJECT_ID(N'portal.fact_usage_breakdown'))
CREATE INDEX IX_fact_breakdown_kind ON portal.fact_usage_breakdown (breakdown_kind, key_1, usage_day) INCLUDE (organization_id, user_id, interaction_count);
GO

IF OBJECT_ID(N'portal.fact_usage_family_count', N'U') IS NULL
CREATE TABLE portal.fact_usage_family_count (
    organization_id BIGINT NOT NULL,
    user_id         BIGINT NOT NULL,
    usage_day       DATE   NOT NULL,
    family          VARCHAR(16)   NOT NULL,
    item_name       NVARCHAR(256) NOT NULL,
    interaction_count INT NOT NULL,
    run_id              UNIQUEIDENTIFIER NOT NULL,
    source_artifact_id  BIGINT      NOT NULL,
    transform_version   VARCHAR(32) NOT NULL,
    CONSTRAINT PK_fact_usage_family_count PRIMARY KEY (organization_id, usage_day, user_id, family, item_name),
    CONSTRAINT CK_fact_family CHECK (family IN ('skill', 'custom_agent', 'mcp', 'slash_cmd', 'plugin')),
    CONSTRAINT CK_fact_family_count CHECK (interaction_count >= 0),
    CONSTRAINT FK_fact_family_daily FOREIGN KEY (organization_id, usage_day, user_id)
        REFERENCES portal.fact_user_daily_usage (organization_id, usage_day, user_id) ON DELETE CASCADE,
    CONSTRAINT FK_fact_family_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id)
);
GO

-- AI Credits module: one row per CSV line. organization_login is the billing name; organization_id is resolved through
-- dim_organization and stays NULL when unresolved (loaded with a warning). user_id resolves from username via
-- dim_user_login_history and is NULL for unresolved (for example hashed logins of deleted users).
IF OBJECT_ID(N'portal.fact_ai_credit_line', N'U') IS NULL
CREATE TABLE portal.fact_ai_credit_line (
    usage_date          DATE           NOT NULL,
    organization_login  NVARCHAR(255)  NOT NULL,
    username            NVARCHAR(255)  NOT NULL,
    model               NVARCHAR(128)  NOT NULL,
    cost_center_name    NVARCHAR(255)  NOT NULL,
    repository          NVARCHAR(255)  NOT NULL,
    app_client_id       NVARCHAR(128)  NOT NULL,
    organization_id     BIGINT         NULL,
    user_id             BIGINT         NULL,
    product             NVARCHAR(64)   NULL,
    sku                 NVARCHAR(128)  NULL,
    quantity            DECIMAL(18, 9) NULL,
    unit_type           NVARCHAR(32)   NULL,
    applied_cost_per_quantity DECIMAL(18, 9) NULL,
    gross_amount        DECIMAL(18, 9) NULL,
    discount_amount     DECIMAL(18, 9) NULL,
    net_amount          DECIMAL(18, 9) NULL,
    total_monthly_quota DECIMAL(18, 9) NULL,
    aic_quantity        DECIMAL(18, 9) NULL,
    aic_gross_amount    DECIMAL(18, 9) NULL,
    input_tokens        BIGINT NULL,
    output_tokens       BIGINT NULL,
    cache_read_tokens   BIGINT NULL,
    cache_write_tokens  BIGINT NULL,
    run_id              UNIQUEIDENTIFIER NOT NULL,
    source_artifact_id  BIGINT      NOT NULL,
    transform_version   VARCHAR(32) NOT NULL,
    -- Hash of the natural key: the text columns exceed the 900-byte clustered key budget.
    natural_key         AS CONVERT(BINARY(32), HASHBYTES('SHA2_256', organization_login + N'|' + username + N'|' + model + N'|' + cost_center_name + N'|' + repository + N'|' + app_client_id + N'|' + ISNULL(sku, N''))) PERSISTED NOT NULL,
    CONSTRAINT PK_fact_ai_credit_line PRIMARY KEY (usage_date, natural_key),
    CONSTRAINT FK_fact_ai_credit_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id),
    CONSTRAINT FK_fact_ai_credit_artifact FOREIGN KEY (source_artifact_id) REFERENCES portal.SourceArtifact (artifact_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_fact_ai_credit_org_date' AND object_id = OBJECT_ID(N'portal.fact_ai_credit_line'))
CREATE INDEX IX_fact_ai_credit_org_date ON portal.fact_ai_credit_line (organization_id, usage_date, user_id) INCLUDE (aic_quantity, aic_gross_amount, net_amount);
GO

-- Aggregates are kept indefinitely (D-12). group_key is the dimension value ('' for the organization total).
-- user_count is the distinct-user count the suppression rule reads (min_group_size).
IF OBJECT_ID(N'portal.agg_daily_usage', N'U') IS NULL
CREATE TABLE portal.agg_daily_usage (
    organization_id BIGINT       NOT NULL,
    usage_day       DATE         NOT NULL,
    group_kind      VARCHAR(24)  NOT NULL,
    group_key       NVARCHAR(128) NOT NULL,
    metric_version  INT          NOT NULL,
    user_count      INT          NOT NULL,
    interaction_count     BIGINT NOT NULL,
    code_generation_count BIGINT NOT NULL,
    code_acceptance_count BIGINT NOT NULL,
    loc_added             BIGINT NOT NULL,
    loc_deleted           BIGINT NOT NULL,
    chat_users            INT NOT NULL,
    agent_users           INT NOT NULL,
    cli_users             INT NOT NULL,
    cloud_agent_users     INT NOT NULL,
    vscode_agent_users    INT NOT NULL,
    app_users             INT NOT NULL,
    code_review_users     INT NOT NULL,
    advanced_users        INT NOT NULL,
    completion_only_users INT NOT NULL,
    ai_credits_used       DECIMAL(18, 9) NOT NULL,
    run_id              UNIQUEIDENTIFIER NOT NULL,
    transform_version   VARCHAR(32) NOT NULL,
    CONSTRAINT PK_agg_daily_usage PRIMARY KEY (organization_id, usage_day, group_kind, group_key),
    CONSTRAINT CK_agg_daily_kind CHECK (group_kind IN ('organization', 'feature', 'model', 'client', 'language', 'ide')),
    CONSTRAINT CK_agg_daily_users CHECK (user_count >= 0),
    CONSTRAINT FK_agg_daily_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id)
);
GO

IF OBJECT_ID(N'portal.agg_ai_credit_daily', N'U') IS NULL
CREATE TABLE portal.agg_ai_credit_daily (
    organization_login NVARCHAR(255) NOT NULL,
    usage_date         DATE          NOT NULL,
    model              NVARCHAR(128) NOT NULL,
    cost_center_name   NVARCHAR(255) NOT NULL,
    metric_version     INT           NOT NULL,
    user_count         INT           NOT NULL,
    aic_quantity       DECIMAL(18, 9) NOT NULL,
    aic_gross_amount   DECIMAL(18, 9) NOT NULL,
    net_amount         DECIMAL(18, 9) NOT NULL,
    run_id             UNIQUEIDENTIFIER NOT NULL,
    transform_version  VARCHAR(32) NOT NULL,
    -- Hash of (organization_login, model, cost_center_name): the text columns exceed the 900-byte clustered key budget.
    natural_key        AS CONVERT(BINARY(32), HASHBYTES('SHA2_256', organization_login + N'|' + model + N'|' + cost_center_name)) PERSISTED NOT NULL,
    CONSTRAINT PK_agg_ai_credit_daily PRIMARY KEY (usage_date, natural_key),
    CONSTRAINT FK_agg_ai_credit_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id)
);
GO
