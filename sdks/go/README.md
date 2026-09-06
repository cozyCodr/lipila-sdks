# Lipila Go SDK

A community Go SDK for the [Lipila](https://lipila.io) payments platform. It
covers mobile-money and card collections, status lookup, and webhook signature
verification, and it imports only the Go standard library.

This is an unofficial SDK. It is not affiliated with or endorsed by Lipila.

## Install

```bash
go get github.com/cozyCodr/lipila-go
```

## Quick start

```go
package main

import (
	"context"
	"errors"
	"log"
	"os"

	lipila "github.com/cozyCodr/lipila-go"
)

func main() {
	client, err := lipila.New(lipila.Config{
		APIKey:        os.Getenv("LIPILA_API_KEY"),
		Environment:   lipila.Sandbox,
		WebhookSecret: os.Getenv("LIPILA_WEBHOOK_SECRET"),
	})
	if err != nil {
		log.Fatal(err)
	}

	result, err := client.Payments.MobileMoney.Create(context.Background(),
		lipila.MobileMoneyPaymentRequest{
			ReferenceID:   "order-123",
			Amount:        100,
			Narration:     "Order 123",
			AccountNumber: "260971234567",
		})
	if err != nil {
		var unknown *lipila.UnknownOutcomeError
		if errors.As(err, &unknown) {
			// Lipila may have received the request. Do not resubmit;
			// reconcile with Payments.Retrieve using unknown.ReferenceID.
		}
		log.Fatal(err)
	}
	log.Printf("payment %s is %s", result.SubmittedReferenceID, result.Payment.Status)
}
```

The customer receives a PIN prompt on their phone. Poll for the outcome:

```go
transaction, err := client.Payments.Retrieve(ctx, "order-123",
	&lipila.RetrieveOptions{MaxAttempts: 3})
```

## Verify webhooks

Lipila signs webhooks over the raw request bytes, so hand `Verify` the body
exactly as received:

```go
func handleWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	event, err := client.Webhooks.Verify(body, r.Header)
	if err != nil {
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}
	if event.Shape == lipila.ShapeTransaction {
		// event.Transaction.Status is "Successful" or "Failed".
	}
	w.WriteHeader(http.StatusOK)
}
```

`Verify` enforces the full documented scheme: constant-time HMAC-SHA256 over
`{id}.{timestamp}.{body}`, a five-minute timestamp tolerance, multiple
signatures per delivery, and multiple configured secrets for rotation. Persist
`event.ID` to deduplicate redeliveries.

## Payment safety

The SDK never retries a payment mutation automatically. When a create request
is interrupted after it may have reached Lipila (a transport fault, a timeout,
or a 5xx), it returns `*UnknownOutcomeError` carrying the submitted
`ReferenceID`. Reconcile with `Payments.Retrieve` before acting again;
resubmitting blindly can charge a customer twice.

Status reads are side-effect free and may retry: opt in per call with
`RetrieveOptions.MaxAttempts` (2 through 6).

Errors are structured. Every SDK error is a `*lipila.Error` (or one of the two
specialized types) exposing `Code`, `Operation`, `Outcome`, `NextStep`, and
`HTTPStatus`, and never containing your API key or webhook secret.

## Architecture

Design decisions and their rationale are recorded in [DESIGN.md](DESIGN.md).
The language-neutral behavioral contract lives in the
[`spec/` directory of the SDK monorepo](https://github.com/cozyCodr/lipila-sdks/tree/main/spec).

## Requirements

- Go 1.23 or newer
- Server-side use only. The API key grants direct account access and must
  never ship in client-side code.
