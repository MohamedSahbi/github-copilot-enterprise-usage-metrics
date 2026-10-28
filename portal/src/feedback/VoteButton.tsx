"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function VoteButton({ itemId, votes }: { itemId: number; votes: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function toggle() {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/feedback/${itemId}/vote`, { method: "POST" });
      if (!response.ok) throw new Error("Your vote could not be saved. Please try again.");
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Your vote could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button type="button" disabled={pending} onClick={toggle}
        aria-label={`Toggle vote for feedback ${itemId}`}
        className="rounded border border-default px-3 py-2 text-sm disabled:opacity-50">
        {pending ? "Saving..." : `Vote / unvote (${votes})`}
      </button>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
