import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tauri serves the app from a static bundle — no Node server at runtime.
  output: "export",
  images: { unoptimized: true },
  // Static export needs trailing slashes for the asset protocol to resolve.
  //
  // Dev is the exception: `next dev` registers its overlay endpoints without a
  // trailing slash (`/__nextjs_original-stack-frames`), so turning this on
  // globally makes every one of them 308 into a 404. The visible symptom is a
  // flood of `POST /__nextjs_original-stack-frames/ 404` in the terminal and
  // error overlays that can never resolve a source location.
  trailingSlash: process.env.NODE_ENV === "production",
};

export default nextConfig;
