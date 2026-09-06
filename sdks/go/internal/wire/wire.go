// Package wire decodes Lipila's transaction bodies. Decoding is deliberately
// tolerant, because Lipila's response examples are not schemas: a field of an
// unexpected type is treated as absent rather than failing the parse, and the
// untouched body is always preserved on the result.
package wire

import (
	"encoding/json"
	"strings"

	"github.com/cozyCodr/lipila-go/internal/fault"
)

// Transaction is a Lipila payment transaction as returned by collection
// creation, status lookup, and webhook payloads.
//
// Lipila's documentation shows the same object with different fields present
// in different examples, so every field except Status is optional and absent
// fields are zero values. Status passes through verbatim: the documented
// values are "Pending", "Successful", and "Failed", but an unrecognized value
// is preserved rather than collapsed into a failure. Raw always holds the
// complete provider body, so nothing Lipila sends is lost to the typed view.
type Transaction struct {
	// Status is the business state of the transaction and the only field the
	// SDK requires. Treat it, never Message, as the source of truth.
	Status string

	// ReferenceID and Identifier are the transaction's two identities. Their
	// exact semantics are contradictory in Lipila's documentation; retrieve
	// payments with the referenceId you submitted at creation.
	ReferenceID string
	Identifier  string
	// ExternalID is the mobile network's settlement reference, populated once
	// a collection succeeds.
	ExternalID string

	Currency      string
	Amount        float64
	AccountNumber string
	// PaymentType is the resolved instrument, such as "AirtelMoney",
	// "MtnMoney", "ZamtelKwacha", or "Card".
	PaymentType string
	// Type distinguishes "Collection" from "Disbursement".
	Type string
	// Message is descriptive provider text. It is not a state machine:
	// Lipila has shown "Transaction Successful" on a Pending transaction.
	Message       string
	Narration     string
	ReferenceData string
	// CardRedirectionURL is the hosted-checkout URL on card collections that
	// require customer redirection.
	CardRedirectionURL string
	CreatedAt          string
	IPAddress          string

	// Raw is the untouched provider response body. Fields the typed view does
	// not model are preserved here.
	Raw json.RawMessage
}

// ParseTransaction decodes a provider body into a Transaction. Only a
// missing or empty status rejects the body.
//
// The operation selects the error metadata: a failed read can simply be
// retried, while a create that produced an unreadable success body is an
// unknown outcome for the caller.
func ParseTransaction(body []byte, operation fault.Operation) (*Transaction, error) {
	var record map[string]any
	if err := json.Unmarshal(body, &record); err != nil {
		invalid := invalidResponse(operation, "Lipila returned invalid JSON.")
		invalid.Err = err
		return nil, invalid
	}
	return ParseRecord(record, body, operation)
}

// ParseRecord builds a Transaction from an already-decoded JSON object,
// preserving rawBody verbatim. Webhook classification uses this directly so
// the body is decoded exactly once.
func ParseRecord(
	record map[string]any,
	rawBody []byte,
	operation fault.Operation,
) (*Transaction, error) {
	status, ok := record["status"].(string)
	if !ok || strings.TrimSpace(status) == "" {
		return nil, invalidResponse(operation, "Lipila returned a transaction without a valid status.")
	}

	str := func(key string) string {
		value, _ := record[key].(string)
		return value
	}
	amount, _ := record["amount"].(float64)

	return &Transaction{
		Status:             status,
		ReferenceID:        str("referenceId"),
		Identifier:         str("identifier"),
		ExternalID:         str("externalId"),
		Currency:           str("currency"),
		Amount:             amount,
		AccountNumber:      str("accountNumber"),
		PaymentType:        str("paymentType"),
		Type:               str("type"),
		Message:            str("message"),
		Narration:          str("narration"),
		ReferenceData:      str("referenceData"),
		CardRedirectionURL: str("cardRedirectionUrl"),
		CreatedAt:          str("createdAt"),
		IPAddress:          str("ipAddress"),
		Raw:                json.RawMessage(append([]byte(nil), rawBody...)),
	}, nil
}

// invalidResponse builds the metadata for an uninterpretable body: reads can
// be retried, while a mutation that produced one is an unknown outcome.
func invalidResponse(operation fault.Operation, message string) *fault.Error {
	e := &fault.Error{
		Code:      fault.CodeInvalidResponse,
		Operation: operation,
		Outcome:   fault.OutcomeNotApplicable,
		NextStep:  fault.NextRetryStatus,
		Message:   message,
	}
	if operation.IsMutation() {
		e.Outcome = fault.OutcomeUnknown
		e.NextStep = fault.NextReconcile
	}
	return e
}
