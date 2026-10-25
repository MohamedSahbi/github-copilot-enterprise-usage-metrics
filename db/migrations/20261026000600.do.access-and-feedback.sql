-- Migration: access control and Feedback module tables (D-5, D-17, D-36; §6.5, §13.1).
--
-- Writers (one per table):
--   portal.Principal: portal
--   portal.PrincipalIdentity: portal
--   portal.AccessGrant: portal
--   portal.BreakGlassConfig: portal
--   portal.DirectorySyncState: ingestion
--   portal.FeedbackItem: portal
--   portal.FeedbackVote: portal
--   portal.FeedbackComment: portal
--
-- Permissions attach to ONE internal principal. Identities link to it by immutable IDs only:
--   entra: (tenant_id, object_id)      github: numeric GitHub user ID
-- Email, login and provider never grant access. A GitHub identity gains permissions only once linked to an Entra
-- principal (stored Entra object ID). Grants are one row per (principal, role, scope, scope value) and replace the
-- legacy comma-separated lists. Fail closed: if freshness cannot be established, the portal denies (D-17).

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID(N'portal.Principal', N'U') IS NULL
CREATE TABLE portal.Principal (
    principal_id    UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Principal_id DEFAULT NEWSEQUENTIALID() CONSTRAINT PK_Principal PRIMARY KEY,
    entra_tenant_id UNIQUEIDENTIFIER NULL,
    entra_object_id UNIQUEIDENTIFIER NULL,
    github_user_id  BIGINT           NULL,
    status          VARCHAR(10)      NOT NULL CONSTRAINT DF_Principal_status DEFAULT 'active',
    created_at      DATETIME2(0)     NOT NULL CONSTRAINT DF_Principal_created DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2(0)     NOT NULL CONSTRAINT DF_Principal_updated DEFAULT SYSUTCDATETIME(),
    -- permission-freshness (D-17): when the grants of this principal were last confirmed from the source of truth
    permissions_verified_at DATETIME2(0) NULL,
    CONSTRAINT CK_Principal_status CHECK (status IN ('active', 'disabled')),
    CONSTRAINT CK_Principal_identity CHECK (entra_object_id IS NOT NULL OR github_user_id IS NOT NULL),
    CONSTRAINT CK_Principal_entra_pair CHECK ((entra_object_id IS NULL AND entra_tenant_id IS NULL) OR (entra_object_id IS NOT NULL AND entra_tenant_id IS NOT NULL))
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_Principal_entra' AND object_id = OBJECT_ID(N'portal.Principal'))
CREATE UNIQUE INDEX UX_Principal_entra ON portal.Principal (entra_tenant_id, entra_object_id) WHERE entra_object_id IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_Principal_github' AND object_id = OBJECT_ID(N'portal.Principal'))
CREATE UNIQUE INDEX UX_Principal_github ON portal.Principal (github_user_id) WHERE github_user_id IS NOT NULL;
GO

-- Audit of how a GitHub identity was linked (D-36): source and evidence, never email matching.
IF OBJECT_ID(N'portal.PrincipalIdentity', N'U') IS NULL
CREATE TABLE portal.PrincipalIdentity (
    identity_id   BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_PrincipalIdentity PRIMARY KEY,
    principal_id  UNIQUEIDENTIFIER NOT NULL,
    provider      VARCHAR(10)      NOT NULL,
    subject_id    NVARCHAR(64)     NOT NULL,
    link_source   VARCHAR(24)      NOT NULL,
    linked_at     DATETIME2(0)     NOT NULL CONSTRAINT DF_PrincipalIdentity_linked DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_PrincipalIdentity_provider CHECK (provider IN ('entra', 'github')),
    CONSTRAINT CK_PrincipalIdentity_source CHECK (link_source IN ('first_sign_in', 'scim_sync', 'admin')),
    CONSTRAINT FK_PrincipalIdentity_principal FOREIGN KEY (principal_id) REFERENCES portal.Principal (principal_id),
    CONSTRAINT UX_PrincipalIdentity UNIQUE (provider, subject_id)
);
GO

IF OBJECT_ID(N'portal.AccessGrant', N'U') IS NULL
CREATE TABLE portal.AccessGrant (
    grant_id     BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_AccessGrant PRIMARY KEY,
    principal_id UNIQUEIDENTIFIER NOT NULL,
    role         VARCHAR(12)   NOT NULL,
    scope        VARCHAR(16)   NOT NULL,
    scope_value  NVARCHAR(128) NOT NULL CONSTRAINT DF_AccessGrant_value DEFAULT N'',
    granted_by   UNIQUEIDENTIFIER NULL,
    granted_at   DATETIME2(0)  NOT NULL CONSTRAINT DF_AccessGrant_granted DEFAULT SYSUTCDATETIME(),
    revoked_at   DATETIME2(0)  NULL,
    CONSTRAINT CK_AccessGrant_role CHECK (role IN ('user', 'manager', 'executive', 'admin')),
    CONSTRAINT CK_AccessGrant_scope CHECK (scope IN ('self', 'team', 'department', 'business_area', 'company')),
    CONSTRAINT CK_AccessGrant_value CHECK (scope IN ('self', 'team', 'company') OR scope_value <> N''),
    CONSTRAINT FK_AccessGrant_principal FOREIGN KEY (principal_id) REFERENCES portal.Principal (principal_id),
    CONSTRAINT UX_AccessGrant UNIQUE (principal_id, role, scope, scope_value)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AccessGrant_active' AND object_id = OBJECT_ID(N'portal.AccessGrant'))
CREATE INDEX IX_AccessGrant_active ON portal.AccessGrant (principal_id) WHERE revoked_at IS NULL;
GO

-- Break-glass: members of this Entra group reach admin and health pages even when permissions cannot be read (D-17).
-- Single-row table; the group ID is a deployment setting mirrored here for audit only when set by an admin.
IF OBJECT_ID(N'portal.BreakGlassConfig', N'U') IS NULL
CREATE TABLE portal.BreakGlassConfig (
    singleton      BIT              NOT NULL CONSTRAINT PK_BreakGlassConfig PRIMARY KEY CONSTRAINT CK_BreakGlass_single CHECK (singleton = 1),
    entra_group_id UNIQUEIDENTIFIER NOT NULL,
    updated_by     UNIQUEIDENTIFIER NULL,
    updated_at     DATETIME2(0)     NOT NULL CONSTRAINT DF_BreakGlass_updated DEFAULT SYSUTCDATETIME()
);
GO

-- Freshness of the directory/SCIM sync that feeds principal links; the portal reads it to decide fail-closed.
IF OBJECT_ID(N'portal.DirectorySyncState', N'U') IS NULL
CREATE TABLE portal.DirectorySyncState (
    source           VARCHAR(16)  NOT NULL CONSTRAINT PK_DirectorySyncState PRIMARY KEY,
    last_success_at  DATETIME2(0) NULL,
    last_attempt_at  DATETIME2(0) NULL,
    last_error_code  VARCHAR(64)  NULL,
    CONSTRAINT CK_DirectorySyncState_source CHECK (source IN ('scim', 'graph', 'csv', 'seats'))
);
GO

IF OBJECT_ID(N'portal.FeedbackItem', N'U') IS NULL
CREATE TABLE portal.FeedbackItem (
    item_id      BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_FeedbackItem PRIMARY KEY,
    author_principal_id UNIQUEIDENTIFIER NOT NULL,
    title        NVARCHAR(200)  NOT NULL,
    body         NVARCHAR(4000) NOT NULL,
    status       VARCHAR(12)    NOT NULL CONSTRAINT DF_FeedbackItem_status DEFAULT 'open',
    visibility   VARCHAR(10)    NOT NULL CONSTRAINT DF_FeedbackItem_vis DEFAULT 'everyone',
    created_at   DATETIME2(0)   NOT NULL CONSTRAINT DF_FeedbackItem_created DEFAULT SYSUTCDATETIME(),
    updated_at   DATETIME2(0)   NOT NULL CONSTRAINT DF_FeedbackItem_updated DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_FeedbackItem_status CHECK (status IN ('open', 'planned', 'done', 'declined')),
    CONSTRAINT CK_FeedbackItem_vis CHECK (visibility IN ('everyone', 'admins')),
    CONSTRAINT FK_FeedbackItem_author FOREIGN KEY (author_principal_id) REFERENCES portal.Principal (principal_id)
);
GO
IF OBJECT_ID(N'portal.FeedbackVote', N'U') IS NULL
CREATE TABLE portal.FeedbackVote (
    item_id      BIGINT           NOT NULL,
    principal_id UNIQUEIDENTIFIER NOT NULL,
    voted_at     DATETIME2(0)     NOT NULL CONSTRAINT DF_FeedbackVote_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_FeedbackVote PRIMARY KEY (item_id, principal_id),
    CONSTRAINT FK_FeedbackVote_item FOREIGN KEY (item_id) REFERENCES portal.FeedbackItem (item_id) ON DELETE CASCADE,
    CONSTRAINT FK_FeedbackVote_principal FOREIGN KEY (principal_id) REFERENCES portal.Principal (principal_id)
);
GO
IF OBJECT_ID(N'portal.FeedbackComment', N'U') IS NULL
CREATE TABLE portal.FeedbackComment (
    comment_id   BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_FeedbackComment PRIMARY KEY,
    item_id      BIGINT           NOT NULL,
    author_principal_id UNIQUEIDENTIFIER NOT NULL,
    body         NVARCHAR(2000)   NOT NULL,
    created_at   DATETIME2(0)     NOT NULL CONSTRAINT DF_FeedbackComment_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_FeedbackComment_item FOREIGN KEY (item_id) REFERENCES portal.FeedbackItem (item_id) ON DELETE CASCADE,
    CONSTRAINT FK_FeedbackComment_author FOREIGN KEY (author_principal_id) REFERENCES portal.Principal (principal_id)
);
GO
