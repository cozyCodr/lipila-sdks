package lipila

// The error model is defined in internal/fault and re-exported here as
// aliases, so callers work entirely in terms of lipila.Error and friends
// while internal packages share the same types without an import cycle.

import "github.com/cozyCodr/lipila-go/internal/fault"

// Code classifies why an operation failed.
type Code = fault.Code

const (
	// CodeConfiguration marks invalid client configuration detected by New.
	CodeConfiguration = fault.CodeConfiguration
	// CodeValidation marks caller input rejected before any request was sent.
	CodeValidation = fault.CodeValidation
	// CodeAuthentication marks a 401 from Lipila: wrong key or wrong environment.
	CodeAuthentication = fault.CodeAuthentication
	// CodeForbidden marks a 403 from Lipila.
	CodeForbidden = fault.CodeForbidden
	// CodeNotFound marks a 404 from Lipila, such as an unknown referenceId.
	CodeNotFound = fault.CodeNotFound
	// CodeRateLimited marks a 429 from Lipila.
	CodeRateLimited = fault.CodeRateLimited
	// CodeProvider marks any other HTTP rejection from Lipila.
	CodeProvider = fault.CodeProvider
	// CodeInvalidResponse marks a response body the SDK could not interpret.
	CodeInvalidResponse = fault.CodeInvalidResponse
	// CodeTransport marks a network-level failure on a read operation.
	CodeTransport = fault.CodeTransport
	// CodeCanceled marks a request stopped by the caller's context before dispatch.
	CodeCanceled = fault.CodeCanceled
)

// Operation names the SDK call that produced an error.
type Operation = fault.Operation

const (
	OpCreateMobileMoneyPayment = fault.OpCreateMobileMoneyPayment
	OpCreateCardPayment        = fault.OpCreateCardPayment
	OpRetrievePayment          = fault.OpRetrievePayment
	OpVerifyWebhook            = fault.OpVerifyWebhook
)

// Outcome states what is known about side effects when an error is returned.
// This is the field payment code must branch on: it says whether money may
// have moved.
type Outcome = fault.Outcome

const (
	// OutcomeNotStarted means Lipila did not accept the request. Fixing the
	// input and submitting again is safe.
	OutcomeNotStarted = fault.OutcomeNotStarted
	// OutcomeNotApplicable means the operation had no financial side effects.
	OutcomeNotApplicable = fault.OutcomeNotApplicable
	// OutcomeUnknown means Lipila may have accepted the request. Reconcile by
	// the submitted referenceId before acting again; see UnknownOutcomeError.
	OutcomeUnknown = fault.OutcomeUnknown
)

// NextStep is the SDK's recommendation for what the caller should do.
type NextStep = fault.NextStep

const (
	NextFixRequest  = fault.NextFixRequest
	NextRetryStatus = fault.NextRetryStatus
	NextReconcile   = fault.NextReconcile
	NextDoNotRetry  = fault.NextDoNotRetry
)

// Error is the structured error returned by every SDK operation. Messages
// never contain the API key, webhook secrets, header values, or request
// bodies.
type Error = fault.Error

// UnknownOutcomeError reports that a payment mutation was interrupted after
// Lipila may have received it. The SDK never retries this automatically:
// submitting again could create a second charge. Look the payment up with
// Payments.Retrieve using ReferenceID, then decide.
type UnknownOutcomeError = fault.UnknownOutcomeError

// VerificationReason classifies why webhook verification rejected a request.
type VerificationReason = fault.VerificationReason

const (
	ReasonMissingSecret             = fault.ReasonMissingSecret
	ReasonMissingHeader             = fault.ReasonMissingHeader
	ReasonInvalidTimestamp          = fault.ReasonInvalidTimestamp
	ReasonTimestampOutsideTolerance = fault.ReasonTimestampOutsideTolerance
	ReasonInvalidSignature          = fault.ReasonInvalidSignature
	ReasonInvalidJSON               = fault.ReasonInvalidJSON
)

// WebhookVerificationError reports a webhook that failed verification. A
// request that produces this error must be answered with an HTTP error status
// and its body must not be processed.
type WebhookVerificationError = fault.WebhookVerificationError
