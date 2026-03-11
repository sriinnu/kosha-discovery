# Discovery Plane v1

`kosha-discovery` now exposes an additive v1 discovery contract for daemon and
engine consumers that need a stable, versioned shape instead of the older
route-oriented debug endpoints.

## What v1 Adds

- `schemaVersion` on every discovery-plane response
- canonical provider normalization via `providerId` and `canonicalProviderId`
- trusted capability taxonomy for engine consumers
- normalized provider health with auth/throttle/degraded/down states
- local runtime metadata for `ollama` and `llama.cpp`
- polling deltas and live watch support
- selection hints for `executionBinding` style consumers without taking over
  route authority

## Library Surface

The registry now exposes additive discovery helpers:

```ts
const registry = await createKosha();

const snapshot = registry.discoverySnapshot();
const delta = registry.discoveryDelta({ sinceCursor: snapshot.cursor });
const cheapest = registry.cheapestCandidates({ role: "embeddings" });
const binding = registry.executionBindingHints({
	role: "chat",
	preferLocalProviders: true,
});
```

For long-lived daemon consumers, `watchDiscovery()` yields the same delta shape
as the polling API:

```ts
for await (const delta of registry.watchDiscovery({ sinceCursor })) {
	console.log(delta.cursor, delta.changes.length);
}
```

## HTTP Surface

The old HTTP routes still exist. The new discovery-plane routes are additive:

- `GET /api/discovery`
- `GET /api/discovery/delta?sinceCursor=<cursor>`
- `GET /api/discovery/watch`
- `GET /api/discovery/cheapest`
- `GET /api/discovery/binding`

`/api/discovery/watch` is an SSE endpoint that emits `delta` events with the
same `DiscoveryDeltaV1` payload returned by `/api/discovery/delta`.

## Contract Notes

- Arrays are always present in the v1 payload.
- Unknown scalar values serialize as `null`.
- v1 is additive-only. New nullable fields are allowed; renames or removals
  require a new schema version.
- `kosha-discovery` still does not own final route policy. It reports
  candidates, health, and hints. Chitragupta still decides.
