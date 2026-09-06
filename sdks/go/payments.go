package lipila

// This file is the payments API surface: request types, the two create
// services, status retrieval, and the outcome classification that keeps
// mutations safe. HTTP mechanics live in internal/transport, input rules in
// internal/validate, and body decoding in internal/wire.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/cozyCodr/lipila-go/internal/fault"
	"github.com/cozyCodr/lipila-go/internal/transport"
	"github.com/cozyCodr/lipila-go/internal/validate"
	"github.com/cozyCodr/lipila-go/internal/wire"
)

// MobileMoneyPaymentRequest describes one mobile-money collection. Field
// names stay provider-native; see the field comments for what Lipila
// documents about each.
type MobileMoneyPaymentRequest struct {
	// ReferenceID is the merchant's unique reference for this payment. It is
	// the handle for status lookup and for reconciliation after an
	// interrupted request, so persist it before calling Create.
	ReferenceID string
	// Amount is the amount to collect, sent as a JSON number exactly as
	// provided. It must be finite and greater than zero.
	Amount float64
	// Narration is the transaction description shown with the payment.
	Narration string
	// AccountNumber is the mobile-money account to debit, in international
	// format such as "260772352417". Lipila resolves the network itself.
	AccountNumber string
	// Currency defaults to "ZMW" when empty. Lipila documents "ZMW" and
	// "USD"; any other ISO-4217-shaped code is passed through.
	Currency string
	// Email optionally associates an email address with the transaction.
	Email string
	// ReferenceData optionally carries an additional description.
	ReferenceData string
	// CallbackURL optionally requests an asynchronous webhook for this
	// payment. HTTPS is required except for loopback hosts.
	CallbackURL string
}

// CardCustomer is the customer identity Lipila requires for card
// collections. Every field is required.
type CardCustomer struct {
	FirstName   string
	LastName    string
	PhoneNumber string
	Email       string
	City        string
	Country     string
	Address     string
	Zip         string
}

// CardPaymentRequest describes one card collection. Card payments return a
// hosted-checkout redirect: send the customer to CreatePaymentResult.
// RedirectURL to complete the charge.
type CardPaymentRequest struct {
	// ReferenceID is the merchant's unique reference for this payment.
	ReferenceID string
	// Amount is the amount to collect. It must be finite and greater than
	// zero.
	Amount float64
	// Narration is the transaction description.
	Narration string
	// AccountNumber is the customer account identifier Lipila requires. Do
	// not send a card PAN; card entry happens on Lipila's hosted page.
	AccountNumber string
	// ReferenceData is required for card collections; Lipila's card endpoint
	// marks it mandatory even though mobile money does not.
	ReferenceData string
	// BackURL is where the hosted checkout returns the customer afterwards.
	BackURL string
	// Customer identifies the paying customer. Every field is required.
	Customer CardCustomer
	// Currency defaults to "ZMW" when empty.
	Currency string
	// CallbackURL optionally requests an asynchronous webhook.
	CallbackURL string
}

// CreatePaymentResult reports an accepted collection request. Acceptance is
// not settlement: mobile-money collections start Pending until the customer
// approves the prompt, and card collections require the redirect.
type CreatePaymentResult struct {
	// SubmittedReferenceID echoes the reference the SDK sent, the value to
	// persist for status lookup and reconciliation.
	SubmittedReferenceID string
	// Payment is Lipila's transaction response.
	Payment *Transaction
	// RedirectURL is the hosted-checkout URL when the payment needs customer
	// redirection, and empty otherwise.
	RedirectURL string
}

// RetrieveOptions controls Payments.Retrieve.
type RetrieveOptions struct {
	// MaxAttempts enables bounded retries for transient failures (408, 429,
	// 5xx, and transport faults) with exponential backoff, honoring a server
	// Retry-After. Zero means a single attempt; otherwise the value must be
	// 2 through 6.
	MaxAttempts int
}

// PaymentsService creates collections and retrieves their status.
type PaymentsService struct {
	// MobileMoney creates mobile-money collections.
	MobileMoney *MobileMoneyService
	// Card creates card collections.
	Card *CardService

	client *Client
}

