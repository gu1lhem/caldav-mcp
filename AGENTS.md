# AGENTS.md — caldav-mcp

Read `README.md` first. The global agent instructions own Git Flow, review and cleanup; this
file adds what is specific to this repo.

## Releasing

Releases are cut in batches (#53): one version bump and one `v<version>` tag once the work in
flight has merged (the end of a session or a wave), not one per PR, or at once for a security or
data-loss fix. The tag's `publish` step retries a stalled `deno publish` itself, three attempts of
10 minutes each, and JSR skips a version it already has; restart the pipeline only after all
three fail.
