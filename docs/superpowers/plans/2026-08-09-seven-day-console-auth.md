# Seven-Day Console Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace repeated in-memory console-password prompts with a signed seven-day browser session while preserving header authentication and distinguishing AIHub login failures.

**Architecture:** A focused `ui-auth.ts` module signs and verifies stateless HMAC cookies and owns constant-time password checks. `server.ts` exposes `/ctl/auth`, accepts either the cookie or the existing header, and emits a unique `UI_AUTH_REQUIRED` code; the embedded page uses a single-flight authentication promise and never persists the password in JavaScript storage.

**Tech Stack:** TypeScript, Bun HTTP server and test runner, Node `crypto`, embedded HTML/JavaScript, Playwright CLI for browser verification.

## Global Constraints

- Session lifetime is exactly `604800` seconds (seven days).
- The cookie is `HttpOnly`, `SameSite=Strict`, `Path=/ctl`, and `Secure` when `publicOrigin` is HTTPS.
- `x-ui-password` remains supported for scripts and non-browser clients.
- Only `{code:"UI_AUTH_REQUIRED"}` may trigger a console-password prompt.
- Passwords and cookie values never enter logs, response messages, `localStorage`, or `sessionStorage`.
- All `/ctl/auth` and `/ctl/*` responses remain `Cache-Control: no-store`.
- Do not modify the unrelated `.playwright-cli/` or `output/` worktree content.

---

### Task 1: Stateless Console Session Helper

**Files:**
- Create: `apps/router/src/ui-auth.ts`
- Create: `apps/router/tests/ui-auth.test.ts`

**Interfaces:**
- Consumes: a configured `uiPassword`, `Request` headers, current Unix time, and whether the public origin is HTTPS.
- Produces: `UI_AUTH_COOKIE_NAME`, `UI_AUTH_MAX_AGE_SECONDS`, `safeSecretEqual(given, expected)`, `issueUiSession(password, secure, now, nonce)`, `uiSessionAuthorized(request, password, now)`, `uiControlAuthorized(request, password, now)`, and `clearUiSessionCookie(secure)`.

- [ ] **Step 1: Write the failing helper tests**

```ts
import { describe, expect, test } from "bun:test";
import {
	UI_AUTH_COOKIE_NAME,
	UI_AUTH_MAX_AGE_SECONDS,
	clearUiSessionCookie,
	issueUiSession,
	safeSecretEqual,
	uiControlAuthorized,
	uiSessionAuthorized,
} from "../src/ui-auth.ts";

describe("seven-day console authentication", () => {
	const password = "console-pass-123";
	const now = Date.UTC(2026, 7, 9, 0, 0, 0);

	test("issues an exact seven-day HttpOnly strict cookie", () => {
		const session = issueUiSession(password, false, now, "fixed-nonce");
		expect(session.expiresAt).toBe(now + UI_AUTH_MAX_AGE_SECONDS * 1000);
		expect(session.setCookie).toContain(`${UI_AUTH_COOKIE_NAME}=`);
		expect(session.setCookie).toContain("Path=/ctl");
		expect(session.setCookie).toContain("Max-Age=604800");
		expect(session.setCookie).toContain("HttpOnly");
		expect(session.setCookie).toContain("SameSite=Strict");
		expect(session.setCookie).not.toContain("; Secure");
		expect(issueUiSession(password, true, now, "fixed-nonce").setCookie)
			.toContain("; Secure");
	});

	test("accepts a valid cookie and rejects expiry, tampering, and password changes", () => {
		const { setCookie } = issueUiSession(password, false, now, "fixed-nonce");
		const cookie = setCookie.split(";", 1)[0]!;
		const request = new Request("http://localhost/ctl/status", {
			headers: { Cookie: cookie },
		});
		expect(uiSessionAuthorized(request, password, now + 1000)).toBe(true);
		expect(uiSessionAuthorized(request, password, now + 604_800_001)).toBe(false);
		expect(uiSessionAuthorized(request, "another-pass", now + 1000)).toBe(false);
		const tampered = new Request("http://localhost/ctl/status", {
			headers: { Cookie: `${cookie}x` },
		});
		expect(uiSessionAuthorized(tampered, password, now + 1000)).toBe(false);
	});

	test("retains header authentication and emits a clearing cookie", () => {
		const request = new Request("http://localhost/ctl/status", {
			headers: { "x-ui-password": password },
		});
		expect(uiControlAuthorized(request, password, now)).toBe(true);
		expect(uiControlAuthorized(request, undefined, now)).toBe(true);
		expect(safeSecretEqual("same", "same")).toBe(true);
		expect(safeSecretEqual("short", "different")).toBe(false);
		expect(clearUiSessionCookie(true)).toContain("Max-Age=0");
		expect(clearUiSessionCookie(true)).toContain("; Secure");
	});
});
```

