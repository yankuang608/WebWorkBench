import {mkdir,readFile,writeFile,readdir,rm,rename,link,unlink,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export interface ResourceOptions {capacity:number;signal?:AbortSignal;owner?:{jobId:string;trialId:string}}
export interface ResourceRecoveryOptions {poolProcessesConfirmedStopped?:boolean}
interface ResourceOwner {leaseId:string;pid:number;jobId?:string;trialId?:string}
interface ResourceRecord {path:string;dev:number;ino:number;bytes:string|null;owner:ResourceOwner|null;pid:number|null}
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const capacity=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=1&&Number(value)<=128;
const validPid=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647;
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
const aborted=()=>new Error('Resource acquisition aborted');
function slots(entries:string[]):string[]{return entries.filter(name=>{
 if(!name.startsWith('slot-'))return false;
 if(!/^slot-(?:0|[1-9]\d*)$/.test(name)||Number(name.slice(5))>=128)throw new Error('Invalid resource slot name: '+name);
 return true;
});}
async function pause(signal?:AbortSignal){
 if(signal?.aborted)throw aborted();
 await new Promise<void>((done,reject)=>{
  const stop=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(aborted());};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);done();},25);
  signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
 });
}
/** Hard-link publication is exclusive even when an old ownerless directory occupies the name. */
async function publish(pool:string,name:string,owner:ResourceOwner){
 const temporary=join(pool,'.claim-'+randomUUID());
 try{
  await writeFile(temporary,JSON.stringify(owner),{flag:'wx',mode:0o600});
  try{await link(temporary,join(pool,name));return true;}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}
 }finally{await unlink(temporary).catch(error=>{if(!missing(error))throw error;});}
}
/** Read both new immutable files and legacy directory/owner.json records without following symlinks. */
async function resourceRecord(path:string):Promise<ResourceRecord|null>{
 const entry=await lstat(path).catch(error=>{if(missing(error))return null;throw error;});if(!entry)return null;
 let bytes:string|null=null;
 try{
  if(entry.isFile())bytes=await readFile(path,'utf8');
  else if(entry.isDirectory()){
   const ownerPath=join(path,'owner.json'),ownerEntry=await lstat(ownerPath).catch(error=>{if(missing(error))return null;throw error;});
   if(ownerEntry?.isFile())bytes=await readFile(ownerPath,'utf8');
  }
 }catch(error){if(!missing(error))throw error;}
 // A scanned entry may have been released normally while its owner file was being read.
 if(!await lstat(path).catch(error=>{if(missing(error))return null;throw error;}))return null;
 let raw:Record<string,unknown>={};
 if(bytes!==null)try{const parsed=JSON.parse(bytes);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))raw=parsed;}catch(error){if(!(error instanceof SyntaxError))throw error;}
 const pid=validPid(raw.pid)?raw.pid:null;
 const valid=pid!==null&&typeof raw.leaseId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(raw.leaseId)
  &&(raw.jobId===undefined&&raw.trialId===undefined||identifier(raw.jobId)&&identifier(raw.trialId));
 return {path,dev:entry.dev,ino:entry.ino,bytes,pid,owner:valid?{leaseId:raw.leaseId as string,pid:pid!,...raw.jobId!==undefined?{jobId:raw.jobId as string,trialId:raw.trialId as string}:{}}:null};
}
function requireStopped(pid:number|null){
 if(pid===null)return;
 try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;if((error as NodeJS.ErrnoException).code!=='EPERM')throw error;}
 throw new Error('Resource owner is still alive; refuse recovery');
}
async function releaseOwned(path:string,owner:ResourceOwner){
 const actual=await resourceRecord(path);
 if(!actual?.owner||actual.owner.leaseId!==owner.leaseId||actual.owner.pid!==owner.pid)throw new Error('Resource belongs to another owner');
 await rm(path,{recursive:true});
}
/** A shared filesystem pool also serializes capacity changes until its owners exit. */
export async function acquireResource(root:string,key:string,options:ResourceOptions):Promise<()=>Promise<void>>{
 if(!identifier(key)||!capacity(options.capacity)||options.owner&&(!identifier(options.owner.jobId)||!identifier(options.owner.trialId)))throw new Error('Invalid resource pool');
 if(options.signal?.aborted)throw aborted();
 const pool=join(root,key);await mkdir(pool,{recursive:true,mode:0o700});
 if(!(await lstat(pool)).isDirectory())throw new Error('Invalid resource pool directory');
 const owner:ResourceOwner={leaseId:randomUUID(),pid:process.pid,...options.owner?{jobId:options.owner.jobId,trialId:options.owner.trialId}:{}};
 while(true){
  if(options.signal?.aborted)throw aborted();
  const control=join(pool,'.control');
  if(!await publish(pool,'.control',owner)){await pause(options.signal);continue;}
  let slot:string|undefined;
  try{
   try{
    if(options.signal?.aborted)throw aborted();
    const occupied=slots(await readdir(pool));
    const current=await readFile(join(pool,'capacity.json'),'utf8').then(JSON.parse).catch(error=>{if(missing(error))return null;throw error;});
    if(current!==null&&!capacity(current?.capacity))throw new Error('Invalid resource pool capacity');
    const compatible=!!current&&current.capacity===options.capacity;
    if(!compatible&&!occupied.length){
     const temporary=join(pool,'.capacity-'+randomUUID());
     try{await writeFile(temporary,JSON.stringify({capacity:options.capacity}),{flag:'wx',mode:0o600});await rename(temporary,join(pool,'capacity.json'));}
     finally{await unlink(temporary).catch(error=>{if(!missing(error))throw error;});}
    }
    for(let i=0;i<options.capacity&&(compatible||!occupied.length);i++){
     if(options.signal?.aborted)throw aborted();
     if(await publish(pool,'slot-'+i,owner)){slot=join(pool,'slot-'+i);break;}
    }
   }finally{await releaseOwned(control,owner);}
  }catch(error){if(slot)await releaseOwned(slot,owner);throw error;}
  if(!slot){await pause(options.signal);continue;}
  if(options.signal?.aborted){await releaseOwned(slot,owner);throw aborted();}
  let released=false;
  return async()=>{if(released)return;await releaseOwned(slot!,owner);released=true;};
 }
}
/** Job confirmation cannot attribute legacy unknown owners; clearing those requires explicit whole-pool confirmation. */
export async function clearStoppedJobResources(root:string,jobId:string,confirmed:boolean,options:ResourceRecoveryOptions={}):Promise<void>{
 if(confirmed!==true)throw new Error('Confirm associated processes stopped before resource recovery');
 if(!identifier(jobId))throw new Error('Invalid resource Job identity');
 const records:ResourceRecord[]=[];
 for(const pool of (await readdir(root).catch(error=>{if(missing(error))return [];throw error;})).sort()){
  if(!identifier(pool))throw new Error('Invalid resource pool key: '+pool);
  const directory=join(root,pool),entry=await lstat(directory).catch(error=>{if(missing(error))return null;throw error;});if(!entry)continue;
  if(!entry.isDirectory())throw new Error('Invalid resource pool directory');
  const entries:string[]=await readdir(directory).catch(error=>{if(missing(error))return [];throw error;});const candidates=slots(entries);if(entries.includes('.control'))candidates.unshift('.control');
  for(const name of candidates){
   const record=await resourceRecord(join(directory,name));if(!record)continue;
   if(options.poolProcessesConfirmedStopped===true){requireStopped(record.pid);records.push(record);continue;}
   if(!record.owner)throw new Error('Unknown resource owner; whole-pool confirmation (--confirm-pool-stopped) is required');
   if(record.owner.jobId!==jobId)continue;
   requireStopped(record.pid);records.push(record);
  }
 }
 // Preflight every candidate before modifying the pool; a live owner leaves all old records intact.
 for(const previous of records){
  const current=await resourceRecord(previous.path);if(!current)continue;
  if(current.dev!==previous.dev||current.ino!==previous.ino||current.bytes!==previous.bytes)throw new Error('Resource owner changed; refuse recovery');
  requireStopped(current.pid);await rm(current.path,{recursive:true}).catch(error=>{if(!missing(error))throw error;});
 }
}
