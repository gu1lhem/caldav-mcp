# Self-hosting

Designed for homelab deployments. Compatible with Radicale, Baïkal, Xandikos, and any CalDAV server.

## Compile to binary (recommended)

```bash
deno compile -A --unstable-kv --output caldav-mcp jsr:@spy4x/caldav-mcp@1
./caldav-mcp                 # stdio (for MCP clients)
./caldav-mcp --http          # HTTP on 127.0.0.1:3000; needs MCP_BEARER_TOKEN, set HOST to listen elsewhere
```

`--unstable-kv` is needed only for OAuth, which keeps its tokens in Deno KV at `OAUTH_KV_PATH`.

## Docker

```yaml
services:
  caldav-mcp:
    build: https://github.com/spy4x/caldav-mcp.git#v1.5.0
    container_name: caldav-mcp
    restart: unless-stopped
    environment:
      - CALDAV_URL=http://radicale:5232
      - CALDAV_USERNAME=${CALDAV_USERNAME}
      - CALDAV_PASSWORD=${CALDAV_PASSWORD}
      - MCP_BEARER_TOKEN=${MCP_BEARER_TOKEN}
    ports:
      - "3000:3000"
    mem_limit: 64M
    cpus: 0.1
    networks:
      - proxy
```

## Systemd (bare metal)

```bash
# Install binary
sudo deno compile -A --unstable-kv --output /usr/local/bin/caldav-mcp \
  jsr:@spy4x/caldav-mcp@1

# Systemd service
cat > /etc/systemd/system/caldav-mcp.service << 'EOF'
[Unit]
Description=caldav-mcp server
After=network.target

[Service]
ExecStart=/usr/local/bin/caldav-mcp --http
Environment=CALDAV_URL=http://localhost:5232
Environment=CALDAV_USERNAME=user
Environment=CALDAV_PASSWORD=pass
Environment=PORT=3000
Environment=MCP_BEARER_TOKEN=<token>
Restart=always
MemoryMax=64M
CPUQuota=10%

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now caldav-mcp
```