- [ ] **Step 2: Run the helper test and verify it fails**

Run: `bun test apps/router/tests/ui-auth.test.ts`

Expected: FAIL because `../src/ui-auth.ts` does not exist.

- [ ] **Step 3: Implement the minimal signed-cookie helper**

```ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const UI_AUTH_COOKIE_NAME = "aihub_auto_ui_session";
export const UI_AUTH_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const UI_AUTH_VERSION = "v1";

function signature(payload: string, password: string): string {
	return createHmac("sha256", `aihub-auto-ui-session\0${password}`)
		.update(payload)
		.digest("base64url");
}

export function safeSecretEqual(given: string, expected: string): boolean {
	const left = Buffer.from(given);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(request: Request): string | undefined {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name === UI_AUTH_COOKIE_NAME) return value.join("=");
	}
	return undefined;
}

function cookieAttributes(secure: boolean): string {
	return `Path=/ctl; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function issueUiSession(
	password: string,
	secure: boolean,
	now = Date.now(),
	nonce = randomBytes(16).toString("base64url"),
): { expiresAt: number; setCookie: string } {
	const expiresAt = now + UI_AUTH_MAX_AGE_SECONDS * 1000;
	const payload = `${UI_AUTH_VERSION}.${expiresAt}.${nonce}`;
	const token = `${payload}.${signature(payload, password)}`;
	return {
		expiresAt,
		setCookie: `${UI_AUTH_COOKIE_NAME}=${token}; Max-Age=${UI_AUTH_MAX_AGE_SECONDS}; Expires=${new Date(expiresAt).toUTCString()}; ${cookieAttributes(secure)}`,
	};
}

export function uiSessionAuthorized(
	request: Request,
	password: string,
	now = Date.now(),
): boolean {
	const token = cookieValue(request);
	if (!token) return false;
	const parts = token.split(".");
	if (parts.length !== 4 || parts[0] !== UI_AUTH_VERSION) return false;
	const expiresAt = Number(parts[1]);
	if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
	const payload = parts.slice(0, 3).join(".");
	return safeSecretEqual(parts[3]!, signature(payload, password));
}

export function uiControlAuthorized(
	request: Request,
	password?: string,
	now = Date.now(),
): boolean {
	if (!password) return true;
	const header = request.headers.get("x-ui-password") ?? "";
	return safeSecretEqual(header, password) || uiSessionAuthorized(request, password, now);
}

