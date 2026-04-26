import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native modules (better-sqlite3, ws) server-side only
  serverExternalPackages: ["better-sqlite3", "ws"],
};

export default nextConfig;
