-- Migration: access-model contract, part 2 (issue #44 items 3, 4, 5, 6; D-34, D-36).
--
-- Writers (one per table):
--   portal.PrincipalLinkState: ingestion
--   portal.GrantRevocation: ingestion
--   portal.dim_user: ingestion
--
-- D-34 single writer. The directory sync (writer: ingestion) must set unlinked_at and revoke grants when an Entra
-- account is disabled, but portal.Principal and portal.AccessGrant are portal-owned and ingestion is denied SELECT on
-- them. So the sync writes its own append-only facts here, and the portal reads grants only through
-- portal.v_active_grant, which applies them. Soft only: nothing is ever deleted, and no portal-owned row is changed.
--
--   PrincipalLinkState: one row per Entra <-> GitHub link. unlinked_at / unlink_reason are set by the sync. Filtered
--     unique indexes on active rows (unlinked_at IS NULL) allow one active GitHub account per Entra identity and one
--     active Entra identity per GitHub account. History rows stay.
--   GrantRevocation: append-only; a revocation applies to every grant of that Entra identity granted before it.
--   v_active_grant: a grant is active iff it is not revoked, its principal is active, and no GrantRevocation or
--     unlink for the same Entra identity happened at or after granted_at. A re-enabled user therefore needs new,
--     audited grants (deny wins, fail closed).
--
-- dim_user gains the directory attributes read through Graph (trimmed and case-normalized by the sync):
--   manager_entra_object_id (team scope is resolved from it) with manager_email ALWAYS stored alongside for
--   recognition, department and business_area (empty attribute setting = that scope disabled, columns stay NULL).
-- Directory contract v2 keeps its Manager email column for the budget Functions; this does not replace it.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID(N'portal.PrincipalLinkState', N'U') IS NULL
CREATE TABLE portal.PrincipalLinkState (
    link_id         BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_PrincipalLinkState PRIMARY KEY,
    entra_tenant_id UNIQUEIDENTIFIER NOT NULL,
    entra_object_id UNIQUEIDENTIFIER NOT NULL,
    github_user_id  BIGINT           NOT NULL,
    linked_at       DATETIME2(7)     NOT NULL CONSTRAINT DF_PrincipalLinkState_linked DEFAULT SYSUTCDATETIME(),
    unlinked_at     DATETIME2(7)     NULL,
    unlink_reason   VARCHAR(16)      NULL,
    run_id          UNIQUEIDENTIFIER NULL,
    CONSTRAINT CK_PrincipalLinkState_reason CHECK (unlink_reason IS NULL OR unlink_reason IN ('entra_disabled', 'entra_deleted', 'github_removed')),
    CONSTRAINT CK_PrincipalLinkState_pair CHECK ((unlinked_at IS NULL AND unlink_reason IS NULL) OR (unlinked_at IS NOT NULL AND unlink_reason IS NOT NULL)),
    CONSTRAINT CK_PrincipalLinkState_order CHECK (unlinked_at IS NULL OR unlinked_at >= linked_at),
    CONSTRAINT FK_PrincipalLinkState_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_PrincipalLinkState_entra' AND object_id = OBJECT_ID(N'portal.PrincipalLinkState'))
CREATE UNIQUE INDEX UX_PrincipalLinkState_entra ON portal.PrincipalLinkState (entra_tenant_id, entra_object_id) WHERE unlinked_at IS NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_PrincipalLinkState_github' AND object_id = OBJECT_ID(N'portal.PrincipalLinkState'))
CREATE UNIQUE INDEX UX_PrincipalLinkState_github ON portal.PrincipalLinkState (github_user_id) WHERE unlinked_at IS NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PrincipalLinkState_unlinked' AND object_id = OBJECT_ID(N'portal.PrincipalLinkState'))
CREATE INDEX IX_PrincipalLinkState_unlinked ON portal.PrincipalLinkState (entra_tenant_id, entra_object_id, unlinked_at) WHERE unlinked_at IS NOT NULL;
GO

IF OBJECT_ID(N'portal.GrantRevocation', N'U') IS NULL
CREATE TABLE portal.GrantRevocation (
    revocation_id   BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_GrantRevocation PRIMARY KEY,
    entra_tenant_id UNIQUEIDENTIFIER NOT NULL,
    entra_object_id UNIQUEIDENTIFIER NOT NULL,
    revoked_at      DATETIME2(7)     NOT NULL CONSTRAINT DF_GrantRevocation_revoked DEFAULT SYSUTCDATETIME(),
    reason          VARCHAR(16)      NOT NULL,
    run_id          UNIQUEIDENTIFIER NULL,
    CONSTRAINT CK_GrantRevocation_reason CHECK (reason IN ('entra_disabled', 'entra_deleted', 'github_removed')),
    CONSTRAINT FK_GrantRevocation_run FOREIGN KEY (run_id) REFERENCES portal.IngestionRun (run_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_GrantRevocation_entra' AND object_id = OBJECT_ID(N'portal.GrantRevocation'))
CREATE INDEX IX_GrantRevocation_entra ON portal.GrantRevocation (entra_tenant_id, entra_object_id, revoked_at);
GO

IF COL_LENGTH(N'portal.dim_user', N'manager_entra_object_id') IS NULL
ALTER TABLE portal.dim_user ADD manager_entra_object_id UNIQUEIDENTIFIER NULL;
GO
IF COL_LENGTH(N'portal.dim_user', N'manager_email') IS NULL
ALTER TABLE portal.dim_user ADD manager_email NVARCHAR(320) NULL;
GO
IF COL_LENGTH(N'portal.dim_user', N'department') IS NULL
ALTER TABLE portal.dim_user ADD department NVARCHAR(100) NULL;
GO
IF COL_LENGTH(N'portal.dim_user', N'business_area') IS NULL
ALTER TABLE portal.dim_user ADD business_area NVARCHAR(50) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_dim_user_manager_email' AND parent_object_id = OBJECT_ID(N'portal.dim_user'))
ALTER TABLE portal.dim_user WITH CHECK ADD CONSTRAINT CK_dim_user_manager_email CHECK (manager_entra_object_id IS NULL OR manager_email IS NOT NULL);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_dim_user_manager' AND object_id = OBJECT_ID(N'portal.dim_user'))
CREATE INDEX IX_dim_user_manager ON portal.dim_user (manager_entra_object_id) WHERE manager_entra_object_id IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_dim_user_department' AND object_id = OBJECT_ID(N'portal.dim_user'))
CREATE INDEX IX_dim_user_department ON portal.dim_user (department) WHERE department IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_dim_user_business_area' AND object_id = OBJECT_ID(N'portal.dim_user'))
CREATE INDEX IX_dim_user_business_area ON portal.dim_user (business_area) WHERE business_area IS NOT NULL;
GO

CREATE OR ALTER VIEW portal.v_active_grant AS
SELECT g.grant_id, g.principal_id, g.principal_entra_oid, g.role, g.scope, g.scope_value, g.granted_by, g.granted_at
FROM portal.AccessGrant AS g
JOIN portal.Principal AS p ON p.principal_id = g.principal_id AND p.status = 'active'
WHERE g.revoked_at IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM portal.GrantRevocation AS r
      WHERE r.entra_tenant_id = p.entra_tenant_id AND r.entra_object_id = g.principal_entra_oid AND r.revoked_at >= g.granted_at)
  AND NOT EXISTS (
      SELECT 1 FROM portal.PrincipalLinkState AS s
      WHERE s.entra_tenant_id = p.entra_tenant_id AND s.entra_object_id = g.principal_entra_oid
        AND s.unlinked_at IS NOT NULL AND s.unlinked_at >= g.granted_at);
GO
