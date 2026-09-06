// Package lipila is a community SDK for the Lipila payments platform.
//
// It covers mobile-money and card collections, status lookup, and webhook
// signature verification, with one safety rule above all others: a payment
// mutation is never retried automatically. When the SDK cannot prove a create
// request failed before reaching Lipila, it returns *UnknownOutcomeError and
// the caller reconciles by referenceId instead of resubmitting.
//
// The API key grants direct account access. Construct the client only in
// server-side code and load the key from configuration, never from source.
package lipila

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/cozyCodr/lipila-go/internal/fault"
	"github.com/cozyCodr/lipila-go/internal/signature"
	"github.com/cozyCodr/lipila-go/internal/transport"
)

// Environment selects which Lipila platform the client talks to. The two
// environments use separate base URLs and separate API keys; a key sent to
// the wrong environment is rejected with 401.
type Environment string

const (
	// Sandbox is the test platform at https://api.lipila.dev.
	Sandbox Environment = "sandbox"
	// Production is the live platform at https://blz.lipila.io.
	Production Environment = "production"
)

const (
	sandboxBaseURL    = "https://api.lipila.dev"
	productionBaseURL = "https://blz.lipila.io"

	defaultTimeout = 15 * time.Second
)

// Config configures a Client. APIKey is the only required field.
type Config struct {
	// APIKey is the environment-specific merchant key, sent as x-api-key.
	APIKey string

	// Environment defaults to Sandbox so that live money requires an
	// explicit opt-in.
	Environment Environment

	// WebhookSecret is the base64-encoded 32-byte signing secret from
	// Dashboard -> Settings -> Webhooks, with or without the whsec_ prefix.
	// Leave it empty if this client never verifies webhooks.
	WebhookSecret string

	// WebhookSecrets holds additional signing secrets, accepted alongside
	// WebhookSecret so a rotation window can verify against both the old and
	// the new secret.
	WebhookSecrets []string

	// Timeout bounds each HTTP attempt when the caller's context carries no
	// deadline of its own. A caller deadline always wins. Zero means the
	// 15 second default; a negative value is a configuration error.
	Timeout time.Duration

	// HTTPClient overrides the HTTP client used for every request. Leave it
	// nil to use a private default. The SDK never mutates the provided
	// client.
	HTTPClient *http.Client
}

// Client is a configured Lipila API client. It is safe for concurrent use.
type Client struct {
	// Payments creates collections and retrieves their status.
	Payments *PaymentsService
	// Webhooks verifies incoming webhook signatures.
	Webhooks *WebhooksService

	baseURL   *url.URL
	transport *transport.Client
}

// New validates the configuration and returns a ready client. Every
// configuration problem is reported here, at startup, rather than surfacing
// on the first live request or webhook.
func New(config Config) (*Client, error) {
	apiKey := strings.TrimSpace(config.APIKey)
	if apiKey == "" {
		return nil, fault.Configuration("APIKey must be a non-empty string.")
	}
	// A key with a character that is illegal in an HTTP header would make the
	// transport fail in ways that can echo the header value into logs. Reject
	// it here and never include the value in the message.
	if !isPrintableASCII(apiKey) {
		return nil, fault.Configuration(
			"APIKey must contain only printable ASCII characters. Check for whitespace or newlines around the value.",
		)
	}

	environment := config.Environment
	if environment == "" {
		environment = Sandbox
	}
	var base string
	switch environment {
	case Sandbox:
		base = sandboxBaseURL
	case Production:
		base = productionBaseURL
	default:
		return nil, fault.Configuration(`Environment must be "sandbox" or "production".`)
	}
	baseURL, err := url.Parse(base)
	if err != nil {
		return nil, fault.Configuration("internal: base URL failed to parse.")
	}

	timeout := config.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	if timeout < 0 {
		return nil, fault.Configuration("Timeout must be positive.")
	}

	var secretInputs []string
	if config.WebhookSecret != "" {
		secretInputs = append(secretInputs, config.WebhookSecret)
	}
	secretInputs = append(secretInputs, config.WebhookSecrets...)
	secrets := make([][]byte, 0, len(secretInputs))
	for _, input := range secretInputs {
		key, err := signature.DecodeSecret(input)
		if err != nil {
			return nil, err
		}
		secrets = append(secrets, key)
	}

	httpClient := config.HTTPClient
	if httpClient == nil {
		// A private client rather than http.DefaultClient: the default client
		// is a mutable global, and an unrelated package changing it must not
		// change how payments behave.
		httpClient = &http.Client{}
	}

	client := &Client{
		baseURL: baseURL,
		transport: &transport.Client{
			APIKey:     apiKey,
			HTTPClient: httpClient,
			Timeout:    timeout,
		},
	}
	client.Payments = newPaymentsService(client)
	client.Webhooks = newWebhooksService(secrets)
	return client, nil
}

func isPrintableASCII(value string) bool {
	for _, r := range value {
		if r < '!' || r > '~' {
			return false
		}
	}
	return true
}
