const MarkdownIt=require('markdown-it');const highlight=require('highlight.js/lib/common');
const parser=new MarkdownIt({html:false,linkify:true,typographer:false,breaks:false});
function parse(text){return parser.parse(String(text||''),{});}
function codeBlocks(text){return parse(text).filter(token=>token.type==='fence'||token.type==='code_block').map(token=>token.content);}
function highlighted(text,language){try{return language&&highlight.getLanguage(language)?highlight.highlight(text,{language,ignoreIllegals:true}).value:null;}catch{return null;}}
module.exports={parse,codeBlocks,highlighted};
