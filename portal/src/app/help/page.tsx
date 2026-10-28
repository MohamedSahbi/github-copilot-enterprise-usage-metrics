import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import SideNavCard from "@/components/SideNavCard";
import SubPageFrame from "@/components/SubPageFrame";

export const dynamic = "force-static";
export const metadata = { title: "Help / FAQ | GitHub Copilot Usage Metrics" };

const slug = (text: ReactNode) => String(text).toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/-$/, "");

export default async function HelpPage() {
  const cwd = process.cwd();
  const root = basename(cwd) === "portal" ? resolve(cwd, "..") : cwd;
  const content = await readFile(resolve(root, "docs/portal-faq.md"), "utf8");
  // "On this page" links, built from the same headings and ids the Markdown renders.
  const toc = [...content.matchAll(/^(#{2,3}) (.+)$/gm)].map(([, level, text]) => ({
    href: `#${slug(text)}`, label: text, depth: level.length as 2 | 3,
  }));

  return (
    <SubPageFrame nav={<div className="hidden lg:block lg:h-full"><SideNavCard label="On this page" heading="On this page"
      items={toc.map(({ href, label, depth }) => ({ href, label, depth: depth === 2 ? 1 : 2 }))} /></div>}>
      <article className="faq rounded-md border border-default bg-white px-6 py-8 shadow-sm sm:px-10">
        <Markdown
          remarkPlugins={[remarkGfm]}
          urlTransform={(url) => defaultUrlTransform(
            url.startsWith("architecture/")
              ? `https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/blob/main/docs/${url}`
              : url,
          )}
          components={{
            h2: ({ children, id }) => <h2 id={id ?? slug(children)}>{children}</h2>,
            h3: ({ children }) => <h3 id={slug(children)}>{children}</h3>,
          }}
        >
          {content}
        </Markdown>
      </article>
    </SubPageFrame>
  );
}
