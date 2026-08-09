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
	return (
		safeSecretEqual(header, password) ||
		uiSessionAuthorized(request, password, now)
	);
}

export function clearUiSessionCookie(secure: boolean): string {
	return `${UI_AUTH_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${cookieAttributes(secure)}`;
}
