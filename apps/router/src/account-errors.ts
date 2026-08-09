export class AccountSwitchBusyError extends Error {
	constructor() {
		super("仍有请求正在处理，请稍后再切换账号");
		this.name = "AccountSwitchBusyError";
	}
}

export class AccountSwitchingError extends Error {
	constructor() {
		super("AIHub 账号正在切换，请稍后重试");
		this.name = "AccountSwitchingError";
	}
}