// MobileMoneyService creates mobile-money collections.
type MobileMoneyService struct{ client *Client }

// CardService creates card collections.
type CardService struct{ client *Client }

func newPaymentsService(client *Client) *PaymentsService {
	return &PaymentsService{
		MobileMoney: &MobileMoneyService{client: client},
		Card:        &CardService{client: client},
		client:      client,
	}
}

// Create submits one mobile-money collection. On success the customer
// receives a PIN prompt and the returned transaction is normally Pending;
// poll Payments.Retrieve with the same referenceId for the outcome.
//
// Create never retries automatically. When it returns *UnknownOutcomeError,
// Lipila may have received the request: reconcile with Payments.Retrieve
// before submitting again, or a customer can be charged twice.
func (s *MobileMoneyService) Create(
	ctx context.Context,
	request MobileMoneyPaymentRequest,
) (*CreatePaymentResult, error) {
	const operation = OpCreateMobileMoneyPayment
	if err := validate.NonEmpty(request.ReferenceID, "ReferenceID", operation); err != nil {
		return nil, err
	}
	if err := validate.NonEmpty(request.Narration, "Narration", operation); err != nil {
		return nil, err
	}
	if err := validate.NonEmpty(request.AccountNumber, "AccountNumber", operation); err != nil {
		return nil, err
	}
	currency, err := validate.Currency(request.Currency, operation)
	if err != nil {
		return nil, err
	}
	if err := validate.Amount(request.Amount, operation); err != nil {
		return nil, err
	}
	callbackURL, err := validate.OptionalURL(request.CallbackURL, "CallbackURL", operation)
	if err != nil {
		return nil, err
	}

	body, err := json.Marshal(struct {
		ReferenceID   string  `json:"referenceId"`
		Amount        float64 `json:"amount"`
		Narration     string  `json:"narration"`
		AccountNumber string  `json:"accountNumber"`
		Currency      string  `json:"currency"`
		Email         string  `json:"email,omitempty"`
		ReferenceData string  `json:"referenceData,omitempty"`
	}{
		ReferenceID:   request.ReferenceID,
		Amount:        request.Amount,
		Narration:     request.Narration,
		AccountNumber: request.AccountNumber,
		Currency:      currency,
		Email:         request.Email,
		ReferenceData: request.ReferenceData,
	})
	if err != nil {
		return nil, fault.Validation(operation, "the request could not be encoded as JSON.")
	}

	return s.client.createPayment(ctx, createRequest{
		operation:   operation,
		referenceID: request.ReferenceID,
		endpoint:    "/api/v1/collections/mobile-money",
		body:        body,
		callbackURL: callbackURL,
	})
}

