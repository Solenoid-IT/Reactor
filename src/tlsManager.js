const fs = require('fs/promises');
const fsNative = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CERT_FILE = 'cert.pem';
const KEY_FILE = 'key.pem';

/**
 * TlsManager — gestisce i certificati TLS self-signed per Reactor.
 *
 * I certificati sono generati con openssl e salvati in:
 *   $REACTOR_DATA_DIR/tls/cert.pem
 *   $REACTOR_DATA_DIR/tls/key.pem
 *
 * Con TLS attivo:
 *  - HTTP server → HTTPS (stessa porta)
 *  - WebSocket exchange → WSS
 *  - Node.sendMessage tenta prima https:// (rejectUnauthorized: false)
 */
class TlsManager {
	constructor(tlsDir) {
		this.tlsDir = tlsDir;
		this.certPath = path.join(tlsDir, CERT_FILE);
		this.keyPath = path.join(tlsDir, KEY_FILE);
	}

	async hasCert() {
		try {
			await Promise.all([fs.access(this.certPath), fs.access(this.keyPath)]);
			return true;
		} catch {
			return false;
		}
	}

	/** Carica cert e key come stringhe PEM. Restituisce null se non esistono. */
	async loadCert() {
		try {
			const [cert, key] = await Promise.all([
				fs.readFile(this.certPath, 'utf8'),
				fs.readFile(this.keyPath, 'utf8'),
			]);
			return { cert, key };
		} catch {
			return null;
		}
	}

	/**
	 * Genera un certificato self-signed RSA-2048 valido 10 anni.
	 * Richiede openssl nel PATH (disponibile su macOS, Linux, e Windows con Git/OpenSSL).
	 * @param {string} reactorName - CN del certificato (nome del reactor)
	 */
	async generateCert(reactorName = 'reactor') {
		await fs.mkdir(this.tlsDir, { recursive: true });

		const safeCN = String(reactorName || 'reactor')
			.replace(/[^a-zA-Z0-9._-]/g, '-')
			.slice(0, 64) || 'reactor';

		try {
			execFileSync(
				'openssl',
				[
					'req', '-x509',
					'-newkey', 'rsa:2048',
					'-keyout', this.keyPath,
					'-out', this.certPath,
					'-days', '3650',
					'-nodes',
					'-subj', `/CN=${safeCN}`,
				],
				{ stdio: 'pipe' },
			);
		} catch (err) {
			const msg = err.stderr ? err.stderr.toString().trim() : err.message;
			throw new Error(`openssl non disponibile o generazione fallita: ${msg}`);
		}

		return this.getCertInfo();
	}

	/** Rimuove i file del certificato. */
	async deleteCert() {
		try { await fs.unlink(this.certPath); } catch { /* ignore */ }
		try { await fs.unlink(this.keyPath); } catch { /* ignore */ }
	}

	/**
	 * Ritorna informazioni sul certificato corrente.
	 * @returns {{ enabled: boolean, subject?: string, notAfter?: string, fingerprint?: string }}
	 */
	async getCertInfo() {
		if (!await this.hasCert()) {
			return { enabled: false };
		}

		try {
			const output = execFileSync(
				'openssl',
				[
					'x509',
					'-in', this.certPath,
					'-noout',
					'-subject', '-enddate', '-fingerprint', '-sha256',
				],
				{ encoding: 'utf8', stdio: 'pipe' },
			);

			const info = { enabled: true };
			for (const line of output.split('\n')) {
				if (line.startsWith('subject=')) {
					info.subject = line.replace('subject=', '').trim();
				} else if (line.startsWith('notAfter=')) {
					info.notAfter = line.replace('notAfter=', '').trim();
				} else if (line.includes('Fingerprint=')) {
					info.fingerprint = line.split('=').slice(1).join('=').trim();
				}
			}
			return info;
		} catch {
			return { enabled: true };
		}
	}
}

module.exports = { TlsManager };
