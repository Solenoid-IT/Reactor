const dns = require('dns');
const os = require('os');

/**
 * Checks internet connectivity via DNS lookup
 * Returns boolean: true if online, false if offline
 */
function checkInternetConnectivity() {
	return new Promise((resolve) => {
		dns.lookup('example.com', (error) => {
			resolve(!error);
		});
	});
}

function inferTransportFromInterfaceName(name) {
	const raw = String(name || '').toLowerCase();
	if (!raw) {
		return 'unknown';
	}
	if (raw.startsWith('lo')) {
		return 'loopback';
	}
	if (/^(wlan|wifi|wl|en1|en2)/.test(raw)) {
		return 'wifi';
	}
	if (/^(wwan|cell|rmnet|pdp_ip|usb\d+)/.test(raw)) {
		return 'cellular';
	}
	if (/^(eth|en\d+)/.test(raw)) {
		return 'ethernet';
	}
	return 'unknown';
}

function collectNetworkSnapshot() {
	const interfaces = os.networkInterfaces();
	const rows = [];

	for (const [name, entries] of Object.entries(interfaces)) {
		for (const entry of entries || []) {
			if (!entry) {
				continue;
			}

			rows.push({
				name,
				family: String(entry.family || ''),
				address: String(entry.address || ''),
				netmask: String(entry.netmask || ''),
				cidr: String(entry.cidr || ''),
				mac: String(entry.mac || ''),
				internal: Boolean(entry.internal),
				transport: inferTransportFromInterfaceName(name),
			});
		}
	}

	rows.sort((a, b) => {
		const keyA = `${a.name}:${a.family}:${a.address}`;
		const keyB = `${b.name}:${b.family}:${b.address}`;
		return keyA.localeCompare(keyB);
	});

	const primary = rows.find((row) => !row.internal && row.family === 'IPv4')
		|| rows.find((row) => !row.internal)
		|| null;

	return {
		timestamp: new Date().toISOString(),
		online: rows.some((row) => !row.internal),
		primaryInterface: primary ? primary.name : null,
		primaryAddress: primary ? primary.address : null,
		subnet: primary ? primary.netmask || null : null,
		gateway: null,
		transport: primary ? primary.transport : 'unknown',
		signal: null,
		interfaces: rows,
	};
}

function buildSnapshotSignature(snapshot) {
	if (!snapshot || typeof snapshot !== 'object') {
		return '';
	}

	const stable = {
		online: Boolean(snapshot.online),
		primaryInterface: snapshot.primaryInterface || null,
		primaryAddress: snapshot.primaryAddress || null,
		subnet: snapshot.subnet || null,
		transport: snapshot.transport || 'unknown',
		interfaces: Array.isArray(snapshot.interfaces)
			? snapshot.interfaces.map((row) => ({
				name: row.name || '',
				family: row.family || '',
				address: row.address || '',
				netmask: row.netmask || '',
				mac: row.mac || '',
				internal: Boolean(row.internal),
				transport: row.transport || 'unknown',
			}))
			: [],
	};

	return JSON.stringify(stable);
}

/**
 * NetworkMonitor handles connectivity state and emits events
 */
class NetworkMonitor {
	constructor(onEventEmit) {
		this.lastConnectivity = null;
		this.lastSnapshot = null;
		this.lastSnapshotSignature = '';
		this.networkInterval = null;
		this.onEventEmit = onEventEmit;
	}

	start(intervalMs = 5000) {
		this.networkInterval = setInterval(async () => {
			const isOnline = await checkInternetConnectivity();
			const snapshot = collectNetworkSnapshot();
			const snapshotSignature = buildSnapshotSignature(snapshot);

			if (this.lastConnectivity === null) {
				this.lastConnectivity = isOnline;
				this.lastSnapshot = snapshot;
				this.lastSnapshotSignature = snapshotSignature;
				if (isOnline) {
					await this.onEventEmit('WIFI_ON');
					await this.onEventEmit('NET_UP');
				} else {
					await this.onEventEmit('WIFI_OFF');
					await this.onEventEmit('NET_DOWN');
				}
				await this.onEventEmit('NET_CHANGE', {
					reason: 'initial',
					previous: null,
					current: snapshot,
				});
				return;
			}

			if (this.lastConnectivity !== isOnline) {
				this.lastConnectivity = isOnline;
				if (isOnline) {
					await this.onEventEmit('WIFI_ON');
					await this.onEventEmit('NET_UP');
				} else {
					await this.onEventEmit('WIFI_OFF');
					await this.onEventEmit('NET_DOWN');
				}
			}

			if (this.lastSnapshotSignature !== snapshotSignature) {
				const previous = this.lastSnapshot;
				this.lastSnapshot = snapshot;
				this.lastSnapshotSignature = snapshotSignature;
				await this.onEventEmit('NET_CHANGE', {
					reason: 'changed',
					previous,
					current: snapshot,
				});
			}
		}, intervalMs);
	}

	stop() {
		if (this.networkInterval) {
			clearInterval(this.networkInterval);
			this.networkInterval = null;
		}
	}
}

module.exports = { NetworkMonitor, checkInternetConnectivity, collectNetworkSnapshot };
