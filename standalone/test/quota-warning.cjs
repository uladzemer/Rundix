const assert=require('node:assert/strict');
const {normalize,lowFiveHour,exhaustion}=require('../ui/limits.js');
const now=Date.UTC(2026,9,17),reset=now/1000+3600;
const data=(remaining,minutes=300,resetsAt=reset)=>({buckets:[{name:'Codex',windows:[{remaining,minutes,resetsAt}]}]});
for(const remaining of [100,75,74.9,72,25])assert.equal(lowFiveHour(data(remaining),now),null);
assert.equal(lowFiveHour(data(24.9),now).remaining,24.9);
assert.equal(lowFiveHour(data(0),now).remaining,0);
assert.equal(lowFiveHour(data(10,10080),now),null);
assert.equal(lowFiveHour(data(10,null),now),null);
assert.equal(lowFiveHour(data(10,300,now/1000),now),null);
assert.equal(lowFiveHour({...data(10),error:true},now),null);
assert.equal(lowFiveHour({},now),null);
const buckets=normalize({rateLimitsByLimitId:{first:{primary:{usedPercent:30,windowDurationMins:300,resetsAt:reset}},second:{primary:{usedPercent:90,windowDurationMins:300,resetsAt:reset}}}});
assert.equal(lowFiveHour({buckets},now).bucketName,'second');
assert.equal(lowFiveHour({buckets},now).remaining,10);
const grouped = {buckets:[
  {name:'same name',windows:[{minutes:300,remaining:20,resetsAt:reset},{minutes:10080,remaining:90}]},
  {name:'same name',windows:[{minutes:300,remaining:10,resetsAt:reset},{minutes:10080,remaining:64}]},
]};
assert.equal(lowFiveHour(grouped,now).weeklyRemaining,64,'Weekly quota belongs to the selected five-hour bucket, even with duplicate names');
const weekly=grouped.buckets[1].windows[1];
weekly.remaining=0;
assert.equal(lowFiveHour(grouped,now).weeklyRemaining,0,'An exhausted week is not omitted');
for(const remaining of [NaN,-1,101]){
  weekly.remaining=remaining;
  assert.equal(lowFiveHour(grouped,now).weeklyRemaining,undefined);
}
weekly.remaining=64;weekly.resetsAt=now/1000;
assert.equal(lowFiveHour(grouped,now).weeklyRemaining,undefined,'An expired weekly snapshot is not shown as current');
assert.equal(lowFiveHour(data(10),now).weeklyRemaining,undefined,'Missing weekly data is not zero');
const snapshot={...data(0),updatedAt:now};
assert.deepEqual(exhaustion(snapshot,now),{resetAt:reset*1000});
assert.equal(exhaustion({...data(50),updatedAt:now},now),null);
assert.equal(exhaustion({...snapshot,error:true},now),null);
assert.equal(exhaustion({...snapshot,updatedAt:now-120001},now),null);
assert.equal(exhaustion({updatedAt:now,buckets:[]},now),null);
assert.deepEqual(exhaustion({...data(0,300,null),updatedAt:now},now),{resetAt:null});
assert.deepEqual(exhaustion({updatedAt:now,buckets:[{windows:[{remaining:0,resetsAt:reset},{remaining:0,resetsAt:reset+100}]}]},now),{resetAt:(reset+100)*1000});
console.log('PASS: quota warnings and exhaustion guard; stale/error/missing data never becomes an exhausted quota.');
