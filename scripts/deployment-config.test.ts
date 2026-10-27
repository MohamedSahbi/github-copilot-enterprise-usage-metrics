import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const keyvault = readFileSync(path.join(root, "infra/terraform/stack/keyvault.tf"), "utf8");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const dir of temporaryRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function check(source: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "deployment-config-"));
  temporaryRoots.push(dir);
  for (const subdirectory of ["scripts", "infra/terraform/stack", "pipelines", ".github/workflows"]) {
    mkdirSync(path.join(dir, subdirectory), { recursive: true });
  }
  cpSync(path.join(root, "scripts/check-e2e-auth-flag.sh"), path.join(dir, "scripts/check-e2e-auth-flag.sh"));
  writeFileSync(path.join(dir, "infra/terraform/stack/keyvault.tf"), source);
  return spawnSync("bash", ["scripts/check-e2e-auth-flag.sh"], { cwd: dir, encoding: "utf8" });
}

describe("deployment-config Key Vault grants", () => {
  it("allows exactly the configured user-only operator exception and per-secret runtime grants", () => {
    const result = check(keyvault);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each([
    ["runtime vault scope", 'format("%s/secrets/%s", module.key_vault.resource_id, each.key)', "module.key_vault.resource_id"],
    ["runtime officer role", '"Key Vault Secrets User"', '"Key Vault Secrets Officer"'],
    ["operator runtime identity", "principal_id         = each.value", 'principal_id         = module.identity["portal"].principal_id'],
    ["operator service principal", 'principal_type       = "User"', 'principal_type       = "ServicePrincipal"'],
    ["operator broad role", '"Key Vault Secrets Officer"', '"Owner"'],
    ["operator wrong scope", "scope                = module.key_vault.resource_id", "scope                = local.resource_group_id"],
    ["operator uncontrolled input", "toset([for id in var.key_vault_operator_object_ids : lower(id)])", "toset([var.organization.entra_tenant_id])"],
  ])("rejects %s", (_name, from, to) => {
    expect(keyvault).toContain(from);
    const result = check(keyvault.replace(from, to));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Only per-secret runtime Secrets User");
  });

  it("rejects additional vault-scoped assignments", () => {
    const result = check(`${keyvault}
resource "azurerm_role_assignment" "extra" {
  scope = module.key_vault.resource_id
  role_definition_name = "Key Vault Secrets User"
  principal_id = "00000000-0000-0000-0000-000000000001"
}
`);
    expect(result.status).toBe(1);
  });
});
