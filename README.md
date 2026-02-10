# Porterman

> Your ports, delivered. Zero-config HTTPS for any local service.

One command. Real SSL. No external servers. No accounts. No BS.

```bash
$ porterman expose 3000
https://3000-85-100-50-25.sslip.io -> http://localhost:3000
```

## How It Works

Porterman runs on machines with a public IP (VPS, cloud instances, dedicated servers). It automatically:

1. Detects your public IP address
2. Obtains Let's Encrypt SSL certificates via ACME HTTP-01 challenge
3. Starts an HTTPS reverse proxy that routes based on hostname
4. Uses [sslip.io](https://sslip.io) for DNS — no configuration needed

The hostname pattern `{port}-{ip-dashed}.sslip.io` embeds both the port and IP, enabling multi-port exposure from a single instance.

## Installation

```bash
npm install -g porterman
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
# https://3000-85-100-50-25.sslip.io -> http://localhost:3000
# https://8080-85-100-50-25.sslip.io -> http://localhost:8080
# https://5173-85-100-50-25.sslip.io -> http://localhost:5173
```

### Custom subdomain name

```bash
porterman expose 3000 --name myapp
# https://myapp-85-100-50-25.sslip.io -> http://localhost:3000
```

### HTTP-only mode (skip SSL)

```bash
porterman expose 3000 --no-ssl
```

### With basic auth

```bash
porterman expose 3000 --auth user:pass
```

### Restrict by IP

```bash
porterman expose 3000 --ip-allow 1.2.3.4,5.6.7.8
```

### All options

```
porterman expose [...ports]

Options:
  -n, --name <name>        Custom subdomain prefix (single port only)
  --no-ssl                 HTTP only mode (skip SSL)
  -v, --verbose            Log all requests
  --timeout <seconds>      Proxy timeout (default: 30)
  --host <ip>              Override auto-detected IP
  --staging                Use Let's Encrypt staging environment
  --http-port <port>       Custom HTTP port (default: 80)
  --https-port <port>      Custom HTTPS port (default: 443)
  --auth <user:pass>       Enable basic auth
  --ip-allow <ips>         Comma-separated allowed IPs
```

### Other commands

```bash
porterman status          # Show running instance info
porterman stop            # Stop running instance
porterman certs --clean   # Remove all cached certificates
porterman --help          # Show help
porterman --version       # Show version
```

## Architecture

```
Internet Request
    |
    |  https://3000-85-100-50-25.sslip.io
    v
+-----------------------------+
|  Porterman HTTPS Server     |
|  (port 443)                 |
|                             |
|  TLS Termination            |
|  (Auto Let's Encrypt)       |
|         |                   |
|  Host-based Router          |
|                             |
|  3000-ip.sslip.io -> localhost:3000  |
|  8080-ip.sslip.io -> localhost:8080  |
+-----------------------------+
|  ACME HTTP-01 Server        |
|  (port 80)                  |
+-----------------------------+
```

## Features

- **Zero config** — just specify the port(s)
- **Real SSL** — automatic Let's Encrypt certificates
- **Multi-port** — expose multiple services simultaneously
- **WebSocket support** — full WS/WSS proxying (critical for HMR)
- **SNI routing** — per-hostname certificate serving
- **Auto IP detection** — with multiple fallback services
- **Cert caching** — certificates persist in `~/.porterman/certs/`
- **Self-signed fallback** — if Let's Encrypt rate limits are hit
- **Basic auth** — optional password protection
- **IP allowlist** — restrict access by source IP
- **Proxy headers** — X-Forwarded-For, X-Forwarded-Proto, X-Real-IP

## Requirements

- Node.js >= 18
- A machine with a public IP address
- Ports 80 and 443 available (or use `--http-port` / `--https-port`)

## Programmatic API

```typescript
import { startServer } from "porterman";

const server = await startServer({
  ports: [3000, 8080],
  verbose: true,
  timeout: 60,
});

// server.urls is a Map<number, string> of port -> URL
console.log(server.urls);

// Graceful shutdown
await server.close();
```

## License

MIT
