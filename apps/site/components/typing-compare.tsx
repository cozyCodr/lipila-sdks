"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Token = [string, string];

const DIY: Token[] = [
  ["import", "kw"], [" { createHmac, timingSafeEqual } ", ""], ["from", "kw"], [" ", ""], ['"node:crypto"', "st"], [";\n\n", ""],
  ["// You reimplement Lipila's whole signing scheme\n", "cm"],
  ["app.", ""], ["post", "fn"], ["(", ""], ['"/webhooks/lipila"', "st"], [", raw, ", ""], ["async", "kw"], [" (req, res) => {\n", ""],
  ["  ", ""], ["const", "kw"], [" id  = req.", ""], ["get", "fn"], ["(", ""], ['"webhook-id"', "st"], [");\n", ""],
  ["  ", ""], ["const", "kw"], [" ts  = req.", ""], ["get", "fn"], ["(", ""], ['"webhook-timestamp"', "st"], [");\n", ""],
  ["  ", ""], ["const", "kw"], [" sig = req.", ""], ["get", "fn"], ["(", ""], ['"webhook-signature"', "st"], [");\n", ""],
  ["  ", ""], ["if", "kw"], [" (!id || !ts || !sig) ", ""], ["return", "kw"], [" res.", ""], ["sendStatus", "fn"], ["(", ""], ["400", "nm"], [");\n\n", ""],
  ["  // reject events outside the 5 minute window\n", "cm"],
  ["  ", ""], ["if", "kw"], [" (Math.", ""], ["abs", "fn"], ["(Date.", ""], ["now", "fn"], ["() / ", ""], ["1000", "nm"], [" - ", ""], ["Number", "fn"], ["(ts)) > ", ""], ["300", "nm"], [")\n", ""],
  ["    ", ""], ["return", "kw"], [" res.", ""], ["sendStatus", "fn"], ["(", ""], ["400", "nm"], [");\n\n", ""],
  ["  // secret is base64, sometimes whsec_ prefixed, 32 bytes\n", "cm"],
  ["  ", ""], ["const", "kw"], [" key = Buffer.", ""], ["from", "fn"], ["(secret.", ""], ["replace", "fn"], ["(/^whsec_/, ", ""], ['""', "st"], ["), ", ""], ['"base64"', "st"], [");\n", ""],
  ["  ", ""], ["const", "kw"], [" want = ", ""], ["createHmac", "fn"], ["(", ""], ['"sha256"', "st"], [", key)\n", ""],
  ["    .", ""], ["update", "fn"], ["(", ""], ["`${id}.${ts}.${req.body}`", "st"], [")  ", ""], ["// RAW bytes\n", "cm"],
  ["    .", ""], ["digest", "fn"], ["();\n\n", ""],
  ["  // the header may carry several space-separated v1 signatures\n", "cm"],
  ["  ", ""], ["const", "kw"], [" ok = sig.", ""], ["split", "fn"], ["(", ""], ['" "', "st"], [").", ""], ["some", "fn"], ["((s) => {\n", ""],
  ["    ", ""], ["const", "kw"], [" got = Buffer.", ""], ["from", "fn"], ["(s.", ""], ["replace", "fn"], ["(/^v1,/, ", ""], ['""', "st"], ["), ", ""], ['"base64"', "st"], [");\n", ""],
  ["    ", ""], ["return", "kw"], [" got.length === ", ""], ["32", "nm"], [" && ", ""], ["timingSafeEqual", "fn"], ["(want, got);\n", ""],
  ["  });\n", ""],
  ["  ", ""], ["if", "kw"], [" (!ok) ", ""], ["return", "kw"], [" res.", ""], ["sendStatus", "fn"], ["(", ""], ["400", "nm"], [");\n\n", ""],
  ["  // dedupe by id so retries never double-fulfil\n", "cm"],
  ["  ", ""], ["if", "kw"], [" (", ""], ["await", "kw"], [" store.", ""], ["seen", "fn"], ["(id)) ", ""], ["return", "kw"], [" res.", ""], ["sendStatus", "fn"], ["(", ""], ["200", "nm"], [");\n", ""],
  ["  ", ""], ["await", "kw"], [" store.", ""], ["markSeen", "fn"], ["(id, { ttlHours: ", ""], ["24", "nm"], [" });\n\n", ""],
  ["  // ...and interrupted charges still need reconciling by hand\n", "cm"],
  ["  ", ""], ["await", "kw"], [" ", ""], ["fulfil", "fn"], ["(JSON.", ""], ["parse", "fn"], ["(req.body));\n", ""],
  ["  res.", ""], ["sendStatus", "fn"], ["(", ""], ["204", "nm"], [");\n", ""],
  ["});", ""],
];

