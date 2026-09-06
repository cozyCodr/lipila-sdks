package lipila

import (
	"net/http"
	"testing"
	"time"
)

// signedRequest signs a body with the shared test secret and returns matching
// headers, reusing the helpers in webhooks_test.go.
func signedRequest(t *testing.T, body []byte) http.Header {
	t.Helper()
	now := time.Now().Unix()
	return webhookHeaders("evt_c", now, signWebhook(t, testSecret, "evt_c", now, body))
}

func TestClassifyWebhookEdgeShapes(t *testing.T) {
	client := webhookClient(t, testSecret)

	cases := []struct {
		name      string
		body      string
		wantShape WebhookShape
	}{
		{
			name:      "envelope",
			body:      `{"type": "transaction.completed", "data": {"status": "Successful"}}`,
			wantShape: ShapeEnvelope,
		},
		{
			name:      "type without data is not an envelope",
			body:      `{"type": "transaction.completed"}`,
			wantShape: ShapeUnknown,
		},
		{
			name:      "flat transaction",
			body:      `{"status": "Failed", "referenceId": "order-1"}`,
			wantShape: ShapeTransaction,
		},
		{
			name:      "blank status is not a transaction",
			body:      `{"status": "   "}`,
			wantShape: ShapeUnknown,
		},
		{
			name:      "array body",
			body:      `[1, 2, 3]`,
			wantShape: ShapeUnknown,
		},
		{
			name:      "scalar body",
			body:      `"just a string"`,
			wantShape: ShapeUnknown,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := []byte(tc.body)
			event, err := client.Webhooks.Verify(body, signedRequest(t, body))
			if err != nil {
				t.Fatalf("Verify failed: %v", err)
			}
			if event.Shape != tc.wantShape {
				t.Errorf("Shape = %q, want %q", event.Shape, tc.wantShape)
			}
			if string(event.Payload) != tc.body {
				t.Error("Payload does not preserve the verified body verbatim")
			}
		})
	}

	t.Run("envelope data is preserved", func(t *testing.T) {
		body := []byte(`{"type": "transaction.completed", "data": {"status": "Successful"}}`)
		event, err := client.Webhooks.Verify(body, signedRequest(t, body))
		if err != nil {
			t.Fatalf("Verify failed: %v", err)
		}
		if event.Type != "transaction.completed" || len(event.Data) == 0 {
			t.Errorf("envelope fields = (%q, %d data bytes), want type and data populated",
				event.Type, len(event.Data))
		}
	})
}
