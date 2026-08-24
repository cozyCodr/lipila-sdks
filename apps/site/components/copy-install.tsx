"use client";

import { useState } from "react";

const COMMAND = "npm i @cozycodr/lipila";

export function CopyInstall() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable; ignore
    }
  }

  return (
    <button type="button" className="lp-copy" onClick={copy} aria-label="Copy install command">
      <b>$</b>
      <span className="lp-copy__cmd">{COMMAND}</span>
      <span className="lp-copy__hint">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
