// Package fault defines the SDK's error model: structured codes, outcome
// metadata, and the three error types every operation returns. The root
// lipila package re-exports these under its own name, so callers never
// import this package directly.
package fault

import (
	"fmt"
	"time"
)

// Code classifies why an operation failed.
type Code string

const (
	// CodeConfiguration marks invalid client configuration detected by New.
	CodeConfiguration Code = "configuration_error"
	// CodeValidation marks caller input rejected before any request was sent.
	CodeValidation Code = "validation_error"
	// CodeAuthentication marks a 401 from Lipila: wrong key or wrong environment.
	CodeAuthentication Code = "authentication_error"
	// CodeForbidden marks a 403 from Lipila.
	CodeForbidden Code = "forbidden"
	// CodeNotFound marks a 404 from Lipila, such as an unknown referenceId.
	CodeNotFound Code = "not_found"
	// CodeRateLimited marks a 429 from Lipila.
	CodeRateLimited Code = "rate_limited"
	// CodeProvider marks any other HTTP rejection from Lipila.
	CodeProvider Code = "provider_error"
	// CodeInvalidResponse marks a response body the SDK could not interpret.
	CodeInvalidResponse Code = "invalid_response"
	// CodeTransport marks a network-level failure on a read operation.
	CodeTransport Code = "transport_error"
	// CodeCanceled marks a request stopped by the caller's context before dispatch.
	CodeCanceled Code = "canceled"
)

// Operation names the SDK call that produced an error.
type Operation string

const (
	OpCreateMobileMoneyPayment Operation = "create_mobile_money_payment"
	OpCreateCardPayment        Operation = "create_card_payment"
	OpRetrievePayment          Operation = "retrieve_payment"
	OpVerifyWebhook            Operation = "verify_webhook"
)

// IsMutation reports whether an operation can move money.
func (o Operation) IsMutation() bool {
	return o == OpCreateMobileMoneyPayment || o == OpCreateCardPayment
}

// Outcome states what is known about side effects when an error is returned.
// This is the field payment code must branch on: it says whether money may
// have moved.
type Outcome string

const (
	// OutcomeNotStarted means Lipila did not accept the request. Fixing the
	// input and submitting again is safe.
	OutcomeNotStarted Outcome = "not_started"
	// OutcomeNotApplicable means the operation had no financial side effects.
	OutcomeNotApplicable Outcome = "not_applicable"
	// OutcomeUnknown means Lipila may have accepted the request. Reconcile by
	// the submitted referenceId before acting again; see UnknownOutcomeError.
	OutcomeUnknown Outcome = "unknown"
)

// NextStep is the SDK's recommendation for what the caller should do.
type NextStep string

const (
	NextFixRequest  NextStep = "fix_request"
	NextRetryStatus NextStep = "retry_status"
	NextReconcile   NextStep = "reconcile_by_reference"
	NextDoNotRetry  NextStep = "do_not_retry"
)

// Error is the structured error returned by every SDK operation. Messages
// never contain the API key, webhook secrets, header values, or request
// bodies.
type Error struct {
	Code      Code
	Operation Operation
	Outcome   Outcome
	NextStep  NextStep
	// HTTPStatus is the provider's status code, or zero when no HTTP response
	// was received.
	HTTPStatus int
	// ProviderCode carries a machine-readable code from Lipila's error body
	// when one was present.
	ProviderCode string
	// RetryAfter is the server-requested wait from a Retry-After header, or
	// zero when none was sent.
	RetryAfter time.Duration
	// Message is human-readable detail, safe to log.
	Message string
	// Err is the underlying cause, if any.
	Err error
}

func (e *Error) Error() string {
	return fmt.Sprintf("lipila: %s: %s", e.Operation, e.Message)
}

// Unwrap exposes the underlying cause, so errors.Is reaches transport and
// context errors such as context.DeadlineExceeded.
func (e *Error) Unwrap() error { return e.Err }

// UnknownOutcomeError reports that a payment mutation was interrupted after
// Lipila may have received it. The SDK never retries this automatically:
// submitting again could create a second charge. Look the payment up with
// Payments.Retrieve using ReferenceID, then decide.
type UnknownOutcomeError struct {
	// ReferenceID is the merchant reference submitted with the interrupted
	// request, the handle for reconciliation.
	ReferenceID string
	Operation   Operation
	// HTTPStatus is set when the ambiguity came from an ambiguous HTTP status
	// (408 or 5xx) rather than a transport fault.
	HTTPStatus int
	Message    string
	// Err is the underlying cause, if any.
	Err error
}

func (e *UnknownOutcomeError) Error() string {
	return fmt.Sprintf(
		"lipila: %s: outcome unknown for referenceId %q: %s",
		e.Operation, e.ReferenceID, e.Message,
	)
}

func (e *UnknownOutcomeError) Unwrap() error { return e.Err }

// VerificationReason classifies why webhook verification rejected a request.
type VerificationReason string

const (
	ReasonMissingSecret             VerificationReason = "missing_secret"
	ReasonMissingHeader             VerificationReason = "missing_header"
	ReasonInvalidTimestamp          VerificationReason = "invalid_timestamp"
	ReasonTimestampOutsideTolerance VerificationReason = "timestamp_outside_tolerance"
	ReasonInvalidSignature          VerificationReason = "invalid_signature"
	ReasonInvalidJSON               VerificationReason = "invalid_json"
)

// WebhookVerificationError reports a webhook that failed verification. A
// request that produces this error must be answered with an HTTP error status
// and its body must not be processed.
type WebhookVerificationError struct {
	Reason  VerificationReason
	Message string
	// Err is the underlying cause, if any.
	Err error
}

func (e *WebhookVerificationError) Error() string {
	return fmt.Sprintf("lipila: verify_webhook: %s: %s", e.Reason, e.Message)
}

func (e *WebhookVerificationError) Unwrap() error { return e.Err }

// Verification builds a WebhookVerificationError.
func Verification(reason VerificationReason, message string) *WebhookVerificationError {
	return &WebhookVerificationError{Reason: reason, Message: message}
}

// Configuration builds the *Error New returns for invalid configuration.
func Configuration(message string) *Error {
	return &Error{
		Code:      CodeConfiguration,
		Operation: OpCreateMobileMoneyPayment,
		Outcome:   OutcomeNotStarted,
		NextStep:  NextFixRequest,
		Message:   message,
	}
}

// Validation builds the *Error returned for rejected caller input.
func Validation(operation Operation, message string) *Error {
	outcome := OutcomeNotApplicable
	if operation.IsMutation() {
		outcome = OutcomeNotStarted
	}
	return &Error{
		Code:      CodeValidation,
		Operation: operation,
		Outcome:   outcome,
		NextStep:  NextFixRequest,
		Message:   message,
	}
}
