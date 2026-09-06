package transport

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/cozyCodr/lipila-go/internal/fault"
)

func headerWith(name, value string) http.Header {
	header := http.Header{}
	header.Set(name, value)
	return header
}

func TestParseRetryAfter(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  time.Duration
	}{
		{name: "absent", value: "", want: 0},
		{name: "seconds", value: "2", want: 2 * time.Second},
		{name: "fractional seconds", value: "0.5", want: 500 * time.Millisecond},
		{name: "negative seconds", value: "-3", want: 0},
		{name: "seconds above ceiling", value: "3600", want: 30 * time.Second},
		{name: "garbage", value: "soon", want: 0},
		{
			name:  "http date in the past",
			value: time.Now().Add(-time.Minute).UTC().Format(http.TimeFormat),
			want:  0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ParseRetryAfter(headerWith("Retry-After", tc.value)); got != tc.want {
				t.Errorf("ParseRetryAfter(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}

	t.Run("http date in the future is capped", func(t *testing.T) {
		value := time.Now().Add(5 * time.Minute).UTC().Format(http.TimeFormat)
		got := ParseRetryAfter(headerWith("Retry-After", value))
		if got <= 0 || got > 30*time.Second {
			t.Errorf("ParseRetryAfter(future date) = %v, want within (0, 30s]", got)
		}
	})
}

func TestRetryDelay(t *testing.T) {
	if got := RetryDelay(0, 0); got != 200*time.Millisecond {
		t.Errorf("first backoff = %v, want 200ms", got)
	}
	if got := RetryDelay(1, 0); got != 400*time.Millisecond {
		t.Errorf("second backoff = %v, want 400ms", got)
	}
	if got := RetryDelay(10, 0); got != maxRetryDelay {
		t.Errorf("deep backoff = %v, want the %v ceiling", got, maxRetryDelay)
	}
	if got := RetryDelay(0, 10*time.Second); got != maxRetryDelay {
		t.Errorf("server Retry-After above ceiling = %v, want clamped to %v", got, maxRetryDelay)
	}
	if got := RetryDelay(3, 100*time.Millisecond); got != 100*time.Millisecond {
		t.Errorf("server Retry-After = %v, want it honored over backoff", got)
	}
}

func TestProviderErrorDetails(t *testing.T) {
	cases := []struct {
		name        string
		body        string
		wantMessage string
		wantCode    string
	}{
		{
			name:        "message field",
			body:        `{"message": "One or more errors occurred!"}`,
			wantMessage: "One or more errors occurred!",
		},
		{
			name:        "error field fallback",
			body:        `{"error": "denied"}`,
			wantMessage: "denied",
		},
		{
			name:        "code field",
			body:        `{"message": "no", "code": "E42"}`,
			wantMessage: "no",
			wantCode:    "E42",
		},
		{
			name:        "errorCode field fallback",
			body:        `{"message": "no", "errorCode": "E43"}`,
			wantMessage: "no",
			wantCode:    "E43",
		},
		{
			name:        "empty body",
			body:        "   ",
			wantMessage: "Lipila rejected the request.",
		},
		{
			name:        "non json body",
			body:        "<html>gateway error</html>",
			wantMessage: "Lipila rejected the request.",
		},
		{
			name:        "non object json",
			body:        `["a"]`,
			wantMessage: "Lipila rejected the request.",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			message, code := providerErrorDetails([]byte(tc.body))
			if message != tc.wantMessage || code != tc.wantCode {
				t.Errorf("providerErrorDetails = (%q, %q), want (%q, %q)",
					message, code, tc.wantMessage, tc.wantCode)
			}
		})
	}

	t.Run("values are truncated", func(t *testing.T) {
		long := make([]byte, 2000)
		for i := range long {
			long[i] = 'a'
		}
		message, _ := providerErrorDetails([]byte(`{"message": "` + string(long) + `"}`))
		if len(message) != 500 {
			t.Errorf("message length = %d, want truncated to 500", len(message))
		}
	})
}

func TestHTTPErrorRetrieveRetryableMarksRetryStatus(t *testing.T) {
	err := HTTPError(fault.OpRetrievePayment, 503, nil, http.Header{}, fault.OutcomeNotApplicable)
	if err.NextStep != fault.NextRetryStatus {
		t.Errorf("NextStep = %q, want retry_status for a retryable read", err.NextStep)
	}
	err = HTTPError(fault.OpCreateCardPayment, 400, nil, http.Header{}, fault.OutcomeNotStarted)
	if err.NextStep != fault.NextFixRequest || err.Code != fault.CodeProvider {
		t.Errorf("400 mapping = %q/%q, want fix_request/provider_error", err.NextStep, err.Code)
	}
}

func TestSleepRespectsContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := Sleep(ctx, time.Minute); err == nil {
		t.Fatal("Sleep with a canceled context returned nil, want the context error")
	}
	if err := Sleep(context.Background(), 0); err != nil {
		t.Fatalf("zero-delay Sleep = %v, want nil", err)
	}
	if err := Sleep(context.Background(), time.Millisecond); err != nil {
		t.Fatalf("short Sleep = %v, want nil", err)
	}
}
