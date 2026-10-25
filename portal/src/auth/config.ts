import NextAuth from "next-auth";
import type {} from "next-auth/jwt";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import GitHub from "next-auth/providers/github";
import type { Identity } from "../authz/access";
import { identityFromProfile } from "./identity";
import { testProviders } from "./test-auth";

declare module "next-auth" {
  interface Session { identity: Identity | null }
  interface User { tid?: string; oid?: string }
}
declare module "next-auth/jwt" {
  interface JWT { identity?: Identity | null }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      issuer: `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/v2.0`,
      authorization: { params: { scope: "openid profile email" } },
    }),
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
    }),
    ...testProviders(),
  ],
  pages: { signIn: "/sign-in" },
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  callbacks: {
    jwt({ token, account, profile, user }) {
      // Never consume session-update data: provider-verified claims are the only identity input.
      if (account) {
        token.identity = account.provider === "test-persona"
          ? identityFromProfile("microsoft-entra-id", { tid: user.tid, oid: user.oid }, process.env.ENTRA_TENANT_ID ?? "")
          : identityFromProfile(account.provider, profile ?? {}, process.env.ENTRA_TENANT_ID ?? "");
      }
      return token;
    },
    session({ session, token }) {
      session.identity = token.identity ?? null;
      return session;
    },
  },
  logger: {
    error() { console.error(JSON.stringify({ level: "error", event: "auth.failed" })); },
    warn(code) { console.warn(JSON.stringify({ level: "warn", event: "auth.warning", code })); },
  },
});
