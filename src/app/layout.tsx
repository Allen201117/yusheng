import type { ReactNode } from "react";
import AuthGuard from "@/components/AuthGuard";
import "./globals.css";

export const metadata = {
  title: "余声",
  description: "重新听到那个人的声音。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AuthGuard>{children}</AuthGuard>
      </body>
    </html>
  );
}
