# SamayPal Local MongoDB Sync Agent

This lightweight Node.js process pulls an approved database archive from the
SamayPal AWS API and restores it into the configured local MongoDB. The
direction is always **AWS → Local**. The agent never sends local database
credentials or data to AWS.

The complete backend API reference is in
`samaypaal_backend/docs/DATABASE_SYNC.md`.

## Requirements

- Windows with Node.js 18, 20, or 22
- MongoDB Database Tools installed and `mongorestore` available in `PATH`
- A local MongoDB service running on `127.0.0.1` or `localhost`
- Network access from the Windows computer to the AWS HTTPS domain

Install MongoDB Database Tools from:
<https://www.mongodb.com/try/download/database-tools>

Verify the installation in PowerShell:

```powershell
mongorestore --version
```

## Configuration

Copy `.env.example` to `.env` and set:

```env
AWS_API_URL=https://your-domain.example
SYNC_AGENT_TOKEN=the-same-random-token-configured-on-aws
LOCAL_MONGODB_URI=mongodb://127.0.0.1:27017/samaypaal
```

Optional settings:

```env
ALLOW_INSECURE_HTTP=false
SYNC_POLL_INTERVAL_MS=5000
MONGORESTORE_PATH=mongorestore
```

`ALLOW_INSECURE_HTTP` must remain `false` in production. The other settings
control polling frequency and the local executable path.

`LOCAL_MONGODB_URI` is safety-checked and must use `mongodb://` with a
`localhost`, `127.0.0.1`, or `::1` host. Remote and `mongodb+srv://` targets
are rejected. The agent maps the AWS source database into the database name
specified in this URI.

Install the agent dependency and start it:

```powershell
cd local-sync-agent
npm install
npm start
```

Keep this process running. It polls the AWS API for a ready synchronization
and downloads the archive as a stream, so the archive is not held in Node.js
memory.

## What happens during synchronization

1. A Super Admin clicks **Sync Database** in the AWS admin Settings page.
2. AWS creates a temporary `mongodump --gzip` archive.
3. The agent detects the ready sync over outbound HTTPS.
4. The agent streams the archive to `local-sync-agent/archives/<syncId>.archive.gz`.
5. The agent runs `mongorestore --drop`, mapping the AWS database name to the
   configured local database.
6. The archive is retained locally after restore for backup, verification, or
   troubleshooting. The AWS-side temporary archive is cleaned up by the
   backend according to its retention process.

Downloaded archives are stored in the `archives` directory under this agent.
Keep enough disk space available for the complete compressed database dump.

`--drop` drops each collection that is restored before writing its AWS copy.
Existing local data in those collections will be overwritten. MongoDB's
`--drop` option does not remove a local-only collection that is absent from
the archive; remove such collections separately if strict collection-for-
collection parity is required.

The agent uses namespace mapping so all collections in the downloaded archive
are written to the database named in `LOCAL_MONGODB_URI`. If `mongorestore`
reports zero restored documents, the agent marks the synchronization as failed
and keeps the archive in `archives` for inspection.

## Agent API protocol

The agent polls:

```text
GET /api/admin/management/database-sync/agent/next
X-Sync-Agent-Token: <sync-agent-token>
```

For a returned `syncId`, it streams:

```text
GET /api/admin/management/database-sync/agent/download/:syncId
X-Sync-Agent-Token: <sync-agent-token>
```

It then reports:

```text
POST /api/admin/management/database-sync/agent/status/:syncId
X-Sync-Agent-Token: <sync-agent-token>
Content-Type: application/json
```

with `{ "status": "RESTORING" }`, followed by either
`{ "status": "COMPLETED" }` or `{ "status": "FAILED", "error": "..." }`.
The agent sends only status messages; it never uploads local MongoDB data.

## Troubleshooting

- **`mongorestore was not found`**: install MongoDB Database Tools and restart
  PowerShell after adding the tools directory to `PATH`.
- **HTTPS or connection errors**: check `AWS_API_URL`, network access, and the
  AWS certificate/domain.
- **Authentication failed**: make sure `SYNC_AGENT_TOKEN` exactly matches the
  AWS environment value. Never place it in source code or commit `.env`.
- **Restore blocked**: use a local `mongodb://127.0.0.1:27017/<database>` URI;
  remote MongoDB targets are intentionally refused.

