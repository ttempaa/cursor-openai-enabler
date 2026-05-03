import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

const STORAGE_KEY =
	"src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
const TOGGLE_COMMAND = "aiSettings.usingOpenAIKey.toggle";
const EXTENSION_ID = "ttempaa.cursor-openai-enabler";
const EXTENSION_NAME = "Cursor OpenAI Enabler";
const STATE_DB_FILE = "state.vscdb";
const RUNTIME_STATE_FILE = "cursor-openai-enabler-runtime.json";
const INITIAL_CHECK_DELAY_MS = 3000;
const DEBOUNCE_DELAY_MS = 1000;
const POLL_INTERVAL_MS = 30_000;
const POST_TOGGLE_READ_DELAY_MS = 500;
const POST_TOGGLE_READ_RETRIES = 3;

let pollInterval: NodeJS.Timeout | undefined;
let debounceTimer: NodeJS.Timeout | undefined;
let initialTimeout: NodeJS.Timeout | undefined;
let sqlJs: SqlJsStatic;
let sqlite3Path: string | undefined;
let statusBarItem: vscode.StatusBarItem;
let isEnabled = true;
let watcher: vscode.FileSystemWatcher | undefined;
let watcherSubscription: vscode.Disposable | undefined;
let checkAndFix: (() => Promise<void>) | undefined;
let log: vscode.OutputChannel;
let runtimeStatePath: string | undefined;
let sessionId: string | undefined;
let currentExtensionPath: string | undefined;

type RuntimeState = {
	sessionId: string;
	enabled: boolean;
	extensionPath: string;
};

function logLine(msg: string) {
	const d = new Date();
	const ts = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
	log.appendLine(`${ts} ${msg}`);
}

