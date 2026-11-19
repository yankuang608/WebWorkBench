import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {NeutralPlan,NeutralTrialSpec} from '../neutral-plan.ts';
import {openNeutralJob,readNeutralJob,beginNeutralTrial,finishNeutralTrial} from '../neutral-ledger.ts';
import type {JobTrialLease} from '../job-ledger.ts';
import type {Outcome,TrialStatus} from '../schema.ts';
import {acquireResource} from './locks.ts';
import {lockNeutralRuntime,verifyNeutralRuntime,resolveNeutralRuntimePlugins,neutralFixtureSeed} from './runtime.ts';
import {loadNeutralPlugins,guardNeutralImports} from './loader.ts';
import {neutralCredentialKeys,withHiddenNeutralCredentials,redactNeutralValue} from './security.ts';
import {executeNeutralTrial} from './worker.ts';
export interface NeutralExecutionContext {root:string;jobDir:string;plan:NeutralPlan;trial:NeutralTrialSpec;lease:JobTrialLease;attemptDir:string;namespace:string;signal:AbortSignal;credentials?:Record<string,string>;enterAgent(signal?:AbortSignal):Promise<void>;enterVerification():Promise<void>}
export interface NeutralExecutionResult {outcome:Outcome;evidenceDirectory?:string}
export type NeutralExecutor=(context:NeutralExecutionContext)=>Promise<NeutralExecutionResult>;
export interface RunNeutralJobOptions {root:string;jobDir?:string;locksRoot?:string;experimentIds?:string[];trialIds?:string[];retryStatuses?:TrialStatus[];signal?:AbortSignal;executor?:NeutralExecutor}
/** Schedule one record per project each round, preserving each project's original record order. */
function interleaveProjectTrials<T extends {trial:{projectKey:string}}>(records:T[]):T[]{
 const grouped=new Map<string,T[]>();for(const record of records){const key=record.trial.projectKey,group=grouped.get(key)??[];group.push(record);grouped.set(key,group);}
 const ordered:T[]=[];let active=[...grouped.values()].map(records=>({records,next:0}));
 while(active.length){const remaining:typeof active=[];for(const group of active){ordered.push(group.records[group.next++]);if(group.next<group.records.length)remaining.push(group);}active=remaining;}
 return ordered;
}
export async function runNeutralJob(plan:NeutralPlan,options:RunNeutralJobOptions){
 const root=resolve(options.root),jobDir=resolve(options.jobDir??join(root,'work/bench/jobs',plan.jobId)),locksRoot=resolve(options.locksRoot??join(root,'work/bench/job-locks'));
 await openNeutralJob(jobDir,plan);const state=await readNeutralJob(jobDir),retry=new Set(options.retryStatuses??[]);if(retry.has('passed')||retry.has('model_failed'))throw new Error('Scored trials cannot be retried');
 if(options.experimentIds?.some(id=>!plan.config.experiments.some(value=>value.id===id)))throw new Error('Experiment is outside Job plan');if(options.trialIds?.some(id=>!plan.trials.some(value=>value.id===id)))throw new Error('Trial is outside Job plan');
 const selected=state.trials.filter(record=>(!options.experimentIds||options.experimentIds.includes(record.trial.experimentId))&&(!options.trialIds||options.trialIds.includes(record.trial.id)));
 if(selected.some(record=>record.state==='active'))throw new Error('Job has active trials; confirm processes stopped and explicitly recover before resume');
 const pending=interleaveProjectTrials(selected.filter(record=>record.state==='pending'||record.result&&retry.has(record.result.outcome.status)));
 return withHiddenNeutralCredentials(neutralCredentialKeys(plan.config),async credentials=>{
  if(!options.executor&&pending.length)await lockNeutralRuntime(plan,root,jobDir);
  const resolution=!options.executor&&pending.length?await resolveNeutralRuntimePlugins(plan,root):undefined,releaseImports=resolution?guardNeutralImports(resolution):()=>{};
  let registry;try{registry=resolution?await loadNeutralPlugins(resolution):undefined;}catch(error){releaseImports();throw error;}
  const controller=new AbortController(),stop=()=>controller.abort();options.signal?.addEventListener('abort',stop,{once:true});if(options.signal?.aborted)stop();const executor=options.executor??executeNeutralTrial;let next=0;
  try{
   const workers=Array.from({length:Math.min(plan.config.scheduling.maxTrials,pending.length)},async()=>{
    while(next<pending.length&&!controller.signal.aborted){
     const scheduled=pending[next++],trial=scheduled.trial,owner={jobId:plan.jobId,trialId:trial.id};let releaseTrial:(()=>Promise<void>)|undefined,releaseProject:(()=>Promise<void>)|undefined,releaseAgent:(()=>Promise<void>)|undefined;const environmentReleases:Array<()=>Promise<void>>=[];
     let lease:JobTrialLease|undefined,attemptDir:string|undefined,agentEntered=false;
     try{
      if(registry)await verifyNeutralRuntime(plan,root,jobDir);releaseTrial=await acquireResource(locksRoot,'global-trials',{capacity:plan.config.scheduling.maxTrials,signal:controller.signal,owner});releaseProject=await acquireResource(locksRoot,'project-'+createHash('sha256').update(trial.projectKey).digest('hex'),{capacity:1,signal:controller.signal,owner});
      if(registry){const experiment=plan.config.experiments.find(value=>value.id===trial.experimentId)!,config=plan.config.environments[experiment.environment],adapter=registry.getEnvironment(config.adapter),task=plan.catalog.find(value=>value.id===trial.taskId)!;
       const anticipatedAttempt=scheduled.latestAttempt+1,anticipatedDirectory=join(jobDir,'trials',trial.id,'attempt-'+String(anticipatedAttempt).padStart(3,'0')),declared=typeof adapter.resourceKey==='function'?adapter.resourceKey({task,variant:config.variant,options:config.options,namespace:trial.namespace+'-a'+anticipatedAttempt,seed:neutralFixtureSeed(plan,trial),artifactDirectory:anticipatedDirectory,signal:controller.signal}):adapter.resourceKey;
       const keys=[...new Set([config.resourceKey,declared].filter((key):key is string=>!!key))].sort();for(const key of keys)environmentReleases.push(await acquireResource(locksRoot,'environment-'+createHash('sha256').update(key).digest('hex'),{capacity:1,signal:controller.signal,owner}));await verifyNeutralRuntime(plan,root,jobDir);
      }
      lease=await beginNeutralTrial(jobDir,trial.id,{retryStatuses:options.retryStatuses});attemptDir=join(jobDir,'trials',trial.id,'attempt-'+String(lease.attempt).padStart(3,'0'));await mkdir(attemptDir,{recursive:true});
      const enterAgent=async(signal?:AbortSignal)=>{if(agentEntered)throw new Error('Agent phase already entered');releaseAgent=await acquireResource(locksRoot,'global-agents',{capacity:plan.config.scheduling.maxAgentProcesses,signal:signal?AbortSignal.any([controller.signal,signal]):controller.signal,owner});agentEntered=true;};
      const enterVerification=async()=>{if(releaseAgent){const release=releaseAgent;releaseAgent=undefined;await release();}};
      const result=await executor({root,jobDir,plan,trial,lease,attemptDir,namespace:trial.namespace+'-a'+lease.attempt,signal:controller.signal,credentials,enterAgent,enterVerification});if(['passed','model_failed'].includes(result.outcome.status)&&!agentEntered)throw new Error('Cannot score without actual agent phase');await finishNeutralTrial(jobDir,lease,redactNeutralValue(result.outcome,Object.values(credentials)),result.evidenceDirectory);
     }catch(error){if(lease&&attemptDir){const path=join(attemptDir,'runtime-error.json'),reason=redactNeutralValue(String(error),Object.values(credentials));await writeFile(path,JSON.stringify({error:reason,at:new Date().toISOString()}),{flag:'wx',mode:0o600});await finishNeutralTrial(jobDir,lease,{status:controller.signal.aborted||agentEntered?'interrupted':'environment_blocked',reason,reward:null,modelStarted:agentEntered,evidence:[path]},attemptDir);}else if(!controller.signal.aborted)throw error;}
     finally{await releaseAgent?.();for(const release of environmentReleases.reverse())await release();await releaseProject?.();await releaseTrial?.();}
    }
   });const results=await Promise.allSettled(workers.map(worker=>worker.catch(error=>{controller.abort();throw error;}))),failure=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failure)throw failure.reason;
  }finally{options.signal?.removeEventListener('abort',stop);releaseImports();}
  const final=await readNeutralJob(jobDir);return {jobDir,jobId:plan.jobId,total:final.trials.length,pending:final.trials.filter(record=>record.state==='pending').length,active:final.trials.filter(record=>record.state==='active').length,completed:final.trials.filter(record=>record.state==='completed').length,interrupted:controller.signal.aborted};
 });
}
