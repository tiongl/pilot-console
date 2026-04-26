import NextAuth from 'next-auth';
import { authConfig } from './auth.config';
import { NextResponse } from 'next/server';

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (!req.auth) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  if (pathname.startsWith('/admin') && req.auth.user?.role !== 'admin') {
    return NextResponse.redirect(new URL('/', req.url));
  }

  return NextResponse.next();
});

export const config = {
  // Protect all routes except NextAuth API, static files, and login
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico|login).*)'],
};
