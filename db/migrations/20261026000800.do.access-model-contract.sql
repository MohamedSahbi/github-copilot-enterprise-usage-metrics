-- Migration: access-model contract, part 1 (issue #44 items 1, 2, 6; D-5, D-17, D-36).
--
-- Writers (one per table). No table is created here; these are the tables altered or dropped:
--   portal.AccessGrant: portal
--   portal.Principal: portal
--   portal.BreakGlassConfig: portal (dropped by this migration, see below)
--
-- 1. Role/scope coherence: roles user, manager, executive, admin; scopes self, team, department, business_area, company.
--    Valid pairs: user -> self; manager -> self, team; executive -> department, business_area, company; admin -> company.
--    Enforced by CK_AccessGrant_role_scope; the TypeScript validator in shared/src/access.ts mirrors it.
-- 2. A grant needs a linked Entra object ID. AccessGrant.principal_entra_oid is NOT NULL and a composite foreign key
--    (principal_id, principal_entra_oid) -> Principal (principal_id, entra_object_id) makes a GitHub-only principal
--    (entra_object_id IS NULL) unable to hold a grant, and keeps the stored OID equal to the principal's OID.
-- 6. The break-glass Entra group ID is a deployment setting (key vault reference or app setting), not a table, so
--    portal.BreakGlassConfig is dropped. Assumption: no deployment has rows worth keeping; the group ID is re-supplied
--    through the setting.
--
-- Existing grants are backfilled from their principal. If any grant belongs to a GitHub-only principal, or violates the
-- role/scope pairs, the migration fails loudly (fail closed) instead of deleting or rewriting access data.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF COL_LENGTH(N'portal.AccessGrant', N'principal_entra_oid') IS NULL
ALTER TABLE portal.AccessGrant ADD principal_entra_oid UNIQUEIDENTIFIER NULL;
GO

UPDATE g
SET g.principal_entra_oid = p.entra_object_id
FROM portal.AccessGrant AS g
JOIN portal.Principal AS p ON p.principal_id = g.principal_id
WHERE g.principal_entra_oid IS NULL;
GO

IF EXISTS (SELECT 1 FROM portal.AccessGrant WHERE principal_entra_oid IS NULL)
THROW 50044, N'AccessGrant rows exist for principals without an Entra object ID; resolve them manually before migrating (issue #44).', 1;
GO

IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'portal.AccessGrant') AND name = N'principal_entra_oid' AND is_nullable = 1)
ALTER TABLE portal.AccessGrant ALTER COLUMN principal_entra_oid UNIQUEIDENTIFIER NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_Principal_id_entra' AND parent_object_id = OBJECT_ID(N'portal.Principal'))
ALTER TABLE portal.Principal ADD CONSTRAINT UQ_Principal_id_entra UNIQUE (principal_id, entra_object_id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_AccessGrant_principal_entra' AND parent_object_id = OBJECT_ID(N'portal.AccessGrant'))
ALTER TABLE portal.AccessGrant ADD CONSTRAINT FK_AccessGrant_principal_entra
    FOREIGN KEY (principal_id, principal_entra_oid) REFERENCES portal.Principal (principal_id, entra_object_id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_AccessGrant_role_scope' AND parent_object_id = OBJECT_ID(N'portal.AccessGrant'))
ALTER TABLE portal.AccessGrant WITH CHECK ADD CONSTRAINT CK_AccessGrant_role_scope CHECK (
    (role = 'user' AND scope = 'self')
    OR (role = 'manager' AND scope IN ('self', 'team'))
    OR (role = 'executive' AND scope IN ('department', 'business_area', 'company'))
    OR (role = 'admin' AND scope = 'company')
);
GO

-- Self, team and company grants carry no scope value; department and business_area keep CK_AccessGrant_value (non-empty).
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_AccessGrant_value_empty' AND parent_object_id = OBJECT_ID(N'portal.AccessGrant'))
ALTER TABLE portal.AccessGrant WITH CHECK ADD CONSTRAINT CK_AccessGrant_value_empty CHECK (scope IN ('department', 'business_area') OR scope_value = N'');
GO

-- Event order between grants and directory revocations is compared on these timestamps, so keep sub-second precision
-- (a tie still fails closed in portal.v_active_grant).
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'portal.AccessGrant') AND name = N'granted_at' AND scale < 7)
BEGIN
    DECLARE @df SYSNAME = (SELECT dc.name FROM sys.default_constraints AS dc JOIN sys.columns AS c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id WHERE dc.parent_object_id = OBJECT_ID(N'portal.AccessGrant') AND c.name = N'granted_at');
    IF @df IS NOT NULL EXEC (N'ALTER TABLE portal.AccessGrant DROP CONSTRAINT ' + @df);
    ALTER TABLE portal.AccessGrant ALTER COLUMN granted_at DATETIME2(7) NOT NULL;
    ALTER TABLE portal.AccessGrant ADD CONSTRAINT DF_AccessGrant_granted DEFAULT SYSUTCDATETIME() FOR granted_at;
END
GO
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'portal.AccessGrant') AND name = N'revoked_at' AND scale < 7)
BEGIN
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AccessGrant_active' AND object_id = OBJECT_ID(N'portal.AccessGrant'))
    DROP INDEX IX_AccessGrant_active ON portal.AccessGrant;
    ALTER TABLE portal.AccessGrant ALTER COLUMN revoked_at DATETIME2(7) NULL;
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AccessGrant_active' AND object_id = OBJECT_ID(N'portal.AccessGrant'))
CREATE INDEX IX_AccessGrant_active ON portal.AccessGrant (principal_id) WHERE revoked_at IS NULL;
GO

IF OBJECT_ID(N'portal.BreakGlassConfig', N'U') IS NOT NULL
DROP TABLE portal.BreakGlassConfig;
GO
