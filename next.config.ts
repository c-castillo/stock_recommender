import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["whatsapp-web.js", "puppeteer", "better-sqlite3"],
};

export default nextConfig;
