// A directory person shown by name and email, with the Entra object ID as secondary detail.
export function personText({ displayName, email, id }: { displayName: string | null; email: string | null; id: string | null }) {
  const name = displayName ?? email;
  if (!name) return id ?? "Unknown";
  return email && email !== name ? `${name} (${email})` : name;
}

export default function PersonLabel({ displayName, email, id }: { displayName: string | null; email: string | null; id: string | null }) {
  if (!displayName && !email) return id ? <code className="font-mono text-xs">{id}</code> : <>-</>;
  return (
    <span className="grid">
      <span className="font-medium text-[#1f2328]">{displayName ?? email}</span>
      {displayName && email && <span className="text-xs text-muted">{email}</span>}
      {id && <code className="whitespace-nowrap font-mono text-[11px] text-muted" title="Entra object ID">{id}</code>}
    </span>
  );
}
