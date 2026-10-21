import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The engine, adapters, db and jobs packages are TypeScript sources inside the workspace.
  transpilePackages: ["@payroll-qa/engine", "@payroll-qa/adapters", "@payroll-qa/db", "@payroll-qa/jobs", "@payroll-qa/profile-builder"],
  serverExternalPackages: ["postgres", "pdf-lib", "unpdf", "mammoth"],
  poweredByHeader: false,
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "no-store" },
      ],
    },
  ],
};

export default nextConfig;
