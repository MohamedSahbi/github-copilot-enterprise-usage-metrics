import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import Link from "next/link";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

export const dynamic = "force-static";
export const metadata = { title: "Help / FAQ | GitHub Copilot Usage Metrics" };

export default async function HelpPage() {
  const cwd = process.cwd();
  const root = basename(cwd) === "portal" ? resolve(cwd, "..") : cwd;
  const content = await readFile(resolve(root, "docs/portal-faq.md"), "utf8");

  return (
    <main className="faq mx-auto max-w-3xl px-6 py-8">
      <Link href="/">Back to portal</Link>
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => defaultUrlTransform(
          url.startsWith("architecture/")
            ? `https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/blob/main/docs/${url}`
            : url,
        )}
        components={{
          h2: ({ children, id }) => <h2 id={id ?? String(children).toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/-$/, "")}>{children}</h2>,
          h3: ({ children }) => <h3 id={String(children).toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/-$/, "")}>{children}</h3>,
        }}
      >
        {content}
      </Markdown>
    </main>
  );
}
