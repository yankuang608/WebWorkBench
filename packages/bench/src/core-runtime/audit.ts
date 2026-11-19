import {appendFile,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import type {ToolSession,ToolResult,ToolLifecycleEvent} from '../../../adapter-api/src/index.ts';
import {neutralSafeError,redactNeutralValue} from './security.ts';
export interface NeutralAuditRecord {type:'tool.started'|'tool.completed';id:string;at:string;tool:string;arguments:Record<string,unknown>;sequence?:number;profileAdapter?:string;status?:'completed'|'failed';result?:ToolResult;error?:string}
export interface NeutralToolObserver {profileAdapter:string;onToolEvent(event:ToolLifecycleEvent):void|Promise<void>}
/** Native calls and their private observations form one serial transaction, not just serial file writes. */
export function auditedNeutralTools(session:ToolSession,path:string,signal:AbortSignal,secrets:string[]=[],observer?:NeutralToolObserver):ToolSession & {stopAdmission():void;readonly lastToolSequence:number;readonly observerErrors:readonly string[]} {
 let queue=Promise.resolve(),dispatch=Promise.resolve(),ended=false,sequence=0,quiescing:Promise<void>|undefined,closing:Promise<void>|undefined;const inFlight=new Set<Promise<unknown>>(),observerErrors:string[]=[];
 const write=(value:NeutralAuditRecord)=>{const next=queue.then(()=>appendFile(path,JSON.stringify(redactNeutralValue(value,secrets))+'\n',{mode:0o600}));queue=next;return next;};
 const observe=async(event:ToolLifecycleEvent)=>{if(!observer)return true;try{await observer.onToolEvent(structuredClone(event));return true;}catch(error){observerErrors.push(neutralSafeError(error));ended=true;return false;}};
 const quiesce=()=>{ended=true;return quiescing??=(async()=>{const backend=session.quiesce();void backend.catch(()=>{});await Promise.allSettled([...inFlight]);await queue;await backend;})();};
 return {stopAdmission(){ended=true;},get lastToolSequence(){return sequence;},get observerErrors(){return [...observerErrors];},hooks:session.hooks,list:()=>session.list(),quiesce,
  call(name,args){const argumentsSnapshot=structuredClone(args),id=randomUUID();
   const task=dispatch.then(async()=>{
    const denied=ended||signal.aborted,admittedSequence=denied?undefined:++sequence,base={id,tool:name,arguments:argumentsSnapshot,...(admittedSequence===undefined?{}:{sequence:admittedSequence}),...(observer?{profileAdapter:observer.profileAdapter}:{})};
    const eventBase={sequence:admittedSequence!,callId:id,profileAdapter:observer?.profileAdapter??'unknown',name,arguments:argumentsSnapshot};
    const at=new Date().toISOString();await write({...base,type:'tool.started',at});
    const callObserved=admittedSequence===undefined||await observe({...eventBase,phase:'call',at});
    try{
     if(!callObserved)throw new Error('Tool call stopped because host observation failed');
     if(denied||signal.aborted)throw new Error(ended?'Tool session has quiesced or closed':'Tool call cancelled');
     const result=await session.call(name,structuredClone(argumentsSnapshot));if(!result||!Array.isArray(result.content))throw new Error('Tool adapter returned an invalid native ToolResult');
     const at=new Date().toISOString();await write({...base,type:'tool.completed',at,status:result.isError?'failed':'completed',result});
     await observe({...eventBase,phase:'result',at,result});return result;
    }catch(error){const at=new Date().toISOString(),message=neutralSafeError(error);await write({...base,type:'tool.completed',at,status:'failed',error:message});if(admittedSequence!==undefined)await observe({...eventBase,phase:'error',at,error:message});throw error;}
   });dispatch=task.then(()=>{},()=>{});
   inFlight.add(task);void task.finally(()=>inFlight.delete(task)).catch(()=>{});return task;
  },close(){ended=true;return closing??=(async()=>{let failure:unknown;try{await quiesce();}catch(error){failure=error;}const backend=session.close();void backend.catch(()=>{});await Promise.allSettled([...inFlight]);await queue;await backend;if(failure)throw failure;})();}
 };
}
export async function readNeutralAudit(path:string):Promise<NeutralAuditRecord[]>{const bytes=await readFile(path,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});return bytes.split('\n').filter(Boolean).map(line=>JSON.parse(line));}
