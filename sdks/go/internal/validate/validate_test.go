package validate

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/cozyCodr/lipila-go/internal/fault"
)

const operation = fault.OpCreateMobileMoneyPayment

func wantValidationError(t *testing.T, err error, fragment string) {
	t.Helper()
	var typed *fault.Error
	if !errors.As(err, &typed) || typed.Code != fault.CodeValidation {
		t.Fatalf("err = %v, want a validation *fault.Error", err)
	}
	if !strings.Contains(typed.Message, fragment) {
		t.Errorf("Message = %q, want it to contain %q", typed.Message, fragment)
	}
}

func TestNonEmpty(t *testing.T) {
	if err := NonEmpty("value", "Field", operation); err != nil {
		t.Fatalf("NonEmpty rejected a valid string: %v", err)
	}
	wantValidationError(t, NonEmpty("", "Field", operation), "Field")
	wantValidationError(t, NonEmpty("   ", "Field", operation), "Field")
}

func TestCurrency(t *testing.T) {
	got, err := Currency("", operation)
	if err != nil || got != DefaultCurrency {
		t.Fatalf("Currency(\"\") = (%q, %v), want the %q default", got, err, DefaultCurrency)
	}
	for _, valid := range []string{"ZMW", "USD", "KES"} {
		if got, err := Currency(valid, operation); err != nil || got != valid {
			t.Errorf("Currency(%q) = (%q, %v), want pass-through", valid, got, err)
		}
	}
	for _, invalid := range []string{"zmw", "ZM", "ZMWK", "12A"} {
		_, err := Currency(invalid, operation)
		wantValidationError(t, err, "ISO 4217")
	}
}

func TestAmount(t *testing.T) {
	for _, valid := range []float64{0.01, 1, 999999.99} {
		if err := Amount(valid, operation); err != nil {
			t.Errorf("Amount(%v) rejected: %v", valid, err)
		}
	}
	for _, invalid := range []float64{0, -1, math.NaN(), math.Inf(1), math.Inf(-1)} {
		wantValidationError(t, Amount(invalid, operation), "Amount")
	}
}

func TestURL(t *testing.T) {
	t.Run("accepted", func(t *testing.T) {
		cases := []struct{ name, input, want string }{
			{name: "https", input: "https://merchant.example/cb", want: "https://merchant.example/cb"},
			{name: "localhost http", input: "http://localhost:3000/cb", want: "http://localhost:3000/cb"},
			{name: "localhost subdomain", input: "http://app.localhost/cb", want: "http://app.localhost/cb"},
			{name: "loopback ipv4", input: "http://127.0.0.1:8080/cb", want: "http://127.0.0.1:8080/cb"},
			{name: "loopback ipv6", input: "http://[::1]:8080/cb", want: "http://[::1]:8080/cb"},
		}
		for _, tc := range cases {
			got, err := URL(tc.input, "CallbackURL", operation)
			if err != nil || got != tc.want {
				t.Errorf("%s: URL(%q) = (%q, %v), want accepted", tc.name, tc.input, got, err)
			}
		}
	})

	t.Run("rejected", func(t *testing.T) {
		cases := []struct{ name, input, fragment string }{
			{name: "empty", input: "", fragment: "non-empty"},
			{name: "relative", input: "/cb", fragment: "absolute URL"},
			{name: "no host", input: "https:///cb", fragment: "absolute URL"},
			{name: "not a url", input: "http://%zz", fragment: "absolute URL"},
			{name: "plain http", input: "http://merchant.example/cb", fragment: "HTTPS"},
			{name: "bind-any host", input: "http://0.0.0.0/cb", fragment: "HTTPS"},
			{name: "ftp scheme", input: "ftp://merchant.example/cb", fragment: "HTTPS"},
			{name: "credentials", input: "https://user:pass@merchant.example/cb", fragment: "credentials"},
			{name: "crlf injection", input: "https://merchant.example/cb\r\nx: 1", fragment: "control characters"},
			{name: "bare newline", input: "https://merchant.example/\ncb", fragment: "control characters"},
		}
		for _, tc := range cases {
			_, err := URL(tc.input, "CallbackURL", operation)
			if err == nil {
				t.Errorf("%s: URL(%q) accepted, want rejection", tc.name, tc.input)
				continue
			}
			wantValidationError(t, err, tc.fragment)
		}
	})
}

func TestOptionalURL(t *testing.T) {
	got, err := OptionalURL("", "CallbackURL", operation)
	if err != nil || got != "" {
		t.Fatalf("OptionalURL(\"\") = (%q, %v), want empty pass-through", got, err)
	}
	if _, err := OptionalURL("http://merchant.example/cb", "CallbackURL", operation); err == nil {
		t.Fatal("OptionalURL accepted a non-loopback http URL")
	}
}
