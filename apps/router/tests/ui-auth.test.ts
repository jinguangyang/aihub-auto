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
		expect(session.expiresAt).toBe(
			now + UI_AUTH_MAX_AGE_SECONDS * 1000,
		);
		expect(session.setCookie).toContain(`${UI_AUTH_COOKIE_NAME}=`);
		expect(session.setCookie).toContain("Path=/ctl");
		expect(session.setCookie).toContain("Max-Age=604800");
		expect(session.setCookie).toContain("HttpOnly");
		expect(session.setCookie).toContain("SameSite=Strict");
		expect(session.setCookie).not.toContain("; Secure");
		expect(
			issueUiSession(password, true, now, "fixed-nonce").setCookie,
		).toContain("; Secure");
	});

	test("accepts a valid cookie and rejects expiry, tampering, and password changes", () => {
		const { setCookie } = issueUiSession(
			password,
			false,
			now,
			"fixed-nonce",
		);
		const cookie = setCookie.split(";", 1)[0]!;
		const request = new Request("http://localhost/ctl/status", {
			headers: { Cookie: cookie },
		});
		expect(uiSessionAuthorized(request, password, now + 1000)).toBe(true);
		expect(
			uiSessionAuthorized(request, password, now + 604_800_001),
		).toBe(false);
		expect(
			uiSessionAuthorized(request, "another-pass", now + 1000),
		).toBe(false);
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
