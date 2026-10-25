-- Migration: portal schema and migration history (D-34, §6.5)
-- Runner: postgrator, forward-only, run from scripts/ under an sp_getapplock wrapper
--         (resource 'portal-migrations', Exclusive, session-owned) so two pipeline runs never overlap.
-- Convention: this PR touches ONLY schema [portal]; never create or alter anything in dbo.
--
-- Writers (one per table):
--   portal.schema_version: migration-runner
--
-- postgrator expects (version, name, md5, run_at); the table is created here so it lives in portal, not dbo.

IF SCHEMA_ID(N'portal') IS NULL EXEC(N'CREATE SCHEMA portal');
GO

IF OBJECT_ID(N'portal.schema_version', N'U') IS NULL
CREATE TABLE portal.schema_version (
    version BIGINT       NOT NULL CONSTRAINT PK_schema_version PRIMARY KEY,
    name    VARCHAR(128) NULL,
    md5     VARCHAR(32)  NULL,
    run_at  DATETIME2(0) NULL
);
GO