// Create submits one card collection. The result carries the hosted-checkout
// RedirectURL; the charge completes only after the customer finishes there.
//
// The same safety rule as mobile money applies: an *UnknownOutcomeError means
// the request may have reached Lipila, so reconcile by referenceId before
// submitting again.
func (s *CardService) Create(
	ctx context.Context,
	request CardPaymentRequest,
) (*CreatePaymentResult, error) {
	const operation = OpCreateCardPayment
	if err := validate.NonEmpty(request.ReferenceID, "ReferenceID", operation); err != nil {
		return nil, err
	}
	if err := validate.NonEmpty(request.Narration, "Narration", operation); err != nil {
		return nil, err
	}
	if err := validate.NonEmpty(request.AccountNumber, "AccountNumber", operation); err != nil {
		return nil, err
	}
	// Lipila documents referenceData as required for the card endpoint.
	if err := validate.NonEmpty(request.ReferenceData, "ReferenceData", operation); err != nil {
		return nil, err
	}
	currency, err := validate.Currency(request.Currency, operation)
	if err != nil {
		return nil, err
	}
	if err := validate.Amount(request.Amount, operation); err != nil {
		return nil, err
	}
	backURL, err := validate.URL(request.BackURL, "BackURL", operation)
	if err != nil {
		return nil, err
	}
	callbackURL, err := validate.OptionalURL(request.CallbackURL, "CallbackURL", operation)
	if err != nil {
		return nil, err
	}
	customerFields := []struct{ value, name string }{
		{request.Customer.FirstName, "Customer.FirstName"},
		{request.Customer.LastName, "Customer.LastName"},
		{request.Customer.PhoneNumber, "Customer.PhoneNumber"},
		{request.Customer.Email, "Customer.Email"},
		{request.Customer.City, "Customer.City"},
		{request.Customer.Country, "Customer.Country"},
		{request.Customer.Address, "Customer.Address"},
		{request.Customer.Zip, "Customer.Zip"},
	}
	for _, field := range customerFields {
		if err := validate.NonEmpty(field.value, field.name, operation); err != nil {
			return nil, err
		}
	}

	type customerWire struct {
		FirstName   string `json:"firstName"`
		LastName    string `json:"lastName"`
		PhoneNumber string `json:"phoneNumber"`
		Email       string `json:"email"`
		City        string `json:"city"`
		Country     string `json:"country"`
		Address     string `json:"address"`
		Zip         string `json:"zip"`
	}
	type collectionWire struct {
		ReferenceID   string  `json:"referenceId"`
		Amount        float64 `json:"amount"`
		Narration     string  `json:"narration"`
		AccountNumber string  `json:"accountNumber"`
		Currency      string  `json:"currency"`
		BackURL       string  `json:"backUrl"`
		ReferenceData string  `json:"referenceData"`
	}
	body, err := json.Marshal(struct {
		CustomerInfo      customerWire   `json:"customerInfo"`
		CollectionRequest collectionWire `json:"collectionRequest"`
	}{
		CustomerInfo: customerWire{
			FirstName:   request.Customer.FirstName,
			LastName:    request.Customer.LastName,
			PhoneNumber: request.Customer.PhoneNumber,
			Email:       request.Customer.Email,
			City:        request.Customer.City,
			Country:     request.Customer.Country,
			Address:     request.Customer.Address,
			Zip:         request.Customer.Zip,
		},
		CollectionRequest: collectionWire{
			ReferenceID:   request.ReferenceID,
			Amount:        request.Amount,
			Narration:     request.Narration,
			AccountNumber: request.AccountNumber,
			Currency:      currency,
			BackURL:       backURL,
			ReferenceData: request.ReferenceData,
		},
	})
	if err != nil {
		return nil, fault.Validation(operation, "the request could not be encoded as JSON.")
	}

	return s.client.createPayment(ctx, createRequest{
		operation:   operation,
		referenceID: request.ReferenceID,
		endpoint:    "/api/v1/collections/card",
		body:        body,
		callbackURL: callbackURL,
	})
}

