# Stream Reliability Roadmap (Chunk-by-Chunk Resume)

## Goal
Implement application-level stream resume for `Node.stream(...)` so transfers can continue after transient disconnects, process restarts, or route changes (P2P direct, P2P relay, exchange), without re-sending the entire payload.

## Scope
- Add chunk-level acknowledgements and retransmission.
- Add sender/receiver stream state persistence.
- Add explicit resume handshake.
- Keep backward compatibility disabled by default unless both peers advertise support.

## Non-Goals (Phase 1)
- Parallel multi-path striping of a single stream.
- Delta compression or deduplicated content-addressed chunks.
- End-to-end encryption redesign (reuse existing transport guarantees).

## Current Baseline (Today)
- Streams use `start -> chunk -> end` envelopes.
- Delivery can be `P2P_DIRECT`, `P2P_RELAY`, or `EXCHANGE`.
- WebRTC DataChannel is reliable/ordered at SCTP transport level.
- There is no application-level resume, no per-chunk ACK, no persisted cursor.

## Design Overview

### Protocol Additions
Add control envelopes under `__reactorStreamControl: true`:

1. `resume-request`
- Fields: `streamId`, `senderNode`, `receiverNode`, `lastKnownAck`, `missingRanges`, `receiverSessionId`, `protocolVersion`.

2. `resume-response`
- Fields: `streamId`, `accepted`, `nextExpectedIndex`, `missingRanges`, `receiverStateVersion`, `reason`.

3. `chunk-ack`
- Fields: `streamId`, `highestContiguousAck`, `missingRanges`, `receivedCount`, `windowHint`.

4. `stream-abort`
- Fields: `streamId`, `reason`, `retryable`, `lastAck`.

### State Model

Sender persistent state (per `streamId`):
- `target`, `createdAt`, `updatedAt`, `contentType`, `metadata`.
- `totalBytes`, `totalChunksPlanned` (optional until known).
- `chunksSentBitmap` (or sparse range set).
- `chunksAckedBitmap` (or highest contiguous + sparse holes).
- `chunkStoreRef` (where raw chunk bytes can be replayed).
- `status`: `active | paused | completed | aborted`.

Receiver persistent state (per `streamId`):
- `sender`, `createdAt`, `updatedAt`.
- `chunksReceivedBitmap` (or ranges).
- `highestContiguousReceived`.
- `totalBytesReceived`.
- `expectedDigest` (from `end`, if already seen).
- `status`: `active | completed | aborted`.

### Storage Strategy
- Create a dedicated local folder for resumable stream state and chunk cache.
- Use append-only journal + periodic compaction.
- Keep bounded retention with TTL and max disk quota.

## Implementation Phases

## Phase 0 - Protocol/Contract Preparation
1. Define new envelope schemas and validation rules.
2. Add protocol version field and capability flag (`supportsStreamResumeV1`).
3. Extend typings in runtime API declarations.
4. Add feature flags:
	 - `REACTOR_STREAM_RESUME_ENABLED` (default `0`)
	 - `REACTOR_STREAM_RESUME_ACK_INTERVAL_CHUNKS` (default `32`)
	 - `REACTOR_STREAM_RESUME_ACK_INTERVAL_MS` (default `250`)
	 - `REACTOR_STREAM_RESUME_MAX_INFLIGHT_CHUNKS` (default `256`)
	 - `REACTOR_STREAM_RESUME_STATE_TTL_MS`

Deliverable:
- Protocol docs and type contracts merged.

## Phase 1 - Receiver ACK Engine
1. Track per-stream chunk reception bitmap/ranges in memory.
2. Emit periodic `chunk-ack` on chunk count/time thresholds.
3. Emit immediate ACK for gaps detected (out-of-order chunk arrivals).
4. Persist receiver cursor and gaps to disk.
5. Recover state on startup and continue ACKing resumed streams.

Deliverable:
- Receiver can tell sender exactly what it has and what is missing.

## Phase 2 - Sender Retransmission Engine
1. Introduce sender sliding window with max in-flight chunks.
2. Maintain retransmission queue for missing ranges from ACKs.
3. Retransmit with bounded retries and exponential backoff.
4. Persist sender state and chunk replay source.
5. Complete stream only when ACK confirms full contiguous delivery.

Deliverable:
- Sender guarantees eventual resend of missing chunks while stream is active.

## Phase 3 - Resume Handshake
1. On reconnect/fallback route change, sender emits `resume-request`.
2. Receiver returns `resume-response` with `nextExpectedIndex` and holes.
3. Sender resumes from receiver cursor, prioritizing missing ranges first.
4. If receiver has no state, sender restarts stream from index `0`.
5. If sender has no chunk cache, fail fast with actionable `stream-abort`.

Deliverable:
- Interrupted streams continue from checkpoint instead of full restart.

## Phase 4 - Route-Aware Continuity
1. Keep stream identity stable across `P2P_DIRECT`, `P2P_RELAY`, `EXCHANGE`.
2. Preserve ACK/retransmit state across transport switch.
3. Ensure idempotent receiver writes per `(streamId, chunkIndex)`.
4. Add dedup guard for duplicated `end` envelope.

Deliverable:
- Resume works even when route changes mid-transfer.

## Phase 5 - Hardening and Operations
1. Add metrics and logs:
	 - ack latency
	 - retransmissions
	 - resume success rate
	 - aborted streams by reason
2. Add cleanup jobs for stale state/chunk cache.
3. Add load and chaos tests (packet delay, disconnects, process restarts).
4. Tune defaults for chunk size/window/ack cadence.

Deliverable:
- Production-ready reliability profile with observability.

## Code Areas to Update

Primary runtime flow:
- `src/runtime.js`
	- `streamToNode(...)`
	- incoming stream packet handling path
	- control envelope dispatch for resume/ack/abort

P2P transport:
- `src/p2pDataChannelManager.js`
	- no protocol logic; only transport reliability/backpressure hooks as needed

Stream packet utilities:
- `src/runtime/streamPackets.js`
	- add builders/parsers for control envelopes and ACK/range encoding

Type contracts:
- `src/core.d.ts`
- `ui/src/lib/monaco/reactor-api.d.ts`

Docs:
- `docs/webrtc.md`
- `docs/node-communication.md`
- `README.md` (feature flag and behavior summary)

## Testing Plan

Unit tests:
- Range merge/split logic for missing chunks.
- ACK cursor updates with out-of-order arrivals.
- Retransmit scheduler behavior.
- Resume state serialization/deserialization.

Integration tests:
- Pause sender process mid-stream, restart, resume.
- Pause receiver process mid-stream, restart, resume.
- Force route switch P2P -> EXCHANGE and verify completion.
- Inject duplicate chunks and verify idempotent assembly.

Soak tests:
- Large file streams (GB scale).
- High concurrency (many simultaneous streamIds).
- Disk pressure and TTL cleanup verification.

## Risks and Mitigations
- Risk: state growth on disk.
	- Mitigation: strict TTL, quota, compaction.
- Risk: protocol drift between nodes.
	- Mitigation: capability negotiation + versioned envelopes.
- Risk: sender cache loss makes resume impossible.
	- Mitigation: explicit abort reason + fallback full restart policy.

## Rollout Plan
1. Ship disabled behind feature flag.
2. Enable in dev and staging with metrics.
3. Enable for selected nodes only.
4. Enable by default after stability threshold is reached.

## Definition of Done
- Stream interruption no longer forces full restart in supported paths.
- End-to-end completion verified after disconnect/reconnect/restart scenarios.
- No data corruption and no duplicate final payload.
- Metrics show stable retransmit and resume success rates.
