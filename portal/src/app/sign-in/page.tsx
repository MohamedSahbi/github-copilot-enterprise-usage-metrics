import { signIn } from "@/auth/config";
import { isTestAuthEnabled, TEST_PERSONAS } from "@/auth/test-auth";
import CenteredCard, { microsoftButtonClass, primaryButtonClass, secondaryButtonClass, GitHubMark } from "@/components/CenteredCard";

function MicrosoftLogo() {
  return (
    <svg aria-hidden="true" focusable="false" className="h-5 w-5" viewBox="0 0 21 21" fill="none">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

export default function SignInPage() {
  return (
    <CenteredCard
      title="GitHub Copilot Usage Metrics"
      description="Sign in to view your GitHub Copilot usage metrics."
      footer="Your access level determines which metrics you can view. Contact your administrator for elevated access."
    >
      <div className="space-y-3">
        <form action={async () => {
          "use server";
          await signIn("microsoft-entra-id", { redirectTo: "/" });
        }}>
          <button className={microsoftButtonClass} type="submit">
            <MicrosoftLogo />
            Sign in with Microsoft Entra ID
          </button>
        </form>
        <form action={async () => {
          "use server";
          await signIn("github", { redirectTo: "/" });
        }}>
          <button className={primaryButtonClass} type="submit">
            <GitHubMark size={20} />
            Sign in with GitHub
          </button>
        </form>
      </div>
      {isTestAuthEnabled() && (
        <div className="mt-6 border-t border-[#d1d9e0] pt-4">
          <p className="mb-3 text-center text-xs font-medium uppercase tracking-wide text-[#59636e]">Test personas</p>
          <div className="space-y-2">
            {Object.entries(TEST_PERSONAS).map(([id, label]) => (
              <form key={id} action={async () => {
                "use server";
                await signIn("test-persona", { persona: id, redirectTo: "/" });
              }}>
                <button className={`${secondaryButtonClass} py-2 text-sm`} type="submit">Sign in as {label}</button>
              </form>
            ))}
          </div>
        </div>
      )}
    </CenteredCard>
  );
}
