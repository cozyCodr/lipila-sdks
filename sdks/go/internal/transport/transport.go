// Package transport executes HTTP requests against Lipila and maps provider
// rejections and retry pacing. It knows nothing about individual endpoints
// or payment semantics; outcome classification stays with the caller.
package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/cozyCodr/lipila-go/internal/fault"
)

// maxResponseBytes bounds how much of a provider response is read.
// Documented Lipila bodies are well under a kilobyte.
const maxResponseBytes = 1 << 20

// Client executes requests with the SDK's authentication and timeout policy.
type Client struct {
	// APIKey is sent as x-api-key on every request.
	APIKey string
	// HTTPClient performs the requests.
	HTTPClient *http.Client
	// Timeout bounds each attempt when the caller's context carries no
	// deadline of its own.
	Timeout time.Duration
}

// Do performs one HTTP attempt. When the caller's context has no deadline,
// the per-attempt Timeout applies; a caller deadline always wins.
func (c *Client) Do(
	ctx context.Context,
	method string,
	endpoint string,
	body []byte,
	callbackURL string,
) (int, []byte, http.Header, error) {
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.Timeout)
		defer cancel()
	}

	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return 0, nil, nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("x-api-key", c.APIKey)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if callbackURL != "" {
		request.Header.Set("callbackUrl", callbackURL)
	}

	response, err := c.HTTPClient.Do(request)
	if err != nil {
		return 0, nil, nil, err
	}
	defer response.Body.Close()

	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return 0, nil, nil, err
	}
	return response.StatusCode, responseBody, response.Header, nil
}

// HTTPError maps a definite provider rejection to a structured *fault.Error.
func HTTPError(
	operation fault.Operation,
	status int,
	body []byte,
	header http.Header,
	outcome fault.Outcome,
) *fault.Error {
	message, providerCode := providerErrorDetails(body)

	code := fault.CodeProvider
	switch {
	case status == http.StatusUnauthorized:
		code = fault.CodeAuthentication
	case status == http.StatusForbidden:
		code = fault.CodeForbidden
	case status == http.StatusNotFound:
		code = fault.CodeNotFound
	case status == http.StatusTooManyRequests:
		code = fault.CodeRateLimited
	}

	nextStep := fault.NextDoNotRetry
	switch {
	case operation == fault.OpRetrievePayment && RetryableReadStatus(status):
		nextStep = fault.NextRetryStatus
	case status == http.StatusBadRequest:
		nextStep = fault.NextFixRequest
	}

	return &fault.Error{
		Code:         code,
		Operation:    operation,
		Outcome:      outcome,
		NextStep:     nextStep,
		HTTPStatus:   status,
		ProviderCode: providerCode,
		RetryAfter:   ParseRetryAfter(header),
		Message:      message,
	}
}

// providerErrorDetails extracts a human message and machine code from a
// Lipila error body, tolerating any shape. Values are truncated so a hostile
// or broken upstream cannot balloon logs.
func providerErrorDetails(body []byte) (message string, providerCode string) {
	const fallback = "Lipila rejected the request."
	if len(bytes.TrimSpace(body)) == 0 {
		return fallback, ""
	}
	var record map[string]any
	if err := json.Unmarshal(body, &record); err != nil {
		return fallback, ""
	}

	message = fallback
	if value, ok := record["message"].(string); ok {
		message = value
	} else if value, ok := record["error"].(string); ok {
		message = value
	}
	if value, ok := record["code"].(string); ok {
		providerCode = value
	} else if value, ok := record["errorCode"].(string); ok {
		providerCode = value
	}
	return truncate(message, 500), truncate(providerCode, 100)
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

// RetryableReadStatus reports whether a status is transient for reads.
// Mutations never consult this: their ambiguous statuses are unknown
// outcomes, not retry candidates.
func RetryableReadStatus(status int) bool {
	return status == http.StatusRequestTimeout ||
		status == http.StatusTooManyRequests ||
		status >= 500
}

const maxRetryDelay = 2 * time.Second

// RetryDelay computes the wait before a read retry: exponential backoff from
// 200ms, capped at two seconds. A server Retry-After is honored but clamped
// to the same ceiling, because the wait is chosen by whoever answers.
func RetryDelay(attempt int, retryAfter time.Duration) time.Duration {
	if retryAfter > 0 {
		return min(retryAfter, maxRetryDelay)
	}
	backoff := 200 * time.Millisecond << attempt
	return min(backoff, maxRetryDelay)
}

// ParseRetryAfter reads a Retry-After header as delay seconds or an HTTP
// date, capped at 30 seconds. Zero means the header was absent or unusable.
func ParseRetryAfter(header http.Header) time.Duration {
	const ceiling = 30 * time.Second
	value := header.Get("Retry-After")
	if value == "" {
		return 0
	}
	if seconds, err := strconv.ParseFloat(value, 64); err == nil {
		if seconds < 0 || math.IsInf(seconds, 0) || math.IsNaN(seconds) {
			return 0
		}
		return min(time.Duration(seconds*float64(time.Second)), ceiling)
	}
	if at, err := http.ParseTime(value); err == nil {
		delay := time.Until(at)
		if delay < 0 {
			return 0
		}
		return min(delay, ceiling)
	}
	return 0
}

// Sleep waits for the delay or until the context ends, whichever is first.
func Sleep(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
