-- Migration: curated dimensions (§6.3). Identity key is the numeric GitHub user ID; login is a mutable attribute (D-36).
--
-- Writers (one per table):
--   portal.dim_date: migration-runner
--   portal.dim_organization: ingestion
--   portal.dim_user: ingestion
--   portal.dim_user_login_history: ingestion
--   portal.dim_feature: ingestion
--   portal.dim_model: ingestion
--   portal.dim_client: ingestion
--   portal.dim_language: ingestion
--
-- dim_user lifecycle: state 'deleted' sets deleted_at; PII columns (login, email, display name) are nulled after the
-- configured retention (setting per_user_months). A re-added user with the same ID flips back to 'active' and PII is
-- repopulated. A recreated EMU account has a NEW numeric ID and therefore a separate row, linked by entra_object_id.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID(N'portal.dim_date', N'U') IS NULL
CREATE TABLE portal.dim_date (
    date_key    DATE        NOT NULL CONSTRAINT PK_dim_date PRIMARY KEY,
    year_num    SMALLINT    NOT NULL,
    month_num   TINYINT     NOT NULL,
    day_of_month TINYINT    NOT NULL,
    iso_week    TINYINT     NOT NULL,
    day_of_week TINYINT     NOT NULL,
    month_start DATE        NOT NULL
);
GO

IF OBJECT_ID(N'portal.dim_organization', N'U') IS NULL
CREATE TABLE portal.dim_organization (
    organization_id BIGINT        NOT NULL CONSTRAINT PK_dim_organization PRIMARY KEY,
    login           NVARCHAR(255) NOT NULL,
    updated_at      DATETIME2(0)  NOT NULL CONSTRAINT DF_dim_org_updated DEFAULT SYSUTCDATETIME()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_dim_organization_login' AND object_id = OBJECT_ID(N'portal.dim_organization'))
CREATE INDEX IX_dim_organization_login ON portal.dim_organization (login);
GO

IF OBJECT_ID(N'portal.dim_user', N'U') IS NULL
CREATE TABLE portal.dim_user (
    user_id         BIGINT        NOT NULL CONSTRAINT PK_dim_user PRIMARY KEY,
    login           NVARCHAR(255) NULL,
    email           NVARCHAR(320) NULL,
    display_name    NVARCHAR(255) NULL,
    entra_object_id UNIQUEIDENTIFIER NULL,
    state           VARCHAR(10)   NOT NULL CONSTRAINT DF_dim_user_state DEFAULT 'active',
    first_seen_day  DATE          NULL,
    last_seen_day   DATE          NULL,
    deleted_at      DATETIME2(0)  NULL,
    pii_purged_at   DATETIME2(0)  NULL,
    updated_at      DATETIME2(0)  NOT NULL CONSTRAINT DF_dim_user_updated DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_dim_user_state CHECK (state IN ('active', 'deleted', 'suspended')),
    CONSTRAINT CK_dim_user_deleted CHECK (state <> 'deleted' OR deleted_at IS NOT NULL)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_dim_user_login' AND object_id = OBJECT_ID(N'portal.dim_user'))
CREATE INDEX IX_dim_user_login ON portal.dim_user (login) WHERE login IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_dim_user_entra' AND object_id = OBJECT_ID(N'portal.dim_user'))
CREATE INDEX IX_dim_user_entra ON portal.dim_user (entra_object_id) WHERE entra_object_id IS NOT NULL;
GO

IF OBJECT_ID(N'portal.dim_user_login_history', N'U') IS NULL
CREATE TABLE portal.dim_user_login_history (
    user_id    BIGINT        NOT NULL,
    login      NVARCHAR(255) NOT NULL,
    first_seen_day DATE      NOT NULL,
    last_seen_day  DATE      NOT NULL,
    is_hashed_login BIT      NOT NULL CONSTRAINT DF_login_hist_hashed DEFAULT 0,
    CONSTRAINT PK_dim_user_login_history PRIMARY KEY (user_id, login),
    CONSTRAINT FK_login_history_user FOREIGN KEY (user_id) REFERENCES portal.dim_user (user_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_login_history_login' AND object_id = OBJECT_ID(N'portal.dim_user_login_history'))
CREATE INDEX IX_login_history_login ON portal.dim_user_login_history (login);
GO

IF OBJECT_ID(N'portal.dim_feature', N'U') IS NULL
CREATE TABLE portal.dim_feature (
    feature_key  NVARCHAR(128) NOT NULL CONSTRAINT PK_dim_feature PRIMARY KEY,
    label        NVARCHAR(128) NULL,
    is_chat      BIT NOT NULL CONSTRAINT DF_dim_feature_chat DEFAULT 0,
    is_agent     BIT NOT NULL CONSTRAINT DF_dim_feature_agent DEFAULT 0,
    is_cli       BIT NOT NULL CONSTRAINT DF_dim_feature_cli DEFAULT 0,
    chat_mode_bucket VARCHAR(8) NULL,
    is_known     BIT NOT NULL CONSTRAINT DF_dim_feature_known DEFAULT 0
);
GO
IF OBJECT_ID(N'portal.dim_model', N'U') IS NULL
CREATE TABLE portal.dim_model (
    model_key NVARCHAR(128) NOT NULL CONSTRAINT PK_dim_model PRIMARY KEY,
    label     NVARCHAR(128) NULL,
    is_known  BIT NOT NULL CONSTRAINT DF_dim_model_known DEFAULT 0
);
GO
IF OBJECT_ID(N'portal.dim_client', N'U') IS NULL
CREATE TABLE portal.dim_client (
    client_key NVARCHAR(128) NOT NULL CONSTRAINT PK_dim_client PRIMARY KEY,
    label      NVARCHAR(128) NULL,
    is_known   BIT NOT NULL CONSTRAINT DF_dim_client_known DEFAULT 0
);
GO
IF OBJECT_ID(N'portal.dim_language', N'U') IS NULL
CREATE TABLE portal.dim_language (
    language_key NVARCHAR(128) NOT NULL CONSTRAINT PK_dim_language PRIMARY KEY,
    label        NVARCHAR(128) NULL
);
GO
