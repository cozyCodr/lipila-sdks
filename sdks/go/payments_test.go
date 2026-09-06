package lipila

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

// testClient returns a client whose base URL points at the given server.
func testClient(t *testing.T, server *httptest.Server) *Client {
	t.Helper()
	client, err := New(Config{APIKey: "lsk_test", HTTPClient: server.Client()})
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}
	base, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parsing test server URL: %v", err)
	}
	client.baseURL = base
	return client
}

func validMobileMoneyRequest() MobileMoneyPaymentRequest {
	return MobileMoneyPaymentRequest{
		ReferenceID:   "order-1",
		Amount:        100,
		Narration:     "Order 1",
		AccountNumber: "260000000000",
	}
}

func TestMobileMoneyCreateSendsDocumentedRequest(t *testing.T) {
	var captured struct {
		path        string
		apiKey      string
		contentType string
		callbackURL string
		body        map[string]any
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured.path = r.URL.Path
		captured.apiKey = r.Header.Get("x-api-key")
		captured.contentType = r.Header.Get("Content-Type")
		captured.callbackURL = r.Header.Get("callbackUrl")
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &captured.body)
		_, _ = w.Write([]byte(`{"status": "Pending", "referenceId": "order-1"}`))
	}))
	defer server.Close()

	request := validMobileMoneyRequest()
	request.CallbackURL = "https://merchant.example/webhooks/lipila"
	result, err := testClient(t, server).Payments.MobileMoney.Create(context.Background(), request)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	if captured.path != "/api/v1/collections/mobile-money" {
		t.Errorf("path = %q", captured.path)
	}
	if captured.apiKey != "lsk_test" {
		t.Errorf("x-api-key = %q", captured.apiKey)
	}
	if captured.contentType != "application/json" {
		t.Errorf("content-type = %q", captured.contentType)
	}
	if captured.callbackURL != "https://merchant.example/webhooks/lipila" {
		t.Errorf("callbackUrl header = %q", captured.callbackURL)
	}
	if captured.body["currency"] != "ZMW" {
		t.Errorf("currency = %v, want the ZMW default", captured.body["currency"])
	}
	if _, present := captured.body["email"]; present {
		t.Error("empty optional email was serialized")
	}
	if result.SubmittedReferenceID != "order-1" || result.Payment.Status != "Pending" {
		t.Errorf("unexpected result: %+v", result)
	}
	if result.RedirectURL != "" {
		t.Errorf("RedirectURL = %q, want empty for mobile money", result.RedirectURL)
	}
}

func TestBusinessFailureResolvesNormally(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status": "Failed", "message": "Insufficient balance"}`))
	}))
	defer server.Close()

	result, err := testClient(t, server).Payments.MobileMoney.Create(
		context.Background(), validMobileMoneyRequest(),
	)
	if err != nil {
		t.Fatalf("a transaction-shaped business failure must resolve, got %v", err)
	}
	if result.Payment.Status != "Failed" {
		t.Errorf("Status = %q, want Failed preserved", result.Payment.Status)
	}
}

func TestCreateClassifiesDefiniteRejections(t *testing.T) {
	cases := []struct {
		status   int
		wantCode Code
	}{
		{http.StatusUnauthorized, CodeAuthentication},
		{http.StatusForbidden, CodeForbidden},
		{http.StatusBadRequest, CodeProvider},
		{http.StatusTooManyRequests, CodeRateLimited},
	}
	for _, tc := range cases {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(`{"message": "One or more errors occurred!"}`))
		}))
		_, err := testClient(t, server).Payments.MobileMoney.Create(
			context.Background(), validMobileMoneyRequest(),
		)
		server.Close()

		var typed *Error
		if !errors.As(err, &typed) {
			t.Fatalf("status %d: err = %v, want *Error", tc.status, err)
		}
		if typed.Code != tc.wantCode || typed.Outcome != OutcomeNotStarted {
			t.Errorf("status %d: Code=%q Outcome=%q, want %q/not_started",
				tc.status, typed.Code, typed.Outcome, tc.wantCode)
		}
		if typed.HTTPStatus != tc.status {
			t.Errorf("HTTPStatus = %d, want %d", typed.HTTPStatus, tc.status)
		}
		if typed.Message != "One or more errors occurred!" {
			t.Errorf("Message = %q, want the provider message", typed.Message)
		}
	}
}

func TestAmbiguousStatusesAreUnknownOutcomes(t *testing.T) {
	for _, status := range []int{http.StatusRequestTimeout, 500, 502, 503} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
		}))
		_, err := testClient(t, server).Payments.MobileMoney.Create(
			context.Background(), validMobileMoneyRequest(),
		)
		server.Close()

		var unknown *UnknownOutcomeError
		if !errors.As(err, &unknown) {
			t.Fatalf("status %d: err = %v, want *UnknownOutcomeError", status, err)
		}
		if unknown.ReferenceID != "order-1" || unknown.HTTPStatus != status {
			t.Errorf("status %d: ReferenceID=%q HTTPStatus=%d", status, unknown.ReferenceID,
				unknown.HTTPStatus)
		}
	}
}

