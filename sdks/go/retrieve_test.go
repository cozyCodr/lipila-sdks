package lipila

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestRetrieveRetriesTransportFaults(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				t.Fatal("test server does not support hijacking")
			}
			connection, _, err := hijacker.Hijack()
			if err != nil {
				t.Fatalf("hijack failed: %v", err)
			}
			_ = connection.Close()
			return
		}
		_, _ = w.Write([]byte(`{"status": "Successful"}`))
	}))
	defer server.Close()

	transaction, err := testClient(t, server).Payments.Retrieve(
		context.Background(), "order-1", &RetrieveOptions{MaxAttempts: 2},
	)
	if err != nil {
		t.Fatalf("Retrieve failed after a transient transport fault: %v", err)
	}
	if transaction.Status != "Successful" || requests.Load() != 2 {
		t.Errorf("status=%q after %d requests, want Successful after 2",
			transaction.Status, requests.Load())
	}
}

func TestRetrieveExhaustedTransportFaultsReturnTransportError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
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

	_, err := testClient(t, server).Payments.Retrieve(
		context.Background(), "order-1", &RetrieveOptions{MaxAttempts: 2},
	)
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != CodeTransport {
		t.Fatalf("err = %v, want CodeTransport after exhausted retries", err)
	}
	if typed.NextStep != NextRetryStatus {
		t.Errorf("NextStep = %q, want retry_status: reads stay safe to retry", typed.NextStep)
	}
}

func TestRetrieveRetriesUnparseableSuccessBodies(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			_, _ = w.Write([]byte(`{"message": "warming up, no status"}`))
			return
		}
		_, _ = w.Write([]byte(`{"status": "Pending"}`))
	}))
	defer server.Close()

	transaction, err := testClient(t, server).Payments.Retrieve(
		context.Background(), "order-1", &RetrieveOptions{MaxAttempts: 2},
	)
	if err != nil {
		t.Fatalf("Retrieve failed: %v", err)
	}
	if transaction.Status != "Pending" {
		t.Errorf("Status = %q, want Pending from the second attempt", transaction.Status)
	}
}

func TestRetrieveExhaustedParseFailuresReturnInvalidResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`no json here`))
	}))
	defer server.Close()

	_, err := testClient(t, server).Payments.Retrieve(
		context.Background(), "order-1", &RetrieveOptions{MaxAttempts: 2},
	)
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != CodeInvalidResponse {
		t.Fatalf("err = %v, want CodeInvalidResponse", err)
	}
}

func TestRetrieveCanceledContextSurfacesAsCanceled(t *testing.T) {
	client, err := New(Config{APIKey: "lsk_test"})
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, retrieveErr := client.Payments.Retrieve(ctx, "order-1", nil)
	var typed *Error
	if !errors.As(retrieveErr, &typed) || typed.Code != CodeCanceled {
		t.Fatalf("err = %v, want CodeCanceled", retrieveErr)
	}
	if !errors.Is(retrieveErr, context.Canceled) {
		t.Error("errors.Is(err, context.Canceled) = false, want the cause preserved")
	}
}

func TestRetrieveHonorsRetryAfterHeader(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			w.Header().Set("Retry-After", "0.01")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write([]byte(`{"status": "Successful"}`))
	}))
	defer server.Close()

	transaction, err := testClient(t, server).Payments.Retrieve(
		context.Background(), "order-1", &RetrieveOptions{MaxAttempts: 2},
	)
	if err != nil {
		t.Fatalf("Retrieve failed: %v", err)
	}
	if transaction.Status != "Successful" || requests.Load() != 2 {
		t.Errorf("status=%q after %d requests, want Successful after a paced retry",
			transaction.Status, requests.Load())
	}
}
