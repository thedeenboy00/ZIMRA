/** @type {import('next').NextConfig} */
const nextConfig = {
  // Proxy all /api/* calls to the Render backend
  // This avoids CORS issues and keeps the API URL out of the browser bundle
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "https://zimra-pos-api.onrender.com";
    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },

  // Security headers
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options",  value: "nosniff" },
          { key: "X-Frame-Options",         value: "DENY" },
          { key: "X-XSS-Protection",        value: "1; mode=block" },
          { key: "Referrer-Policy",         value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;