func TestTransportFailureIsUnknownOutcomeAndNeverRetried(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		// Kill the connection mid-response so the client sees a transport error.
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("test server does not support hijacking")
		}
		connection, _, err := hijacker.Hijack()
		if err != nil {
			t.Fatalf("hijack failed: %v", err)
		}
		_ = connection.Close()
	}))
	defer server.Close()

	_, err := testClient(t, server).Payments.MobileMoney.Create(
		context.Background(), validMobileMoneyRequest(),
	)
	var unknown *UnknownOutcomeError
	if !errors.As(err, &unknown) {
		t.Fatalf("err = %v, want *UnknownOutcomeError", err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("mutation was sent %d times, must be exactly 1", got)
	}
}

func TestUnreadableSuccessBodyIsUnknownOutcome(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"message": "accepted but no status"}`))
	}))
	defer server.Close()

	_, err := testClient(t, server).Payments.MobileMoney.Create(
		context.Background(), validMobileMoneyRequest(),
	)
	var unknown *UnknownOutcomeError
	if !errors.As(err, &unknown) {
		t.Fatalf("err = %v, want *UnknownOutcomeError", err)
	}
}

func TestCreateValidatesInput(t *testing.T) {
	client, err := New(Config{APIKey: "lsk_test"})
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}
	cases := []struct {
		name    string
		mutate  func(*MobileMoneyPaymentRequest)
		wantErr string
	}{
		{
			name:    "missing reference",
			mutate:  func(r *MobileMoneyPaymentRequest) { r.ReferenceID = "" },
			wantErr: "ReferenceID",
		},
		{
			name:    "zero amount",
			mutate:  func(r *MobileMoneyPaymentRequest) { r.Amount = 0 },
			wantErr: "Amount",
		},
		{
			name:    "lowercase currency",
			mutate:  func(r *MobileMoneyPaymentRequest) { r.Currency = "zmw" },
			wantErr: "Currency",
		},
		{
			name:    "plain http callback",
			mutate:  func(r *MobileMoneyPaymentRequest) { r.CallbackURL = "http://merchant.example/cb" },
			wantErr: "HTTPS",
		},
		{
			name: "callback with credentials",
			mutate: func(r *MobileMoneyPaymentRequest) {
				r.CallbackURL = "https://user:pass@merchant.example/cb"
			},
			wantErr: "credentials",
		},
		{
			name: "callback with CRLF",
			mutate: func(r *MobileMoneyPaymentRequest) {
				r.CallbackURL = "https://merchant.example/cb\r\nx-injected: 1"
			},
			wantErr: "control characters",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := validMobileMoneyRequest()
			tc.mutate(&request)
			_, err := client.Payments.MobileMoney.Create(context.Background(), request)
			var typed *Error
			if !errors.As(err, &typed) || typed.Code != CodeValidation {
				t.Fatalf("err = %v, want a validation *Error", err)
			}
			if typed.Outcome != OutcomeNotStarted {
				t.Errorf("Outcome = %q, want not_started", typed.Outcome)
			}
			if !strings.Contains(typed.Message, tc.wantErr) {
				t.Errorf("Message = %q, want it to mention %q", typed.Message, tc.wantErr)
			}
		})
	}

	t.Run("loopback http callback is allowed", func(t *testing.T) {
		request := validMobileMoneyRequest()
		request.CallbackURL = "http://localhost:3000/cb"
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"status": "Pending"}`))
		}))
		defer server.Close()
		if _, err := testClient(t, server).Payments.MobileMoney.Create(
			context.Background(), request,
		); err != nil {
			t.Fatalf("loopback callback rejected: %v", err)
		}
	})
}

