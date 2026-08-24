import { Banner } from "fumadocs-ui/components/banner";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import SearchDialog from "@/components/search";
import "./global.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://lipilasdk.oapps.dev"),
  title: {
    default: "Lipila SDK",
    template: "%s — Lipila SDK",
  },
  description:
    "An independent, community-built SDK for the Lipila payments platform. Payment safety, verified webhooks, and durable lifecycle handling, written once and reused.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider
          theme={{ enabled: false, defaultTheme: "light" }}
          search={{ SearchDialog }}
        >
          <Banner id="lipila-unofficial" className="text-fd-muted-foreground">
            <span className="lipila-banner__text">
              An independent, community-built SDK for the{" "}
              <strong className="text-fd-foreground">Lipila</strong> payments platform. Not
              affiliated with, or endorsed by, Lipila.
            </span>
          </Banner>
          {children}
          <footer className="lip-credit">
            <span>
              Developed by{" "}
              <a href="https://github.com/cozyCodr" target="_blank" rel="noreferrer">
                cozyCodr
              </a>
            </span>
            <span>Unofficial and community-built. Not affiliated with Lipila.</span>
            <span>MIT licensed.</span>
          </footer>
        </RootProvider>
      </body>
    </html>
  );
}
