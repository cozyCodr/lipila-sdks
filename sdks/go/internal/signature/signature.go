// Package signature implements the cryptographic half of Lipila's webhook
// scheme: secret decoding and constant-time HMAC-SHA256 verification over
// "{id}.{timestamp}.{body}". Header extraction, timestamp policy, and
// payload classification stay with the caller.
package signature

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"

	"github.com/cozyCodr/lipila-go/internal/fault"
)

// DecodeSecret decodes a base64 (optionally whsec_-prefixed) webhook secret
// to its raw 32-byte key. Secrets are commonly read from mounted files or
// shell substitution, which leave a trailing newline, so surrounding
// whitespace is trimmed before validation.
func DecodeSecret(secret string) ([]byte, error) {
	malformed := &fault.Error{
		Code:      fault.CodeConfiguration,
		Operation: fault.OpVerifyWebhook,
		Outcome:   fault.OutcomeNotApplicable,
		NextStep:  fault.NextFixRequest,
		Message:   "WebhookSecret must be a base64-encoded 32-byte key (optionally prefixed with whsec_).",
	}

	value := strings.TrimSpace(secret)
	value = strings.TrimPrefix(value, "whsec_")
	if value == "" {
		return nil, malformed
	}

	padded := padBase64(value)
	key, err := base64.StdEncoding.DecodeString(padded)
	if err != nil || len(key) != 32 {
		return nil, malformed
	}
	// Round-trip to reject non-canonical encodings that would alias another
	// key, such as stray bits in the final character.
	if base64.StdEncoding.EncodeToString(key) != padded {
		return nil, malformed
	}
	return key, nil
}

// padBase64 restores the trailing = characters StdEncoding expects, so an
// unpadded but otherwise canonical input compares equal after round-trip.
func padBase64(value string) string {
	if remainder := len(value) % 4; remainder != 0 {
		return value + strings.Repeat("=", 4-remainder)
	}
	return value
}

// Valid reports whether any v1 signature in the header authenticates the
// body under any configured secret. The signed bytes are the UTF-8 form of
// "{id}.{timestamp}." followed by the untouched body, and every comparison
// is constant time.
func Valid(
	secrets [][]byte,
	id string,
	timestampHeader string,
	body []byte,
	signatureHeader string,
) bool {
	signatures := decodeSignatures(signatureHeader)
	prefix := []byte(id + "." + timestampHeader + ".")

	valid := false
	for _, key := range secrets {
		mac := hmac.New(sha256.New, key)
		mac.Write(prefix)
		mac.Write(body)
		expected := mac.Sum(nil)
		for _, candidate := range signatures {
			if hmac.Equal(expected, candidate) {
				valid = true
			}
		}
	}
	return valid
}

// decodeSignatures extracts every well-formed v1 signature from the
// space-delimited webhook-signature header. Entries with other versions or
// malformed base64 are skipped, not fatal: any single valid signature
// authenticates the delivery, which is how secret rotation overlaps.
func decodeSignatures(header string) [][]byte {
	var signatures [][]byte
	for _, entry := range strings.Fields(header) {
		version, encoded, found := strings.Cut(entry, ",")
		if !found || version != "v1" {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(decoded) != sha256.Size {
			continue
		}
		signatures = append(signatures, decoded)
	}
	return signatures
}
