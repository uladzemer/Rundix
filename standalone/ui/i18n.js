(function(root){
 const translations=typeof module!=='undefined'&&module.exports?require('./translations.js'):root.WorkbenchTranslations;
 let language=typeof document!=='undefined'?document.documentElement.dataset.language||'ru':'ru';
 function resolve(choice,ideLanguage='en'){return (choice==='auto'?ideLanguage:choice).toLowerCase().startsWith('ru')?'ru':'en';}
 function setLanguage(value){language=resolve(value);if(typeof document!=='undefined')document.documentElement.lang=language;}
 function t(text,...values){const translated=language==='en'&&Object.hasOwn(translations,text)?translations[text]:text;return values.length?translated.replace(/\{(\d+)\}/g,(match,index)=>index<values.length?String(values[index]):match):translated;}
 const api={t,resolve,setLanguage,get language(){return language;}};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WorkbenchI18n=api;
})(globalThis);
