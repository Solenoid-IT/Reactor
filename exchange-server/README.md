# Reactor Exchange Server

The Exchange server is the shared network layer used by Reactor nodes when direct P2P delivery is not available.

It has three core responsibilities:

- relay messages and streams between nodes
- act as the signaling server for WebRTC negotiation
- accept heartbeat traffic so nodes can verify Exchange availability

It also exposes operational HTTP endpoints:

- `GET /health` for service health and basic runtime status
- `GET /nodes` for the discovery snapshot of connected nodes

In practice, nodes use Exchange as the fallback path for `Node.sendMessage(...)`, `Node.stream(...)`, and WebRTC signaling when `P2P_DIRECT` or `P2P_RELAY` cannot be used.
