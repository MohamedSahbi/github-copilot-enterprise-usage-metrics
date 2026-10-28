import Link from "next/link";
import CenteredCard, { primaryButtonClass } from "@/components/CenteredCard";

function WarningIcon() {
  return (
    <svg aria-hidden="true" focusable="false" className="h-7 w-7" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
    </svg>
  );
}

export default function ServiceUnavailablePage() {
  return (
    <CenteredCard
      title="Service unavailable"
      tone="danger"
      icon={<WarningIcon />}
      description={<>
        <p>Permissions cannot be verified right now. No data has been made available.</p>
        <p className="mt-2">Please try again later.</p>
      </>}
      footer={<Link className="underline underline-offset-2" href="/help#why-is-the-service-unavailable">Help / FAQ: Why is the service unavailable?</Link>}
    >
      <Link className={`${primaryButtonClass} !text-white`} href="/">Try again</Link>
    </CenteredCard>
  );
}