// Retrieve looks up a collection by the referenceId submitted at creation.
// It performs a single GET unless options enables bounded retries. Reads are
// side-effect free, so retrying them is always safe.
func (s *PaymentsService) Retrieve(
	ctx context.Context,
	referenceID string,
	options *RetrieveOptions,
) (*Transaction, error) {
	const operation = OpRetrievePayment
	if err := validate.NonEmpty(referenceID, "referenceID", operation); err != nil {
		return nil, err
	}
	maxAttempts := 1
	if options != nil && options.MaxAttempts != 0 {
		if options.MaxAttempts < 2 || options.MaxAttempts > 6 {
			return nil, fault.Validation(operation, "MaxAttempts must be 2 through 6.")
		}
		maxAttempts = options.MaxAttempts
	}

	endpoint := s.client.baseURL.JoinPath("/api/v1/collections/check-status")
	query := url.Values{}
	query.Set("referenceId", referenceID)
	endpoint.RawQuery = query.Encode()

	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		status, body, header, err := s.client.transport.Do(
			ctx, http.MethodGet, endpoint.String(), nil, "",
		)
		if err != nil {
			if ctx.Err() != nil {
				return nil, &Error{
					Code:      CodeCanceled,
					Operation: operation,
					Outcome:   OutcomeNotApplicable,
					NextStep:  NextRetryStatus,
					Message:   "the request was stopped by the caller's context.",
					Err:       err,
				}
			}
			lastErr = &Error{
				Code:      CodeTransport,
				Operation: operation,
				Outcome:   OutcomeNotApplicable,
				NextStep:  NextRetryStatus,
				Message:   "the payment could not be retrieved from Lipila.",
				Err:       err,
			}
			if attempt+1 < maxAttempts {
				if sleepErr := transport.Sleep(ctx, transport.RetryDelay(attempt, 0)); sleepErr != nil {
					return nil, lastErr
				}
				continue
			}
			return nil, lastErr
		}

		if status >= 200 && status < 300 {
			transaction, parseErr := wire.ParseTransaction(body, operation)
			if parseErr == nil {
				return transaction, nil
			}
			lastErr = parseErr
			if attempt+1 < maxAttempts {
				if sleepErr := transport.Sleep(ctx, transport.RetryDelay(attempt, 0)); sleepErr != nil {
					return nil, lastErr
				}
				continue
			}
			return nil, lastErr
		}

		if transport.RetryableReadStatus(status) && attempt+1 < maxAttempts {
			delay := transport.RetryDelay(attempt, transport.ParseRetryAfter(header))
			if sleepErr := transport.Sleep(ctx, delay); sleepErr != nil {
				return nil, transport.HTTPError(operation, status, body, header, OutcomeNotApplicable)
			}
			continue
		}
		return nil, transport.HTTPError(operation, status, body, header, OutcomeNotApplicable)
	}
	return nil, lastErr
}

// createRequest carries one prepared mutation through the shared create path.
type createRequest struct {
	operation   Operation
	referenceID string
	endpoint    string
	body        []byte
	callbackURL string
}

// createPayment sends one collection POST and classifies the outcome. The
// classification is the heart of the SDK's safety model: a response proving
// the request was rejected surfaces as a normal error, while anything
// ambiguous (transport fault, 408, 5xx, unreadable success body) surfaces as
// *UnknownOutcomeError and is never retried here.
func (c *Client) createPayment(
	ctx context.Context,
	request createRequest,
) (*CreatePaymentResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, &Error{
			Code:      CodeCanceled,
			Operation: request.operation,
			Outcome:   OutcomeNotStarted,
			NextStep:  NextDoNotRetry,
			Message:   "the request was stopped by the caller's context before dispatch.",
			Err:       err,
		}
	}

	endpoint := c.baseURL.JoinPath(request.endpoint)
	status, body, header, err := c.transport.Do(
		ctx, http.MethodPost, endpoint.String(), request.body, request.callbackURL,
	)
	if err != nil {
		return nil, &UnknownOutcomeError{
			ReferenceID: request.referenceID,
			Operation:   request.operation,
			Message: "Lipila may have received the payment request. " +
				"Reconcile by referenceId before taking another action.",
			Err: err,
		}
	}

	if status == http.StatusRequestTimeout || status >= 500 {
		return nil, &UnknownOutcomeError{
			ReferenceID: request.referenceID,
			Operation:   request.operation,
			HTTPStatus:  status,
			Message: "Lipila returned an ambiguous response. " +
				"Reconcile by referenceId before taking another action.",
		}
	}

	if status < 200 || status >= 300 {
		return nil, transport.HTTPError(request.operation, status, body, header, OutcomeNotStarted)
	}

	transaction, parseErr := wire.ParseTransaction(body, request.operation)
	if parseErr != nil {
		return nil, &UnknownOutcomeError{
			ReferenceID: request.referenceID,
			Operation:   request.operation,
			Message: "Lipila accepted the request but returned an unreadable payment. " +
				"Reconcile by referenceId.",
			Err: parseErr,
		}
	}

	result := &CreatePaymentResult{
		SubmittedReferenceID: request.referenceID,
		Payment:              transaction,
	}
	if redirect := strings.TrimSpace(transaction.CardRedirectionURL); redirect != "" {
		result.RedirectURL = redirect
	}
	return result, nil
}
