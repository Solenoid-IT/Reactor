function splitBufferIntoChunks(buffer, chunkSize) {
	const safeChunkSize = Math.max(1024, Number(chunkSize) || 64 * 1024);
	const out = [];
	for (let offset = 0; offset < buffer.length; offset += safeChunkSize) {
		out.push(buffer.subarray(offset, Math.min(offset + safeChunkSize, buffer.length)));
	}
	return out;
}

function toBufferChunk(value) {
	if (Buffer.isBuffer(value)) {
		return value;
	}

	if (value instanceof Uint8Array) {
		return Buffer.from(value);
	}

	if (value instanceof ArrayBuffer) {
		return Buffer.from(new Uint8Array(value));
	}

	if (typeof value === 'string') {
		return Buffer.from(value, 'utf8');
	}

	if (value && typeof value === 'object' && value.buffer instanceof ArrayBuffer && Number.isFinite(value.byteLength)) {
		return Buffer.from(new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength));
	}

	throw new Error('stream chunk type not supported. expected Buffer, Uint8Array, ArrayBuffer or string');
}

async function* iterateStreamSourceChunks(source, chunkSize) {
	if (source === null || source === undefined) {
		throw new Error('invalid stream source');
	}

	const emitBuffer = async function* emitBufferChunks(raw) {
		const buffer = toBufferChunk(raw);
		if (buffer.length === 0) {
			return;
		}
		for (const chunk of splitBufferIntoChunks(buffer, chunkSize)) {
			yield chunk;
		}
	};

	if (
		Buffer.isBuffer(source)
		|| source instanceof Uint8Array
		|| source instanceof ArrayBuffer
		|| typeof source === 'string'
	) {
		yield* emitBuffer(source);
		return;
	}

	if (typeof source.getReader === 'function') {
		const reader = source.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				yield* emitBuffer(value);
			}
		} finally {
			if (typeof reader.releaseLock === 'function') {
				reader.releaseLock();
			}
		}
		return;
	}

	if (typeof source[Symbol.asyncIterator] === 'function') {
		for await (const value of source) {
			yield* emitBuffer(value);
		}
		return;
	}

	if (typeof source[Symbol.iterator] === 'function') {
		for (const value of source) {
			yield* emitBuffer(value);
		}
		return;
	}

	throw new Error('stream source not iterable/readable');
}

class IncomingStreamPacket {
	constructor(payload = {}) {
		this.payload = payload && typeof payload === 'object' ? payload : {};
	}

	getId() {
		return String(this.payload.streamId || '');
	}

	getPhase() {
		return String(this.payload.phase || '').toLowerCase();
	}

	isStart() {
		return this.getPhase() === 'start';
	}

	isChunk() {
		return this.getPhase() === 'chunk';
	}

	isEnd() {
		return this.getPhase() === 'end';
	}

	getMetadata() {
		const value = this.payload.metadata;
		return value && typeof value === 'object' ? value : {};
	}

	getContentType() {
		return String(this.payload.contentType || 'application/octet-stream');
	}

	getChunkIndex() {
		return Number.isFinite(Number(this.payload.index)) ? Number(this.payload.index) : -1;
	}

	getChunkSize() {
		return Number.isFinite(Number(this.payload.size)) ? Number(this.payload.size) : 0;
	}

	getBase64() {
		return String(this.payload.data || '');
	}

	readChunkBuffer() {
		if (!this.isChunk()) {
			return Buffer.alloc(0);
		}

		if (Buffer.isBuffer(this.payload.binary)) {
			return this.payload.binary;
		}

		if (this.payload.binary instanceof Uint8Array) {
			return Buffer.from(this.payload.binary);
		}

		return Buffer.from(this.getBase64(), 'base64');
	}

	readChunkText(encoding = 'utf8') {
		return this.readChunkBuffer().toString(encoding);
	}
}

class IncomingStreamEndInfo {
	constructor(payload = {}) {
		this.payload = payload && typeof payload === 'object' ? payload : {};
	}

	getId() {
		return String(this.payload.streamId || '');
	}

	getSender() {
		return String(this.payload.sender || '');
	}

	getPath() {
		return String(this.payload.path || '');
	}

	getBytes() {
		return Number.isFinite(Number(this.payload.totalBytes)) ? Number(this.payload.totalBytes) : 0;
	}

	getChunks() {
		return Number.isFinite(Number(this.payload.chunks)) ? Number(this.payload.chunks) : 0;
	}

	getDigestSha256() {
		return String(this.payload.digestSha256 || '');
	}

	isValid() {
		return Boolean(this.payload.valid !== false);
	}

	getError() {
		return String(this.payload.error || '');
	}

	getMetadata() {
		const value = this.payload.metadata;
		return value && typeof value === 'object' ? value : {};
	}
}

module.exports = {
	IncomingStreamEndInfo,
	IncomingStreamPacket,
	iterateStreamSourceChunks,
	splitBufferIntoChunks,
	toBufferChunk,
};