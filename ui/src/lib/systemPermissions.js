import rawAvailablePermissions from '../../../available-permissions.json';

function normalizePermissionName(value) {
	return String(value || '').trim();
}

export function normalizeSavedPermissionsConfig(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return {};
	}

	const normalized = {};
	for (const [platformName, entries] of Object.entries(input)) {
		const safePlatformName = String(platformName || '').trim();
		if (!safePlatformName || !Array.isArray(entries)) {
			continue;
		}

		normalized[safePlatformName] = entries
			.map((entry) => {
				if (!entry || typeof entry !== 'object') {
					return null;
				}

				const name = normalizePermissionName(entry.name);
				if (!name) {
					return null;
				}

				return {
					name,
					checked: Boolean(entry.checked),
				};
			})
			.filter(Boolean);
	}

	return normalized;
}

function normalizeAvailablePermissionsModel(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return {};
	}

	const normalized = {};
	for (const [platformName, entries] of Object.entries(input)) {
		const safePlatformName = String(platformName || '').trim();
		if (!safePlatformName || !Array.isArray(entries)) {
			continue;
		}

		const seen = new Set();
		normalized[safePlatformName] = entries
			.map((entry) => normalizePermissionName(typeof entry === 'string' ? entry : entry?.name))
			.filter((name) => {
				if (!name || seen.has(name)) {
					return false;
				}
				seen.add(name);
				return true;
			});
	}

	return normalized;
}

export const availablePermissionsModel = normalizeAvailablePermissionsModel(rawAvailablePermissions);

export function getCurrentRuntimePlatform() {
	const capacitorPlatform = globalThis?.window?.Capacitor?.getPlatform?.();
	if (capacitorPlatform === 'android') {
		return 'Android';
	}

	const userAgent = String(globalThis?.navigator?.userAgent || '').toLowerCase();
	if (userAgent.includes('mac os') || userAgent.includes('macintosh')) {
		return 'Mac';
	}
	if (userAgent.includes('windows')) {
		return 'Windows';
	}
	if (userAgent.includes('linux')) {
		return 'Linux';
	}

	return 'Mac';
}

export function buildPermissionsEntries(savedConfig, platformName) {
	const safePlatformName = String(platformName || '').trim();
	const config = normalizeSavedPermissionsConfig(savedConfig);
	const availablePermissions = Array.isArray(availablePermissionsModel[safePlatformName])
		? availablePermissionsModel[safePlatformName]
		: [];
	const savedEntries = Array.isArray(config[safePlatformName]) ? config[safePlatformName] : [];
	const savedMap = new Map(savedEntries.map((entry) => [entry.name, Boolean(entry.checked)]));

	return availablePermissions.map((name) => ({
		name,
		checked: Boolean(savedMap.get(name)),
	}));
}

export function mergePermissionsEntries(savedConfig, platformName, entries) {
	const safePlatformName = String(platformName || '').trim();
	const normalizedConfig = normalizeSavedPermissionsConfig(savedConfig);
	if (!safePlatformName) {
		return normalizedConfig;
	}

	normalizedConfig[safePlatformName] = Array.isArray(entries)
		? entries
			.map((entry) => {
				const name = normalizePermissionName(entry?.name);
				if (!name) {
					return null;
				}

				return {
					name,
					checked: Boolean(entry?.checked),
				};
			})
			.filter(Boolean)
		: [];

	return normalizedConfig;
}