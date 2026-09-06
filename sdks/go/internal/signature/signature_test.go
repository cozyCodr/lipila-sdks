package signature

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
)

const testSecret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="

func sign(t *testing.T, secretB64, id, timestamp string, body []byte) string {
	t.Helper()
	key, err := base64.StdEncoding.DecodeString(secretB64)
	if err != nil {
		t.Fatalf("decoding test secret: %v", err)
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(id + "." + timestamp + "."))
	mac.Write(body)
	return "v1," + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestDecodeSecret(t *testing.T) {
	t.Run("accepted spellings", func(t *testing.T) {
		for name, input := range map[string]string{
			"plain":            testSecret,
			"whsec prefix":     "whsec_" + testSecret,
			"unpadded":         strings.TrimRight(testSecret, "="),
			"surrounding gunk": "  " + testSecret + "\n",
		} {
			key, err := DecodeSecret(input)
			if err != nil || len(key) != 32 {
				t.Errorf("%s: DecodeSecret = (%d bytes, %v), want 32-byte key", name, len(key), err)
			}
		}
	})

	t.Run("rejected spellings", func(t *testing.T) {
		for name, input := range map[string]string{
			"empty":            "",
			"prefix only":      "whsec_",
			"not base64":       "!!definitely-not!!",
			"wrong length":     base64.StdEncoding.EncodeToString([]byte("short")),
			"non canonical":    strings.TrimRight(testSecret, "=")[:42] + "x",
			"inner whitespace": "AAECAwQFBgcICQoLDA0ODx AREhMUFRYXGBkaGxwdHh8=",
		} {
			if _, err := DecodeSecret(input); err == nil {
				t.Errorf("%s: DecodeSecret(%q) succeeded, want rejection", name, input)
			}
		}
	})
}

func TestValid(t *testing.T) {
	key, _ := DecodeSecret(testSecret)
	otherKey, _ := DecodeSecret(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	body := []byte(`{"status":"Successful"}`)
	good := sign(t, testSecret, "evt_1", "1700000000", body)

	t.Run("valid signature", func(t *testing.T) {
		if !Valid([][]byte{key}, "evt_1", "1700000000", body, good) {
			t.Fatal("valid signature rejected")
		}
	})
	t.Run("wrong key", func(t *testing.T) {
		if Valid([][]byte{otherKey}, "evt_1", "1700000000", body, good) {
			t.Fatal("signature accepted under the wrong key")
		}
	})
	t.Run("second configured secret matches", func(t *testing.T) {
		if !Valid([][]byte{otherKey, key}, "evt_1", "1700000000", body, good) {
			t.Fatal("rotation: signature rejected although a configured secret matches")
		}
	})
	t.Run("different id changes the signed bytes", func(t *testing.T) {
		if Valid([][]byte{key}, "evt_2", "1700000000", body, good) {
			t.Fatal("signature accepted for a different webhook id")
		}
	})
	t.Run("no signatures", func(t *testing.T) {
		if Valid([][]byte{key}, "evt_1", "1700000000", body, "") {
			t.Fatal("empty signature header accepted")
		}
	})
}

func TestDecodeSignaturesSkipsMalformedEntries(t *testing.T) {
	valid := "v1," + base64.StdEncoding.EncodeToString(make([]byte, 32))
	header := strings.Join([]string{
		"v2,ignored", // unsupported version
		"v1",         // no comma payload
		"v1,%%%",     // invalid base64
		"v1," + base64.StdEncoding.EncodeToString([]byte("short")), // wrong length
		valid,
	}, " ")
	signatures := decodeSignatures(header)
	if len(signatures) != 1 {
		t.Fatalf("decodeSignatures kept %d entries, want exactly the 1 well-formed one", len(signatures))
	}
}
