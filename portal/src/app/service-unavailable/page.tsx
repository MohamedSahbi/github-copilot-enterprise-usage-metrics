import Link from "next/link";

export default function ServiceUnavailablePage() {
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold">Service unavailable</h1>
      <p className="mt-2">Permissions cannot be verified right now. No data has been made available.</p>
      <p className="mt-4">Please try again later.</p>
      <Link className="mt-4 inline-block underline" href="/">Try again</Link>
    </main>
  );
}
