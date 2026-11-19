import {mkdir,readFile,writeFile,readdir,link,unlink,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {OutcomeSchema,StatusSchema,type Outcome,type TrialStatus} from './schema.ts';
import {JobPlanSchema,canonicalJobJSON,type JobPlan,type TrialSpec} from './job-plan.ts';

export const JobTrialLeaseSchema=z.object({trialId:z.string().regex(/^t_[a-f0-9]{24}$/),attempt:z.number().int().positive().safe(),leaseId:z.string().uuid(),pid:z.number().int().positive(),startedAt:z.string().datetime()}).strict();
export type JobTrialLease=z.infer<typeof JobTrialLeaseSchema>;
export const JobTrialResultSchema=JobTrialLeaseSchema.extend({finishedAt:z.string().datetime(),outcome:OutcomeSchema,evidenceDirectory:z.string().min(1).optional()}).strict();
export type JobTrialResult=z.infer<typeof JobTrialResultSchema>;
export interface JobTrialAttempt {lease:JobTrialLease;result?:JobTrialResult}
export interface LedgerTrialState<TTrial extends {id:string}> {
 trial:TTrial;
 state:'pending'|'active'|'completed';
 latestAttempt:number;
 lease?:JobTrialLease;
 result?:JobTrialResult;
 attempts:JobTrialAttempt[];
}
export interface JobTrialState extends LedgerTrialState<TrialSpec> {}
export interface JobState {plan:JobPlan;trials:JobTrialState[]}
export interface LedgerPlan {trials:Array<{id:string}>}
export interface LedgerJobState<P extends LedgerPlan> {plan:P;trials:LedgerTrialState<P['trials'][number]>[]}
export interface JobRetryOptions {retryStatuses?:TrialStatus[]}
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
const attemptName=(attempt:number)=>'attempt-'+String(attempt).padStart(3,'0');
async function readJSON(path:string):Promise<unknown>{return JSON.parse(await readFile(path,'utf8'));}
async function atomicExclusiveJSON(path:string,value:unknown):Promise<void>{
 const temporary=path+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
 try{await link(temporary,path);}catch(error){
  if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Record already exists: '+path);
  throw error;
 }finally{await unlink(temporary);}
}
/** Lease publication, immutable attempts and explicit recovery are shared across plan versions. */
export function createJobLedger<P extends LedgerPlan>(planSchema:{parse(input:unknown):P}){
async function readPlan(dir:string):Promise<P>{return planSchema.parse(await readJSON(join(dir,'manifest.json')));}

/** Reopening can only reuse exactly the same effective config, dataset and trial matrix. */
async function openJob(dir:string,plan:P):Promise<P>{
 const parsed=planSchema.parse(plan);
 await mkdir(dir,{recursive:true,mode:0o700});
 try{await atomicExclusiveJSON(join(dir,'manifest.json'),parsed);return parsed;}catch(error){
  const previous=await readPlan(dir).catch(readError=>{if(missing(readError))throw error;throw readError;});
  if(canonicalJobJSON(previous)!==canonicalJobJSON(parsed))throw new Error('Job manifest changed; use a new Job for different config, dataset or trial matrix');
  return previous;
 }
}
function trialFromPlan(plan:P,trialId:string):P['trials'][number]{
 const trial=plan.trials.find(candidate=>candidate.id===trialId);
 if(!trial)throw new Error('Trial is outside Job plan');
 return trial;
}
async function trialState(dir:string,trial:P['trials'][number]):Promise<LedgerTrialState<P['trials'][number]>>{
 const base=join(dir,'trials',trial.id);
 let names:string[];
 try{names=await readdir(base);}catch(error){if(missing(error))return {trial,state:'pending',latestAttempt:0,attempts:[]};throw error;}
 const attempts:JobTrialAttempt[]=[];
 const ordered=names.filter(name=>/^attempt-\d{3,}$/.test(name)).sort((a,b)=>Number(a.slice(8))-Number(b.slice(8)));
 for(const [index,name] of ordered.entries()){
  const expected=index+1;
  if(name!==attemptName(expected))throw new Error('Corrupt non-contiguous Job attempt history');
  const path=join(base,name);
  const lease=JobTrialLeaseSchema.parse(await readJSON(join(path,'lease.json')));
  if(lease.trialId!==trial.id||lease.attempt!==expected)throw new Error('Corrupt Job trial lease identity');
  let result:JobTrialResult|undefined;
  try{result=JobTrialResultSchema.parse(await readJSON(join(path,'result.json')));}catch(error){if(!missing(error))throw error;}
  if(result){
   const {finishedAt:_,outcome:__,evidenceDirectory:___,...resultLease}=result;
   if(canonicalJobJSON(resultLease)!==canonicalJobJSON(lease))throw new Error('Result belongs to another Job trial lease');
  }
  if(index<ordered.length-1&&!result)throw new Error('Corrupt active attempt precedes another attempt');
  attempts.push({lease,...result?{result}:{}});
 }
 const latest=attempts.at(-1);
 return {trial,state:latest?(latest.result?'completed':'active'):'pending',latestAttempt:latest?.lease.attempt??0,...latest?{lease:latest.lease,...latest.result?{result:latest.result}:{}}:{},attempts};
}
async function listJobTrials(dir:string):Promise<LedgerTrialState<P['trials'][number]>[]>{
 const plan=await readPlan(dir);
 return Promise.all(plan.trials.map(trial=>trialState(dir,trial)));
}
async function readJob(dir:string):Promise<LedgerJobState<P>>{
 const plan=await readPlan(dir);
 return {plan,trials:await Promise.all(plan.trials.map(trial=>trialState(dir,trial)))};
}
function retryStatuses(options:JobRetryOptions):Set<TrialStatus>{
 const statuses=z.array(StatusSchema).parse(options.retryStatuses??[]);
 if(statuses.includes('passed')||statuses.includes('model_failed'))throw new Error('Scored completed trials are immutable; intentional repeats require a new repetition or Job');
 return new Set(statuses);
}

/** All technical retries are explicit and append evidence; an active lease is never stolen. */
async function beginJobTrial(dir:string,trialId:string,options:JobRetryOptions={}):Promise<JobTrialLease>{
 const retry=retryStatuses(options);
 const plan=await readPlan(dir);
 const trial=trialFromPlan(plan,trialId);
 const previous=await trialState(dir,trial);
 if(previous.state==='active')throw new Error('Trial already has an active lease; recover only after associated processes are confirmed stopped');
 if(previous.result){
  if(['passed','model_failed'].includes(previous.result.outcome.status)||!retry.has(previous.result.outcome.status))throw new Error('Trial already completed; no implicit retry');
 }
 const lease:JobTrialLease={trialId,attempt:previous.latestAttempt+1,leaseId:randomUUID(),pid:process.pid,startedAt:new Date().toISOString()};
 const base=join(dir,'trials',trialId);
 await mkdir(base,{recursive:true,mode:0o700});
 // Publish a fully initialized directory atomically: readers never observe a half-written lease.
 const temporary=join(base,'.claim-'+randomUUID());
 await mkdir(temporary,{mode:0o700});
 try{
  await atomicExclusiveJSON(join(temporary,'lease.json'),lease);
  try{await rename(temporary,join(base,attemptName(lease.attempt)));}catch(error){
   if(['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??''))throw new Error('Trial already claimed by another worker');
   throw error;
  }
 }finally{await rm(temporary,{recursive:true,force:true});}
 return lease;
}

async function finishJobTrial(dir:string,lease:JobTrialLease,outcome:Outcome,evidenceDirectory?:string):Promise<JobTrialResult>{
 const parsedLease=JobTrialLeaseSchema.parse(lease);
 const plan=await readPlan(dir);
 trialFromPlan(plan,parsedLease.trialId);
 const path=join(dir,'trials',parsedLease.trialId,attemptName(parsedLease.attempt));
 const stored=JobTrialLeaseSchema.parse(await readJSON(join(path,'lease.json')));
 if(canonicalJobJSON(stored)!==canonicalJobJSON(parsedLease))throw new Error('Lease does not match active Job trial');
 const result=JobTrialResultSchema.parse({...parsedLease,finishedAt:new Date().toISOString(),outcome,...evidenceDirectory===undefined?{}:{evidenceDirectory}});
 await atomicExclusiveJSON(join(path,'result.json'),result);
 return result;
}

/** Explicit caller confirmation is mandatory; PID liveness alone cannot prove owned children stopped. */
async function recoverJobTrial(dir:string,lease:JobTrialLease,options:{processesConfirmedStopped:boolean}):Promise<JobTrialResult>{
 if(options.processesConfirmedStopped!==true)throw new Error('Associated processes must be confirmed stopped before recovery');
 return finishJobTrial(dir,lease,{status:'interrupted',reason:'Explicit recovery after associated processes were confirmed stopped',reward:null,modelStarted:false,evidence:[]});
}

return {openJob,readJob,listJobTrials,beginJobTrial,finishJobTrial,recoverJobTrial};
}

const jobLedger=createJobLedger(JobPlanSchema);
export const {openJob,readJob,listJobTrials,beginJobTrial,finishJobTrial,recoverJobTrial}=jobLedger;