export function clearUiSessionCookie(secure: boolean): string {
	return `${UI_AUTH_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${cookieAttributes(secure)}`;
}
```

- [ ] **Step 4: Run focused tests and type checking**

Run: `bun test apps/router/tests/ui-auth.test.ts`

Expected: 3 tests PASS.

Run: `bunx tsc --noEmit -p tsconfig.json`

Expected: exit code 0.

- [ ] **Step 5: Commit the helper**

```bash
git add apps/router/src/ui-auth.ts apps/router/tests/ui-auth.test.ts
git commit -m "feat: add signed console sessions"
```

### Task 2: Console Authentication HTTP Contract

**Files:**
- Modify: `apps/router/src/server.ts`
- Modify: `apps/router/tests/integration.test.ts`

**Interfaces:**
- Consumes: all exports from `apps/router/src/ui-auth.ts` produced by Task 1.
- Produces: `POST /ctl/auth`, `DELETE /ctl/auth`, cookie-or-header authorization for all other `/ctl/*` endpoints, `UI_AUTH_REQUIRED`, and `AIHUB_REAUTH_REQUIRED` response codes.

- [ ] **Step 1: Add failing integration cases for creation, use, clearing, and error separation**

Extend the existing `uiPassword 配置后` test with these exact assertions:

```ts
const unauthorized = await fetch(`${base}/ctl/status`);
expect(unauthorized.status).toBe(401);
expect(await unauthorized.json()).toEqual({
	code: "UI_AUTH_REQUIRED",
	error: "需要控制台口令",
});

const invalidAuth = await fetch(`${base}/ctl/auth`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ password: "wrong-password" }),
});
expect(invalidAuth.status).toBe(401);
expect(invalidAuth.headers.get("set-cookie")).toBeNull();

const auth = await fetch(`${base}/ctl/auth`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ password: "console-pass-123" }),
});
expect(auth.status).toBe(200);
expect(await auth.clone().json()).toMatchObject({ ok: true });
const setCookie = auth.headers.get("set-cookie")!;
expect(setCookie).toContain("Max-Age=604800");
expect(setCookie).toContain("HttpOnly");
const cookie = setCookie.split(";", 1)[0]!;
expect((await fetch(`${base}/ctl/status`, { headers: { Cookie: cookie } })).status)
	.toBe(200);

const cleared = await fetch(`${base}/ctl/auth`, {
	method: "DELETE",
	headers: { Cookie: cookie },
});
expect(cleared.status).toBe(200);
expect(cleared.headers.get("set-cookie")).toContain("Max-Age=0");
```

Add an AIHub failure assertion after authenticating with the cookie:

```ts
h.mock.expireToken = true;
const accountFailure = await fetch(`${base}/ctl/account`, {
	headers: { Cookie: cookie },
});
expect(accountFailure.status).toBe(401);
expect(await accountFailure.json()).toEqual({
	code: "AIHUB_REAUTH_REQUIRED",
	error: "读取 AIHub 账户信息失败",
});
```

- [ ] **Step 2: Run the integration case and verify it fails**

Run: `bun test apps/router/tests/integration.test.ts -t "uiPassword 配置后"`

Expected: FAIL because `/ctl/auth` is guarded as an unknown unauthenticated control route and unauthorized bodies lack `code`.

- [ ] **Step 3: Wire the auth endpoints and machine-readable failures**

In `server.ts`, import the helper and replace the local password comparator:

```ts
import {
	clearUiSessionCookie,
	issueUiSession,
	safeSecretEqual,
	uiControlAuthorized,
} from "./ui-auth.ts";

function secureUiCookie(config: AppConfig): boolean {
	return config.publicOrigin.startsWith("https://");
}

function uiAuthRequired(): Response {
	return json({ code: "UI_AUTH_REQUIRED", error: "需要控制台口令" }, 401);
}

async function handleUiAuth(req: Request, deps: ServerDeps): Promise<Response> {
	const secure = secureUiCookie(deps.config);
	if (req.method === "DELETE") {
		const response = json({ ok: true });
		response.headers.set("Set-Cookie", clearUiSessionCookie(secure));
		return response;
	}
	if (req.method !== "POST") {
		const response = json({ error: "仅支持 POST 或 DELETE" }, 405);
		response.headers.set("Allow", "POST, DELETE");
		return response;
	}
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return json({ error: "非法 JSON" }, 400);
	}
	if (!deps.config.uiPassword) return json({ ok: true, expiresAt: null });
	const password =
		typeof body === "object" && body !== null && !Array.isArray(body)
			? (body as Record<string, unknown>)["password"]
			: undefined;
	if (typeof password !== "string" || !safeSecretEqual(password, deps.config.uiPassword)) {
		return uiAuthRequired();
	}
	const session = issueUiSession(deps.config.uiPassword, secure);
	const response = json({ ok: true, expiresAt: session.expiresAt });
	response.headers.set("Set-Cookie", session.setCookie);
	return response;
}
```

At the top of `handleControl`, use:

```ts
if (!uiControlAuthorized(req, deps.config.uiPassword)) return uiAuthRequired();
```

For `/ctl/account` upstream `401`, return:

```ts
return json(
	error instanceof AIHubApiError && error.status === 401
		? { code: "AIHUB_REAUTH_REQUIRED", error: "读取 AIHub 账户信息失败" }
		: { error: "读取 AIHub 账户信息失败" },
	error instanceof AIHubApiError && error.status === 401 ? 401 : 502,
);
```

Dispatch the auth route before the generic guard:

```ts
if (path === "/ctl/auth") return handleUiAuth(req, deps);
if (path.startsWith("/ctl/")) return handleControl(req, url, deps);
```

- [ ] **Step 4: Run focused and complete router tests**

Run: `bun test apps/router/tests/ui-auth.test.ts apps/router/tests/integration.test.ts`

Expected: all tests PASS.

Run: `bunx tsc --noEmit -p tsconfig.json`

Expected: exit code 0.

- [ ] **Step 5: Commit the HTTP contract**

```bash
git add apps/router/src/server.ts apps/router/tests/integration.test.ts
git commit -m "feat: remember console authentication for seven days"
```

### Task 3: Single-Flight Browser Authentication

**Files:**
- Modify: `apps/router/src/ui.ts`
- Modify: `apps/router/tests/integration.test.ts`

**Interfaces:**
- Consumes: `/ctl/auth`, `UI_AUTH_REQUIRED`, and `status.config.uiAuthRequired` from Task 2.
- Produces: `authenticateUi()`, one shared `uiAuthPromise`, body-aware `api()`, the `forgetUiAuth` action, and seven-day status copy.

- [ ] **Step 1: Add failing rendered-UI assertions**

In the existing UI HTML assertions, add:

```ts
expect(html).toContain('id="uiAuthSessionRow"');
expect(html).toContain('id="forgetUiAuth"');
expect(html).toContain("验证后 7 天内免输控制台口令");
expect(html).toContain('let uiAuthPromise;');
expect(html).toContain('body.code==="UI_AUTH_REQUIRED"');
expect(html).toContain('fetch("/ctl/auth"');
expect(html).toContain('credentials:"same-origin"');
expect(html).not.toContain('let uiPass=""');
expect(html).not.toContain("aihub-auto-pass");
```

- [ ] **Step 2: Run the rendered-UI test and verify it fails**

Run: `bun test apps/router/tests/integration.test.ts -t "uiPassword 配置后"`

Expected: FAIL because the current page retains `uiPass` and retries every `401` through `prompt()`.

- [ ] **Step 3: Replace the page-level password with a single-flight session flow**

Add this settings row in the existing `客户端连接` panel:

```html
<div class="setting-row" id="uiAuthSessionRow" hidden><label>控制台免密</label><span class="setting-help">验证后 7 天内免输控制台口令。</span><button class="secondary mini" id="forgetUiAuth">清除免密登录</button></div>
```

Replace `uiPass`, `hdrs()`, and the current `api()` with:

```js
let uiAuthPromise;
function hdrs(){return {"Content-Type":"application/json"}}
async function readJson(response){try{return await response.json()}catch{return {error:String(response.status)}}}
async function authenticateUi(){
  const password=prompt("控制台口令:");
  if(password==null)throw new Error("需要控制台口令");
  const response=await fetch("/ctl/auth",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({password})});
  const body=await readJson(response);
  if(!response.ok)throw new Error(body.error||"控制台口令错误");
}
async function api(path,opts,retried=false){
  const response=await fetch(path,Object.assign({headers:hdrs(),credentials:"same-origin"},opts));
  const body=await readJson(response);
  if(response.status===401&&body.code==="UI_AUTH_REQUIRED"&&!retried){
    hideProxyToken();
    if(!uiAuthPromise)uiAuthPromise=authenticateUi().finally(()=>{uiAuthPromise=undefined});
    await uiAuthPromise;
    return api(path,opts,true);
  }
  if(!response.ok)throw new Error(body.error||String(response.status));
  return body;
}
async function forgetUiAuth(){
  const response=await fetch("/ctl/auth",{method:"DELETE",credentials:"same-origin"});
  if(!response.ok)throw new Error("清除免密登录失败");
  hideProxyToken();
  toast("免密登录已清除；下次请求需要重新验证");
}
```

In `render(status)`, toggle the row:

```js
$("#uiAuthSessionRow").hidden=!status.config.uiAuthRequired;
```

Register the action:

```js
$("#forgetUiAuth").addEventListener("click",event=>action(event.currentTarget,forgetUiAuth));
```

- [ ] **Step 4: Run UI-focused tests and type checking**

Run: `bun test apps/router/tests/integration.test.ts -t "uiPassword 配置后"`

Expected: PASS.

Run: `bun test apps/router/tests/ui-auth.test.ts apps/router/tests/integration.test.ts`

Expected: all tests PASS.

Run: `bunx tsc --noEmit -p tsconfig.json`

Expected: exit code 0.

- [ ] **Step 5: Commit the page flow**

```bash
git add apps/router/src/ui.ts apps/router/tests/integration.test.ts
git commit -m "feat: reuse browser console sessions"
```

### Task 4: Documentation and Browser Verification

**Files:**
- Modify: `README.md`
- Modify: `apps/router/README.md`
- Modify: `security_best_practices_report.md`

**Interfaces:**
- Consumes: the completed seven-day authentication behavior.
- Produces: accurate operator documentation and visual/browser evidence.

- [ ] **Step 1: Update operator and security documentation**

Add this behavior to the control-console documentation:

```md
输入正确的 `uiPassword` 后，浏览器会获得仅用于 `/ctl` 的 7 天免密会话；
会话到期、清除免密登录或修改 `uiPassword` 后需要重新验证。路由器不会把
控制台口令写入网页存储。
```

Replace the obsolete AAH-SEC-002 fix statement with:

```md
- Fix: The browser exchanges the password for a seven-day, signed `HttpOnly`,
  `SameSite=Strict`, `/ctl`-scoped cookie. The password and cookie value remain
  unavailable to page JavaScript and are never stored in Web Storage.
```

- [ ] **Step 2: Run documentation and source consistency checks**

Run: `rg -n "7 天|seven-day|HttpOnly|UI_AUTH_REQUIRED" README.md apps/router/README.md security_best_practices_report.md apps/router/src apps/router/tests`

Expected: matches in both docs, the helper/server/UI, and tests; no statement says every reload requires re-entering the password.

Run: `git diff --check`

Expected: exit code 0.

- [ ] **Step 3: Run the complete automated verification suite**

Run: `bun test`

Expected: all tests PASS.

Run: `bunx tsc --noEmit -p tsconfig.json`

Expected: exit code 0.

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: all Rust tests PASS.

- [ ] **Step 4: Verify the browser flow with Playwright**

Start a router instance with a temporary config directory, `uiPassword` set to
`console-pass-123`, and a free loopback port. Use Playwright to verify:

```text
1. Open /ui and accept the one console-password dialog.
2. Reload /ui and confirm no second dialog appears.
3. Open Settings and confirm the seven-day row fits at 1280x800 and 390x844.
4. Activate 清除免密登录 and confirm the next protected request asks again.
5. Confirm the browser console contains no uncaught errors.
```

Expected: screenshots are nonblank, controls do not overlap, reload is prompt-free before clearing, and the prompt returns after clearing.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md apps/router/README.md security_best_practices_report.md
git commit -m "docs: explain seven-day console sessions"
```

