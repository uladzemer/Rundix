const locale=require('../ui/i18n.js');
// Browser sign-in and all credential storage belong to the official CLI.
async function startLogin(server,{openExternal}){
 const result=await server.request('account/login/start',{type:'chatgpt'});
 if(!result.authUrl)throw Error(locale.t('Codex CLI не вернул адрес входа.'));const url=new URL(result.authUrl);if(url.protocol!=='https:')throw Error(locale.t('CLI вернул неподдерживаемый адрес входа.'));
 const opened=await openExternal(url.href);if(opened===false)throw Error(locale.t('Не удалось открыть браузер для входа.'));return result.loginId||null;
}
const identity=account=>account?account.type+':'+(account.email||''):'signed-out';
module.exports={startLogin,identity};
