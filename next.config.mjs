/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    // The fluent-ffmpeg wrapper relies on dynamic require + native binary
    // bundled by @ffmpeg-installer/ffmpeg. Treat both as external so Next's
    // server compiler doesn't try to inline them.
    serverComponentsExternalPackages: [
      'fluent-ffmpeg',
      '@ffmpeg-installer/ffmpeg',
    ],
  },
};

export default nextConfig;