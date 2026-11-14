/**
 * kosha-discovery — can this machine call a route?
 *
 * kosha lists every route whether or not you hold a key. A key adds the
 * provider's live list and a check that the key works. This module turns
 * what discovery learned into one answer per provider: callable or not, and
 * why. Ranking (`cheapest`, ranked routes), MCP and the proxy all read it,
 * so they agree on what "a route you can call" means.
 * @module
 */

import { getProviderDescriptor, providerExecutionCredentialRequired } from "./provider-catalog.js";
import type { RegistryState } from "./registry-state.js";
import type { ModelCard, ProviderInfo, RouteAccess } from "./types.js";

/**
 * Access for one provider, from its discovery result.
 *
 * The order matters. A refused key also leaves `authenticated` true when the
 * models came from the last good cache, so the failure is checked first.
 * A Claude subscription OAuth token resolves as a credential, but it is for
 * Claude's own apps and is never sent on an API call.
 */
export function providerAccess(providerId: string, provider: ProviderInfo | undefined): RouteAccess {
	const credentialSource = provider?.credentialSource ?? "none";
	const descriptor = getProviderDescriptor(providerId);
	// No descriptor: kosha can't say what it needs, and the proxy has always
	// treated such a route as callable. Keep the two in step.
	const needsKey = descriptor ? providerExecutionCredentialRequired(descriptor) : false;

	// A refused key fails the call even where a key is optional: it is still
	// sent. Any other failed list (a timeout, a 5xx) says nothing about the key,
	// so one blip doesn't hide a working one; it only leaves the key unchecked.
	const degraded = provider?.degradedReason;
	if (degraded && isKeyRefusal(degraded)) {
		return { callable: false, credentialSource, keyVerified: false, uncallableReason: "key-refused" };
	}
	if (!needsKey) {
		if (provider?.unreachableReason) {
			return { callable: false, credentialSource, keyVerified: false, uncallableReason: "unreachable" };
		}
		return { callable: true, credentialSource, keyVerified: false };
	}
	if (credentialSource === "oauth") {
		return { callable: false, credentialSource, keyVerified: false, uncallableReason: "subscription-oauth" };
	}
	if (!provider?.authenticated || credentialSource === "none") {
		// A key was held, the list failed for another reason, and the catalog
		// stood in: the provider didn't answer, which is not the same as no key.
		const uncallableReason = degraded ? "unreachable" : "no-key";
		return { callable: false, credentialSource, keyVerified: false, uncallableReason };
	}
	// The key is only proven when the live list answered with it and the list
	// needs a key: OpenRouter and Vercel list publicly, so a junk key passes
	// there. A seed-only provider, or a list from the catalog, never tested it.
	const keyVerified =
		!degraded && descriptor?.credentialRequired === true && provider.models.some((model) => model.source === "api");
	return { callable: true, credentialSource, keyVerified };
}

/**
 * A 401/403 from the provider, a 400 that names the key (Google's
 * "API key not valid"), or kosha's own refused-shared-key message. Matched on
 * the status kosha writes, not on words in the provider's body, so a 502
 * "upstream connection refused" isn't read as a bad key.
 */
function isKeyRefusal(reason: string): boolean {
	return (
		/API error:\s*40[13]\b/.test(reason) ||
		/API error:\s*400\b.*(API[_ ]KEY[_ ]INVALID|API key not valid)/i.test(reason) ||
		/was refused by every provider that reads it/.test(reason)
	);
}

/** Access for the provider serving `model`. */
export function registryRouteAccess(state: RegistryState, model: Pick<ModelCard, "provider">): RouteAccess {
	return providerAccess(model.provider, state.providerMap.get(model.provider));
}

/**
 * One line on how to make a route callable, for agents and the CLI. Names
 * the env var a provider reads, so an agent can tell its user what to set.
 */
export function routeAccessHint(providerId: string, access: RouteAccess): string | undefined {
	if (access.callable) return undefined;
	const envVars = getProviderDescriptor(providerId)?.credentialEnvVars ?? [];
	const setKey = envVars.length > 0 ? `set ${envVars.join(" or ")}` : "configure a key";
	switch (access.uncallableReason) {
		case "key-refused":
			return `${providerId} refused the key on the last discovery: replace it (${setKey}), then refresh.`;
		case "subscription-oauth":
			return `Only a Claude subscription token was found, which can't make API calls: ${setKey}.`;
		case "unreachable":
			return `${providerId} didn't answer on the last discovery: start it or check the network, then refresh.`;
		default:
			return `No key for ${providerId}: ${setKey}.`;
	}
}
