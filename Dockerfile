# ── Multistage build: compile → distroless runtime ──
FROM denoland/deno:alpine-2.9.7 AS builder

WORKDIR /app
COPY . .

# Compile to static binary
# --unstable-kv: the OAuth store is Deno KV.
# --frozen: the build fails when deno.lock does not match deno.jsonc, instead of resolving afresh.
RUN deno compile -A --unstable-kv --frozen \
  --target x86_64-unknown-linux-gnu \
  --output /tmp/caldav-mcp \
  main.ts

# ── Runtime: distroless ──
FROM gcr.io/distroless/cc-debian12

COPY --from=builder /tmp/caldav-mcp /usr/local/bin/caldav-mcp

# Inside a container the server must listen on all interfaces; the port is published by Docker.
ENV HOST=0.0.0.0
EXPOSE 3000
# With OAuth on, grants and tokens live in /data/oauth.kv (OAUTH_KV_PATH): mount a writable volume.
VOLUME /data

ENTRYPOINT ["caldav-mcp"]
CMD ["--http"]
