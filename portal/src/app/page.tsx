import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-semibold">GitHub Copilot Usage Metrics</h1>
      <p className="mt-2">Phase 1 skeleton. No business features yet.</p>
      <p className="mt-4">
        <Link className="underline" href="/poc/feature-adoption">
          Submodule proof of concept: Feature Adoption chart
        </Link>
      </p>
    </main>
  );
}
