function normalizeTrigger(value) {
	return String(value || '').trim().toUpperCase();
}

function inferPermissionsFromMetadata(metadata) {
	const required = new Set();

	if (metadata && Array.isArray(metadata.watchRules) && metadata.watchRules.length > 0) {
		required.add('MANAGE_EXTERNAL_STORAGE');
	}

	const onList = metadata && Array.isArray(metadata.on) ? metadata.on : [];
	for (const eventName of onList) {
		const event = normalizeTrigger(eventName);
		if (event.startsWith('NET_') || event.startsWith('WIFI_')) {
			required.add('ACCESS_NETWORK_STATE');
		}
		if (event === 'GPS_ON' || event === 'GPS_OFF' || event === 'LOCATION_CHANGED') {
			required.add('ACCESS_FINE_LOCATION');
		}
	}

	return Array.from(required);
}

module.exports = {
	inferPermissionsFromMetadata,
};
