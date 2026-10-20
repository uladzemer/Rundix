// Synthetic app-server only. No CLI discovery, network, credential records or
// persistent sign-in operations. Delays exercise stale authentication callbacks.
const readline = require('node:readline');
const methods = [];
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  methods.push(message.method);
  let result = {};
  if (message.method === 'account/login/start') {
    if (message.params.chatgptAccountId === 'synthetic-reject') {
      output({id:message.id, error:{code:-32000, message:'Synthetic private diagnostic must not escape'}}); return;
    }
    result = {type:message.params.chatgptAccountId === 'synthetic-wrong-type' ? 'chatgpt' : 'chatgptAuthTokens'};
  }
  if (message.method === 'account/read') result = {account:{type:'chatgpt'}};
  if (message.method === 'config/read') result = {methods:[...methods], codexHome:process.env.CODEX_HOME};
  if (message.method === 'turn/start') result = {turn:{id:'synthetic-turn'}};
  const reply = () => output({id:message.id, result});
  if (message.params?.chatgptAccountId === 'synthetic-delay' || message.params?.threadId === 'synthetic-delay') setTimeout(reply, 80);
  else reply();
});