function createSessionId() {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readRuntimeState(): Promise<RuntimeState | undefined> {
	if (!runtimeStatePath) return;

	try {
		const content = await readFile(runtimeStatePath, "utf8");
		return JSON.parse(content) as RuntimeState;
	} catch {
		return undefined;
	}
}

async function writeRuntimeState(enabled: boolean): Promise<void> {
	if (!runtimeStatePath || !sessionId || !currentExtensionPath) return;
	const state: RuntimeState = {
		sessionId,
		enabled,
		extensionPath: currentExtensionPath,
	};
	try {
		const { writeFile } = await import("node:fs/promises");
		await writeFile(runtimeStatePath, JSON.stringify(state), "utf8");
	} catch (err) {
		logLine(`[writeRuntimeState] error: ${err}`);
	}
}

async function shouldMonitor(): Promise<boolean> {
	const state = await readRuntimeState();
	if (!state) {
		logLine("[guard] runtime state missing");
		stopMonitoring();
		return false;
	}
	if (state.sessionId !== sessionId) {
		logLine("[guard] stale session detected");
		stopMonitoring();
		return false;
	}
	if (!fs.existsSync(state.extensionPath)) {
		logLine("[guard] extension path missing, stopping");
		stopMonitoring();
		return false;
	}
	if (!vscode.extensions.getExtension(EXTENSION_ID)) {
		logLine("[guard] extension no longer registered, stopping");
		stopMonitoring();
		return false;
	}
	if (!state.enabled) return false;
	return true;
}

export async function activate(context: vscode.ExtensionContext) {
	log = vscode.window.createOutputChannel(EXTENSION_NAME);
	context.subscriptions.push(log);

	const globalStorageDir = path.dirname(context.globalStorageUri.fsPath);
	const stateDbPath = path.join(globalStorageDir, STATE_DB_FILE);
	runtimeStatePath = path.join(globalStorageDir, RUNTIME_STATE_FILE);
	currentExtensionPath = context.extensionPath;
	sessionId = createSessionId();

	if (!fs.existsSync(stateDbPath)) {
		logLine(`${STATE_DB_FILE} not found, skipping.`);
		return;
	}

	sqlite3Path = await findSqlite3();

	const wasmPath = path.join(context.extensionPath, "dist", "sql-wasm.wasm");
	sqlJs = await initSqlJs({ locateFile: () => wasmPath });

	checkAndFix = createChecker(stateDbPath);

	// Restore saved state
	isEnabled = context.globalState.get<boolean>("enabled", true);
	await writeRuntimeState(isEnabled);
	logLine(`[activate] session=${sessionId} enabled=${isEnabled}`);

	// Status bar toggle button
	statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100,
	);
	statusBarItem.command = "cursor-openai-enabler.toggle";
	context.subscriptions.push(statusBarItem);
	updateStatusBar();

	// Toggle command
	const toggleCmd = vscode.commands.registerCommand(
		"cursor-openai-enabler.toggle",
		async () => {
			isEnabled = !isEnabled;
			await writeRuntimeState(isEnabled);
			logLine(`[toggle] ${isEnabled ? "activated" : "paused"}`);
			context.globalState.update("enabled", isEnabled);
			updateStatusBar();
			if (isEnabled) {
				startMonitoring(globalStorageDir);
				if (checkAndFix) await checkAndFix();
			} else {
				stopMonitoring();
				// Disable the key in Cursor when pausing
				try {
					const currentValue = await readUseOpenAIKey(stateDbPath);
					if (currentValue === true) {
						logLine("[toggle] disabling key");
						await vscode.commands.executeCommand(TOGGLE_COMMAND);
					}
				} catch (err) {
					logLine(`[toggle] error disabling key: ${err}`);
				}
			}
			vscode.window.showInformationMessage(
				`${EXTENSION_NAME}: ${isEnabled ? "activated" : "paused"}`,
			);
		},
	);
	context.subscriptions.push(toggleCmd);

	// Toggle Key command — toggles the OpenAI key in Cursor and syncs extension state
	const toggleOpenAIKeyCmd = vscode.commands.registerCommand(
		"cursor-openai-enabler.toggleOpenAIKey",
		async () => {
			logLine("[toggleOpenAIKey] executing toggle command");

			// Remember current state so we can restore monitoring on error
			const wasEnabled = isEnabled;
			// Stop monitoring before toggling so the watcher cannot race us
			stopMonitoring();

			// Read the current value before the toggle for comparison
			const prevValue = await readUseOpenAIKey(stateDbPath);
			logLine(`[toggleOpenAIKey] pre-toggle value=${prevValue}`);

			try {
				await vscode.commands.executeCommand(TOGGLE_COMMAND);
			} catch (err) {
				logLine(`[toggleOpenAIKey] toggle command failed: ${err}`);
				vscode.window.showErrorMessage(
					`${EXTENSION_NAME}: failed to toggle OpenAI API Key.`,
				);
				if (wasEnabled) startMonitoring(globalStorageDir);
				return;
			}

			let newValue: boolean | undefined;
			for (let i = 0; i < POST_TOGGLE_READ_RETRIES; i++) {
				await new Promise((r) => setTimeout(r, POST_TOGGLE_READ_DELAY_MS));
				newValue = await readUseOpenAIKey(stateDbPath);
				logLine(
					`[toggleOpenAIKey] post-toggle read ${i + 1}: value=${newValue}`,
				);

				// If the value appeared (was undefined) or changed, the toggle has been applied
				if (
					newValue !== undefined &&
					(prevValue === undefined || newValue !== prevValue)
				) {
					break;
				}

				if (i < POST_TOGGLE_READ_RETRIES - 1) {
					logLine(
						`[toggleOpenAIKey] retry ${i + 1}/${POST_TOGGLE_READ_RETRIES}`,
					);
				}
			}

			if (
				newValue === undefined ||
				(prevValue !== undefined && newValue === prevValue)
			) {
				logLine(
					"[toggleOpenAIKey] failed to confirm key state change after toggle",
				);
				vscode.window.showWarningMessage(
					`${EXTENSION_NAME}: could not confirm key state after toggle.`,
				);
				if (wasEnabled) startMonitoring(globalStorageDir);
				return;
			}

			isEnabled = newValue;
			await writeRuntimeState(isEnabled);
			await context.globalState.update("enabled", isEnabled);
			updateStatusBar();
			logLine(
				`[toggleOpenAIKey] key=${isEnabled}, monitoring ${isEnabled ? "active" : "paused"}`,
			);

			if (isEnabled) {
				startMonitoring(globalStorageDir);
				if (checkAndFix) await checkAndFix();
			}

			vscode.window.showInformationMessage(
				`${EXTENSION_NAME}: OpenAI API Key is ${isEnabled ? "ON" : "OFF"}, monitoring ${isEnabled ? "active" : "paused"}.`,
			);
		},
	);
	context.subscriptions.push(toggleOpenAIKeyCmd);

	if (isEnabled) {
		startMonitoring(globalStorageDir);
	}
}

