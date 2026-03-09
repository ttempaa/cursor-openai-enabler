import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import initSqlJs from "sql.js";

const execFileAsync = promisify(execFile);

const STORAGE_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
const TOGGLE_COMMAND = "aiSettings.usingOpenAIKey.toggle";
const EXTENSION_ID = "ttempaa.cursor-openai-enabler";

let pollInterval: ReturnType<typeof setInterval> | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let initialTimeout: ReturnType<typeof setTimeout> | undefined;
let sqlPromise: ReturnType<typeof initSqlJs>;
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

function readRuntimeState(): RuntimeState | undefined {
  if (!runtimeStatePath || !fs.existsSync(runtimeStatePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(runtimeStatePath, "utf8")) as RuntimeState;
  } catch {
    return undefined;
  }
}

function writeRuntimeState(enabled: boolean) {
  if (!runtimeStatePath || !sessionId || !currentExtensionPath) return;
  const state: RuntimeState = {
    sessionId,
    enabled,
    extensionPath: currentExtensionPath,
  };
  fs.writeFileSync(runtimeStatePath, JSON.stringify(state), "utf8");
}

function shouldMonitor() {
  const state = readRuntimeState();
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
  log = vscode.window.createOutputChannel("Cursor OpenAI Enabler");
  context.subscriptions.push(log);

  const globalStorageDir = path.dirname(context.globalStorageUri.fsPath);
  const stateDbPath = path.join(globalStorageDir, "state.vscdb");
  runtimeStatePath = path.join(globalStorageDir, "cursor-openai-enabler-runtime.json");
  currentExtensionPath = context.extensionPath;
  sessionId = createSessionId();

  if (!fs.existsSync(stateDbPath)) {
    logLine("state.vscdb not found, skipping.");
    return;
  }

  sqlite3Path = await findSqlite3();

  const wasmPath = path.join(context.extensionPath, "dist", "sql-wasm.wasm");
  sqlPromise = initSqlJs({ locateFile: () => wasmPath });

  checkAndFix = createChecker(stateDbPath);

  // Restore saved state
  isEnabled = context.globalState.get<boolean>("enabled", true);
  writeRuntimeState(isEnabled);
  logLine(`[activate] session=${sessionId} enabled=${isEnabled}`);

  // Status bar toggle button
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "cursor-openai-enabler.toggle";
  context.subscriptions.push(statusBarItem);
  updateStatusBar();

  // Toggle command
  const toggleCmd = vscode.commands.registerCommand(
    "cursor-openai-enabler.toggle",
    async () => {
      isEnabled = !isEnabled;
      writeRuntimeState(isEnabled);
      logLine(`[toggle] ${isEnabled ? "activated" : "paused"}`);
      context.globalState.update("enabled", isEnabled);
      updateStatusBar();
      if (isEnabled) {
        startMonitoring(globalStorageDir, stateDbPath, context);
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
        `Cursor OpenAI Enabler: ${isEnabled ? "activated" : "paused"}`
      );
    }
  );
  context.subscriptions.push(toggleCmd);

  if (isEnabled) {
    startMonitoring(globalStorageDir, stateDbPath, context);
  }
}

function updateStatusBar() {
  if (isEnabled) {
    statusBarItem.text = "$(check) OpenAI Key";
    statusBarItem.tooltip = "Cursor OpenAI Enabler: Active (click to pause)";
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = "$(circle-slash) OpenAI Key";
    statusBarItem.tooltip = "Cursor OpenAI Enabler: Paused (click to activate)";
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  }
  statusBarItem.show();
}

function startMonitoring(
  globalStorageDir: string,
  stateDbPath: string,
  context: vscode.ExtensionContext
) {
  if (!checkAndFix) return;
  stopMonitoring(); // prevent double-start leaking intervals

  // Initial check (with delay to let Cursor fully initialize)
  initialTimeout = setTimeout(checkAndFix, 3000);

  // File watcher (debounced)
  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(globalStorageDir), "state.vscdb")
  );
  const fn = checkAndFix;
  watcherSubscription = watcher.onDidChange(() => {
    if (!shouldMonitor()) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fn, 1000);
  });

  // Polling fallback every 30s
  pollInterval = setInterval(() => {
    if (shouldMonitor()) fn();
  }, 30_000);
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

export function deactivate() {
  isEnabled = false;
  writeRuntimeState(false);
  stopMonitoring();
  if (statusBarItem) statusBarItem.dispose();
}

async function findSqlite3(): Promise<string | undefined> {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(cmd, ["sqlite3"]);
    return stdout.trim().split(/\r?\n/)[0] || undefined;
  } catch {
    return undefined;
  }
}

async function readUseOpenAIKey(dbPath: string): Promise<boolean | undefined> {
  // Prefer sqlite3 CLI for proper WAL handling
  if (sqlite3Path) {
    try {
      const { stdout } = await execFileAsync(sqlite3Path, [
        dbPath,
        `SELECT value FROM ItemTable WHERE key = '${STORAGE_KEY}';`,
      ]);
      const raw = stdout.trim();
      if (!raw) return undefined;
      return JSON.parse(raw).useOpenAIKey;
    } catch {
      // Fall through to sql.js
    }
  }

  const SQL = await sqlPromise;
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);
  try {
    const result = db.exec(
      `SELECT value FROM ItemTable WHERE key = '${STORAGE_KEY}'`
    );
    if (!result.length || !result[0].values.length) return undefined;
    return JSON.parse(result[0].values[0][0] as string).useOpenAIKey;
  } finally {
    db.close();
  }
}

function createChecker(stateDbPath: string) {
  let running = false;

  return async function checkAndFix() {
    if (!shouldMonitor()) return;
    if (running) return;
    running = true;

    try {
      const enabled = await readUseOpenAIKey(stateDbPath);
      if (enabled === false && shouldMonitor()) {
        logLine("[check] re-enabling key");
        await vscode.commands.executeCommand(TOGGLE_COMMAND);

        vscode.window.showInformationMessage(
          "Cursor OpenAI Enabler: re-enabled OpenAI API Key toggle."
        );
      }
    } catch (err) {
      logLine(`[check] error: ${err}`);
    } finally {
      running = false;
    }
  };
}
