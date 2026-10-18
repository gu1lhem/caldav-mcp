# Self-hosting

Designed for homelab deployments. Tested with Stalwart and Radicale. caldav-mcp signs in with HTTP
Basic auth only, so a server set to Digest auth, such as Baïkal by default, needs Basic turned on.

## Compile to binary (recommended)

```bash
deno compile --unstable-kv --allow-net \
  --allow-env=CALDAV_URL,CALDAV_SERVER_URL,CALDAV_USERNAME,CALDAV_PASSWORD,CALDAV_MCP_TOOLS,CALDAV_MCP_TIME_ZONE,HOST,PORT,LOG_LEVEL,MCP_BEARER_TOKEN,ALLOW_BEARER_TOKEN_WITH_OAUTH,TRUSTED_PROXIES,PUBLIC_URL,OWNER_PASSWORD_HASH,AUTH_PEPPER,OAUTH_KV_PATH \
  --allow-read=/data --allow-write=/data \
  --output caldav-mcp jsr:@spy4x/caldav-mcp@1.6.0
./caldav-mcp                 # stdio (for MCP clients)
./caldav-mcp --http          # HTTP on 127.0.0.1:3000; needs MCP_BEARER_TOKEN, set HOST to listen elsewhere
```

The permissions are compiled into the binary. `--allow-net` lets it listen on its port and reach
your CalDAV server; name both (`--allow-net=cal.example.com,127.0.0.1:3000`) if you know them when
you compile. `--allow-env` lists the settings in [configuration.md](configuration.md).
`--unstable-kv`, `--allow-read=/data` and `--allow-write=/data` are needed only for OAuth, which
keeps its tokens in Deno KV at `OAUTH_KV_PATH` (default `/data/oauth.kv`); put a different path in
both flags if you change it.

## Docker

Every release is published to Docker Hub as `antonshubin/caldav-mcp`, tagged with its version
(and `latest`). It starts in HTTP mode on port 3000.

```bash
docker pull antonshubin/caldav-mcp:1.6.0
```

```yaml
services:
  caldav-mcp:
    image: antonshubin/caldav-mcp:1.6.0
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
# Install binary (no OAuth here; for OAuth add the flags from "Compile to binary" above)
sudo deno compile --allow-net=localhost:5232,127.0.0.1:3000 \
  --allow-env=CALDAV_URL,CALDAV_SERVER_URL,CALDAV_USERNAME,CALDAV_PASSWORD,CALDAV_MCP_TOOLS,CALDAV_MCP_TIME_ZONE,HOST,PORT,LOG_LEVEL,MCP_BEARER_TOKEN,ALLOW_BEARER_TOKEN_WITH_OAUTH,TRUSTED_PROXIES,PUBLIC_URL,OWNER_PASSWORD_HASH,AUTH_PEPPER,OAUTH_KV_PATH \
  --output /usr/local/bin/caldav-mcp jsr:@spy4x/caldav-mcp@1.6.0

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
