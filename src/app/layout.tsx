import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SimProvider } from "@/components/sim/sim-provider";
import { TopBar } from "@/components/sim/top-bar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "No One Left Behind · Catastrophe response",
  description: "Reach every policyholder after a disaster, triage by urgency, and get help moving.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <SimProvider>
          <TopBar />
          <main className="flex flex-1 flex-col">{children}</main>
        </SimProvider>
      </body>
    </html>
  );
}
