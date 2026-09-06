package wire

import (
	"errors"
	"testing"

	"github.com/cozyCodr/lipila-go/internal/fault"
)

func TestParseTransactionTolerance(t *testing.T) {
	t.Run("full body", func(t *testing.T) {
		body := []byte(`{
			"referenceId": "ref-1",
			"currency": "ZMW",
			"amount": 1,
			"accountNumber": "260000000000",
			"status": "Successful",
			"paymentType": "AirtelMoney",
			"type": "Collection",
			"identifier": "LPLXC-1",
			"externalId": "MP1",
			"message": "Transaction is successful.",
			"narration": "test",
			"unknownFutureField": {"kept": true}
		}`)
		transaction, err := ParseTransaction(body, fault.OpRetrievePayment)
		if err != nil {
			t.Fatalf("parseTransaction failed: %v", err)
		}
		if transaction.Status != "Successful" || transaction.ExternalID != "MP1" ||
			transaction.Amount != 1 {
			t.Errorf("unexpected transaction: %+v", transaction)
		}
		if string(transaction.Raw) != string(body) {
			t.Error("Raw does not preserve the provider body verbatim")
		}
	})

	t.Run("wrongly typed fields degrade to absent", func(t *testing.T) {
		body := []byte(`{"status": "Pending", "amount": "1", "referenceId": 42, "externalId": null}`)
		transaction, err := ParseTransaction(body, fault.OpRetrievePayment)
		if err != nil {
			t.Fatalf("parseTransaction failed on tolerable body: %v", err)
		}
		if transaction.Amount != 0 || transaction.ReferenceID != "" || transaction.ExternalID != "" {
			t.Errorf("mis-typed fields should be zero values, got %+v", transaction)
		}
	})

	t.Run("unknown status passes through", func(t *testing.T) {
		transaction, err := ParseTransaction([]byte(`{"status": "Reversed"}`), fault.OpRetrievePayment)
		if err != nil {
			t.Fatalf("parseTransaction failed: %v", err)
		}
		if transaction.Status != "Reversed" {
			t.Errorf("Status = %q, want the provider value preserved", transaction.Status)
		}
	})

	t.Run("missing status rejects", func(t *testing.T) {
		_, err := ParseTransaction([]byte(`{"message": "ok"}`), fault.OpRetrievePayment)
		var typed *fault.Error
		if !errors.As(err, &typed) || typed.Code != fault.CodeInvalidResponse {
			t.Fatalf("err = %v, want *Error with fault.CodeInvalidResponse", err)
		}
		if typed.Outcome != fault.OutcomeNotApplicable || typed.NextStep != fault.NextRetryStatus {
			t.Errorf("read metadata = %q/%q, want not_applicable/retry_status", typed.Outcome, typed.NextStep)
		}
	})

	t.Run("mutation parse failure is an unknown outcome downstream", func(t *testing.T) {
		_, err := ParseTransaction([]byte(`not json`), fault.OpCreateMobileMoneyPayment)
		var typed *fault.Error
		if !errors.As(err, &typed) {
			t.Fatalf("err = %v, want *Error", err)
		}
		if typed.Outcome != fault.OutcomeUnknown || typed.NextStep != fault.NextReconcile {
			t.Errorf("mutation metadata = %q/%q, want unknown/reconcile_by_reference",
				typed.Outcome, typed.NextStep)
		}
	})
}