const SDK: Token[] = [
  ["import", "kw"], [" { lipila } ", ""], ["from", "kw"], [" ", ""], ['"@cozycodr/lipila"', "st"], [";\n\n", ""],
  ["const", "kw"], [" client = ", ""], ["lipila", "fn"], ["({ apiKey, webhookSecret });\n\n", ""],
  ["app.", ""], ["post", "fn"], ["(", ""], ['"/webhooks/lipila"', "st"], [", raw, ", ""], ["async", "kw"], [" (req, res) => {\n", ""],
  ["  ", ""], ["const", "kw"], [" receipt = ", ""], ["await", "kw"], [" client.webhooks.", ""], ["handle", "fn"], ["({\n", ""],
  ["    rawBody: req.body,\n", ""],
  ["    headers: req.headers,\n", ""],
  ["  });\n\n", ""],
  ["  res.", ""], ["sendStatus", "fn"], ["(receipt.acknowledge ? ", ""], ["204", "nm"], [" : ", ""], ["500", "nm"], [");\n", ""],
  ["});\n\n", ""],
  ["// signatures, rotation, the replay window, and dedupe: built in", "cm"],
];

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function total(tokens: Token[]) {
  return tokens.reduce((n, t) => n + t[0].length, 0);
}
function lineCount(tokens: Token[]) {
  return (tokens.map((t) => t[0]).join("").match(/\n/g) || []).length + 1;
}
function html(tokens: Token[], shown: number, done: boolean) {
  let out = "";
  let used = 0;
  for (const [txt, cls] of tokens) {
    if (used >= shown) break;
    const take = Math.min(txt.length, shown - used);
    const slice = esc(txt.slice(0, take));
    out += cls ? `<span class="${cls}">${slice}</span>` : slice;
    used += take;
  }
  out += `<span class="lp-caret${done ? " blink" : ""}"></span>`;
  return out;
}

const DIY_TOTAL = total(DIY);
const SDK_TOTAL = total(SDK);
const MAX_TOTAL = Math.max(DIY_TOTAL, SDK_TOTAL);

export function TypingCompare() {
  const [shown, setShown] = useState(0);
  const [run, setRun] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setShown(MAX_TOTAL);
      return;
    }
    setShown(0);
    const interval = 30;
    const targetMs = 6000;
    const step = Math.max(1, Math.round(MAX_TOTAL / (targetMs / interval)));
    timer.current = setInterval(() => {
      setShown((s) => {
        const next = s + step;
        if (next >= MAX_TOTAL && timer.current) {
          clearInterval(timer.current);
          timer.current = null;
        }
        return next;
      });
    }, interval);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [run]);

  const replay = useCallback(() => setRun((r) => r + 1), []);

  return (
    <div className="lp-compare">
      <p className="lp-compare__label">
        <b>Verify one Lipila webhook.</b> Signatures, secret decoding, rotation, replay window, and
        dedupe.
      </p>
      <div className="lp-twin">
        <div className="lp-cbox">
          <div className="lp-cbar">
            <span className="fname">by-hand.ts</span>
            <span className="tag">JavaScript</span>
            <span className="status warn">you maintain this</span>
          </div>
          {/* biome-ignore lint: highlighted code is escaped in html() */}
          <pre dangerouslySetInnerHTML={{ __html: html(DIY, Math.min(shown, DIY_TOTAL), shown >= DIY_TOTAL) }} />
          <div className="lp-cfoot warn">
            <span className="k">{lineCount(DIY)} lines</span>
            <span>every edge case is now yours to keep correct</span>
          </div>
        </div>
        <div className="lp-cbox">
          <div className="lp-cbar">
            <span className="fname">with-lipila.ts</span>
            <span className="tag">JavaScript</span>
            <span className="status good">the SDK maintains this</span>
          </div>
          {/* biome-ignore lint: highlighted code is escaped in html() */}
          <pre dangerouslySetInnerHTML={{ __html: html(SDK, Math.min(shown, SDK_TOTAL), shown >= SDK_TOTAL) }} />
          <div className="lp-cfoot good">
            <span className="k">{lineCount(SDK)} lines</span>
            <span>verification, rotation, replay guard, and dedupe are built in</span>
          </div>
        </div>
      </div>
      <div className="lp-replay">
        <button type="button" onClick={replay}>
          Replay typing
        </button>
      </div>
    </div>
  );
}
