# FAQ

**Q: Does it work with Google Calendar?**
A: No. Google Calendar does offer a CalDAV API, but only behind OAuth 2.0, and caldav-mcp signs
in with a username and password (HTTP Basic auth) only.

**Q: Which CalDAV servers does it work with?**
A: I run it every day against Stalwart, and the README's picture shows an exchange with Radicale.
It signs in with HTTP Basic auth only, so a server set to Digest auth, such as Baïkal by default,
needs Basic turned on. Other servers are not tested yet. If one fails, open an issue with the
server's name and version.

**Q: Why not `deno run -A`?**
A: `-A` grants every permission. caldav-mcp needs only network access to your CalDAV server and read
access to its own settings, so the install commands grant exactly those; see the README's
[quick start](../README.md#quick-start).

**Q: Can it handle thousands of tasks?**
A: Yes. Responses are truncated at 200 items with `truncated: true` flag. AI can narrow filters.

**Q: Does it support CardDAV (contacts)?**
A: Not yet. Tasks + events only. PRs welcome.

**Q: Multi-user?**
A: Currently connects as one CalDAV user. For multi-user, run multiple instances.
