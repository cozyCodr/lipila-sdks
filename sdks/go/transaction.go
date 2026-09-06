package lipila

import "github.com/cozyCodr/lipila-go/internal/wire"

// Transaction is a Lipila payment transaction as returned by collection
// creation, status lookup, and webhook payloads.
//
// Every field except Status is optional: Lipila's documentation shows the
// same object with different fields present in different examples, so absent
// fields are zero values, unknown statuses pass through verbatim, and Raw
// always preserves the complete provider body. The full field documentation
// lives on the underlying type in internal/wire.
type Transaction = wire.Transaction
