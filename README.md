# Porterman

> Your ports, delivered. Zero-config HTTPS tunnels powered by Cloudflare.

One command. Real HTTPS. No servers. No accounts. No configuration.

```bash
$ porterman expose 3000
https://random-words-here.trycloudflare.com -> http://localhost:3000
```

## How It Works

Porterman uses [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) to expose your local ports to the internet. It automatically:

1. Downloads the `cloudflared` binary (first run only)
2. Creates a Cloudflare Tunnel for each specified port
3. Assigns a public `*.trycloudflare.com` HTTPS URL to each port
4. Routes traffic from the public URL to your local service

No Cloudflare account needed. No public IP needed. No SSL certificates to manage. Works behind NAT, firewalls, and any network.

## Installation

```bash
npm install -g @mucan54/porterman
```

Requires Node.js 18+.

## Usage

### Expose a single port

```bash
porterman expose 3000
```

### Expose multiple ports

```bash
porterman expose 3000 8080 5173
# https://random-abc.trycloudflare.com -> http://localhost:3000
# https://random-def.trycloudflare.com -> http://localhost:8080
# https://random-ghi.trycloudflare.com -> http://localhost:5173
```

### Verbose mode

```bash
porterman expose 3000 --verbose
```

### All options

```
porterman expose [...ports]

Options:
  -v, --verbose    Log all tunnel activity
```

### Other commands

```bash
porterman status          # Show running instance info
porterman stop            # Stop running instance
porterman --help          # Show help
porterman --version       # Show version
```

## Features

- **Zero config** -- just specify the port(s)
- **Real HTTPS** -- Cloudflare handles TLS, no certificates needed
- **Works anywhere** -- behind NAT, firewalls, no public IP required
- **Multi-port** -- expose multiple services simultaneously
- **WebSocket support** -- full WS/WSS proxying
- **No account needed** -- uses Cloudflare Quick Tunnels (free)
- **Auto-install** -- downloads `cloudflared` binary automatically on first run
- **Cross-platform** -- works on macOS, Linux, and Windows

## Architecture

```
Internet Request
    |
    |  https://random-words.trycloudflare.com
    v
+-----------------------------+
|  Cloudflare Edge Network    |
|  (TLS termination, CDN,    |
|   DDoS protection)         |
+-----------------------------+
    |
    |  cloudflared tunnel
    v
+-----------------------------+
|  Your Machine (any network) |
|  localhost:3000             |
+-----------------------------+
```

## Programmatic API

```typescript
import { startServer } from "@mucan54/porterman";

const server = await startServer({
  ports: [3000, 8080],
  verbose: true,
});

// server.urls is a Map<number, string> of port -> URL
console.log(server.urls);

// Graceful shutdown
await server.close();
```

## Limitations

- Quick Tunnels have a 200 concurrent request limit per tunnel
- URLs are randomly generated and change each time
- No SLA or uptime guarantee from Cloudflare for free tunnels
- Server-Sent Events (SSE) are not supported on Quick Tunnels

## Requirements

- Node.js >= 18
- Internet connection (to reach Cloudflare)

## License

MIT
