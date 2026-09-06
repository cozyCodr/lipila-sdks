"use client";

import { useState } from "react";

export function CopyInstall({ command = "npm i @cozycodr/lipila" }: { command?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable; ignore
    }
  }

  return (
    <button type="button" className="lp-copy" onClick={copy} aria-label="Copy install command">
      <b>$</b>
      <span className="lp-copy__cmd">{command}</span>
      <span className="lp-copy__hint">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
