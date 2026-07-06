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

- in `node` mode, for logical node targets (`node_name` and `node_name/endpoint_id`), Reactor first checks whether a connected P2P route already exists;
- if a connected P2P route exists, `Node.sendMessage(...)` and `Node.stream(...)` use DataChannel;
- otherwise, Reactor routes through `Exchange` relay.

For Network View remote endpoint discovery (clicking a non-current node), Reactor follows the same desktop/mobile strategy:

- first try `requestRemoteEndpointsP2P(...)` over DataChannel;
- if P2P fails or times out, fallback to Exchange discovery endpoint (`/nodes`).

Discovery responses expose `source` as `p2p-datachannel` or `exchange-discovery`.

Delivery results expose `deliveredVia`:

- `P2P_DIRECT`
- `P2P_RELAY`
- `EXCHANGE`

For `Node.sendMessage(...)`, queue fallback is opt-in:

- `enqueueOnFail=false` (default): delivery failure is returned immediately
- `enqueueOnFail=true`: payload is queued and retried later
