(function(root){
 const locale=typeof module!=='undefined'&&module.exports?require('./i18n.js'):root.WorkbenchI18n;
 function choices(schema){return schema.enum?.map((value,i)=>({value,label:schema.enumNames?.[i]||value}))||(schema.oneOf||schema.anyOf)?.filter(option=>typeof option.const==='string').map(option=>({value:option.const,label:option.title||option.const}));}
 function supported(schema){return schema?.type==='object'&&schema.properties&&Object.values(schema.properties).every(field=>['string','number','integer','boolean'].includes(field.type)||field.type==='array'&&!!choices(field.items||{}));}
 function validate(schema,content){
  if(!supported(schema))throw Error(locale.t('Эта схема формы пока не поддерживается.'));if(!content||typeof content!=='object'||Array.isArray(content))throw Error(locale.t('Ожидается заполненная форма.'));
  const result={};for(const name of Object.keys(content))if(!Object.hasOwn(schema.properties,name))throw Error(locale.t('Неизвестное поле формы.'));
  for(const [name,field] of Object.entries(schema.properties)){
   const value=content[name],required=schema.required?.includes(name);if(value===undefined||value===''&&field.type!=='boolean'){if(required)throw Error(locale.t("Заполните поле: {0}",field.title||name));continue;}
   if(field.type==='string'){if(typeof value!=='string')throw Error(locale.t('Ожидается текст.'));if(field.minLength!=null&&value.length<field.minLength||field.maxLength!=null&&value.length>field.maxLength)throw Error(locale.t('Неверная длина текста.'));}
   if(field.type==='number'||field.type==='integer'){if(typeof value!=='number'||!Number.isFinite(value)||field.type==='integer'&&!Number.isInteger(value))throw Error(locale.t('Ожидается число.'));if(field.minimum!=null&&value<field.minimum||field.maximum!=null&&value>field.maximum)throw Error(locale.t('Число вне допустимого диапазона.'));}
   if(field.type==='boolean'&&typeof value!=='boolean')throw Error(locale.t('Ожидается переключатель.'));
   const options=choices(field);if(options&&!options.some(option=>option.value===value))throw Error(locale.t('Выберите значение из списка.'));
   if(field.type==='array'){const options=choices(field.items);if(!Array.isArray(value)||value.some(v=>!options.some(o=>o.value===v)))throw Error(locale.t('Неверные значения списка.'));if(field.minItems!=null&&value.length<field.minItems||field.maxItems!=null&&value.length>field.maxItems)throw Error(locale.t('Неверное количество значений.'));}
   Object.defineProperty(result,name,{value,enumerable:true});
  }return result;
 }
 const api={choices,supported,validate};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WorkbenchForms=api;
})(globalThis);
