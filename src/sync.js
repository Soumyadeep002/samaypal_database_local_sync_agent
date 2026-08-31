const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");
const { spawn } = require("child_process");

const SYNC_ID_PATTERN = /^sync_\d{8}_[a-f0-9]{16}$/;
const ARCHIVE_DIR = path.resolve(__dirname, "../archives");

function sanitizeToolDiagnostics(diagnostics) {
    return String(diagnostics || "")
        .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[redacted MongoDB URI]")
        .replace(/(password|pwd|token|secret)=([^&\s]+)/gi, "$1=[redacted]")
        .slice(0, 4000);
}

function headers(config) {
    return {
        "X-Sync-Agent-Token": config.token,
        Accept: "application/json"
    };
}

async function requestJson(url, options = {}) {
    let response;
    try {
        response = await fetch(url, options);
    } catch {
        throw new Error("Unable to connect to the AWS server.");
    }

    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
        ? await response.json().catch(() => ({}))
        : await response.text().catch(() => "");

    if (!response.ok) {
        throw new Error(
            typeof body === "object" && body.message
                ? body.message
                : `AWS server request failed with status ${response.status}.`
        );
    }
    return body;
}

async function getNextSync(config) {
    const body = await requestJson(`${config.apiBase}/agent/next`, {
        method: "GET",
        headers: headers(config)
    });
    return body?.data || null;
}

async function reportSyncStatus(config, syncId, status, error = null) {
    const body = { status };
    if (error) body.error = String(error).slice(0, 500);
    await requestJson(`${config.apiBase}/agent/status/${encodeURIComponent(syncId)}`, {
        method: "POST",
        headers: {
            ...headers(config),
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });
}

async function downloadArchive(config, syncId) {
    if (!SYNC_ID_PATTERN.test(syncId)) {
        throw new Error("The AWS server returned an invalid synchronization ID.");
    }

    let response;
    try {
        response = await fetch(
            `${config.apiBase}/agent/download/${encodeURIComponent(syncId)}`,
            { method: "GET", headers: headers(config) }
        );
    } catch {
        throw new Error("Database download was interrupted.");
    }

    if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || "Database download was interrupted.");
    }

    await fsp.mkdir(ARCHIVE_DIR, { recursive: true });
    const archivePath = path.join(ARCHIVE_DIR, `${syncId}.archive.gz`);
    await fsp.rm(archivePath, { force: true }).catch(() => {});
    try {
        await pipeline(
            Readable.fromWeb(response.body),
            fs.createWriteStream(archivePath, { flags: "wx" })
        );
    } catch (error) {
        await fsp.rm(archivePath, { force: true }).catch(() => {});
        throw new Error("Database download was interrupted.");
    }

    const stat = await fsp.stat(archivePath).catch(() => null);
    if (!stat?.isFile() || stat.size <= 0) {
        await fsp.rm(archivePath, { force: true }).catch(() => {});
        throw new Error("Database download was empty or incomplete.");
    }
    return archivePath;
}

function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
            if (stdout.length < 4000) stdout += String(chunk).slice(0, 4000 - stdout.length);
        });
        child.stderr?.on("data", (chunk) => {
            if (stderr.length < 4000) stderr += String(chunk).slice(0, 4000 - stderr.length);
        });
        child.once("error", (error) => {
            error.toolStdout = stdout;
            error.toolStderr = stderr;
            reject(error);
        });
        child.once("close", (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            const error = new Error(`${path.basename(command)} exited with code ${code || "unknown"}.`);
            error.toolStdout = stdout;
            error.toolStderr = stderr;
            reject(error);
        });
    });
}

async function validateMongorestore(config) {
    try {
        await runCommand(config.mongorestorePath, ["--version"]);
    } catch (error) {
        if (error.code === "ENOENT") {
            throw new Error(
                "mongorestore was not found. Install MongoDB Database Tools and add mongorestore to the Windows PATH."
            );
        }
        throw new Error("mongorestore is unavailable on this computer.");
    }
}

async function restoreArchive(config, archivePath) {
    const args = [
        `--uri=${config.localMongoUri}`,
        `--archive=${archivePath}`,
        "--gzip",
        "--drop",
        // The dump may contain a database name different from the local URI.
        // Match the archive namespace broadly and restore all collections into
        // the explicitly configured local database.
        "--nsFrom=*",
        `--nsTo=${config.localDatabaseName}.*`
    ];
    const result = await runCommand(config.mongorestorePath, args);
    const diagnostics = sanitizeToolDiagnostics(`${result.stderr}\n${result.stdout}`);
    if (diagnostics.trim()) {
        console.log(`[SYNC] mongorestore diagnostics:\n${diagnostics}`);
    }
    const restoredMatch = diagnostics.match(/([\d,]+)\s+document\(s\)\s+restored successfully/i);
    if (restoredMatch && Number(restoredMatch[1].replace(/,/g, "")) === 0) {
        throw new Error(
            "mongorestore completed but restored 0 documents. The archive may be empty or incompatible with the installed MongoDB tools."
        );
    }
}

async function performSync(config, job) {
    const syncId = String(job?.syncId || "");
    let archivePath = null;
    console.log(`[SYNC] Sync requested: ${syncId}`);
    try {
        console.log("[SYNC] Downloading database archive...");
        archivePath = await downloadArchive(config, syncId);
        console.log("[SYNC] Download completed");

        console.log(
            `[SYNC] Restore target database: ${config.localDatabaseName}` +
            `${job.databaseName ? ` (AWS source: ${job.databaseName})` : " (AWS source name unavailable; using archive namespaces)"}`
        );
        await reportSyncStatus(config, syncId, "RESTORING");
        console.log("[SYNC] Restoring local MongoDB...");
        await restoreArchive(config, archivePath);
        console.log("[SYNC] Restore completed");

        await reportSyncStatus(config, syncId, "COMPLETED");
        console.log(`[SYNC] Archive retained at: ${archivePath}`);
        console.log("[SYNC] Synchronization completed successfully");
    } catch (error) {
        console.error("[SYNC] Synchronization failed:", error.message);
        try {
            await reportSyncStatus(config, syncId, "FAILED", error.message);
        } catch (reportError) {
            console.error("[SYNC] Could not report failure to AWS:", reportError.message);
        }
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForSync(config) {
    while (true) {
        try {
            const job = await getNextSync(config);
            if (job) {
                await performSync(config, job);
            } else {
                await sleep(config.pollIntervalMs);
            }
        } catch (error) {
            console.error("[SYNC] Polling error:", error.message);
            await sleep(config.pollIntervalMs);
        }
    }
}

module.exports = {
    validateMongorestore,
    getNextSync,
    downloadArchive,
    restoreArchive,
    reportSyncStatus,
    performSync,
    pollForSync
};
