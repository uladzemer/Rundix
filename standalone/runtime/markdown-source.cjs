const MarkdownIt=require('markdown-it');const highlight=require('highlight.js/lib/common');
const parser=new MarkdownIt({html:false,linkify:true,typographer:false,breaks:false});
// Windows link targets (D:\repo\.rundix\a.js) must keep backslashes that Markdown treats as escapes.
const destination=parser.helpers.parseLinkDestination;
parser.helpers.parseLinkDestination=(str,start,max)=>{
  const result=destination(str,start,max);if(!result.ok)return result;
  const raw=str.slice(start,result.pos).replace(/^<([^]*)>$/,'$1');
  if(/^[A-Za-z]:\\/.test(raw))result.str=raw.replace(/\\/g,'/');
  return result;
};
function parse(text){return parser.parse(String(text||''),{});}
function codeBlocks(text){return parse(text).filter(token=>token.type==='fence'||token.type==='code_block').map(token=>token.content);}
function highlighted(text,language){try{return language&&highlight.getLanguage(language)?highlight.highlight(text,{language,ignoreIllegals:true}).value:null;}catch{return null;}}
module.exports={parse,codeBlocks,highlighted};
