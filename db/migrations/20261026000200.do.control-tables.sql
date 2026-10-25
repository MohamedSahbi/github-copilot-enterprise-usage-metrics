-- Migration: control tables for ingestion runs, source artifacts, checkpoints, validation and audit (§6.2, §6.5)
--
-- Writers (one per table):
--   portal.TransformVersion: migration-runner
--   portal.MetricDefinition: migration-runner
--   portal.IngestionRun: ingestion
--   portal.SourceArtifact: ingestion
--   portal.SourceCheckpoint: ingestion
--   portal.ValidationIssue: ingestion
--   portal.AuditLog: portal
--
-- Per-day replacement guard (§6.2 step 9): the filtered unique index UX_IngestionRun_current allows exactly one
-- current published run per (source_kind, scope_key, report_day). A replacement run publishes inside one transaction:
-- delete the day's rows for that run's scope, insert the new rows, flip is_current of the old run to 0 and the new
-- run to 1. A run may only publish after it holds the applock.
--
-- sp_getapplock convention (§6.2 step 5): resource names are
--   'ingest:{source_kind}:{scope_key}:{report_day}'  for per-day usage runs
--   'ingest:ai_credit:{enterprise}'                   for billing exports (GitHub returns 409 for concurrent
--                                                     exports on one enterprise, regardless of date range)
--   'portal-migrations'                               for the migration runner
-- Mode Exclusive, owner Session, timeout 0 (fail fast, caller retries with backoff). Never use dbo resources.
--
-- portal.AuditLog is append-only: the portal identity gets INSERT and SELECT only (see the runtime-grants migration, which also denies UPDATE and DELETE).

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID(N'portal.TransformVersion', N'U') IS NULL
CREATE TABLE portal.TransformVersion (
    transform_version VARCHAR(32)   NOT NULL CONSTRAINT PK_TransformVersion PRIMARY KEY,
    description       NVARCHAR(400) NULL,
    source_revision   VARCHAR(64)   NULL,
    created_at        DATETIME2(0)  NOT NULL CONSTRAINT DF_TransformVersion_created DEFAULT SYSUTCDATETIME()
);
GO

IF OBJECT_ID(N'portal.MetricDefinition', N'U') IS NULL
CREATE TABLE portal.MetricDefinition (
    metric_key        VARCHAR(64)    NOT NULL,
    metric_version    INT            NOT NULL,
    formula           NVARCHAR(1000) NOT NULL,
    upstream_ref      NVARCHAR(200)  NULL,
    differs_from_upstream BIT        NOT NULL CONSTRAINT DF_MetricDefinition_diff DEFAULT 0,
    difference_note   NVARCHAR(1000) NULL,
    effective_from    DATE           NOT NULL,
    CONSTRAINT PK_MetricDefinition PRIMARY KEY (metric_key, metric_version)
);
GO

