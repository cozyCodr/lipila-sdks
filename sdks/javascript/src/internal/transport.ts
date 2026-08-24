export interface TransportRequest {
  method: "GET" | "POST";
  url: URL;
  headers: Readonly<Record<string, string>>;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Headers;
  body: string;
}

export type TransportFailureKind = "aborted" | "timeout" | "network";

export class TransportFailure extends Error {
  readonly kind: TransportFailureKind;

  constructor(kind: TransportFailureKind, cause: unknown) {
    super(
      kind === "timeout"
        ? "The request timed out."
        : kind === "aborted"
          ? "The request was aborted."
          : "The request could not reach Lipila.",
      { cause },
    );
    this.name = "TransportFailure";
    this.kind = kind;
  }
}

export interface HttpTransport {
  send(request: TransportRequest): Promise<TransportResponse>;
}

export class FetchTransport implements HttpTransport {
  readonly #fetch: typeof globalThis.fetch;

  constructor(fetchImplementation: typeof globalThis.fetch) {
    this.#fetch = fetchImplementation;
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    if (request.signal?.aborted) {
      throw new TransportFailure("aborted", request.signal.reason);
    }

    const timeoutSignal = AbortSignal.timeout(request.timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;

    try {
      const response = await this.#fetch(request.url, {
        method: request.method,
        headers: request.headers,
        redirect: "error",
        signal,
        ...(request.body === undefined ? {} : { body: request.body }),
      });

      return {
        status: response.status,
        headers: response.headers,
        body: await response.text(),
      };
    } catch (cause) {
      const kind: TransportFailureKind = timeoutSignal.aborted
        ? "timeout"
        : request.signal?.aborted
          ? "aborted"
          : "network";
      throw new TransportFailure(kind, cause);
    }
  }
}
