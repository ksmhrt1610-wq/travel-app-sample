/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // next dev が AGENTS.md / CLAUDE.md を自動生成しないようにする（このプロトタイプでは不要）
  agentRules: false,
};

export default nextConfig;
