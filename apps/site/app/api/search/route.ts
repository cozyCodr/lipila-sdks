import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// Static export: build a search index served as a static file, searched
// client-side with Orama (no server runtime).
export const revalidate = false;
export const dynamic = "force-static";

export const { staticGET: GET } = createFromSource(source, {
  language: "english",
});
