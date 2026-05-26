/** @type {import('next').NextConfig} */
const nextConfig = {
  // App Router route handler 的 body 大小限制（默认无限制，但部分部署平台有）
  serverExternalPackages: ["better-sqlite3"],
};

module.exports = nextConfig;
