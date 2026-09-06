package lipila

import (
	"os"
	"path/filepath"
	"testing"
)

// readFixture loads a conformance fixture. The fixtures' source of truth is
// spec/fixtures in the SDK monorepo; the standalone repository publish copies
// them into testdata/, so both locations are tried.
func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	for _, path := range []string{
		filepath.Join("testdata", name),
		filepath.Join("..", "..", "spec", "fixtures", name),
	} {
		if data, err := os.ReadFile(path); err == nil {
			return data
		}
	}
	t.Skipf("fixture %s unavailable", name)
	return nil
}
