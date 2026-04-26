import type { NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

// Edge-compatible auth config (no DB access here — authorize logic lives in lib/auth.ts)
export const authConfig: NextAuthConfig = {
  providers: [
    Credentials({
      id: 'github-cli',
      name: 'GitHub CLI',
      credentials: {},
      // authorize is overridden in lib/auth.ts (Node-only runtime)
      authorize: () => null,
    }),
  ],
  pages: {
    signIn: '/login',
  },
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user;
    },
  },
};