function updateStatusBar() {
	if (isEnabled) {
		statusBarItem.text = "$(check) OpenAI Key";
		statusBarItem.tooltip = `${EXTENSION_NAME}: Active (click to pause)`;
		statusBarItem.backgroundColor = undefined;
	} else {
		statusBarItem.text = "$(circle-slash) OpenAI Key";
		statusBarItem.tooltip = `${EXTENSION_NAME}: Paused (click to activate)`;
		statusBarItem.backgroundColor = new vscode.ThemeColor(
			"statusBarItem.warningBackground",
		);
	}
	statusBarItem.show();
}

function startMonitoring(globalStorageDir: string) {
	const checker = checkAndFix;
	if (!checker) return;
	stopMonitoring(); // prevent double-start leaking intervals

	// Initial check (with delay to let Cursor fully initialize)
	initialTimeout = setTimeout(checker, INITIAL_CHECK_DELAY_MS);

	// File watcher (debounced)
	watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(
			vscode.Uri.file(globalStorageDir),
			STATE_DB_FILE,
		),
	);

	const handleFileChange = async () => {
		if (!(await shouldMonitor())) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(checker, DEBOUNCE_DELAY_MS);
	};

	const handlePoll = async () => {
		if (await shouldMonitor()) await checker();
	};

	watcherSubscription = watcher.onDidChange(() => void handleFileChange());
	pollInterval = setInterval(() => void handlePoll(), POLL_INTERVAL_MS);
}

function stopMonitoring() {
	if (initialTimeout) {
		clearTimeout(initialTimeout);
		initialTimeout = undefined;
	}
	if (pollInterval) {
		clearInterval(pollInterval);
		pollInterval = undefined;
	}
	if (debounceTimer) {
		clearTimeout(debounceTimer);
		debounceTimer = undefined;
	}
	if (watcherSubscription) {
		watcherSubscription.dispose();
		watcherSubscription = undefined;
	}
	if (watcher) {
		watcher.dispose();
		watcher = undefined;
	}
}

export async function deactivate() {
	isEnabled = false;
	await writeRuntimeState(false);
	stopMonitoring();
	if (statusBarItem) statusBarItem.dispose();
}

async function findSqlite3(): Promise<string | undefined> {
	const cmd = process.platform === "win32" ? "where" : "which";
	try {
		const { stdout } = await execFileAsync(cmd, ["sqlite3"]);
		return stdout.trim().split(/\r?\n/)[0] || undefined;
	} catch {
		return;
	}
}

async function readUseOpenAIKey(dbPath: string): Promise<boolean | undefined> {
	const query = `SELECT value FROM ItemTable WHERE key = '${STORAGE_KEY}';`;

	// Prefer sqlite3 CLI for proper WAL handling
	if (sqlite3Path) {
		try {
			const { stdout } = await execFileAsync(sqlite3Path, [dbPath, query]);
			const raw = stdout.trim();
			if (!raw) return undefined;
			const parsed = JSON.parse(raw);
			return parsed.useOpenAIKey as boolean | undefined;
		} catch (err) {
			logLine(`[readKey] sqlite3 error: ${err}, falling back to sql.js`);
			// Fall through to sql.js
		}
	}

	try {
		const buffer = await readFile(dbPath);
		const db = new sqlJs.Database(buffer);
		try {
			const result = db.exec(query);
			if (!result.length || !result[0].values.length) return undefined;
			const parsed = JSON.parse(result[0].values[0][0] as string);
			return parsed.useOpenAIKey as boolean | undefined;
		} finally {
			db.close();
		}
	} catch (err) {
		logLine(`[readKey] sql.js error: ${err}`);
		return undefined;
	}
}

function createChecker(stateDbPath: string) {
	let running = false;

	return async function checkAndFix() {
		if (!(await shouldMonitor())) return;
		if (running) return;
		running = true;

		try {
			const enabled = await readUseOpenAIKey(stateDbPath);
			if (enabled === false) {
				logLine("[check] re-enabling key");
				await vscode.commands.executeCommand(TOGGLE_COMMAND);

				vscode.window.showInformationMessage(
					`${EXTENSION_NAME}: re-enabled OpenAI API Key toggle.`,
				);
			}
		} catch (err) {
			logLine(`[check] error: ${err}`);
		} finally {
			running = false;
		}
	};
}
