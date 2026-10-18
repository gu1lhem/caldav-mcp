# MCP clients

The [README](../README.md#quick-start) configures Claude Desktop. This page covers running the
server without a client and the other clients.

## Run it directly

```bash
# One command — no npm install, no node_modules
CALDAV_URL=https://cal.example.com \
CALDAV_USERNAME=user \
CALDAV_PASSWORD=pass \
deno run --allow-net=cal.example.com \
  --allow-env=CALDAV_URL,CALDAV_SERVER_URL,CALDAV_USERNAME,CALDAV_PASSWORD,CALDAV_MCP_TOOLS,CALDAV_MCP_TIME_ZONE,HOST,PORT,LOG_LEVEL,MCP_BEARER_TOKEN,ALLOW_BEARER_TOKEN_WITH_OAUTH,TRUSTED_PROXIES,PUBLIC_URL,OWNER_PASSWORD_HASH,AUTH_PEPPER,OAUTH_KV_PATH \
  jsr:@spy4x/caldav-mcp@1.6.0
```

`--allow-net` names the host of your `CALDAV_URL`, and `--allow-env` the settings in
[configuration.md](configuration.md); the server needs nothing else. The README explains each
permission in its [quick start](../README.md#quick-start).

## OpenCode

```json
{
  "mcp": {
    "caldav-mcp": {
      "type": "local",
      "command": ["./caldav-mcp"],
      "enabled": true
    }
  }
}
```

## OpenWebUI

```json
{
  "url": "http://caldav-mcp:3000/mcp",
  "type": "mcp",
  "auth_type": "bearer",
  "key": "your-token",
  "config": {"enable": true},
  "info": {
    "id": "caldav-mcp",
    "name": "CalDAV MCP",
    "description": "Tasks and events"
  }
}
```

## Cursor

Settings → Features → MCP → Add new MCP server:

| Field | Value |
|-------|-------|
| Name | `caldav-mcp` |
| Type | `command` |
| Command | `deno run --allow-net=cal.example.com --allow-env=CALDAV_URL,CALDAV_SERVER_URL,CALDAV_USERNAME,CALDAV_PASSWORD,CALDAV_MCP_TOOLS,CALDAV_MCP_TIME_ZONE,HOST,PORT,LOG_LEVEL,MCP_BEARER_TOKEN,ALLOW_BEARER_TOKEN_WITH_OAUTH,TRUSTED_PROXIES,PUBLIC_URL,OWNER_PASSWORD_HASH,AUTH_PEPPER,OAUTH_KV_PATH jsr:@spy4x/caldav-mcp@1.6.0` |
| Environment | `CALDAV_URL`, `CALDAV_USERNAME`, `CALDAV_PASSWORD` |
