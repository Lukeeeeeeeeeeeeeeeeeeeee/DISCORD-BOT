# DM Worker Setup Guide

The DM Worker system allows scaling the bot's DM capacity by running specialized, isolated bot instances that only handle sending messages from the campaign queue.

## 1. Prerequisites
- One or more additional Discord Bot accounts (applications) created in the [Discord Developer Portal](https://discord.com/developers/applications).
- Each bot must have the **Server Members Intent** enabled.
- Each bot must be invited to the target guild with `Send Messages` permissions.

## 2. Environment Configuration
Create a separate environment configuration (e.g., `.env.worker1`) for each worker bot instance.

### Mandatory Variables:
| Variable | Description |
| :--- | :--- |
| `DISCORD_TOKEN` | The distinct token for this worker bot account. |
| `CLIENT_ID` | The Application ID of this worker bot. |
| `BOT_RUNTIME_MODE` | Must be set to `dm_worker`. |
| `DM_WORKER_ID` | A unique string ID for this worker (e.g., `worker_alpha`). |

### Optional Tunables:
| Variable | Default | Description |
| :--- | :--- | :--- |
| `DM_QUEUE_POLL_MS` | `1500` | How often to check for new targets in the DB. |
| `DM_MIN_DELAY_MS` | `500` | Minimum delay between individual DMs. |
| `DATABASE_PATH` | `./data/bot.db` | Path to the shared SQLite database. |

## 3. Running a Worker
Start the worker using the main entry point but with the worker environment:

```powershell
$env:BOT_RUNTIME_MODE="dm_worker"; $env:DM_WORKER_ID="worker1"; node src/index.js
```

```bash
# Example using a specific env file
dotenv -e .env.worker1 node src/index.js
```

## 4. Automatic "Auto-Scaling" Mode
Instead of running separate commands for each worker, you can now configure the **Main Bot** to automatically launch and manage multiple worker bots on startup.

### Configuration:
Add these to your main `.env` file:
| Variable | Description |
| :--- | :--- |
| `DM_WORKER_TOKENS` | A comma-separated list of additional worker bot tokens. |
| `ENABLE_INTERNAL_WORKER` | Set to `true` to also run a worker on your main bot account. |

**Example:**
`DM_WORKER_TOKENS=NTk4...token1,OTM2...token2`

When you start your main bot (`node src/index.js`), it will automatically:
1. Log into your main account.
2. Log into every worker account provided in `DM_WORKER_TOKENS`.
3. Start the background DM processing for all of them simultaneously.

## 5. How it Works
1. **Heartbeat**: Upon starting, the worker registers itself in the `dm_workers` table.
2. **Polling**: It claims a batch of targets from `dm_campaign_targets` where `status = 'pending'`.
3. **Affinity**: The system attempts to route messages to workers that the user has already interacted with ("Sticky Affinity").
4. **Error Handling**: If a worker is blocked by a user, that specific (Worker, User) pair is recorded, and the target is requeued for a different worker.

## 5. Monitoring
Use the `/dm workers` command in the main bot to see the status, last seen time, and health of all connected workers.

> [!TIP]
> **Scaling**: If you have a large campaign (e.g., 5,000+ members), running 3-5 workers significantly reduces the total time required while minimizing the risk of a single bot being rate-limited or flagged.
