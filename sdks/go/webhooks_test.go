package lipila

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"testing"
	"time"
)

// signWebhook produces the documented signature for a body: HMAC-SHA256 with
// the decoded secret over "{id}.{timestamp}.{body}", base64, "v1," prefix.
func signWebhook(t *testing.T, secretB64, id string, timestamp int64, body []byte) string {
	t.Helper()
	key, err := base64.StdEncoding.DecodeString(secretB64)
	if err != nil {
		t.Fatalf("decoding test secret: %v", err)
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(id + "." + strconv.FormatInt(timestamp, 10) + "."))
	mac.Write(body)
	return "v1," + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func webhookHeaders(id string, timestamp int64, signature string) http.Header {
	header := http.Header{}
	header.Set("webhook-id", id)
	header.Set("webhook-timestamp", strconv.FormatInt(timestamp, 10))
	header.Set("webhook-signature", signature)
	return header
}

func webhookClient(t *testing.T, secrets ...string) *Client {
	t.Helper()
	client, err := New(Config{APIKey: "lsk_test", WebhookSecrets: secrets})
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}
	return client
}

// TestVerifyMatchesSpecFixture verifies the independently generated signature
// vector from spec/fixtures, the cross-language conformance anchor.
func TestVerifyMatchesSpecFixture(t *testing.T) {
	fixtureBytes := readFixture(t, "webhook-hmac-sha256.json")
	var fixture struct {
		SecretBase64     string `json:"secretBase64"`
		WebhookID        string `json:"webhookId"`
		WebhookTimestamp string `json:"webhookTimestamp"`
		RawBody          string `json:"rawBody"`
		SignatureHeader  string `json:"signatureHeader"`
	}
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatalf("decoding fixture: %v", err)
	}
	timestamp, err := strconv.ParseInt(fixture.WebhookTimestamp, 10, 64)
	if err != nil {
		t.Fatalf("fixture timestamp: %v", err)
	}

	client := webhookClient(t, fixture.SecretBase64)
	// Pin the verifier clock inside tolerance of the fixture timestamp.
	client.Webhooks.now = func() time.Time { return time.Unix(timestamp+10, 0) }

	event, err := client.Webhooks.Verify(
		[]byte(fixture.RawBody),
		webhookHeaders(fixture.WebhookID, timestamp, fixture.SignatureHeader),
	)
	if err != nil {
		t.Fatalf("fixture signature rejected: %v", err)
	}
	if event.ID != fixture.WebhookID {
		t.Errorf("ID = %q, want %q", event.ID, fixture.WebhookID)
	}
	if event.Shape != ShapeEnvelope || event.Type != "transaction.completed" {
		t.Errorf("Shape=%q Type=%q, want envelope/transaction.completed", event.Shape, event.Type)
	}
}

func TestVerifyAcceptsAndClassifiesTransactionShape(t *testing.T) {
	body := []byte(`{"referenceId": "order-1", "status": "Successful", "amount": 1}`)
	now := time.Now().Unix()
	signature := signWebhook(t, testSecret, "evt_1", now, body)

	event, err := webhookClient(t, testSecret).Webhooks.Verify(
		body, webhookHeaders("evt_1", now, signature),
	)
	if err != nil {
		t.Fatalf("Verify failed: %v", err)
	}
	if event.Shape != ShapeTransaction || event.Transaction == nil {
		t.Fatalf("Shape = %q, want transaction", event.Shape)
	}
	if event.Transaction.Status != "Successful" || event.Transaction.ReferenceID != "order-1" {
		t.Errorf("unexpected transaction: %+v", event.Transaction)
	}
}

