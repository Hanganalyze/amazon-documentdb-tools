# MongoDB Oplog Growth Tool

The mongodb oplog growth tool measures how fast the oplog of a MongoDB replica set member grows, in GiB per hour. It also calculates the oplog size that holds a target number of hours.

Use it before an online migration with change data capture (for example AWS DMS full load and CDC). The source oplog must hold all changes from the start of the full load until CDC catches up. If the oplog wraps before that, the CDC start position is lost and the only recovery is a new full load.

The tool is read-only. It reads `local.oplog.rs` only.

# Requirements
- mongosh
- MongoDB 4.4 or later (`$bsonSize`). The hourly mode needs MongoDB 5.1 or later (`$tsSecond`).

## Required privileges
The user needs `find` on `local.oplog.rs`. The built-in `clusterMonitor` role grants it. On a sharded cluster, users created through mongos do not exist on the shards: create a shard-local user on each shard replica set.

## Using the MongoDB Oplog Growth Tool
Connect to one member of each replica set directly (not to mongos). Prefer a secondary.

`mongosh "mongodb://<user>:<pwd>@<host>:<port>/admin?directConnection=true" --quiet --file mongodb-oplog-growth.js`

Set the mode with environment variables:

| Variable | Effect |
|---|---|
| (none) | Average rate over the whole oplog window. Reads only the collection stats and the oldest and newest entries. The average hides the peak hour. |
| `HOURLY=1` | Bytes per UTC hour for every hour in the oplog window. The rate of the busiest whole hour gives the result. This mode reads the whole oplog on the server: run it on a secondary. |
| `SAMPLE_MINUTES=<n>` | Waits n minutes, then adds the size of the new oplog entries. Use it during a known busy period. |
| `TARGET_HOURS=<n>` | Hours of oplog to hold (default 72). |
| `LABEL=<text>` | Free text in the output, for example the shard name. |

Example, hourly mode for shard0:

`HOURLY=1 TARGET_HOURS=72 LABEL=shard0 mongosh "<uri>" --quiet --file mongodb-oplog-growth.js`

## Output
The tool prints one JSON document:
- `growth_gib_per_hour`: the measured rate for the mode you selected.
- `oplog_size_needed_gib` and `oplog_size_needed_mb`: rate x `TARGET_HOURS`. The MB value is the unit of `replSetResizeOplog`.
- `disk_needed_gib_estimate`: the same size divided by the current oplog compression ratio (`size / storageSize`). It is an estimate.
- `oplog_full`: if false, the oplog has not reached its maximum size yet. Its window then shows how long the member has run, not how long the oplog holds entries. Use `HOURLY=1` or `SAMPLE_MINUTES`.
- With `HOURLY=1`: `peak_hour_utc` and one row per hour. The first and last hours are partial, so the tool does not use them for the peak.

## Notes
- Run the tool on each shard of a sharded cluster. Each shard has its own oplog and its own rate.
- Run `HOURLY=1` soon after the busiest period ends. The mode sees only the hours that are still in the oplog, so a run later than one oplog window after the peak misses it. If the oplog window is short, use `SAMPLE_MINUTES` during the peak.
- Choose `TARGET_HOURS` from the expected full load duration plus a margin for CDC catch-up and for the time to notice and fix a problem.
- To change the oplog size, run `replSetResizeOplog` on every member of the replica set (https://www.mongodb.com/docs/manual/reference/command/replSetResizeOplog/). Make sure that the disk has space for the new size.
- A minimum retention period (`minRetentionHours`, or `storage.oplogMinRetentionHours` in the configuration file) keeps entries for that number of hours. With it, the oplog can grow past its maximum size, so monitor disk space.

## License
This tool is licensed under the Apache 2.0 License.
