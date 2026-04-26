import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { authConfig } from '../auth.config';
import { upsertUser } from './user-store';
import { getGitHubCliProfile } from './gh-cli-auth';

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      id: 'github-cli',
      name: 'GitHub CLI',
      credentials: {},
      async authorize() {
        const profile = await getGitHubCliProfile();
        if (!profile) return null;
        const user = upsertUser(
          String(profile.id),
          profile.login,
          profile.email ?? null,
          profile.name ?? null,
        );
        return {
          id: user.id,
          name: user.displayName ?? user.githubLogin,
          email: user.email,
          image: profile.avatar_url,
        };
      },
    }),
  ],
  session: { strategy: 'jwt' },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
        // role is set during upsert; fetch it
        const stored = (await import('./user-store')).getUserById(user.id!);
        token.role = stored?.role ?? 'user';
        token.githubId = stored?.githubId;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.userId) session.user.id = token.userId as string;
      if (token.role) session.user.role = token.role as string;
      return session;
    },
  },
});
