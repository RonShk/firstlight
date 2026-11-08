import type { Metadata } from "next";
import { Source_Sans_3 } from "next/font/google";
import "./globals.css";
import { AppHeader } from "@/components/claims/app-header";
import { ClaimsProvider } from "@/components/claims/claims-provider";

const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "State Farm Claims",
  description: "Triage every policyholder's claim by urgency, with the policy documents that apply.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sourceSans.variable} h-full antialiased`}>
      <body className="flex h-dvh flex-col overflow-hidden">
        <ClaimsProvider>
          <AppHeader />
          {children}
        </ClaimsProvider>
      </body>
    </html>
  );
}
