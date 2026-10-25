-- Migration: staging tables (§6.2 steps 3-6). Typed rows keyed by run ID and source keys, loaded before validation
-- and published into curated by a per-day replacement. Staging holds no history: rows of published or failed runs
-- are deleted by the ingestion identity after the retention window in settings (default 14 days).
--
-- Writers (one per table):
--   portal.stg_user_daily: ingestion
--   portal.stg_user_breakdown: ingestion
--   portal.stg_user_family_count: ingestion
--   portal.stg_ai_credit_line: ingestion
--
-- Row identity: (run_id, artifact_id, line_number) points to the line in one SourceArtifact. A report can arrive as
-- several parts (download links / CSV parts) under one run and every part restarts at line 1, so artifact_id is part of
-- the key. The duplicate-key guards below stay per run so duplicates across parts are still caught. Quarantined rows are NOT in staging;
-- they are described in portal.ValidationIssue only.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID(N'portal.stg_user_daily', N'U') IS NULL
CREATE TABLE portal.stg_user_daily (
    run_id          UNIQUEIDENTIFIER NOT NULL,
    artifact_id     BIGINT           NOT NULL,
    line_number     INT              NOT NULL,
    organization_id BIGINT           NOT NULL,
    enterprise_id   BIGINT           NULL,
    user_id         BIGINT           NOT NULL,
    user_login      NVARCHAR(255)    NULL,
    usage_day       DATE             NOT NULL,
    interaction_count          INT   NOT NULL,
    code_generation_count      INT   NOT NULL,
    code_acceptance_count      INT   NOT NULL,
    loc_suggested_to_add       BIGINT NOT NULL,
    loc_suggested_to_delete    BIGINT NOT NULL,
    loc_added                  BIGINT NOT NULL,
    loc_deleted                BIGINT NOT NULL,
    used_agent              BIT NOT NULL,
    used_chat               BIT NOT NULL,
    used_cli                BIT NOT NULL,
    used_coding_agent       BIT NOT NULL,
    used_cloud_agent        BIT NOT NULL,
    used_copilot_app        BIT NOT NULL,
    used_vscode_agent       BIT NOT NULL,
    used_code_review_active  BIT NOT NULL,
    used_code_review_passive BIT NOT NULL,
    ai_credits_used         DECIMAL(18, 9) NOT NULL,
    ai_adoption_phase_number TINYINT NULL,
    ai_adoption_phase       VARCHAR(64) NULL,
    extra_json              NVARCHAR(MAX) NULL,
    CONSTRAINT PK_stg_user_daily PRIMARY KEY (run_id, artifact_id, line_number),
    CONSTRAINT CK_stg_user_daily_counts CHECK (
        interaction_count >= 0 AND code_generation_count >= 0 AND code_acceptance_count >= 0
        AND loc_suggested_to_add >= 0 AND loc_suggested_to_delete >= 0 AND loc_added >= 0 AND loc_deleted >= 0
        AND ai_credits_used >= 0),
    CONSTRAINT CK_stg_user_daily_extra CHECK (extra_json IS NULL OR ISJSON(extra_json) = 1),
    CONSTRAINT FK_stg_user_daily_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id),
    CONSTRAINT FK_stg_user_daily_run_artifact FOREIGN KEY (artifact_id) REFERENCES portal.SourceArtifact (artifact_id)
);
GO

-- The duplicate-key guard: one staged row per (run, organization, user, day).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_stg_user_daily_key' AND object_id = OBJECT_ID(N'portal.stg_user_daily'))
CREATE UNIQUE INDEX UX_stg_user_daily_key ON portal.stg_user_daily (run_id, organization_id, user_id, usage_day);
GO

-- dimension: ide | feature | language_feature | language_model | model_feature | client
IF OBJECT_ID(N'portal.stg_user_breakdown', N'U') IS NULL
CREATE TABLE portal.stg_user_breakdown (
    run_id          UNIQUEIDENTIFIER NOT NULL,
    artifact_id     BIGINT           NOT NULL,
    line_number     INT              NOT NULL,
    item_number     INT              NOT NULL,
    breakdown_kind  VARCHAR(24)      NOT NULL,
    key_1           NVARCHAR(128)    NOT NULL,
    key_2           NVARCHAR(128)    NOT NULL CONSTRAINT DF_stg_user_breakdown_key2 DEFAULT N'',
    interaction_count       INT      NOT NULL,
    code_generation_count   INT      NOT NULL,
    code_acceptance_count   INT      NOT NULL,
    loc_suggested_to_add    BIGINT   NOT NULL,
    loc_suggested_to_delete BIGINT   NOT NULL,
    loc_added               BIGINT   NOT NULL,
    loc_deleted             BIGINT   NOT NULL,
    session_count           INT      NULL,
    request_count           INT      NULL,
    prompt_tokens           BIGINT   NULL,
    output_tokens           BIGINT   NULL,
    version_info            NVARCHAR(1000) NULL,
    CONSTRAINT PK_stg_user_breakdown PRIMARY KEY (run_id, artifact_id, line_number, item_number),
    CONSTRAINT CK_stg_user_breakdown_kind CHECK (breakdown_kind IN
        ('ide', 'feature', 'language_feature', 'language_model', 'model_feature', 'client')),
    CONSTRAINT FK_stg_user_breakdown_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id),
    CONSTRAINT FK_stg_user_breakdown_run_artifact FOREIGN KEY (artifact_id) REFERENCES portal.SourceArtifact (artifact_id)
);
GO

