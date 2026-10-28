"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

// Submit button for server-action forms: shows a spinner and blocks double submits while the action runs.
export default function SubmitButton({
  className,
  pendingLabel,
  children,
}: {
  className: string;
  pendingLabel: string;
  children: ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button className={className} type="submit" disabled={pending} aria-busy={pending || undefined}>
      {pending ? (
        <>
          <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          {pendingLabel}
        </>
      ) : children}
    </button>
  );
}
