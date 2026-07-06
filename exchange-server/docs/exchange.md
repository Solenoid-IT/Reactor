# Exchange: What It Is For

`Exchange` is a central HTTP/WebSocket server that enables communication between Reactor nodes when they are on different networks (not on the same LAN).

In practice:

- on a LAN, nodes can often communicate directly through local endpoints;
- across the Internet or different private networks, NAT and firewalls can block direct connectivity;
- `Exchange` provides a common point for discovery, signaling, and message relay when direct delivery is not available.

## Runtime Behavior In Reactor

- Reactor routes logical node targets (`node_name` and `node_name/endpoint_id`) through `Exchange` relay.
- `Node.sendMessage(...)` and `Node.stream(...)` use HTTP/WebSocket delivery through Exchange.

For Network View remote endpoint discovery (clicking a non-current node), Reactor follows the same desktop/mobile strategy:

- Reactor queries the Exchange discovery flow for remote endpoints via the `/nodes` endpoint.

Discovery responses expose `source` as `exchange-discovery`.

Delivery results expose `deliveredVia`:

- `EXCHANGE`

For `Node.sendMessage(...)`, queue fallback is opt-in:

- `enqueueOnFail=false` (default): delivery failure is returned immediately
- `enqueueOnFail=true`: payload is queued and retried later
