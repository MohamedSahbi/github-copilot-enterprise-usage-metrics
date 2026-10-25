import { signIn } from "@/auth/config";
import { isTestAuthEnabled, TEST_PERSONAS } from "@/auth/test-auth";

export default function SignInPage() {
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-2">Sign in to GitHub Copilot Usage Metrics.</p>
      <form className="mt-4" action={async () => {
        "use server";
        await signIn("microsoft-entra-id", { redirectTo: "/" });
      }}>
        <button className="underline" type="submit">Sign in with Microsoft Entra ID</button>
      </form>
      <form className="mt-4" action={async () => {
        "use server";
        await signIn("github", { redirectTo: "/" });
      }}>
        <button className="underline" type="submit">Sign in with GitHub</button>
      </form>
      {isTestAuthEnabled() && Object.entries(TEST_PERSONAS).map(([id, label]) => (
        <form className="mt-4" key={id} action={async () => {
          "use server";
          await signIn("test-persona", { persona: id, redirectTo: "/" });
        }}>
          <button className="underline" type="submit">Sign in as {label}</button>
        </form>
      ))}
    </main>
  );
}
