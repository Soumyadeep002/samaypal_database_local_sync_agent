const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function parseAwsApiUrl(value) {
    const raw = String(value || "").trim().replace(/\/+$/, "");
    if (!raw) throw new Error("AWS_API_URL is required.");

    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Error("AWS_API_URL must be a valid HTTPS URL.");
    }

    const allowHttp = String(process.env.ALLOW_INSECURE_HTTP || "").toLowerCase() === "true";
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
        throw new Error("AWS_API_URL must use HTTPS. HTTP is allowed only with ALLOW_INSECURE_HTTP=true for local testing.");
    }

    return raw;
}

function validateLocalMongoUri(value) {
    const uri = String(value || "").trim();
    if (!uri) throw new Error("LOCAL_MONGODB_URI is required.");
    if (uri.startsWith("mongodb+srv://")) {
        throw new Error("LOCAL_MONGODB_URI must point to local MongoDB, not a remote MongoDB/Atlas cluster.");
    }

    let parsed;
    try {
        parsed = new URL(uri);
    } catch {
        throw new Error("LOCAL_MONGODB_URI must be a valid mongodb:// URI.");
    }

    if (parsed.protocol !== "mongodb:") {
        throw new Error("LOCAL_MONGODB_URI must use mongodb:// and point to local MongoDB.");
    }

    const hostname = String(parsed.hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
    if (!LOCAL_HOSTS.has(hostname)) {
        throw new Error("Restore blocked: LOCAL_MONGODB_URI must point to localhost, 127.0.0.1, or ::1.");
    }

    return uri;
}

function getMongoDatabaseName(uri) {
    let databaseName = "";
    try {
        databaseName = decodeURIComponent(new URL(uri).pathname.replace(/^\/+/, ""));
    } catch {
        // validateLocalMongoUri already provides the user-facing URI error.
    }
    if (!databaseName || databaseName.includes("/") || databaseName.includes(".")) {
        throw new Error("LOCAL_MONGODB_URI must include a valid local database name.");
    }
    return databaseName;
}

function apiEndpointBase(awsApiUrl) {
    return awsApiUrl.endsWith("/api")
        ? `${awsApiUrl}/admin/management/database-sync`
        : `${awsApiUrl}/api/admin/management/database-sync`;
}

function redactMongoUri(uri) {
    try {
        const parsed = new URL(uri);
        if (parsed.username) parsed.username = "***";
        if (parsed.password) parsed.password = "***";
        return parsed.toString();
    } catch {
        return "mongodb://local MongoDB";
    }
}

function loadConfig() {
    const awsApiUrl = parseAwsApiUrl(process.env.AWS_API_URL);
    const token = String(process.env.SYNC_AGENT_TOKEN || "").trim();
    if (!token) throw new Error("SYNC_AGENT_TOKEN is required.");

    const localMongoUri = validateLocalMongoUri(process.env.LOCAL_MONGODB_URI);
    const localDatabaseName = getMongoDatabaseName(localMongoUri);
    const pollIntervalMs = Number(process.env.SYNC_POLL_INTERVAL_MS || 5000);
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
        throw new Error("SYNC_POLL_INTERVAL_MS must be at least 1000 milliseconds.");
    }

    return {
        awsApiUrl,
        apiBase: apiEndpointBase(awsApiUrl),
        token,
        localMongoUri,
        localDatabaseName,
        localMongoDisplayUri: redactMongoUri(localMongoUri),
        pollIntervalMs,
        mongorestorePath: String(process.env.MONGORESTORE_PATH || "mongorestore").trim() || "mongorestore"
    };
}

module.exports = { loadConfig, validateLocalMongoUri, redactMongoUri };
