import Link from "next/link";
import { CopyInstall } from "@/components/copy-install";
import { TypingCompare } from "@/components/typing-compare";

export default function HomePage() {
  return (
    <div className="lp">
      <section className="lp-hero">
        <h1>Everything the raw Lipila API leaves to you, handled.</h1>
        <p>
          Verifying a webhook correctly is the part most integrations get subtly wrong. Below is the
          signature check written properly by hand, and the same thing with the SDK.
        </p>
        <div className="lp-btns">
          <Link className="lp-primary" href="/docs">
            Read the docs
          </Link>
          <CopyInstall />
        </div>
      </section>

      <TypingCompare />

      <section className="lp-values">
        <h2>Why one shared SDK beats a fresh integration on every project.</h2>
        <div className="lp-vgrid">
          <div className="lp-vitem">
            <div className="lab">Safety</div>
            <h3>Mutations never auto-retry</h3>
            <p>
              An interrupted charge is an unknown outcome. The SDK asks you to reconcile by reference
              rather than charging a customer twice.
            </p>
          </div>
          <div className="lp-vitem">
            <div className="lab">Written once</div>
            <h3>Reused everywhere</h3>
            <p>
              The webhook plumbing, idempotency, and state handling you would rewrite per project
              live in one tested package.
            </p>
          </div>
          <div className="lp-vitem">
            <div className="lab">Proven</div>
            <h3>Durability you can trust</h3>
            <p>
              The PostgreSQL adapter runs a shared conformance suite against a real database in CI,
              so persistence behaves the same everywhere.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
