// mongodb-oplog-growth.js - measure the oplog growth rate of one replica set member and
// the oplog size needed to hold a target number of hours.
//
// Read-only. Run it on EVERY shard, connected to a shard member directly
// (not to mongos). Prefer a secondary.
//   mongosh "mongodb://<user>:<pwd>@<shard-host>:<port>/admin?directConnection=true" \
//     --quiet --file mongodb-oplog-growth.js
//
// Modes (environment variables):
//   (none)           Average rate over the whole oplog window. Cheap: reads
//                    collection stats and the oldest and newest entries only.
//                    The average hides the peak hour.
//   HOURLY=1         Bytes per UTC hour for every hour in the oplog window.
//                    Reads the whole oplog on the server: run it on a secondary.
//                    The peak hour gives the sizing rate.
//   SAMPLE_MINUTES=N Wait N minutes, then sum the bytes of the new entries.
//                    Use it during a known busy period.
//   TARGET_HOURS     Hours of oplog to hold (default 72).
//   LABEL            Free text printed in the output (for example the shard name).
//
// Required privilege: find on local.oplog.rs (built-in role clusterMonitor).
// Requires MongoDB 4.4 or later ($bsonSize); HOURLY needs 5.1 or later ($tsSecond).

const TARGET_HOURS = Number(process.env.TARGET_HOURS || 72);
const SAMPLE_MINUTES = Number(process.env.SAMPLE_MINUTES || 0);
const HOURLY = process.env.HOURLY === '1';
const LABEL = process.env.LABEL || db.hello().setName || 'member';
const GiB = 1024 ** 3;

const local = db.getSiblingDB('local');
const oplog = local.getCollection('oplog.rs');

function edgeSec(dir) {
  return oplog.find({}, { ts: 1 }).sort({ $natural: dir }).limit(1).next().ts.getHighBits();
}

// Exact bytes of the entries with firstSec < ts <= lastSec. The ts range
// bounds the scan of the oplog (it does not read the older entries).
function bytesBetween(firstSec, lastSec) {
  const r = oplog.aggregate([
    { $match: { ts: { $gt: Timestamp({ t: firstSec, i: 0 }), $lte: Timestamp({ t: lastSec, i: 0 }) } } },
    { $group: { _id: null, bytes: { $sum: { $bsonSize: '$$ROOT' } }, entries: { $sum: 1 } } },
  ]).toArray();
  return r.length ? r[0] : { bytes: 0, entries: 0 };
}

const stats = local.runCommand({ collStats: 'oplog.rs' });
const firstSec = edgeSec(1);
const lastSec = edgeSec(-1);
const windowHours = (lastSec - firstSec) / 3600;
const full = stats.size >= 0.95 * stats.maxSize;
const compression = stats.storageSize > 0 ? stats.size / stats.storageSize : 1;

const out = {
  label: LABEL,
  oplog_max_gib: +(stats.maxSize / GiB).toFixed(3),
  oplog_used_gib: +(stats.size / GiB).toFixed(3),
  oplog_on_disk_gib: +(stats.storageSize / GiB).toFixed(3),
  oplog_full: full,
  oplog_window_hours: +windowHours.toFixed(2),
  oldest_entry_utc: new Date(firstSec * 1000).toISOString(),
  newest_entry_utc: new Date(lastSec * 1000).toISOString(),
};
if (!full) {
  out.note = 'The oplog is not full: its window shows uptime, not retention. Use HOURLY=1 or SAMPLE_MINUTES.';
}

let rate;
if (SAMPLE_MINUTES > 0) {
  sleep(SAMPLE_MINUTES * 60 * 1000);
  const endSec = edgeSec(-1);
  const r = bytesBetween(lastSec, endSec);
  const hours = Math.max(endSec - lastSec, 1) / 3600;
  rate = r.bytes / hours;
  out.method = `bytes of new entries over ${SAMPLE_MINUTES} min (${r.entries} entries)`;
} else if (HOURLY) {
  const rows = oplog.aggregate([
    { $group: {
        _id: { $dateToString: { format: '%Y-%m-%dT%H:00Z', date: { $toDate: { $multiply: [{ $tsSecond: '$ts' }, 1000] } } } },
        bytes: { $sum: { $bsonSize: '$$ROOT' } }, entries: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ], { allowDiskUse: true }).toArray();
  // The first and last hours are partial: leave them out of the peak.
  const whole = rows.length > 2 ? rows.slice(1, -1) : rows;
  const peak = whole.reduce((m, x) => (x.bytes > m.bytes ? x : m), { bytes: 0 });
  rate = peak.bytes;
  out.method = 'peak whole UTC hour in the oplog window';
  out.peak_hour_utc = peak._id;
  out.hours = rows.map((x) => ({ hour_utc: x._id, gib: +(x.bytes / GiB).toFixed(3), entries: x.entries }));
} else {
  if (!full) { printjson(out); quit(2); }
  rate = stats.size / Math.max(windowHours, 1 / 3600);
  out.method = 'average over the oplog window (hides the peak hour)';
}

const needed = rate * TARGET_HOURS;
out.growth_gib_per_hour = +(rate / GiB).toFixed(3);
out.target_hours = TARGET_HOURS;
out.oplog_size_needed_gib = +(needed / GiB).toFixed(1);
out.oplog_size_needed_mb = Math.ceil(needed / (1024 * 1024));
out.disk_needed_gib_estimate = +((needed / compression) / GiB).toFixed(1);
printjson(out);
