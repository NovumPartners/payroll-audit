import type { ReactNode } from "react";
import "./globals.css";
import { currentUser } from "@/lib/auth";

export const metadata = { title: "Payroll QA", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a href="/"><strong>Payroll QA</strong></a>
          {user && (
            <>
              <a href="/">Queue</a>
              <a href="/clients">Clients</a>
              <a href="/inbox">Inbox</a>
              {user.role === "lead" && <a href="/admin">Admin</a>}
              <span className="who">{user.name} · {user.role} · <a href="/auth/signout">sign out</a></span>
            </>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
