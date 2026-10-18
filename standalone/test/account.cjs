const assert=require('node:assert/strict');const {startLogin,identity}=require('../runtime/account.cjs');
(async()=>{const calls=[],opened=[],server={request:async(method,params)=>{calls.push({method,params});return method==='account/login/start'?{loginId:'fixture-login',authUrl:'https://auth.openai.com/fixture'}:{};}};
 assert.equal(await startLogin(server,{openExternal:async url=>{opened.push(url);return true;}}),'fixture-login');assert.deepEqual(calls.map(call=>call.method),['account/login/start']);assert.deepEqual(calls[0].params,{type:'chatgpt'});assert.equal(opened.length,1);
 calls.length=0;await startLogin(server,{openExternal:async()=>true});assert.equal(calls.length,1);assert.equal(calls[0].method,'account/login/start');assert.notEqual(identity({type:'chatgpt',email:'first@example.test'}),identity({type:'chatgpt',email:'second@example.test'}));
 await assert.rejects(startLogin({request:async()=>({authUrl:'file:///fixture'})},{openExternal:async()=>{throw Error('Must not open');}}),/адрес/);
 console.log('PASS: local browser sign-in uses only the official login RPC; URLs validated and account identities isolated.');
})().catch(error=>{console.error(error);process.exitCode=1});
