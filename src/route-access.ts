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

	// A failed live list fails the call too, even where a key is optional: the
	// key is still sent. A 401/403 is a refused key; anything else (a timeout,
	// a 5xx) is a provider that didn't answer.
	if (provider?.degradedReason) {
		const uncallableReason = isKeyRefusal(provider.degradedReason) ? "key-refused" : "unreachable";
		return { callable: false, credentialSource, keyVerified: false, uncallableReason };
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
		return { callable: false, credentialSource, keyVerified: false, uncallableReason: "no-key" };
	}
	// The key is only proven when the live list answered with it. A seed-only
	// provider, or a list that fell back to the catalog, never tested it.
	const keyVerified = provider.models.some((model) => model.source === "api");
	return { callable: true, credentialSource, keyVerified };
}

/** A 401 or 403 from the provider, or kosha's own refused-shared-key message. */
function isKeyRefusal(reason: string): boolean {
	return /\b40[13]\b|unauthori[sz]ed|forbidden|invalid[ _-]?(api[ _-]?)?key|refused/i.test(reason);
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
