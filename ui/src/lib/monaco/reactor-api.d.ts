declare module 'core' {
	/** Mappa header HTTP custom da includere nelle chiamate Node. */
	export type HeadersMap = Record<string, string>;

	/**
	 * Opzioni addizionali per Node.sendMessage(...).
	 */
	export interface NodeSendMessageOptions {
		/** Header HTTP custom inviati verso il nodo target. */
		headers?: HeadersMap;
	}

	/**
	 * Opzioni per Node.stream(...).
	 */
	export interface NodeStreamOptions {
		/** Dimensione chunk in byte (best effort). */
		chunkSize?: number;
		/** Content-Type del flusso (es. application/octet-stream). */
		contentType?: string;
		/** Metadati opzionali allegati allo stream. */
		metadata?: Record<string, unknown>;
		/** Numero totale byte previsto, se noto. */
		totalBytes?: number;
		/** Header HTTP custom per stream diretto. */
		headers?: HeadersMap;
		/** ID stream forzato (altrimenti generato runtime). */
		streamId?: string;
	}

	export type NodeStreamSource =
		| ReadableStream<Uint8Array>
		| AsyncIterable<Uint8Array | Buffer | string | ArrayBuffer>
		| Iterable<Uint8Array | Buffer | string | ArrayBuffer>
		| Uint8Array
		| Buffer
		| string
		| ArrayBuffer;

	export interface NodeStreamResponse {
		/** Target originale passato alla chiamata. */
		target: string;
		/** Trasporto usato: direct (HTTP) o exchange (WS). */
		via: 'direct' | 'exchange';
		/** Identificativo univoco stream. */
		streamId: string;
		/** Numero chunk inviati. */
		chunks: number;
		/** Totale byte inviati. */
		totalBytes: number;
		/** Digest SHA-256 payload lato sender. */
		digestSha256: string;
	}

	export interface NodeSendMessageResponse {
		/** Target originale passato alla chiamata. */
		target: string;
		/** Endpoint HTTP usato se disponibile. */
		endpoint?: string;
		/** Status HTTP se il trasporto e' diretto. */
		status?: number;
		/** Header risposta se disponibili. */
		headers?: HeadersMap;
		/** Body risposta se disponibile. */
		body?: string;
		/** Trasporto usato quando noto. */
		via?: 'direct' | 'exchange';
		/** true se il messaggio e' stato messo in coda. */
		queued?: boolean;
		/** Motivazione sintetica in caso queue/fallback. */
		reason?: string;
	}

	export interface NodeExchangeSendMessageResponse {
		target: string;
		via: 'exchange';
		queued: true;
	}

	export interface NodeExchangeApi {
		/**
		 * Invia un messaggio forzando il canale Exchange.
		 *
		 * @param target Formati supportati:
		 * - node_name
		 * - node_name/script_uuid
		 * - host_or_ip:port
		 * - host_or_ip:port/script_uuid
		 */
		sendMessage: (
			target: string,
			content: string | Uint8Array | Buffer | Record<string, unknown>,
		) => Promise<NodeExchangeSendMessageResponse>;

		/**
		 * Invia uno stream forzando il canale Exchange.
		 *
		 * @param target Formati supportati:
		 * - node_name
		 * - node_name/script_uuid
		 * - host_or_ip:port
		 * - host_or_ip:port/script_uuid
		 */
		stream: (
			target: string,
			source: NodeStreamSource,
			options?: Omit<NodeStreamOptions, 'headers'>,
		) => Promise<NodeStreamResponse>;
	}

	export interface NodeApi {
		/**
		 * Invia un messaggio verso un nodo Reactor.
		 *
		 * @param target Formati supportati:
		 * - node_name
		 * - node_name/script_uuid
		 * - host_or_ip
		 * - host_or_ip:port
		 * - host_or_ip/script_uuid
		 * - host_or_ip:port/script_uuid
		 *
		 * Se e' presente /script_uuid, il messaggio viene indirizzato al solo progetto target.
		 */
		sendMessage: (
			target: string,
			content: string | Uint8Array | Buffer | Record<string, unknown>,
			options?: NodeSendMessageOptions,
		) => Promise<NodeSendMessageResponse>;

		/**
		 * Invia uno stream binario/testuale verso un nodo Reactor.
		 *
		 * @param target Formati supportati:
		 * - node_name
		 * - node_name/script_uuid
		 * - host_or_ip
		 * - host_or_ip:port
		 * - host_or_ip/script_uuid
		 * - host_or_ip:port/script_uuid
		 */
		stream: (
			target: string,
			source: NodeStreamSource,
			options?: NodeStreamOptions,
		) => Promise<NodeStreamResponse>;

		/**
		 * Restituisce l'API Exchange esplicita (invio sempre via Exchange).
		 */
		exchange: () => NodeExchangeApi;
	}

	export type LogLevel = 'E' | 'W' | 'I' | 'D';
	/** Log su activity.log del runtime corrente. */
	export function log(message: string, type?: LogLevel): Promise<void> | void;
	/** API nodo disponibile globalmente negli script Reactor. */
	export const Node: NodeApi;
}

declare const Node: import('core').NodeApi;
declare function log(message: string, type?: import('core').LogLevel): Promise<void> | void;
