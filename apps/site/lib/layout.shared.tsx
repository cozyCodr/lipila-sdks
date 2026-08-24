import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "Lipila SDK",
    },
    githubUrl: "https://github.com/cozyCodr/lipila-sdks",
    // Light-only Ledger look: no theme switch.
    themeSwitch: { enabled: false },
  };
}
