# Use Haat from Claude, ChatGPT-style clients and any MCP client

Haat ships a local MCP server. Add it to your AI app, say "do kilo aata", approve on your own
screen, done. It runs on the local mock network: no real sellers, no real money.

## Try it in two minutes

You need Node.js 22.18 or newer.

    git clone https://github.com/techsaurabh-394/haat-gateway
    cd haat-gateway
    node src/mcp/main.ts        # speaks MCP on stdin/stdout; Ctrl+C to stop

### Claude Code

    claude mcp add haat -- node /full/path/to/haat-gateway/src/mcp/main.ts

### Claude Desktop (and other clients that read a JSON config)

    {
      "mcpServers": {
        "haat": { "command": "node", "args": ["/full/path/to/haat-gateway/src/mcp/main.ts"] }
      }
    }

Then ask: "Order 2 kilo aata and 1 litre doodh from Haat."

## What the agent can do

| Tool | What it does | Changes anything? |
| --- | --- | --- |
| `search_groceries` | Understands Hindi, Hinglish and other languages; returns offers and a suggested basket | No |
| `place_order` | Orders a basket from `search_groceries` after the person approves | Only with approval |
| `order_status` | Reads the state of an order | No |

## How approval works

1. The model calls `place_order`.
2. The gateway answers `approval_required` with the exact order summary.
3. The server sends an MCP **elicitation** request. Your client shows its own dialog with the
   summary: this is the person speaking, not the model.
4. Only an "accept" with `approve: true` repeats the request with that one operation and revision.
   Decline or cancel orders nothing.
5. A retry or a timeout can never place a second order (the at-most-once gate in the gateway).

If your client does not support elicitation, `place_order` refuses and nothing is ordered. The
model cannot approve on your behalf, and it never sees Session JWTs or keys.

## Settings

| Variable | Meaning |
| --- | --- |
| `HAAT_URL` | Use an existing Haat gateway instead of starting the local mock network |
| `HAAT_DELIVERY` | Delivery JSON (name, phone, address, gps). Default is a demo address |

Real ONDC access is not covered by this; see [going-live](going-live.md).

## Poppy

A company's `poppy.json` can list MCP servers; this server is a personal-agent-side tool that
talks Poppy to the gateway, so any Poppy company, not just Haat, can sit behind it later.
