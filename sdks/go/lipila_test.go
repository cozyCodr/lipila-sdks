package lipila

import (
	"errors"
	"strings"
	"testing"
)

// testSecret is the synthetic 32-byte key from spec/fixtures, base64-encoded.
const testSecret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="

func TestNewValidatesConfiguration(t *testing.T) {
	cases := []struct {
		name    string
		config  Config
		wantErr string
	}{
		{
			name:    "empty api key",
			config:  Config{},
			wantErr: "APIKey must be a non-empty string",
		},
		{
			name:    "whitespace api key",
			config:  Config{APIKey: "   "},
			wantErr: "APIKey must be a non-empty string",
		},
		{
			name:    "non ascii api key",
			config:  Config{APIKey: "lsk_ékey"},
			wantErr: "printable ASCII",
		},
		{
			name:    "embedded newline api key",
			config:  Config{APIKey: "lsk_a\nb"},
			wantErr: "printable ASCII",
		},
		{
			name:    "unknown environment",
			config:  Config{APIKey: "lsk_test", Environment: "staging"},
			wantErr: `Environment must be "sandbox" or "production"`,
		},
		{
			name:    "negative timeout",
			config:  Config{APIKey: "lsk_test", Timeout: -1},
			wantErr: "Timeout must be positive",
		},
		{
			name:    "non base64 webhook secret",
			config:  Config{APIKey: "lsk_test", WebhookSecret: "not-base64!!"},
			wantErr: "base64-encoded 32-byte key",
		},
		{
			name:    "wrong length webhook secret",
			config:  Config{APIKey: "lsk_test", WebhookSecret: "aGVsbG8="},
			wantErr: "base64-encoded 32-byte key",
		},
		{
			name:    "bad secret in rotation list",
			config:  Config{APIKey: "lsk_test", WebhookSecrets: []string{testSecret, "bad"}},
			wantErr: "base64-encoded 32-byte key",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := New(tc.config)
			if err == nil {
				t.Fatalf("New(%+v) succeeded, want error containing %q", tc.config, tc.wantErr)
			}
			var typed *Error
			if !errors.As(err, &typed) {
				t.Fatalf("error is %T, want *Error", err)
			}
			if typed.Code != CodeConfiguration {
				t.Errorf("Code = %q, want %q", typed.Code, CodeConfiguration)
			}
			if !strings.Contains(typed.Message, tc.wantErr) {
				t.Errorf("Message = %q, want it to contain %q", typed.Message, tc.wantErr)
			}
		})
	}
}

func TestNewAcceptsValidConfiguration(t *testing.T) {
	cases := []struct {
		name   string
		secret string
	}{
		{name: "plain base64", secret: testSecret},
		{name: "whsec prefixed", secret: "whsec_" + testSecret},
		{name: "unpadded base64", secret: strings.TrimRight(testSecret, "=")},
		{name: "trailing newline", secret: testSecret + "\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client, err := New(Config{APIKey: "lsk_test", WebhookSecret: tc.secret})
			if err != nil {
				t.Fatalf("New() failed: %v", err)
			}
			if len(client.Webhooks.secrets) != 1 || len(client.Webhooks.secrets[0]) != 32 {
				t.Fatalf("decoded secrets = %d x %d bytes, want 1 x 32", len(client.Webhooks.secrets),
					len(client.Webhooks.secrets[0]))
			}
		})
	}
}

func TestNewDefaultsToSandbox(t *testing.T) {
	client, err := New(Config{APIKey: "lsk_test"})
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}
	if got := client.baseURL.String(); got != "https://api.lipila.dev" {
		t.Errorf("baseURL = %q, want the sandbox URL", got)
	}

	live, err := New(Config{APIKey: "lsk_test", Environment: Production})
	if err != nil {
		t.Fatalf("New(production) failed: %v", err)
	}
	if got := live.baseURL.String(); got != "https://blz.lipila.io" {
		t.Errorf("production baseURL = %q, want https://blz.lipila.io", got)
	}
}

func TestErrorMessagesNeverContainCredentials(t *testing.T) {
	const key = "lsk_super_secret_value"
	_, err := New(Config{APIKey: key, WebhookSecret: "malformed"})
	if err == nil {
		t.Fatal("New() succeeded, want configuration error")
	}
	if strings.Contains(err.Error(), key) || strings.Contains(err.Error(), "malformed") {
		t.Fatalf("error message leaks configuration values: %q", err.Error())
	}
}
