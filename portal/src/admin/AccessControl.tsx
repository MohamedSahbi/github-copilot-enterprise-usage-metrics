"use client";

import { useState, type FormEvent } from "react";
import type {
  AdminGrant, AdminGrantFormData, AdminPrincipalSummary, ApiResponse, AdminGrantChangeRequest,
} from "../../../shared/src/api";
import type { Role, Scope } from "../../../shared/src/rows";
import { validateGrantRequest } from "../../../shared/src/access";
import {
  alertClass, buttonClass, Card, dangerActionClass, DataTable, fieldClass, primaryActionClass, statusClass,
} from "../components/SubPageFrame";

async function mutate(path: string, method: string, body: unknown): Promise<ApiResponse<AdminGrant>> {
  const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${result.error?.code ?? "request_failed"} (reference ${result.error?.correlationId ?? "unavailable"})`);
  return result;
}

export default function AccessControl({
  formData, principals, grants, principalId,
}: {
  formData: AdminGrantFormData; principals: AdminPrincipalSummary[]; grants: AdminGrant[]; principalId: string;
}) {
  const [showForm, setShowForm] = useState(false);
  const [role, setRole] = useState<Role>("user");
  const [scope, setScope] = useState<Scope>("self");
  const [scopeValue, setScopeValue] = useState("");
  const [oid, setOid] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [rows, setRows] = useState(grants);
  const scopes = formData.roleScopes[role].filter((value) => formData.enabledScopes.includes(value));

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(""); setMessage("");
    const request = { principalEntraObjectId: oid, role, scope, scopeValue };
    const validation = validateGrantRequest(request, {
      enabledScopes: formData.enabledScopes, directoryValues: formData.scopeValues,
      // The form checks syntax only; the server establishes the stored identity.
      principalHasLinkedEntraId: true,
    });
    if (!validation.ok) { setError(validation.code); return; }
    setPending(true);
    try {
      const result = await mutate("/api/admin/grants", "POST", request);
      setMessage(`Grant ${result.data.grantId} created. Select the target principal to refresh its effective grants.`);
      setShowForm(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Grant failed."); }
    finally { setPending(false); }
  }

  async function revoke(grant: AdminGrant) {
    setPending(true); setError(""); setMessage("");
    try {
      const request: AdminGrantChangeRequest = { principalId, role: grant.role, scope: grant.scope, scopeValue: grant.scopeValue, action: "revoke" };
      await mutate("/api/admin/access", "POST", request);
      setRows(rows.filter(({ grantId }) => grantId !== grant.grantId));
      setConfirmation(null); setMessage("Access revoked.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Revocation failed."); }
    finally { setPending(false); }
  }

  return <section aria-label="Access Control" className="space-y-5">
    {error && <p role="alert" className={alertClass}>{error}</p>}
    {message && <p role="status" className={statusClass}>{message}</p>}
    <Card title="Access control" actions={<button type="button" className={showForm ? buttonClass : primaryActionClass} onClick={() => setShowForm(!showForm)}>
      {showForm ? "Cancel" : "Grant Access"}
    </button>}>
      <form className="flex flex-wrap items-center gap-3 text-sm" action="/admin">
        <input type="hidden" name="section" value="access" />
        <label htmlFor="principal" className="font-semibold">Existing principal</label>
        <select id="principal" name="principalId" defaultValue={principalId} className={fieldClass}>
          <option value="">Select a principal</option>
          {principalId && !principals.some((principal) => principal.principalId === principalId) &&
            <option value={principalId}>{principalId} (selected)</option>}
          {principals.map((principal) => <option key={principal.principalId} value={principal.principalId}>
            {principal.principalId} ({principal.status})
          </option>)}
        </select>
        <button type="submit" className={buttonClass}>Load grants</button>
      </form>
      <p className="text-sm text-muted">Permissions attach to an existing Entra principal, never an email or login. Principal creation is an operator workflow.</p>
    {showForm && <form onSubmit={save} className="flex flex-wrap items-end gap-4 rounded-md border border-default bg-[#f6f8fa] p-4 text-sm">
      <label className="grid gap-1">Entra object ID
        <input required value={oid} onChange={(event) => setOid(event.target.value)} className={fieldClass} />
      </label>
      <label className="grid gap-1">Role
        <select value={role} className={fieldClass} onChange={(event) => {
          const next = event.target.value as Role;
          setRole(next);
          setScope(formData.roleScopes[next].find((item) => formData.enabledScopes.includes(item)) ?? "self");
          setScopeValue("");
        }}>
          {Object.keys(formData.roleScopes).map((value) => <option key={value}>{value}</option>)}
        </select>
      </label>
      <label className="grid gap-1">Scope
        <select value={scope} className={fieldClass} onChange={(event) => { setScope(event.target.value as Scope); setScopeValue(""); }}>
          {scopes.map((value) => <option key={value}>{value}</option>)}
        </select>
      </label>
      {(scope === "department" || scope === "business_area") && <label className="grid gap-1">Scope value
        <select required value={scopeValue} onChange={(event) => setScopeValue(event.target.value)} className={fieldClass}>
          <option value="">Select a directory value</option>
          {formData.scopeValues[scope].map((value) => <option key={value}>{value}</option>)}
        </select>
      </label>}
      <button type="submit" disabled={pending || scopes.length === 0} className={primaryActionClass}>{pending ? "Saving..." : "Save"}</button>
    </form>}
    <DataTable caption="Effective access grants" empty="No effective access grants found for this selection." headings={["Grant", "Role", "Scope", "Value", "Actions"]}
      rows={rows.map((grant) => [grant.grantId, grant.role, grant.scope, grant.scopeValue || "-",
        confirmation === grant.grantId
          ? <span className="flex gap-2"><button className={dangerActionClass} disabled={pending} onClick={() => revoke(grant)}>Confirm revoke</button>
            <button className={buttonClass} disabled={pending} onClick={() => setConfirmation(null)}>Cancel</button></span>
          : <button className={dangerActionClass} disabled={pending} onClick={() => setConfirmation(grant.grantId)}>Revoke</button>])} />
    </Card>
  </section>;
}
