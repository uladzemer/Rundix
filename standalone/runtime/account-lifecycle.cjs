// Host state is supplied explicitly; mutable values are read through deps.
function browserSignInMessage(deps, otherWindow = false) {
  return deps.locale.language === 'en'
    ? (otherWindow ? 'Account access is busy in another window. Complete or cancel any browser sign-in from the account menu in that window, or wait for the connection change to finish.' : 'Complete or cancel the browser sign-in from the account menu before sending or changing connections.')
    : (otherWindow ? 'Аккаунт занят в другом окне. Завершите или отмените вход через браузер в меню аккаунта того окна либо дождитесь смены подключения.' : 'Завершите или отмените вход через браузер в меню аккаунта перед отправкой или сменой подключения.');
}

function createPendingLogin(deps) {
  return new deps.PendingLogin({timeout: 5 * 60 * 1000, onFinish: (error, record) => {
    deps.loginId = null;
    if (deps.authOwner === record.release) { deps.authOwner = null; deps.authBusy = false; }
    if (record.disposed && deps.server === record.client) {
      deps.server = null; deps.connecting = null; deps.activeConnection = null;
      deps.account = null; deps.catalog = []; deps.catalogUpdatedAt = 0;
    }
    if (error && deps.target()) deps.target().error = error;
    deps.broadcast();
  }});
}
module.exports = { browserSignInMessage, createPendingLogin };
