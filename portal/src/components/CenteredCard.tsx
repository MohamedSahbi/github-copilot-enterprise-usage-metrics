import type { ReactNode } from "react";

export type CenteredCardTone = "brand" | "danger" | "attention";

const TONE_CLASSES: Record<CenteredCardTone, string> = {
  brand: "bg-[#24292f] text-white",
  danger: "bg-[#ffebe9] text-[#d1242f]",
  attention: "bg-[#fff8c5] text-[#9a6700]",
};

export function GitHubMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" height={size} width={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12.5.75C6.146.75 1 5.896 1 12.25c0 5.089 3.292 9.387 7.863 10.91.575.101.79-.244.79-.546 0-.273-.014-1.178-.014-2.142-2.889.532-3.636-.704-3.866-1.35-.13-.331-.69-1.352-1.18-1.625-.402-.216-.977-.748-.014-.762.906-.014 1.553.834 1.769 1.179 1.035 1.74 2.688 1.25 3.349.948.1-.747.402-1.25.733-1.538-2.559-.287-5.232-1.279-5.232-5.678 0-1.25.445-2.285 1.178-3.09-.115-.288-.517-1.467.115-3.048 0 0 .963-.302 3.163 1.179.92-.259 1.897-.388 2.875-.388.977 0 1.955.13 2.875.388 2.2-1.495 3.162-1.179 3.162-1.179.633 1.581.23 2.76.115 3.048.733.805 1.179 1.825 1.179 3.09 0 4.413-2.688 5.39-5.247 5.678.417.36.776 1.05.776 2.128 0 1.538-.014 2.774-.014 3.162 0 .302.216.662.79.547C20.709 21.637 24 17.324 24 12.25 24 5.896 18.854.75 12.5.75Z" />
    </svg>
  );
}

// Full-page centered card used by sign-in, no-access and outage pages.
export default function CenteredCard({
  title,
  description,
  icon,
  tone = "brand",
  footer,
  children,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  tone?: CenteredCardTone;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f6f8fa] px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-[#d1d9e0] bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <div className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full ${TONE_CLASSES[tone]}`}>
            {icon ?? <GitHubMark size={30} />}
          </div>
          <h1 className="text-2xl font-semibold text-[#1f2328]">{title}</h1>
          {description && <div className="mt-2 text-sm text-[#59636e]">{description}</div>}
        </div>
        {children}
        {footer && <div className="mt-6 text-center text-xs text-[#59636e]">{footer}</div>}
      </div>
    </main>
  );
}

export const primaryButtonClass =
  "flex w-full cursor-pointer items-center justify-center gap-3 rounded-lg bg-[#24292f] px-4 py-3 font-medium text-white shadow-sm transition-all duration-150 hover:bg-[#1a1e22] hover:shadow-md active:scale-[0.98] active:bg-[#13161a]";

export const secondaryButtonClass =
  "flex w-full cursor-pointer items-center justify-center gap-3 rounded-lg border border-[#d1d9e0] bg-white px-4 py-3 font-medium !text-[#1f2328] shadow-sm transition-all duration-150 hover:border-[#8c959f] hover:bg-[#f6f8fa] hover:shadow-md active:scale-[0.98]";

export const microsoftButtonClass =
  "flex w-full cursor-pointer items-center justify-center gap-3 rounded-lg bg-[#0078d4] px-4 py-3 font-medium text-white shadow-sm transition-all duration-150 hover:bg-[#005a9e] hover:shadow-md active:scale-[0.98] active:bg-[#004578]";