// TestCardCreateMatchesFixture replays the card fixture from spec/fixtures
// and checks the SDK produces the fixture's expected result.
func TestCardCreateMatchesFixture(t *testing.T) {
	fixtureBytes := readFixture(t, "card-create-hosted-redirect.json")
	var fixture struct {
		Request struct {
			Path string `json:"path"`
			Body struct {
				CollectionRequest struct {
					ReferenceID   string  `json:"referenceId"`
					Amount        float64 `json:"amount"`
					Narration     string  `json:"narration"`
					AccountNumber string  `json:"accountNumber"`
					Currency      string  `json:"currency"`
					BackURL       string  `json:"backUrl"`
					ReferenceData string  `json:"referenceData"`
				} `json:"collectionRequest"`
				CustomerInfo CardCustomer `json:"customerInfo"`
			} `json:"body"`
		} `json:"request"`
		Response struct {
			Status int             `json:"status"`
			Body   json.RawMessage `json:"body"`
		} `json:"response"`
		ExpectedSDKResult struct {
			SubmittedReferenceID string `json:"submittedReferenceId"`
			PaymentStatus        string `json:"paymentStatus"`
			Action               struct {
				URL string `json:"url"`
			} `json:"action"`
		} `json:"expectedSdkResult"`
	}
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatalf("decoding fixture: %v", err)
	}

	var capturedBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != fixture.Request.Path {
			t.Errorf("path = %q, want %q", r.URL.Path, fixture.Request.Path)
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &capturedBody)
		w.WriteHeader(fixture.Response.Status)
		_, _ = w.Write(fixture.Response.Body)
	}))
	defer server.Close()

	source := fixture.Request.Body.CollectionRequest
	result, err := testClient(t, server).Payments.Card.Create(context.Background(), CardPaymentRequest{
		ReferenceID:   source.ReferenceID,
		Amount:        source.Amount,
		Narration:     source.Narration,
		AccountNumber: source.AccountNumber,
		Currency:      source.Currency,
		BackURL:       source.BackURL,
		ReferenceData: source.ReferenceData,
		Customer:      fixture.Request.Body.CustomerInfo,
	})
	if err != nil {
		t.Fatalf("card Create failed: %v", err)
	}

	expected := fixture.ExpectedSDKResult
	if result.SubmittedReferenceID != expected.SubmittedReferenceID {
		t.Errorf("SubmittedReferenceID = %q, want %q",
			result.SubmittedReferenceID, expected.SubmittedReferenceID)
	}
	if result.Payment.Status != expected.PaymentStatus {
		t.Errorf("Status = %q, want %q", result.Payment.Status, expected.PaymentStatus)
	}
	if result.RedirectURL != expected.Action.URL {
		t.Errorf("RedirectURL = %q, want %q", result.RedirectURL, expected.Action.URL)
	}
	if _, ok := capturedBody["customerInfo"]; !ok {
		t.Error("request body is missing customerInfo")
	}
	if _, ok := capturedBody["collectionRequest"]; !ok {
		t.Error("request body is missing collectionRequest")
	}
}

func TestRetrieveSingleAttemptByDefault(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if got := r.URL.Query().Get("referenceId"); got != "order-1" {
			t.Errorf("referenceId query = %q", got)
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	_, err := testClient(t, server).Payments.Retrieve(context.Background(), "order-1", nil)
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != CodeProvider {
		t.Fatalf("err = %v, want a provider *Error", err)
	}
	if typed.NextStep != NextRetryStatus {
		t.Errorf("NextStep = %q, want retry_status", typed.NextStep)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("default Retrieve made %d requests, want 1", got)
	}
}

func TestRetrieveRetriesWhenOptedIn(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"status": "Successful"}`))
	}))
	defer server.Close()

	transaction, err := testClient(t, server).Payments.Retrieve(
		context.Background(), "order-1", &RetrieveOptions{MaxAttempts: 3},
	)
	if err != nil {
		t.Fatalf("Retrieve failed: %v", err)
	}
	if transaction.Status != "Successful" || requests.Load() != 2 {
		t.Errorf("status=%q after %d requests, want Successful after 2",
			transaction.Status, requests.Load())
	}
}

func TestRetrieveDoesNotRetryDefiniteAnswers(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	_, err := testClient(t, server).Payments.Retrieve(
		context.Background(), "missing", &RetrieveOptions{MaxAttempts: 4},
	)
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != CodeNotFound {
		t.Fatalf("err = %v, want CodeNotFound", err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("a 404 was retried %d times; definite answers must not retry", got)
	}
}

func TestRetrieveValidatesMaxAttempts(t *testing.T) {
	client, err := New(Config{APIKey: "lsk_test"})
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}
	for _, attempts := range []int{1, 7, -2} {
		_, err := client.Payments.Retrieve(
			context.Background(), "order-1", &RetrieveOptions{MaxAttempts: attempts},
		)
		var typed *Error
		if !errors.As(err, &typed) || typed.Code != CodeValidation {
			t.Fatalf("MaxAttempts=%d: err = %v, want validation error", attempts, err)
		}
	}
}

func TestContextCancellationBeforeDispatch(t *testing.T) {
	client, err := New(Config{APIKey: "lsk_test"})
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, createErr := client.Payments.MobileMoney.Create(ctx, validMobileMoneyRequest())
	var typed *Error
	if !errors.As(createErr, &typed) || typed.Code != CodeCanceled {
		t.Fatalf("err = %v, want CodeCanceled", createErr)
	}
	if typed.Outcome != OutcomeNotStarted {
		t.Errorf("Outcome = %q, want not_started before dispatch", typed.Outcome)
	}
	if !errors.Is(createErr, context.Canceled) {
		t.Error("errors.Is(err, context.Canceled) = false, want the cause preserved")
	}
}
