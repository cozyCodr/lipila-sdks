// Package validate checks caller input before any request is built.
// Validation stays deliberately minimal: Lipila documents almost no format
// constraints, and the provider contract forbids inventing undocumented ones.
package validate

import (
	"math"
	"net/url"
	"regexp"
	"strings"

	"github.com/cozyCodr/lipila-go/internal/fault"
)

// DefaultCurrency is applied when a request leaves Currency empty.
const DefaultCurrency = "ZMW"

// NonEmpty rejects a missing or blank required string.
func NonEmpty(value string, name string, operation fault.Operation) error {
	if strings.TrimSpace(value) == "" {
		return fault.Validation(operation, name+" must be a non-empty string.")
	}
	return nil
}

var currencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)

// Currency applies the ZMW default and accepts any ISO-4217-shaped code.
// Lipila documents ZMW and USD; other codes pass through rather than
// hard-failing a potentially valid one.
func Currency(currency string, operation fault.Operation) (string, error) {
	if currency == "" {
		return DefaultCurrency, nil
	}
	if !currencyPattern.MatchString(currency) {
		return "", fault.Validation(
			operation, `Currency must be a 3-letter ISO 4217 code such as "ZMW" or "USD".`,
		)
	}
	return currency, nil
}

// Amount requires a finite number greater than zero. Precision is never
// rounded or reformatted; the value is sent exactly as provided.
func Amount(amount float64, operation fault.Operation) error {
	if math.IsNaN(amount) || math.IsInf(amount, 0) || amount <= 0 {
		return fault.Validation(operation, "Amount must be a finite number greater than zero.")
	}
	return nil
}

// OptionalURL validates a URL when present and passes emptiness through.
func OptionalURL(value string, name string, operation fault.Operation) (string, error) {
	if value == "" {
		return "", nil
	}
	return URL(value, name, operation)
}

// URL validates a caller-supplied URL and returns its normalized form.
// Control characters are rejected outright: url.Parse tolerates some of
// them, and a CRLF-laced value must never reach an HTTP header. Embedded
// credentials are rejected, and plain HTTP is allowed only for loopback
// hosts used in local development.
func URL(value string, name string, operation fault.Operation) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", fault.Validation(operation, name+" must be a non-empty string.")
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return "", fault.Validation(operation, name+" must not contain control characters.")
		}
	}
	parsed, err := url.Parse(value)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" {
		return "", fault.Validation(operation, name+" must be a valid absolute URL.")
	}
	if parsed.User != nil {
		return "", fault.Validation(operation, name+" must not embed credentials.")
	}
	switch parsed.Scheme {
	case "https":
	case "http":
		if !isLoopbackHost(parsed.Hostname()) {
			return "", fault.Validation(
				operation, name+" must use HTTPS (HTTP is allowed only for loopback hosts).",
			)
		}
	default:
		return "", fault.Validation(
			operation, name+" must use HTTPS (HTTP is allowed only for loopback hosts).",
		)
	}
	return parsed.String(), nil
}

// isLoopbackHost reports whether a hostname is a loopback destination that
// may use plain HTTP during local development. url.URL.Hostname strips IPv6
// brackets, so the bare forms are compared. 0.0.0.0 is deliberately excluded:
// it is a bind-any address, never a routable callback target.
func isLoopbackHost(hostname string) bool {
	host := strings.ToLower(strings.TrimSuffix(hostname, "."))
	return host == "localhost" ||
		strings.HasSuffix(host, ".localhost") ||
		host == "::1" ||
		host == "::ffff:127.0.0.1" ||
		strings.HasPrefix(host, "127.")
}
