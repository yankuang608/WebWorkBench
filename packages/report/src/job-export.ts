import {lstat,mkdir,readFile,readdir,realpath,rename,stat,unlink,writeFile} from 'node:fs/promises';
import {basename,dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {crc32} from 'node:zlib';
import type {JobTrialAttempt,JobTrialState} from '../../bench/src/job-ledger.ts';
import {createEvidenceRedactor} from './redaction.ts';
interface DownloadEvidence {status:string;path:string;ordinal:number;suggestedFilename:string;sha256:string|null;size:number|null}

export interface JobReportTokens {input:number;cached:number;uncached:number;output:number;reasoning:number|null}
export interface JobReportEvidence {name:string;url:string;kind:'record'|'text'|'screenshot'|'download';sourceSha256:string;exportSha256:string;size:number}
export interface JobReportAttempt {
 attempt:number;status:string;startedAt:string;finishedAt:string|null;modelStarted:boolean;reward:0|1|null;
 excluded:boolean;excludeReason:string|null;superseded:boolean;reason:string|null;
 durationSeconds:number|null;tokens:JobReportTokens|null;usageSource:'native'|'outcome'|'unknown';
 binary:{fileName:string|null;version:string|null;sha256:string|null}|null;browser:Record<string,unknown>|null;
 evidence:JobReportEvidence[]; businessPassed:boolean|null; executionValid:boolean|null; harnessSuccess:boolean|null;
}
export interface EvidenceHash {trialId:string;attempt:number;name:string;url:string|null;sourceSha256:string|null;exportSha256:string|null;exported:boolean;reason:string|null}
interface SourceEvidence {path:string;name:string;bytes:Buffer|null;kind:JobReportEvidence['kind'];exported:boolean;reason:string|null}
export type ReportState=Omit<JobTrialState,'trial'>&{trial:{id:string;taskId:string;arm?:string}};
interface AttemptContext {state:ReportState;record:JobTrialAttempt;sources:SourceEvidence[];native:Record<string,unknown>;summary:Record<string,unknown>;runtime:Record<string,unknown>}
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const text=(value:unknown)=>typeof value==='string'?value:null;
const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
const unsafeName=(name:string)=>/(?:storage[-_.]?state|mcp[-_.](?:backend|descriptor|connection)|fixtures?|seeds?|login|credentials?|cookies?|(?:^|[/._-])auth(?:[/._-]|$)|raw[-_.]?trace|\.trace(?:\.|$))/i.test(name);
const textFile=(name:string)=>/\.(?:json|jsonl|txt|log|csv|tsv|md)$/i.test(name);
const within=(root:string,path:string)=>path===root||path.startsWith(root+sep);
async function contained(root:string,path:string){const actual=await realpath(path);if(!within(root,actual))throw new Error('Evidence path escapes private Job directory');return actual;}
function validText(bytes:Buffer){const value=bytes.toString('utf8');return Buffer.from(value).equals(bytes)&&!/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(value);}
/** Export PNG pixel chunks only. Text/EXIF/unknown metadata and trailing payloads stay private. */
function safePNG(bytes:Buffer):boolean{
 if(bytes.length>10*1024*1024||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return false;
 let offset=8,first=true,image=false;
 while(offset+12<=bytes.length){
  const size=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);if(offset+size+12>bytes.length||!['IHDR','PLTE','IDAT','IEND','tRNS'].includes(type))return false;
  if(crc32(bytes.subarray(offset+4,offset+8+size))!==bytes.readUInt32BE(offset+8+size))return false;
  if(first){if(type!=='IHDR'||size!==13)return false;const width=bytes.readUInt32BE(offset+8),height=bytes.readUInt32BE(offset+12);if(!width||!height||width>10000||height>10000)return false;first=false;}
  else if(type==='IHDR')return false;
  if(type==='IDAT')image=true;
  offset+=size+12;
  if(type==='IEND')return size===0&&image&&offset===bytes.length;
 }
 return false;
}
function tokens(value:unknown):JobReportTokens|null{
 const raw=object(value),input=number(raw.inputTokens??raw.input_tokens),cached=number(raw.cachedInputTokens??raw.cached_input_tokens),output=number(raw.outputTokens??raw.output_tokens);
 if(input===null||cached===null||output===null||![input,cached,output].every(Number.isSafeInteger)||cached>input)return null;
 const reasoning=number(raw.reasoningOutputTokens??raw.reasoning_output_tokens);
 return {input,cached,uncached:input-cached,output,reasoning:reasoning!==null&&Number.isSafeInteger(reasoning)?reasoning:null};
}
function nativeTokens(model:Record<string,unknown>):JobReportTokens|null{
 if('tokenUsage' in model)return tokens(model.tokenUsage);
 if(!Array.isArray(model.usage)||!model.usage.length)return null;
 const rows=model.usage.map(tokens);if(rows.some(row=>row===null))return null;
 const known=rows as JobReportTokens[];
 const sum=(key:'input'|'cached'|'output')=>known.reduce((total,row)=>total+row[key],0);
 return tokens({inputTokens:sum('input'),cachedInputTokens:sum('cached'),outputTokens:sum('output'),reasoningOutputTokens:known.every(row=>row.reasoning!==null)?known.reduce((total,row)=>total+row.reasoning!,0):null});
}
async function readObject(root:string,path:string,allowEmpty=false):Promise<Record<string,unknown>>{try{const bytes=await readFile(await contained(root,path),'utf8');return allowEmpty&&!bytes.trim()?{}:object(JSON.parse(bytes));}catch(error){if(missing(error))return {};throw error;}}
async function context(jobRoot:string,state:ReportState,record:JobTrialAttempt):Promise<AttemptContext>{
 const attemptDir=await contained(jobRoot,join(jobRoot,'trials',state.trial.id,'attempt-'+String(record.lease.attempt).padStart(3,'0')));
 const sources:SourceEvidence[]=[];
 async function walk(directory:string){
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const path=join(directory,entry.name);
   if(entry.isSymbolicLink()){sources.push({path,name:entry.name,bytes:null,kind:'text',exported:false,reason:'Symbolic links are not exported'});continue;}
   if(entry.isDirectory()){await walk(path);continue;}
   if(!entry.isFile())continue;
   const isText=textFile(entry.name),isPng=extname(entry.name).toLowerCase()==='.png';
   if(!isText&&!isPng){sources.push({path,name:entry.name,bytes:null,kind:'text',exported:false,reason:'Raw archives, browser state and other binary files stay private'});continue;}
   if((await stat(path)).size>32*1024*1024)throw new Error('Text or image evidence exceeds safe report processing size');
   const bytes=await readFile(await contained(jobRoot,path));
   const screenshotName=[state.trial.taskId+'.before.png',state.trial.taskId+'.after.png',state.trial.taskId+'.attribution.png'].includes(entry.name);
   const safe=!unsafeName(relative(attemptDir,path).split(sep).join('/'))&&(isText?validText(bytes):screenshotName&&safePNG(bytes));
   sources.push({path,name:entry.name,bytes,kind:isPng?'screenshot':['lease.json','result.json'].includes(entry.name)?'record':'text',exported:safe,reason:safe?null:'Authentication, fixtures, invalid text or unreviewed image metadata stay private'});
  }
 }
 await walk(attemptDir);
 let native:Record<string,unknown>={},summary:Record<string,unknown>={},runtime:Record<string,unknown>={};
 {
  const declared=record.result?.evidenceDirectory?resolve(jobRoot,record.result.evidenceDirectory):join(attemptDir,'execution',state.trial.id,...state.trial.arm?[state.trial.arm]:[]);
  const nativeDir=await contained(jobRoot,declared).catch(error=>{if(missing(error))return undefined;throw error;});
  if(nativeDir){
   if(!within(attemptDir,nativeDir))throw new Error('Native evidence must belong to its own attempt');
   native=await readObject(nativeDir,join(nativeDir,state.trial.taskId+'.result.json'));
   // Codex reserves this file before execution and fills it before independent verification.
   summary=await readObject(nativeDir,join(nativeDir,state.trial.taskId+'.summary.json'),true);
   runtime=await readObject(nativeDir,join(nativeDir,'runtime-actual.json'));
   if(native.caseId!==undefined&&native.caseId!==state.trial.taskId)throw new Error('Native evidence task identity mismatch');
   for(const raw of Array.isArray(native.downloads)?native.downloads:[]){
    const download=object(raw) as Partial<DownloadEvidence>;
    if(download.status!=='completed')continue;
    if(typeof download.path!=='string'||!isAbsolute(download.path)||!Number.isSafeInteger(download.ordinal)||download.ordinal!<1||typeof download.suggestedFilename!=='string')throw new Error('Unsafe download evidence');
    const path=await contained(nativeDir,download.path);const bytes=await readFile(path);
    if(hash(bytes)!==download.sha256||bytes.length!==download.size)throw new Error('Downloaded evidence differs from recorded bytes/hash');
    const safe=!unsafeName(relative(attemptDir,path).split(sep).join('/'))&&!unsafeName(download.suggestedFilename)&&(textFile(download.suggestedFilename)?validText(bytes):extname(download.suggestedFilename).toLowerCase()==='.png'&&safePNG(bytes));
    const existing=sources.findIndex(source=>source.path===path);if(existing>=0)sources.splice(existing,1);
    sources.push({path,name:download.suggestedFilename,bytes,kind:'download',exported:safe,reason:safe?null:'Only validated text and PNG downloads are exported'});
   }
  }
 }
 return {state,record,sources,native,summary,runtime};
}
export async function prepareReportExport(jobDir:string,output:string,plan:unknown,states:ReportState[],options:{strictPrivateRoot?:boolean}={}){
 const jobRoot=await realpath(resolve(jobDir)),out=resolve(output);
 const overlaps=(path:string)=>options.strictPrivateRoot&&within(jobRoot,path)||path===jobRoot||within(path,jobRoot)||within(join(jobRoot,'trials'),path)||within(join(jobRoot,'execution'),path);
 if(overlaps(out))throw new Error('Report output must not overlap private input records');
 const redactor=createEvidenceRedactor();
 const contexts:AttemptContext[]=[];
 for(const state of states)for(const record of state.attempts)contexts.push(await context(jobRoot,state,record));
 redactor.collectText(JSON.stringify(plan));
 // Collect every text source, including non-exportable login/fixture records, before any copy.
 for(const current of contexts)for(const source of current.sources)if(source.bytes&&validText(source.bytes))redactor.collectText(source.bytes.toString('utf8'));
 function clean(source:string){return redactor.redactText(source).replaceAll(jobRoot,'[PRIVATE_JOB]').replaceAll(resolve(jobDir),'[PRIVATE_JOB]').replace(/\/(?:Users|home)\/[^\s"'<>]+/g,'[PRIVATE_PATH]');}
 const attemptsByTrial=new Map<string,JobReportAttempt[]>(),evidenceHashes:EvidenceHash[]=[];
 let existing=out;
 while(true){try{await lstat(existing);break;}catch(error){if(!missing(error))throw error;existing=dirname(existing);}}
 const destination=resolve(await realpath(existing),relative(existing,out));
 if(overlaps(destination))throw new Error('Report output redirects into private input records');
 await mkdir(destination,{recursive:true,mode:0o700});
 async function writePublic(path:string,bytes:Buffer|string){
  const target=join(destination,path);let directory=destination;
  for(const part of relative(destination,dirname(target)).split(sep).filter(Boolean)){
   directory=join(directory,part);
   try{await mkdir(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   const entry=await lstat(directory);if(entry.isSymbolicLink()||!entry.isDirectory())throw new Error('Export destination must stay inside the report directory');
  }
  // Atomic replacement never follows an existing leaf symlink or writes through a hard link.
  const temporary=target+'.'+randomUUID()+'.tmp';await writeFile(temporary,bytes,{flag:'wx',mode:0o600});
  try{await rename(temporary,target);}finally{await unlink(temporary).catch(error=>{if(!missing(error))throw error;});}
 }
 const byLease=new Map(contexts.map(current=>[current.record.lease.leaseId,current]));
 for(const state of states){
  const attempts:JobReportAttempt[]=[];
  for(const record of state.attempts){
   const current=byLease.get(record.lease.leaseId)!,outcome=record.result?.outcome,model=object(current.native.model),binary={...object(current.summary.binary),...object(model.binary)};
   const nativeUsage=nativeTokens(model)??nativeTokens(current.summary),outcomeUsage=tokens(outcome?.usage),usage=nativeUsage??outcomeUsage;
   const durationMs=number(model.durationMs)??number(current.summary.durationMs);
   const actualBrowser=object(current.runtime.browserConfig),browserVersion=text(current.runtime.browserVersion??object(current.native.browser).version);
   const evidence:JobReportEvidence[]=[];
   for(const [index,source] of current.sources.entries()){
    const sourceSha256=source.bytes?hash(source.bytes):null;
    if(!source.exported||!source.bytes){evidenceHashes.push({trialId:state.trial.id,attempt:record.lease.attempt,name:source.name,url:null,sourceSha256,exportSha256:null,exported:false,reason:source.reason});continue;}
    const leaf=String(index).padStart(3,'0')+'-'+basename(clean(source.name)).replace(/[^a-zA-Z0-9_.-]/g,'_').slice(0,100);
    const url='evidence/'+state.trial.id+'/attempt-'+String(record.lease.attempt).padStart(3,'0')+'/'+leaf;
    const bytes=source.kind==='screenshot'||extname(source.name).toLowerCase()==='.png'?source.bytes:Buffer.from(clean(source.bytes.toString('utf8')));
    const exportSha256=hash(bytes);await writePublic(url,bytes);
    evidence.push({name:source.name,url,kind:source.kind,sourceSha256:sourceSha256!,exportSha256,size:bytes.length});
    evidenceHashes.push({trialId:state.trial.id,attempt:record.lease.attempt,name:source.name,url,sourceSha256,exportSha256,exported:true,reason:null});
   }
   const superseded=record.lease.attempt!==state.latestAttempt,excluded=superseded||!outcome||outcome.reward===null;
   attempts.push({attempt:record.lease.attempt,status:outcome?.status??'active',startedAt:record.lease.startedAt,finishedAt:record.result?.finishedAt??null,modelStarted:outcome?.modelStarted??false,reward:outcome?.reward??null,excluded,excludeReason:excluded?(outcome?.reason??'Attempt is active; independent outcome is pending'):null,superseded,reason:outcome?.reason??null,
    durationSeconds:durationMs===null?null:durationMs/1000,tokens:usage,usageSource:nativeUsage?'native':outcomeUsage?'outcome':'unknown',
    binary:Object.keys(binary).length?{fileName:text(binary.path??binary.requested)?basename(String(binary.path??binary.requested)):null,version:text(binary.version),sha256:text(binary.sha256)}:null,
    businessPassed:typeof object(current.native.oracle).businessPassed==='boolean'?object(current.native.oracle).businessPassed as boolean:null,executionValid:typeof object(current.native.oracle).executionValid==='boolean'?object(current.native.oracle).executionValid as boolean:null,harnessSuccess:typeof model.success==='boolean'?model.success:null,
    browser:browserVersion||Object.keys(actualBrowser).length?{version:browserVersion,...Object.fromEntries(['channel','headless','viewport','locale','timezoneId'].filter(key=>key in actualBrowser).map(key=>[key,actualBrowser[key]]))}:null,evidence});
  }
  attemptsByTrial.set(state.trial.id,attempts);
 }
 return {attemptsByTrial,evidenceHashes,clean,writePublic,out,destination};
}
