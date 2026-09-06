package lipila

// This file is the webhook API surface: header policy, timestamp tolerance,
// and payload classification. The cryptographic verification itself lives in
// internal/signature, and transaction decoding in internal/wire.

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/cozyCodr/lipila-go/internal/fault"
	"github.com/cozyCodr/lipila-go/internal/signature"
	"github.com/cozyCodr/lipila-go/internal/wire"
)

const (
	// webhookTolerance is the documented maximum age (and forward skew) of an
	// acceptable webhook timestamp.
	webhookTolerance = 300 * time.Second
	// maxWebhookIDLength bounds the id so a hostile caller cannot force
	// unbounded HMAC work through the signed prefix.
	maxWebhookIDLength = 255
	// maxSignatureHeaderLength bounds how many candidate signatures one
	// request may carry.
	maxSignatureHeaderLength = 4096
)

// WebhookShape says which of Lipila's documented body shapes a verified
// webhook matched.
type WebhookShape string

const (
	// ShapeTransaction is the flat transaction object from the callback
	// documentation.
	ShapeTransaction WebhookShape = "transaction"
	// ShapeEnvelope is the {"type": ..., "data": ...} event wrapper shown in
	// Lipila's security documentation.
	ShapeEnvelope WebhookShape = "envelope"
	// ShapeUnknown is any other verified JSON body. The signature was valid;
	// only the classification is unknown.
	ShapeUnknown WebhookShape = "unknown"
)

// WebhookEvent is a webhook whose signature has been verified.
type WebhookEvent struct {
	// ID is the stable webhook-id. Lipila retries deliveries with the same
	// id, so persist processed ids to deduplicate.
	ID string
	// Timestamp is the signed webhook-timestamp.
	Timestamp time.Time
	// Shape says which documented body shape matched and therefore which of
	// the fields below is populated.
	Shape WebhookShape
	// Type is the event type when Shape is ShapeEnvelope.
	Type string
	// Data is the envelope payload when Shape is ShapeEnvelope.
	Data json.RawMessage
	// Transaction is the parsed body when Shape is ShapeTransaction.
	Transaction *Transaction
	// Payload is the complete verified body for every shape.
	Payload json.RawMessage
}

// WebhooksService verifies incoming Lipila webhooks.
type WebhooksService struct {
	secrets [][]byte
	// now is replaceable in tests so fixture timestamps stay verifiable.
	now func() time.Time
}

func newWebhooksService(secrets [][]byte) *WebhooksService {
	return &WebhooksService{secrets: secrets, now: time.Now}
}

// Verify authenticates one webhook request and returns its classified
// payload. rawBody must be the untouched request body bytes: JSON that has
// been parsed and reserialized will not reproduce the signed bytes. In a
// standard net/http handler:
//
//	body, err := io.ReadAll(r.Body)
//	if err != nil { /* 400 */ }
//	event, err := client.Webhooks.Verify(body, r.Header)
//
// Verification implements Lipila's documented scheme: HMAC-SHA256 with the
// decoded secret over "{webhook-id}.{webhook-timestamp}.{body}", compared in
// constant time against every v1 signature in the webhook-signature header,
// for every configured secret, with timestamps rejected outside a five
// minute tolerance. The body is parsed as JSON only after a signature
// validates.
//
// On error, respond with an HTTP error status and do not process the body.
// A verified event is authenticated but not deduplicated; persist event IDs
// to protect against redelivery.
func (s *WebhooksService) Verify(rawBody []byte, header http.Header) (*WebhookEvent, error) {
	if len(s.secrets) == 0 {
		return nil, fault.Verification(
			ReasonMissingSecret,
			"configure WebhookSecret before verifying Lipila webhooks.",
		)
	}

	id := header.Get("webhook-id")
	timestampHeader := header.Get("webhook-timestamp")
	signatureHeader := header.Get("webhook-signature")
	if strings.TrimSpace(id) == "" ||
		timestampHeader == "" ||
		strings.TrimSpace(signatureHeader) == "" {
		return nil, fault.Verification(ReasonMissingHeader, "Lipila webhook headers are incomplete.")
	}

	// Reject an id containing the field separator: "{id}.{timestamp}.{body}"
	// would otherwise be ambiguous, letting one signature cover a different
	// split of the same bytes.
	if len(id) > maxWebhookIDLength || strings.Contains(id, ".") {
		return nil, fault.Verification(
			ReasonMissingHeader,
			"webhook-id must be a short identifier that does not contain a period.",
		)
	}
	if len(signatureHeader) > maxSignatureHeaderLength {
		return nil, fault.Verification(
			ReasonInvalidSignature, "webhook-signature header is unreasonably large.",
		)
	}

	timestampSeconds, err := parseWebhookTimestamp(timestampHeader)
	if err != nil {
		return nil, err
	}
	timestamp := time.Unix(timestampSeconds, 0)
	if age := s.now().Sub(timestamp).Abs(); age > webhookTolerance {
		return nil, fault.Verification(
			ReasonTimestampOutsideTolerance,
			"the Lipila webhook timestamp is outside the five-minute tolerance.",
		)
	}

	if !signature.Valid(s.secrets, id, timestampHeader, rawBody, signatureHeader) {
		return nil, fault.Verification(
			ReasonInvalidSignature, "the Lipila webhook signature is invalid.",
		)
	}

	var payload any
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		return nil, &WebhookVerificationError{
			Reason:  ReasonInvalidJSON,
			Message: "the verified Lipila webhook body is not valid JSON.",
			Err:     err,
		}
	}
	return classifyWebhook(id, timestamp, payload, rawBody), nil
}

func parseWebhookTimestamp(value string) (int64, error) {
	for _, r := range value {
		if r < '0' || r > '9' {
			return 0, fault.Verification(
				ReasonInvalidTimestamp, "webhook-timestamp must be Unix time in whole seconds.",
			)
		}
	}
	seconds, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fault.Verification(
			ReasonInvalidTimestamp, "webhook-timestamp must be Unix time in whole seconds.",
		)
	}
	return seconds, nil
}

// classifyWebhook maps a verified body onto Lipila's two documented shapes.
// Classification failures never reject the webhook: the signature already
// proved authenticity, so an unmodeled shape surfaces as ShapeUnknown with
// the payload preserved.
func classifyWebhook(
	id string,
	timestamp time.Time,
	payload any,
	rawBody []byte,
) *WebhookEvent {
	event := &WebhookEvent{
		ID:        id,
		Timestamp: timestamp,
		Shape:     ShapeUnknown,
		Payload:   json.RawMessage(append([]byte(nil), rawBody...)),
	}

	record, ok := payload.(map[string]any)
	if !ok {
		return event
	}

	if eventType, ok := record["type"].(string); ok {
		if _, hasData := record["data"]; hasData {
			event.Shape = ShapeEnvelope
			event.Type = eventType
			if data, err := json.Marshal(record["data"]); err == nil {
				event.Data = data
			}
			return event
		}
	}

	if status, ok := record["status"].(string); ok && strings.TrimSpace(status) != "" {
		transaction, err := wire.ParseRecord(record, rawBody, OpVerifyWebhook)
		if err == nil {
			event.Shape = ShapeTransaction
			event.Transaction = transaction
		}
		return event
	}

	return event
}
