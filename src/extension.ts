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

let pollInterval: ReturnType<typeof setInterval> | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let sqlPromise: ReturnType<typeof initSqlJs>;
let sqlite3Path: string | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const globalStorageDir = path.dirname(context.globalStorageUri.fsPath);
  const stateDbPath = path.join(globalStorageDir, "state.vscdb");

  if (!fs.existsSync(stateDbPath)) {
    console.log("cursor-openai-fix: state.vscdb not found, skipping.");
    return;
  }

  sqlite3Path = await findSqlite3();

  const wasmPath = path.join(context.extensionPath, "dist", "sql-wasm.wasm");
  sqlPromise = initSqlJs({ locateFile: () => wasmPath });

  const checkAndFix = createChecker(stateDbPath);

  // Initial check (with delay to let Cursor fully initialize)
  setTimeout(checkAndFix, 3000);

  // File watcher (debounced)
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(globalStorageDir), "state.vscdb")
  );
  watcher.onDidChange(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(checkAndFix, 1000);
  });
  context.subscriptions.push(watcher);

  // Polling fallback every 30s
  pollInterval = setInterval(checkAndFix, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(pollInterval!) });
}

export function deactivate() {
  if (pollInterval) clearInterval(pollInterval);
  if (debounceTimer) clearTimeout(debounceTimer);
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
    if (running) return;
    running = true;

    try {
      const enabled = await readUseOpenAIKey(stateDbPath);

      if (enabled === false) {
        // Toggle it ON via Cursor's own command
        await vscode.commands.executeCommand(TOGGLE_COMMAND);

        vscode.window.showInformationMessage(
          "Cursor OpenAI Fix: re-enabled OpenAI API Key toggle."
        );
        console.log("cursor-openai-fix: toggled useOpenAIKey back to true");
      }
    } catch (err) {
      console.error("cursor-openai-fix:", err);
    } finally {
      running = false;
    }
  };
}
