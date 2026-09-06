package fault

import (
	"errors"
	"strings"
	"testing"
)

func TestErrorStringsAndUnwrap(t *testing.T) {
	cause := errors.New("connection reset")

	t.Run("Error", func(t *testing.T) {
		err := &Error{
			Code:      CodeTransport,
			Operation: OpRetrievePayment,
			Message:   "the payment could not be retrieved from Lipila.",
			Err:       cause,
		}
		if !strings.Contains(err.Error(), string(OpRetrievePayment)) {
			t.Errorf("Error() = %q, want it to name the operation", err.Error())
		}
		if !errors.Is(err, cause) {
			t.Error("errors.Is does not reach the wrapped cause")
		}
	})

	t.Run("UnknownOutcomeError", func(t *testing.T) {
		err := &UnknownOutcomeError{
			ReferenceID: "order-1",
			Operation:   OpCreateCardPayment,
			Message:     "reconcile first.",
			Err:         cause,
		}
		text := err.Error()
		if !strings.Contains(text, `"order-1"`) || !strings.Contains(text, "outcome unknown") {
			t.Errorf("Error() = %q, want the referenceId and the ambiguity named", text)
		}
		if !errors.Is(err, cause) {
			t.Error("errors.Is does not reach the wrapped cause")
		}
	})

	t.Run("WebhookVerificationError", func(t *testing.T) {
		err := Verification(ReasonInvalidSignature, "the Lipila webhook signature is invalid.")
		if !strings.Contains(err.Error(), string(ReasonInvalidSignature)) {
			t.Errorf("Error() = %q, want the reason included", err.Error())
		}
		if errors.Unwrap(err) != nil {
			t.Error("constructor-built verification error should have no cause")
		}
	})
}

func TestValidationOutcomeDependsOnOperation(t *testing.T) {
	if got := Validation(OpCreateMobileMoneyPayment, "m").Outcome; got != OutcomeNotStarted {
		t.Errorf("mutation validation Outcome = %q, want not_started", got)
	}
	if got := Validation(OpRetrievePayment, "m").Outcome; got != OutcomeNotApplicable {
		t.Errorf("read validation Outcome = %q, want not_applicable", got)
	}
}

func TestIsMutation(t *testing.T) {
	for operation, want := range map[Operation]bool{
		OpCreateMobileMoneyPayment: true,
		OpCreateCardPayment:        true,
		OpRetrievePayment:          false,
		OpVerifyWebhook:            false,
	} {
		if got := operation.IsMutation(); got != want {
			t.Errorf("%s.IsMutation() = %v, want %v", operation, got, want)
		}
	}
}
