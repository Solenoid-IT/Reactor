const dns = require('dns');

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

/**
 * NetworkMonitor handles connectivity state and emits events
 */
class NetworkMonitor {
	constructor(onEventEmit) {
		this.lastConnectivity = null;
		this.networkInterval = null;
		this.onEventEmit = onEventEmit;
	}

	start(intervalMs = 5000) {
		this.networkInterval = setInterval(async () => {
			const isOnline = await checkInternetConnectivity();
			if (this.lastConnectivity === null) {
				this.lastConnectivity = isOnline;
				if (isOnline) {
					await this.onEventEmit('WIFI_ON');
					await this.onEventEmit('NET_ON');
				} else {
					await this.onEventEmit('WIFI_OFF');
					await this.onEventEmit('NET_OFF');
				}
				return;
			}

			if (this.lastConnectivity !== isOnline) {
				this.lastConnectivity = isOnline;
				if (isOnline) {
					await this.onEventEmit('WIFI_ON');
					await this.onEventEmit('NET_ON');
				} else {
					await this.onEventEmit('WIFI_OFF');
					await this.onEventEmit('NET_OFF');
				}
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

module.exports = { NetworkMonitor, checkInternetConnectivity };