func TestVerifyRejections(t *testing.T) {
	body := []byte(`{"status": "Successful"}`)
	now := time.Now().Unix()
	goodSignature := signWebhook(t, testSecret, "evt_1", now, body)

	otherSecret := base64.StdEncoding.EncodeToString(make([]byte, 32))

	cases := []struct {
		name       string
		body       []byte
		header     http.Header
		wantReason VerificationReason
	}{
		{
			name:       "tampered body",
			body:       append([]byte(nil), append(body, ' ')...),
			header:     webhookHeaders("evt_1", now, goodSignature),
			wantReason: ReasonInvalidSignature,
		},
		{
			name:       "signature from wrong secret",
			body:       body,
			header:     webhookHeaders("evt_1", now, signWebhook(t, otherSecret, "evt_1", now, body)),
			wantReason: ReasonInvalidSignature,
		},
		{
			name:       "missing signature header",
			body:       body,
			header:     webhookHeaders("evt_1", now, ""),
			wantReason: ReasonMissingHeader,
		},
		{
			name:       "stale timestamp",
			body:       body,
			header:     webhookHeaders("evt_1", now-3600, signWebhook(t, testSecret, "evt_1", now-3600, body)),
			wantReason: ReasonTimestampOutsideTolerance,
		},
		{
			name:       "future timestamp",
			body:       body,
			header:     webhookHeaders("evt_1", now+3600, signWebhook(t, testSecret, "evt_1", now+3600, body)),
			wantReason: ReasonTimestampOutsideTolerance,
		},
		{
			name:       "non numeric timestamp",
			body:       body,
			header:     webhookHeaders("evt_1", now, goodSignature),
			wantReason: ReasonInvalidTimestamp,
		},
		{
			name:       "id containing separator",
			body:       body,
			header:     webhookHeaders("evt.1", now, signWebhook(t, testSecret, "evt.1", now, body)),
			wantReason: ReasonMissingHeader,
		},
	}
	// Corrupt the timestamp for the non-numeric case after signing.
	cases[5].header.Set("webhook-timestamp", "17e9")

	client := webhookClient(t, testSecret)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := client.Webhooks.Verify(tc.body, tc.header)
			var verification *WebhookVerificationError
			if !errors.As(err, &verification) {
				t.Fatalf("err = %v, want *WebhookVerificationError", err)
			}
			if verification.Reason != tc.wantReason {
				t.Errorf("Reason = %q, want %q", verification.Reason, tc.wantReason)
			}
		})
	}
}

func TestVerifyWithoutSecretFailsClosed(t *testing.T) {
	client := webhookClient(t)
	_, err := client.Webhooks.Verify([]byte(`{}`), webhookHeaders("evt_1", time.Now().Unix(), "v1,x"))
	var verification *WebhookVerificationError
	if !errors.As(err, &verification) || verification.Reason != ReasonMissingSecret {
		t.Fatalf("err = %v, want missing_secret", err)
	}
}

// TestVerifySupportsSecretRotation covers the documented 24-hour rotation
// overlap: a delivery signed with the old secret verifies while both secrets
// are configured, and multiple space-delimited signatures are accepted when
// any one matches.
func TestVerifySupportsSecretRotation(t *testing.T) {
	oldSecret := testSecret
	newSecret := base64.StdEncoding.EncodeToString(func() []byte {
		key := make([]byte, 32)
		for i := range key {
			key[i] = byte(0x40 + i)
		}
		return key
	}())

	body := []byte(`{"status": "Successful"}`)
	now := time.Now().Unix()
	client := webhookClient(t, newSecret, oldSecret)

	t.Run("old secret still verifies", func(t *testing.T) {
		signature := signWebhook(t, oldSecret, "evt_1", now, body)
		if _, err := client.Webhooks.Verify(body, webhookHeaders("evt_1", now, signature)); err != nil {
			t.Fatalf("old-secret signature rejected during rotation: %v", err)
		}
	})

	t.Run("any signature in a multi-signature header matches", func(t *testing.T) {
		bogus := "v1," + base64.StdEncoding.EncodeToString(make([]byte, 32))
		real := signWebhook(t, newSecret, "evt_2", now, body)
		header := webhookHeaders("evt_2", now, bogus+" "+real)
		if _, err := client.Webhooks.Verify(body, header); err != nil {
			t.Fatalf("multi-signature header rejected: %v", err)
		}
	})
}

func TestVerifyRejectsUnverifiedJSONParsing(t *testing.T) {
	// A valid signature over a non-JSON body verifies but reports invalid
	// JSON, proving parsing happens only after authentication.
	body := []byte(`not json`)
	now := time.Now().Unix()
	signature := signWebhook(t, testSecret, "evt_1", now, body)
	_, err := webhookClient(t, testSecret).Webhooks.Verify(
		body, webhookHeaders("evt_1", now, signature),
	)
	var verification *WebhookVerificationError
	if !errors.As(err, &verification) || verification.Reason != ReasonInvalidJSON {
		t.Fatalf("err = %v, want invalid_json after successful authentication", err)
	}
}
