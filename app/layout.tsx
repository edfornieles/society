import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Society — Realtime Voice Starter",
  description: "Realtime voice improv worldbuilding with an AI friend.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
