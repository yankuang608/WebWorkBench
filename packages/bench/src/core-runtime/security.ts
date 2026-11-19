import {StringDecoder} from 'node:string_decoder';
import type {ModelConfig} from '../../../adapter-api/src/index.ts';
const marker='[REDACTED_MODEL_CREDENTIAL]';
const patterns=(secrets:string[])=>[...new Set(secrets.filter(Boolean).flatMap(value=>[value,JSON.stringify(value).slice(1,-1)]))].sort((a,b)=>b.length-a.length);
export function redactNeutralValue<T>(value:T,secrets:string[]):T {
 const replacements=patterns(secrets),redact=(item:any):any=>typeof item==='string'?replacements.reduce((text,secret)=>text.replaceAll(secret,marker),item):Array.isArray(item)?item.map(redact):item&&typeof item==='object'?Object.fromEntries(Object.entries(item).map(([key,child])=>[redact(key),redact(child)])):item;return redact(value);
}
export const neutralSafeError=(error:unknown)=>String(error).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED]');
/** Keep unfinished UTF-8 characters and secret prefixes across arbitrary child-output chunks. */
export class NeutralCredentialOutputFilter {
 private readonly decoder=new StringDecoder('utf8');private pending='';private readonly values:string[];private readonly maximum:number;
 constructor(secrets:string[]){this.values=patterns(secrets);this.maximum=Math.max(1,...this.values.map(value=>value.length));}
 push(chunk:Buffer):string{this.pending+=this.decoder.write(chunk);return this.flush(false);}
 end():string{this.pending+=this.decoder.end();return this.flush(true);}
 private flush(final:boolean):string {
  let boundary=final?this.pending.length:Math.max(0,this.pending.length-this.maximum+1),cursor=0,output='';
  if(boundary>0&&boundary<this.pending.length&&/[\uD800-\uDBFF]/.test(this.pending[boundary-1])&&/[\uDC00-\uDFFF]/.test(this.pending[boundary]))boundary--;
  while(cursor<boundary){let found=-1,pattern='';for(const candidate of this.values){const index=this.pending.indexOf(candidate,cursor);if(index>=0&&(found<0||index<found)){found=index;pattern=candidate;}}
   if(found<0||found>=boundary){output+=this.pending.slice(cursor,boundary);cursor=boundary;break;}output+=this.pending.slice(cursor,found)+marker;cursor=found+pattern.length;
  }this.pending=this.pending.slice(cursor);return output;
 }
}
const vault=new Map<string,{value:string|undefined;users:number}>();
export function neutralCredentialKeys(config:{agents:Record<string,{model:ModelConfig}>}):string[]{return [...new Set(Object.values(config.agents).flatMap(agent=>agent.model.provider?.envKey?[agent.model.provider.envKey]:[]))];}
/** Trusted environment/suite/profile/plugin code never receives model credentials in ambient env. */
export async function withHiddenNeutralCredentials<T>(keys:string[],operation:(credentials:Record<string,string>)=>Promise<T>):Promise<T>{
 const credentials:Record<string,string>={};
 for(const key of keys){const existing=vault.get(key);if(existing)existing.users++;else vault.set(key,{value:process.env[key],users:1});const record=vault.get(key)!;if(record.value!==undefined)credentials[key]=record.value;delete process.env[key];}
 try{return await operation(credentials);}finally{for(const key of keys){const record=vault.get(key)!;if(--record.users===0){if(record.value!==undefined)process.env[key]=record.value;else delete process.env[key];vault.delete(key);}}}
}
