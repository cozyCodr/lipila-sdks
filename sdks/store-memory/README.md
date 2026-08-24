# `@cozycodr/lipila-store-memory`

An in-process `PaymentLifecycleStore` for tests and local examples. It is not durable and must not be used for production payments.

```ts
import { memoryPaymentStore } from "@cozycodr/lipila-store-memory";

const store = memoryPaymentStore({ namespace: "lipila:sandbox:merchant-123" });
```

`migrate()` and `close()` are no-ops. State is lost when the process exits and is not shared between processes.
