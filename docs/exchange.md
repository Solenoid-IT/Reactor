# Exchange: What It Is For

`Exchange` is a central server that enables communication between Reactor nodes when they are on different networks (not on the same LAN).

In practice:

- on a LAN, nodes can often communicate directly through local endpoints;
- across the Internet or different private networks, NAT and firewalls can block direct connectivity;
- `Exchange` provides a common point for discovery, signaling, and message relay when direct delivery is not available.

## STUN/TURN Together With Exchange

When `STUN` and `TURN` are configured alongside `Exchange`, nodes can attempt real peer-to-peer communication over WebRTC DataChannel.

- `Exchange` handles signaling (offer/answer/candidate) between nodes;
- `STUN` helps nodes discover their public-facing endpoint and attempt direct peer connectivity;
- `TURN` provides relay transport when direct connectivity fails.

Result:

- when network conditions allow it, nodes use direct peering (P2P);
- when direct peering is not possible, traffic falls back to relay (`TURN` or `Exchange`, depending on configuration).

## Runtime Behavior In Reactor

- with both `STUN` and `TURN` configured, `Node.sendMessage(target, content, enqueueOnFail)` and `Node.stream()` prefer WebRTC DataChannel P2P;
- if `TURN` is not configured (or P2P is unavailable), Reactor uses `Exchange` as relay.

For `Node.sendMessage(...)`, queue fallback is opt-in:

- `enqueueOnFail=false` (default): delivery failure is returned immediately
- `enqueueOnFail=true`: payload is queued and retried later
