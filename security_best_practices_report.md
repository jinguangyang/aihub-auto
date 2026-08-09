# Security Best Practices Report

Date: 2026-07-31

## Executive Summary

The review found one high-severity browser-to-local-service trust-boundary
issue and two medium-severity console hardening issues. All three are fixed in
this branch with regression tests. The standalone router's exact runtime
dependency set has no known advisory in the OSV result. One moderate advisory
remains in a Koishi development/test-only transitive package and is rated low
for this repository's shipped router exposure.

The hardened router now rejects DNS rebinding Hosts and cross-site browser
requests before any UI, control, health, or proxy route runs. The embedded
console uses a per-response nonce CSP, cannot be framed, is not cached, and no
longer persists its password in browser storage.

## Scope and Method

- Reviewed TypeScript sources under `apps/router`, the embedded browser UI,
  proxy header handling, credential persistence, release build, and GitHub
  workflow.
- Searched for DOM injection, Web Storage secrets, dynamic code execution,
  subprocess execution, unsafe redirects, missing request boundaries, and
  credential leakage.
- Queried OSV on 2026-07-31 for all 174 exact npm package/version pairs parsed
  from `bun.lock`.
- Ran 194 Bun tests with 626 assertions and TypeScript checking on Bun 1.3.14.
- Built the Linux x64 release with `bun-linux-x64-baseline` and ran old-userland
  compatibility probes on the supplied Docker host.

## High Severity

### AAH-SEC-001: Browser Requests Could Reach the Unauthenticated Loopback Service

- Rule ID: AAH-SEC-001
- Severity: High
- Status: Fixed
- Location: `apps/router/src/server.ts:57` (`LOOPBACK_HOSTS`),
  `apps/router/src/server.ts:63` (`browserRequestProblem`), and
  `apps/router/src/server.ts:421` (guard before route dispatch)
- Evidence: On `origin/main`, `createServer().fetch` dispatched requests based
  only on URL path. Default loopback mode intentionally had no `uiPassword` or
  `proxyToken`. A malicious website could send simple cross-site requests to
  the local control/proxy service, while DNS rebinding could present an
  attacker-controlled Host that resolved to loopback. The fixed code checks:

```ts
if (
 LOOPBACK_HOSTS.has(normalizedHostname(config.listen.host)) &&
 !LOOPBACK_HOSTS.has(normalizedHostname(url.hostname))
) {
 return { status: 421, error: "请求主机与本机监听地址不匹配" };
}
```

It also rejects mismatched `Origin`, `Origin: null`, and
`Sec-Fetch-Site: cross-site`. A TLS reverse proxy is accepted only when its
exact external HTTP(S) origin is explicitly configured as `publicOrigin`;
client-supplied forwarded headers are not trusted.

- Impact: A malicious webpage opened by a logged-in user could trigger routing
  or credential/control actions against the local process. DNS rebinding could
  additionally make local responses readable under an attacker origin. This
  could consume paid API quota, alter router state, or replace the active
  AIHub token.
- Fix: Apply one browser request guard before every route. Reject non-loopback
  Hosts on a loopback listener with 421 and reject cross-site browser provenance
  with 403. Preserve headerless SDK/CLI traffic and authenticated reverse proxy
  deployments.
- Mitigation: Keep the default listener on loopback. For a network listener,
  retain the mandatory `proxyToken` and `uiPassword`, use TLS, preserve the
  original Host, and set `publicOrigin` to the one external HTTPS origin.
- False positive notes: Requests without browser provenance headers are not
  assumed malicious because OpenAI SDKs and health clients normally omit them.
  The Host check still protects default loopback mode from DNS rebinding.

## Medium Severity

### AAH-SEC-002: Console Password Persisted in Web Storage

- Rule ID: AAH-SEC-002 / JS-STORAGE-001
- Severity: Medium
- Status: Fixed
- Location: `apps/router/src/ui-auth.ts`, `apps/router/src/server.ts`, and
  `apps/router/src/ui.ts`
- Evidence: `origin/main` loaded and saved `aihub-auto-pass` through
  `localStorage`. The fixed UI exchanges a prompted value once at `/ctl/auth`
  and contains no console-password storage key. Its remaining `localStorage`
  use retains only the non-sensitive dismissed state of the first-run guide.
- Impact: Any same-origin script execution, browser extension with page access,
  or later console XSS could recover a long-lived control password. Persistence
  also left the password available after the operator closed and reopened the
  console.
- Fix: Exchange the password for a seven-day signed `HttpOnly`,
  `SameSite=Strict`, `/ctl`-scoped cookie. The password and cookie value remain
  unavailable to page JavaScript and are never stored in Web Storage. The
  signed expiry is checked server-side, and changing `uiPassword` invalidates
  existing sessions.
- Mitigation: Use a unique `uiPassword`, serve network deployments behind TLS,
  and keep the nonce CSP enabled.
