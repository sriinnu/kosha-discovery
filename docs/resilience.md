# Resilience

Kosha is designed to degrade gracefully and auto-heal when providers are unavailable.

## Circuit Breaker

Each provider has an independent circuit breaker with three states:

- **Closed** (healthy) — requests pass through normally
- **Open** (failing) — after 3 consecutive failures, the provider is short-circuited for 60 seconds
- **Half-Open** (probing) — after cooldown, one probe request is allowed; success -> closed, failure -> open

## Stale Cache Fallback

When a provider fails during discovery, Kosha serves the last-known-good cached data (marked as stale) instead of returning nothing. This ensures your application always has model data, even during provider outages.

## Health Monitoring

```typescript
const kosha = await createKosha();

// Check provider health
const health = kosha.providerHealth();
// -> { anthropic: "closed", nvidia: "open", groq: "half-open", ... }

// Reset a provider's circuit breaker
kosha.resetHealth("nvidia");
```
