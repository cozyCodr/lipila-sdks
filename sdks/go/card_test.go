package lipila

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func validCardRequest() CardPaymentRequest {
	return CardPaymentRequest{
		ReferenceID:   "order-card-1",
		Amount:        100,
		Narration:     "Order 1",
		AccountNumber: "260000000000",
		ReferenceData: "cart-1",
		BackURL:       "https://merchant.example/payments/return",
		Customer: CardCustomer{
			FirstName:   "Jane",
			LastName:    "Doe",
			PhoneNumber: "260000000000",
			Email:       "jane@example.com",
			City:        "Lusaka",
			Country:     "ZM",
			Address:     "1 Example Road",
			Zip:         "10101",
		},
	}
}

func TestCardCreateValidatesInput(t *testing.T) {
	client, err := New(Config{APIKey: "lsk_test"})
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}

	cases := []struct {
		name    string
		mutate  func(*CardPaymentRequest)
		wantErr string
	}{
		{
			name:    "missing reference data",
			mutate:  func(r *CardPaymentRequest) { r.ReferenceData = "" },
			wantErr: "ReferenceData",
		},
		{
			name:    "missing back url",
			mutate:  func(r *CardPaymentRequest) { r.BackURL = "" },
			wantErr: "BackURL",
		},
		{
			name:    "http back url",
			mutate:  func(r *CardPaymentRequest) { r.BackURL = "http://merchant.example/return" },
			wantErr: "HTTPS",
		},
		{
			name:    "missing customer first name",
			mutate:  func(r *CardPaymentRequest) { r.Customer.FirstName = "" },
			wantErr: "Customer.FirstName",
		},
		{
			name:    "missing customer zip",
			mutate:  func(r *CardPaymentRequest) { r.Customer.Zip = " " },
			wantErr: "Customer.Zip",
		},
		{
			name:    "bad currency",
			mutate:  func(r *CardPaymentRequest) { r.Currency = "kwacha" },
			wantErr: "Currency",
		},
		{
			name:    "zero amount",
			mutate:  func(r *CardPaymentRequest) { r.Amount = 0 },
			wantErr: "Amount",
		},
		{
			name:    "bad callback url",
			mutate:  func(r *CardPaymentRequest) { r.CallbackURL = "not-a-url" },
			wantErr: "absolute URL",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := validCardRequest()
			tc.mutate(&request)
			_, err := client.Payments.Card.Create(context.Background(), request)
			var typed *Error
			if !errors.As(err, &typed) || typed.Code != CodeValidation {
				t.Fatalf("err = %v, want a validation *Error", err)
			}
			if typed.Outcome != OutcomeNotStarted {
				t.Errorf("Outcome = %q, want not_started: nothing was sent", typed.Outcome)
			}
			if !strings.Contains(typed.Message, tc.wantErr) {
				t.Errorf("Message = %q, want it to mention %q", typed.Message, tc.wantErr)
			}
		})
	}
}
