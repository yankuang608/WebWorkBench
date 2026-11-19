/** Private raw evidence stays unchanged; credentials are removed from report copies. */
export function createEvidenceRedactor(){
 const marker='[REDACTED_CREDENTIAL]';
 const secrets=new Set<string>();
 const imagePayloads=new Set<string>();
 const sensitive=(key:string)=>/^(?:.*(?:password|passwd|token|secret|apikey)|authorization|cookie|setcookie|sessionid)$/i.test(key.replace(/[^a-z0-9]/gi,''));
 const remember=(value:string)=>{if(value.length>=8&&!value.startsWith('[REDACTED')&&!['password','authorization'].includes(value))secrets.add(value);};
 const parse=(text:string):unknown=>{try{return JSON.parse(text)}catch{return undefined}};
 function collect(value:unknown,depth=0){
  if(depth>24)return;
  if(typeof value==='string'){
   const nested=parse(value);if(nested!==null&&typeof nested==='object')collect(nested,depth+1);
   for(const match of value.matchAll(/\/sign\/([A-Za-z0-9_-]{16,})/g))remember(match[1]);
   for(const match of value.matchAll(/https?:\/\/[^\s<>"']+/g))try{for(const [key,item] of new URL(match[0]).searchParams)if(sensitive(key))remember(item)}catch{}
  }else if(Array.isArray(value))value.forEach(item=>collect(item,depth+1));
  else if(value&&typeof value==='object'){
   const image=value as Record<string,unknown>;
   if(typeof image.data==='string'&&(image.type==='image'||String(image.media_type??image.mimeType??'').startsWith('image/')))imagePayloads.add(image.data);
   for(const [key,item] of Object.entries(value)){
    if(sensitive(key)&&typeof item==='string'){remember(item);if(/^Bearer\s+/i.test(item))remember(item.replace(/^Bearer\s+/i,''));}
    collect(item,depth+1);
   }
  }
 }
 function collectText(text:string){const value=parse(text);if(value!==undefined)collect(value);else for(const line of text.split('\n')){const item=parse(line);if(item!==undefined)collect(item);else collect(line)}}
 function replace(text:string){
  if(imagePayloads.has(text)||/^data:image\/[^;,]+;base64,/i.test(text))return '[OMITTED_INLINE_IMAGE]';
  let out=text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED_JWT]');
  out=out.replace(/https?:\/\/[^\s<>"']+/g,raw=>{
   try{const url=new URL(raw);const keys=[...url.searchParams.keys()].filter(sensitive);if(!keys.length)return raw;for(const key of keys)url.searchParams.set(key,marker);return url.toString()}catch{return raw}
  });
  for(const value of [...secrets].sort((a,b)=>b.length-a.length))out=out.replaceAll(value,marker);return out;
 }
 // Transform JSON string tokens while leaving number literals and object layout
 // untouched. Parsing and reserializing an entire response would round bigint IDs.
 function scrubJson(text:string,depth=0):string{
  let lastKey='';
  return text.replace(/"(?:\\.|[^"\\])*"/g,(literal,offset:number)=>{
   const value=JSON.parse(literal) as string;
   let next=offset+literal.length;while(next<text.length&&/\s/.test(text[next]))next++;
   if(text[next]===':'){lastKey=value;return literal;}
   let previous=offset-1;while(previous>=0&&/\s/.test(text[previous]))previous--;
   if(text[previous]===':'&&sensitive(lastKey))return JSON.stringify(marker);
   const nested=depth<24?parse(value):undefined;
   const clean=nested!==null&&typeof nested==='object'?scrubJson(value,depth+1):replace(value);
   return clean===value?literal:JSON.stringify(clean);
  });
 }
 function redactText(text:string){
  collectText(text);
  if(parse(text)!==undefined)return scrubJson(text);
  return text.split('\n').map(line=>parse(line)!==undefined?scrubJson(line):replace(line)).join('\n');
 }
 return {collectText,redactText};
}
