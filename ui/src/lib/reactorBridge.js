function getBridge() {
	if (typeof window === 'undefined') {
		return null;
	}
	return window.reactor || null;
}

function getMobilePlugin() {
	if (typeof window === 'undefined') {
		return null;
	}
	const plugins = window.Capacitor && window.Capacitor.Plugins ? window.Capacitor.Plugins : null;
	return plugins && plugins.ReactorMobile ? plugins.ReactorMobile : null;
}

function getCapacitorRuntime() {
	if (typeof window === 'undefined') {
		return null;
	}
	return window.Capacitor || null;
}

async function invokeNative(pluginName, methodName, options = {}) {
	const capacitor = getCapacitorRuntime();
	if (!capacitor || typeof capacitor.nativePromise !== 'function') {
		return null;
	}

	try {
		const raw = await capacitor.nativePromise(pluginName, methodName, options);
		if (!raw || typeof raw !== 'object') {
			return raw;
		}

		if (Object.prototype.hasOwnProperty.call(raw, 'ok') || Object.prototype.hasOwnProperty.call(raw, 'endpoints') || Object.prototype.hasOwnProperty.call(raw, 'path')) {
			return raw;
		}

		if (raw.value && typeof raw.value === 'object') {
			return raw.value;
		}

		if (raw.data && typeof raw.data === 'object') {
			return raw.data;
		}

		if (raw.result && typeof raw.result === 'object') {
			return raw.result;
		}

		return raw;
	} catch (error) {
		return { ok: false, error: error?.message || 'native bridge unavailable' };
	}
}

export {
	getBridge,
	getMobilePlugin,
	getCapacitorRuntime,
	invokeNative,
};