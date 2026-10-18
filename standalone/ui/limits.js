(function (root) {
  function normalize(payload) {
    const buckets = payload?.rateLimitsByLimitId;
    const snapshots =
      buckets && Object.keys(buckets).length
        ? Object.entries(buckets)
        : payload?.rateLimits
          ? [[payload.rateLimits.limitId || "codex", payload.rateLimits]]
          : [];
    return snapshots.map(([id, snapshot]) => ({
      id,
      name: snapshot.limitName || id,
      blocked:
        !!snapshot.rateLimitReachedType ||
        snapshot.spendControlReached === true,
      windows: ["primary", "secondary"].flatMap((key) => {
        const w = snapshot[key];
        return w && Number.isFinite(w.usedPercent)
          ? [
              {
                key,
                remaining: Math.max(0, Math.min(100, 100 - w.usedPercent)),
                minutes: Number.isFinite(w.windowDurationMins)
                  ? w.windowDurationMins
                  : null,
                resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null,
              },
            ]
          : [];
      }),
    }));
  }
  function lowFiveHour(data,now=Date.now()) {
    if(data?.error)return null;
    const windows=(data?.buckets || []).flatMap(bucket=>(bucket.windows || [])
      .filter(window=>window.minutes===300 && Number.isFinite(window.remaining) && window.remaining>=0 && window.remaining<25 &&
        (!Number.isFinite(window.resetsAt) || window.resetsAt*1000>now))
      .map(window=>{
        const weekly=(bucket.windows || []).find(candidate=>candidate.minutes===10080 &&
          Number.isFinite(candidate.remaining) && candidate.remaining>=0 && candidate.remaining<=100 &&
          (!Number.isFinite(candidate.resetsAt) || candidate.resetsAt*1000>now));
        return {...window,bucketName:bucket.name || bucket.id,weeklyRemaining:weekly?.remaining};
      }));
    return windows.sort((a,b)=>a.remaining-b.remaining)[0] || null;
  }
  function exhaustion(data, now = Date.now()) {
    if (!data || data.error || !data.updatedAt || now - data.updatedAt > 120000) return null;
    const bucket = data.buckets?.find(item => item.id === 'codex') || data.buckets?.[0];
    const windows = (bucket?.windows || []).filter(window => Number.isFinite(window.remaining));
    if (!windows.length) return null;
    const blocked = windows.filter(window => bucket.blocked || window.remaining <= 0);
    if (!blocked.length) return null;
    const resets = blocked.map(window => window.resetsAt * 1000);
    return { resetAt: resets.every(time => Number.isFinite(time) && time > now) ? Math.max(...resets) : null };
  }
  const api = { normalize, lowFiveHour, exhaustion };
  if (typeof module === "object") module.exports = api;
  else root.WorkbenchLimits = api;
})(typeof globalThis === "object" ? globalThis : this);
