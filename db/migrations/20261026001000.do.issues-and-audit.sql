-- Migration: admin issues inbox, quarantine and audit rows (issue #44 items 4, 8, 9, 10; §6.2, D-34).
--
-- Writers (one per table):
--   portal.IssueAction: portal
--   portal.IngestionAuditEvent: ingestion
--   portal.ValidationIssue: ingestion
--   portal.IngestionRun: ingestion
--
-- Admin issues inbox, backed by ValidationIssue. Ingestion writes the issues (duplicate_file, smaller_day) and sets
-- handled_at after it has reprocessed the day. The portal only appends the admin's chosen action to IssueAction; a
-- chosen action just marks the day for reprocessing, the ingestion Function does the work. Status is derived:
-- open (no action, or action not yet handled), resolved (handled), dismissed (reject or discard).
--
-- Quarantine: IngestionRun.status gains 'quarantined'. Incoming data of a quarantined run stays in staging and in the
-- raw blob until an admin acts; the staging purge must skip quarantined runs. A smaller day or a duplicate file never
-- reaches the curated tables by itself.
--
-- Audit: portal.AuditLog stays portal-written. Actions of the directory sync and the login-history purge run in
-- ingestion, which cannot write AuditLog, so they append to portal.IngestionAuditEvent (append-only, same shape).
-- The Admin audit view reads both.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF COL_LENGTH(N'portal.ValidationIssue', N'issue_type') IS NULL
ALTER TABLE portal.ValidationIssue ADD issue_type VARCHAR(16) NULL;
GO
IF COL_LENGTH(N'portal.ValidationIssue', N'report_day') IS NULL
ALTER TABLE portal.ValidationIssue ADD report_day DATE NULL;
GO
IF COL_LENGTH(N'portal.ValidationIssue', N'handled_at') IS NULL
ALTER TABLE portal.ValidationIssue ADD handled_at DATETIME2(0) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_ValidationIssue_type' AND parent_object_id = OBJECT_ID(N'portal.ValidationIssue'))
ALTER TABLE portal.ValidationIssue WITH CHECK ADD CONSTRAINT CK_ValidationIssue_type CHECK (issue_type IS NULL OR issue_type IN ('duplicate_file', 'smaller_day'));
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ValidationIssue_inbox' AND object_id = OBJECT_ID(N'portal.ValidationIssue'))
CREATE INDEX IX_ValidationIssue_inbox ON portal.ValidationIssue (issue_type, handled_at, created_at DESC) WHERE issue_type IS NOT NULL;
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_IngestionRun_status' AND parent_object_id = OBJECT_ID(N'portal.IngestionRun') AND definition NOT LIKE N'%quarantined%')
ALTER TABLE portal.IngestionRun DROP CONSTRAINT CK_IngestionRun_status;
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_IngestionRun_status' AND parent_object_id = OBJECT_ID(N'portal.IngestionRun'))
ALTER TABLE portal.IngestionRun WITH CHECK ADD CONSTRAINT CK_IngestionRun_status
    CHECK (status IN ('started', 'staged', 'validated', 'published', 'failed', 'cancelled', 'quarantined'));
GO

IF OBJECT_ID(N'portal.IssueAction', N'U') IS NULL
CREATE TABLE portal.IssueAction (
    action_id      BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_IssueAction PRIMARY KEY,
    issue_id       BIGINT           NOT NULL,
    action         VARCHAR(16)      NOT NULL,
    actor_entra_oid UNIQUEIDENTIFIER NOT NULL,
    requested_at   DATETIME2(0)     NOT NULL CONSTRAINT DF_IssueAction_requested DEFAULT SYSUTCDATETIME(),
    correlation_id VARCHAR(64)      NULL,
    CONSTRAINT CK_IssueAction_action CHECK (action IN ('retry', 'accept_last', 'accept_first', 'reject', 'force', 'discard')),
    CONSTRAINT FK_IssueAction_issue FOREIGN KEY (issue_id) REFERENCES portal.ValidationIssue (issue_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_IssueAction_issue' AND object_id = OBJECT_ID(N'portal.IssueAction'))
CREATE INDEX IX_IssueAction_issue ON portal.IssueAction (issue_id, requested_at DESC);
GO

IF OBJECT_ID(N'portal.IngestionAuditEvent', N'U') IS NULL
CREATE TABLE portal.IngestionAuditEvent (
    event_id       BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_IngestionAuditEvent PRIMARY KEY,
    occurred_at    DATETIME2(3)     NOT NULL CONSTRAINT DF_IngestionAuditEvent_occurred DEFAULT SYSUTCDATETIME(),
    action         VARCHAR(64)      NOT NULL,
    run_id         UNIQUEIDENTIFIER NULL,
    target_type    VARCHAR(64)      NULL,
    target_id      NVARCHAR(128)    NULL,
    outcome        VARCHAR(16)      NOT NULL,
    correlation_id VARCHAR(64)      NULL,
    detail_json    NVARCHAR(MAX)    NULL,
    CONSTRAINT CK_IngestionAuditEvent_action CHECK (action IN ('grant.revoked_by_directory_sync', 'principal.unlinked_by_directory_sync', 'login_history.purged')),
    CONSTRAINT CK_IngestionAuditEvent_outcome CHECK (outcome IN ('success', 'failure')),
    CONSTRAINT CK_IngestionAuditEvent_detail CHECK (detail_json IS NULL OR ISJSON(detail_json) = 1),
    CONSTRAINT FK_IngestionAuditEvent_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_IngestionAuditEvent_time' AND object_id = OBJECT_ID(N'portal.IngestionAuditEvent'))
CREATE INDEX IX_IngestionAuditEvent_time ON portal.IngestionAuditEvent (occurred_at DESC, action);
GO