- False positive notes: Web Storage is origin-scoped, but it is readable by all
  scripts executing on that origin and is therefore not an appropriate secret
  store.

### AAH-SEC-003: Credential Console Lacked Browser Security Headers

- Rule ID: AAH-SEC-003 / JS-CSP-001 / JS-CSP-002
- Severity: Medium
- Status: Fixed
- Location: `apps/router/src/server.ts:34` (`uiResponse`),
  `apps/router/src/server.ts:48`, and `apps/router/src/ui.ts:8`,
  `apps/router/src/ui.ts:68`, `apps/router/src/ui.ts:100`
- Evidence: `origin/main` served the embedded console with only
  `Content-Type`. The fixed response generates a cryptographically random nonce
  for the static style and script and sends:

```text
default-src 'none'; script-src 'nonce-...'; style-src 'nonce-...';
connect-src 'self'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'; object-src 'none'
```

It also sends `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
JSON control and error responses default to `Cache-Control: no-store`.

- Impact: Without CSP and framing protection, a future injection defect would
  have a larger execution surface and the control UI could be embedded for
  clickjacking. Sensitive status/control responses could also be retained by
  browser or intermediary caches.
- Fix: Deliver a nonce-based CSP and focused security headers from the Bun
  server. Validate nonce syntax before inserting it into the embedded template.
- Mitigation: Keep the console free of third-party scripts and avoid adding
  `unsafe-inline` or `unsafe-eval` to the CSP.
- False positive notes: The existing dynamic `innerHTML` calls escape upstream
  text with `esc()` or use fixed application strings. They remain a review
  surface but no attacker-controlled value was found reaching an unescaped
  executable sink.

## Low Severity and Residual Risk

### AAH-DEP-001: Development Dependency Contains an ASF Parser DoS Advisory

- Rule ID: AAH-DEP-001
- Severity: Low repository exposure (OSV advisory severity: Moderate)
- Status: Open residual dependency risk
- Location: `bun.lock:49` and `bun.lock:211`
- Evidence: The 2026-07-31 OSV batch query returned exactly one finding among
  174 exact packages: `file-type@16.5.4`,
  `GHSA-5v7r-6r5c-r473` / `CVE-2026-31808`. A malformed ASF sub-header can make
  the parser loop indefinitely. The dependency arrives through
  `@cordisjs/plugin-http@0.6.3` in the Koishi development/test graph.
- Impact: A process that passes untrusted media to the affected detector could
  suffer event-loop denial of service. The standalone `aihub-auto` router does
  not import or bundle `file-type`, and this repository's Koishi plugin does not
  call it, so no shipped router attack path was identified.
- Fix: No forced override was applied. The fixed `file-type` version is a
  breaking major release outside the current Koishi dependency range. Update
  when the Koishi/Cordis dependency chain adopts a compatible patched version.
- Mitigation: Koishi hosts should avoid passing untrusted media to the affected
  file detector without isolation/timeouts and should track the upstream
  dependency update.
- False positive notes: This is a real vulnerable package in the lockfile, but
  the project-specific severity is reduced because it is not in the standalone
  router bundle and no plugin call path was found.

## Linux Compatibility Results

The Linux x64 artifact uses `bun-linux-x64-baseline`, which removes the AVX2
requirement for older x86-64 CPUs. Docker tests share the Ubuntu 24.04 host
kernel (6.17), so the following results establish userland/libc compatibility,
not old-kernel compatibility.

| Userland | libc | Image ID | Result |
| --- | --- | --- | --- |
| CentOS 7 / manylinux2014 | glibc 2.17 | `sha256:92f4005bb231...786d23` | `--help` and port 19090 `/healthz` pass |
| Debian 9 / manylinux_2_24 | glibc 2.24 | `sha256:a332ca25073b...91f9e` | `--help` and port 19091 `/healthz` pass |
| CentOS 6 / manylinux2010 | glibc 2.12 | `sha256:3b5eb5ab9bc7...66fb` | Unsupported: missing GLIBC 2.14/2.16/2.17 |
| CentOS 5 test image | glibc 2.5 | `sha256:f7a115141688...2e249` | Unsupported: missing GLIBC 2.6 through 2.17 |

Debian 10 and Alpine 3.18 images could not be pulled from Docker Hub because
that registry timed out from the supplied host. CentOS 7 establishes the
minimum successful glibc boundary at 2.17. Alpine is not claimed as supported
by this glibc release artifact.

## Verification Notes

- `bun install --frozen-lockfile`: pass with Bun 1.3.14.
- `bun test`: 194 pass, 0 fail, 626 assertions.
- `bunx tsc --noEmit -p tsconfig.json`: pass.
- `bun scripts/build.ts linux-x64`: pass on the supplied Linux host.
- Baseline artifact `--help` and non-default-port health smoke tests: pass.
- The Koishi test suite prints an existing Satori `dispose()` teardown
  exception while still reporting all tests passed and exit code 0. This branch
  does not change that dependency-owned behavior.
