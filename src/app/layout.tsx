import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Code Editor",
  description: "Four models solve the same problem independently, then get compared.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
