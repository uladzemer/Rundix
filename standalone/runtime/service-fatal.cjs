// Process-entry safety net: never print exception objects or provider payloads.
function installFatalGuards({runtime=process,log,shutdown,exit=code=>process.exit(code),timeoutMs=7000}) {
  let stopping=false;
  const fail=()=>{
    if(stopping)return;stopping=true;
    try{log({code:'host_error'});}catch{}
    const timer=setTimeout(()=>exit(1),timeoutMs);
    Promise.resolve().then(shutdown).catch(()=>{}).finally(()=>{clearTimeout(timer);exit(1);});
  };
  runtime.on('uncaughtException',fail);runtime.on('unhandledRejection',fail);
  return ()=>{runtime.removeListener('uncaughtException',fail);runtime.removeListener('unhandledRejection',fail);};
}
module.exports={installFatalGuards};