-- family: skill | custom_agent | mcp | slash_cmd | plugin
IF OBJECT_ID(N'portal.stg_user_family_count', N'U') IS NULL
CREATE TABLE portal.stg_user_family_count (
    run_id       UNIQUEIDENTIFIER NOT NULL,
    artifact_id     BIGINT           NOT NULL,
    line_number  INT              NOT NULL,
    item_number  INT              NOT NULL,
    family       VARCHAR(16)      NOT NULL,
    item_name    NVARCHAR(256)    NOT NULL,
    interaction_count INT         NOT NULL,
    CONSTRAINT PK_stg_user_family_count PRIMARY KEY (run_id, artifact_id, line_number, item_number),
    CONSTRAINT CK_stg_user_family CHECK (family IN ('skill', 'custom_agent', 'mcp', 'slash_cmd', 'plugin')),
    CONSTRAINT CK_stg_user_family_count CHECK (interaction_count >= 0),
    CONSTRAINT FK_stg_user_family_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id),
    CONSTRAINT FK_stg_user_family_run_artifact FOREIGN KEY (artifact_id) REFERENCES portal.SourceArtifact (artifact_id)
);
GO

-- One line of the enterprise ai_credit CSV (grain: date x username x model, plus cost center/organization/repository).
-- Decimals are DECIMAL(18,9) and never rounded; source values may carry floating-point artefacts.
IF OBJECT_ID(N'portal.stg_ai_credit_line', N'U') IS NULL
CREATE TABLE portal.stg_ai_credit_line (
    run_id              UNIQUEIDENTIFIER NOT NULL,
    artifact_id     BIGINT           NOT NULL,
    line_number         INT              NOT NULL,
    usage_date          DATE             NOT NULL,
    username            NVARCHAR(255)    NOT NULL,
    product             NVARCHAR(64)     NULL,
    sku                 NVARCHAR(128)    NULL,
    model               NVARCHAR(128)    NOT NULL,
    quantity            DECIMAL(18, 9)   NULL,
    unit_type           NVARCHAR(32)     NULL,
    applied_cost_per_quantity DECIMAL(18, 9) NULL,
    gross_amount        DECIMAL(18, 9)   NULL,
    discount_amount     DECIMAL(18, 9)   NULL,
    net_amount          DECIMAL(18, 9)   NULL,
    total_monthly_quota DECIMAL(18, 9)   NULL,
    organization        NVARCHAR(255)    NOT NULL CONSTRAINT DF_stg_ai_credit_org DEFAULT N'',
    app_client_id       NVARCHAR(128)    NOT NULL CONSTRAINT DF_stg_ai_credit_app DEFAULT N'',
    repository          NVARCHAR(255)    NOT NULL CONSTRAINT DF_stg_ai_credit_repo DEFAULT N'',
    cost_center_name    NVARCHAR(255)    NOT NULL CONSTRAINT DF_stg_ai_credit_cc DEFAULT N'',
    aic_quantity        DECIMAL(18, 9)   NULL,
    aic_gross_amount    DECIMAL(18, 9)   NULL,
    input_tokens        BIGINT           NULL,
    output_tokens       BIGINT           NULL,
    cache_read_tokens   BIGINT           NULL,
    cache_write_tokens  BIGINT           NULL,
    -- Hash of the natural key: the text columns are far wider than the 1700-byte index key budget.
    natural_key         AS CONVERT(BINARY(32), HASHBYTES('SHA2_256', organization + N'|' + username + N'|' + model + N'|' + cost_center_name + N'|' + repository + N'|' + app_client_id + N'|' + ISNULL(sku, N''))) PERSISTED NOT NULL,
    CONSTRAINT PK_stg_ai_credit_line PRIMARY KEY (run_id, artifact_id, line_number),
    CONSTRAINT FK_stg_ai_credit_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id),
    CONSTRAINT FK_stg_ai_credit_run_artifact FOREIGN KEY (artifact_id) REFERENCES portal.SourceArtifact (artifact_id)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_stg_ai_credit_key' AND object_id = OBJECT_ID(N'portal.stg_ai_credit_line'))
CREATE UNIQUE INDEX UX_stg_ai_credit_key
    ON portal.stg_ai_credit_line (run_id, usage_date, natural_key);
GO