IF OBJECT_ID(N'portal.IngestionRun', N'U') IS NULL
CREATE TABLE portal.IngestionRun (
    run_id            UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_IngestionRun PRIMARY KEY,
    source_kind       VARCHAR(40)      NOT NULL,
    scope_key         NVARCHAR(100)    NOT NULL,
    report_day        DATE             NULL,
    range_start       DATE             NULL,
    range_end         DATE             NULL,
    status            VARCHAR(16)      NOT NULL,
    is_current        BIT              NOT NULL CONSTRAINT DF_IngestionRun_current DEFAULT 0,
    transform_version VARCHAR(32)      NOT NULL,
    attempt           INT              NOT NULL CONSTRAINT DF_IngestionRun_attempt DEFAULT 1,
    rows_read         INT              NULL,
    rows_loaded       INT              NULL,
    rows_quarantined  INT              NULL,
    error_code        VARCHAR(64)      NULL,
    correlation_id    VARCHAR(64)      NULL,
    started_at        DATETIME2(0)     NOT NULL CONSTRAINT DF_IngestionRun_started DEFAULT SYSUTCDATETIME(),
    completed_at      DATETIME2(0)     NULL,
    CONSTRAINT CK_IngestionRun_source CHECK (source_kind IN ('users_1_day', 'ai_credit', 'directory', 'organization')),
    CONSTRAINT CK_IngestionRun_status CHECK (status IN ('started', 'staged', 'validated', 'published', 'failed', 'cancelled')),
    CONSTRAINT CK_IngestionRun_current CHECK (is_current = 0 OR status = 'published'),
    CONSTRAINT CK_IngestionRun_range CHECK (range_end IS NULL OR range_start IS NULL OR range_end >= range_start),
    CONSTRAINT FK_IngestionRun_transform FOREIGN KEY (transform_version) REFERENCES portal.TransformVersion (transform_version)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_IngestionRun_current' AND object_id = OBJECT_ID(N'portal.IngestionRun'))
CREATE UNIQUE INDEX UX_IngestionRun_current
    ON portal.IngestionRun (source_kind, scope_key, report_day)
    WHERE is_current = 1;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_IngestionRun_started' AND object_id = OBJECT_ID(N'portal.IngestionRun'))
CREATE INDEX IX_IngestionRun_started ON portal.IngestionRun (source_kind, scope_key, started_at DESC);
GO

IF OBJECT_ID(N'portal.SourceArtifact', N'U') IS NULL
CREATE TABLE portal.SourceArtifact (
    artifact_id    BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_SourceArtifact PRIMARY KEY,
    run_id         UNIQUEIDENTIFIER NOT NULL,
    blob_container NVARCHAR(63)     NOT NULL,
    blob_path      NVARCHAR(600)    NOT NULL, -- keeps UX_SourceArtifact_blob under the 1700-byte index key limit
    sha256         CHAR(64)         NOT NULL,
    size_bytes     BIGINT           NOT NULL,
    row_count      INT              NULL,
    received_at    DATETIME2(0)     NOT NULL CONSTRAINT DF_SourceArtifact_received DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_SourceArtifact_sha CHECK (sha256 NOT LIKE '%[^0-9a-f]%'),
    CONSTRAINT CK_SourceArtifact_size CHECK (size_bytes >= 0),
    CONSTRAINT FK_SourceArtifact_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_SourceArtifact_blob' AND object_id = OBJECT_ID(N'portal.SourceArtifact'))
CREATE UNIQUE INDEX UX_SourceArtifact_blob ON portal.SourceArtifact (run_id, blob_container, blob_path);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SourceArtifact_sha' AND object_id = OBJECT_ID(N'portal.SourceArtifact'))
CREATE INDEX IX_SourceArtifact_sha ON portal.SourceArtifact (sha256);
GO

IF OBJECT_ID(N'portal.SourceCheckpoint', N'U') IS NULL
CREATE TABLE portal.SourceCheckpoint (
    source_kind       VARCHAR(40)      NOT NULL,
    scope_key         NVARCHAR(100)    NOT NULL,
    last_complete_day DATE             NULL,
    last_run_id       UNIQUEIDENTIFIER NULL,
    updated_at        DATETIME2(0)     NOT NULL CONSTRAINT DF_SourceCheckpoint_updated DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_SourceCheckpoint PRIMARY KEY (source_kind, scope_key),
    CONSTRAINT FK_SourceCheckpoint_run FOREIGN KEY (last_run_id) REFERENCES portal.IngestionRun (run_id)
);
GO

-- Machine-readable quarantine. severity 'reject' = row not loaded; 'warn' = loaded with a note; 'fatal' = file failed.
-- Raw object reference: artifact_id + line_number (+ raw_row_sha256) points back at the immutable blob; the row itself
-- is never copied here, so no personal data is duplicated.
IF OBJECT_ID(N'portal.ValidationIssue', N'U') IS NULL
CREATE TABLE portal.ValidationIssue (
    issue_id       BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_ValidationIssue PRIMARY KEY,
    run_id         UNIQUEIDENTIFIER NOT NULL,
    artifact_id    BIGINT           NULL,
    line_number    INT              NULL,
    raw_row_sha256 CHAR(64)         NULL,
    severity       VARCHAR(8)       NOT NULL,
    error_code     VARCHAR(64)      NOT NULL,
    field_path     NVARCHAR(200)    NULL,
    message        NVARCHAR(400)    NULL,
    created_at     DATETIME2(0)     NOT NULL CONSTRAINT DF_ValidationIssue_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_ValidationIssue_severity CHECK (severity IN ('reject', 'warn', 'fatal')),
    CONSTRAINT FK_ValidationIssue_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id),
    CONSTRAINT FK_ValidationIssue_artifact FOREIGN KEY (artifact_id) REFERENCES portal.SourceArtifact (artifact_id)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ValidationIssue_run' AND object_id = OBJECT_ID(N'portal.ValidationIssue'))
CREATE INDEX IX_ValidationIssue_run ON portal.ValidationIssue (run_id, severity, error_code);
GO

IF OBJECT_ID(N'portal.AuditLog', N'U') IS NULL
CREATE TABLE portal.AuditLog (
    audit_id        BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_AuditLog PRIMARY KEY,
    occurred_at     DATETIME2(3)     NOT NULL CONSTRAINT DF_AuditLog_occurred DEFAULT SYSUTCDATETIME(),
    actor_principal_id UNIQUEIDENTIFIER NULL,
    actor_entra_oid UNIQUEIDENTIFIER NULL,
    action          VARCHAR(64)      NOT NULL,
    target_type     VARCHAR(64)      NULL,
    target_id       NVARCHAR(128)    NULL,
    outcome         VARCHAR(16)      NOT NULL,
    correlation_id  VARCHAR(64)      NULL,
    detail_json     NVARCHAR(MAX)    NULL,
    CONSTRAINT CK_AuditLog_outcome CHECK (outcome IN ('allowed', 'denied', 'success', 'failure')),
    CONSTRAINT CK_AuditLog_detail CHECK (detail_json IS NULL OR ISJSON(detail_json) = 1)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuditLog_time' AND object_id = OBJECT_ID(N'portal.AuditLog'))
CREATE INDEX IX_AuditLog_time ON portal.AuditLog (occurred_at DESC, action);
GO
