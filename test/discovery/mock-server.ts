/**
 * Minimal mock helper that stubs global fetch for testing discoverers.
 *
 * Usage:
 *   mockFetch({ "https://api.example.com/models": { status: 200, body: { data: [] } } });
 *   // ... run tests ...
 *   restoreFetch();
 */

let originalFetch: typeof globalThis.fetch | undefined;

export function mockFetch(responses: Record<string, { status: number; body: any }>): void {
	originalFetch = globalThis.fetch;

	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

		// Check signal for abort (timeout simulation)
		if (init?.signal?.aborted) {
			const err = new DOMException("The operation was aborted.", "AbortError");
			throw err;
		}

		// Find a matching response by URL prefix
		const matchedKey = Object.keys(responses).find((key) => url.startsWith(key));

		if (!matchedKey) {
			throw new Error(`mockFetch: no mock configured for URL: ${url}`);
		}

		const mock = responses[matchedKey];

		return {
			ok: mock.status >= 200 && mock.status < 300,
			status: mock.status,
			statusText: statusTextForCode(mock.status),
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => mock.body,
			text: async () => JSON.stringify(mock.body),
		} as Response;
	}) as typeof globalThis.fetch;
}

/**
 * Create a mock that simulates a network error (e.g., ECONNREFUSED).
 */
export function mockFetchError(error: Error): void {
	originalFetch = globalThis.fetch;

	globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
		throw error;
	}) as typeof globalThis.fetch;
}

/**
 * Create a mock that simulates a timeout by never resolving (until AbortController fires).
 */
export function mockFetchTimeout(): void {
	originalFetch = globalThis.fetch;

	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		return new Promise<Response>((_resolve, reject) => {
			if (init?.signal) {
				init.signal.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted.", "AbortError"));
				});
			}
			// Never resolves — will be aborted by AbortController timeout
		});
	}) as typeof globalThis.fetch;
}

/**
 * Restore the original global fetch.
 */
export function restoreFetch(): void {
	if (originalFetch) {
		globalThis.fetch = originalFetch;
		originalFetch = undefined;
	}
}

function statusTextForCode(code: number): string {
	const map: Record<number, string> = {
		200: "OK",
		201: "Created",
		400: "Bad Request",
		401: "Unauthorized",
		403: "Forbidden",
		404: "Not Found",
		429: "Too Many Requests",
		500: "Internal Server Error",
	};
	return map[code] ?? "Unknown";
}
