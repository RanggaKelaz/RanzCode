# Installer dependencies

`script/stage-installer.ts` refuses to build unless these files exist:

```
installer/deps/tor/tor.exe                  Tor Expert Bundle (Windows x86_64)
installer/deps/tor/geoip                    Tor's IPv4 country table
installer/deps/tor/geoip6                   Tor's IPv6 country table (optional)
installer/deps/impersonate/curl-impersonate.exe
installer/deps/impersonate/LICENSE
installer/deps/electron/electron.exe        Electron runtime (or a node_modules fallback)
```

They are third-party binaries and are intentionally not committed. Fetch them
with:

```powershell
bun run script/fetch-installer-deps.ts
bun run script/fetch-electron.ts
```

`fetch-installer-deps.ts` pins current stable Windows x64 Tor and
curl-impersonate builds and verifies their SHA-256. To review and use newer
binaries instead, override the URLs (and optional hashes):

```powershell
$env:TOR_EXPERT_URL="https://dist.torproject.org/torbrowser/<version>/tor-expert-bundle-windows-x86_64-<version>.tar.gz"
$env:CURL_IMPERSONATE_URL="https://github.com/lexiforest/curl-impersonate/releases/download/<version>/<asset>.tar.gz"
bun run script/fetch-installer-deps.ts
```

Tor is launched on demand by the sidecar; curl-impersonate is only used for
`opencode.ai` requests and falls back to native fetch when absent.
