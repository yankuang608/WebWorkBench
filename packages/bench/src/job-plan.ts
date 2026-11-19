import {createHash} from 'node:crypto';
import {z} from 'zod';
import {JobConfigSchema,type JobConfig} from './job-config.ts';
import {ExecutionArmSchema,TaskIdSchema} from './schema.ts';

/** Canonical object keys make hashes independent of JSON/YAML property order. */
export function canonicalJobJSON(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonicalJobJSON).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>JSON.stringify(key)+':'+canonicalJobJSON(v)).join(',')+'}';
 return JSON.stringify(value);
}
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const digest=(value:unknown)=>createHash('sha256').update(canonicalJobJSON(value)).digest('hex');
function matrixSize(config:JobConfig):number{
 let count=1;
 for(const dimension of [config.taskIds.length,config.agents.length,config.arms.length,config.repetitions]){
  if(dimension>100000/count)throw new Error('Job trial matrix exceeds limit of 100000 trials');
  count*=dimension;
 }
 return count;
}
const catalogTask=z.object({id:TaskIdSchema,projectKey:z.string().regex(/^[RV]\d{2}$/),sha256:sha}).strict().refine(t=>t.id.startsWith(t.projectKey+'-'),'Task project identity mismatch');
export const TrialSpecSchema=z.object({id:z.string().regex(/^t_[a-f0-9]{24}$/),taskId:TaskIdSchema,projectKey:z.string().regex(/^[RV]\d{2}$/),agentId:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),arm:ExecutionArmSchema,repetition:z.number().int().positive(),namespace:z.string().regex(/^wwb_[a-f0-9]{24}$/)}).strict();
export type TrialSpec=z.infer<typeof TrialSpecSchema>;
function identity(jobId:string,configSha256:string,datasetSha256:string,taskId:string,agentId:string,arm:string,repetition:number){
 const short=digest([jobId,configSha256,datasetSha256,taskId,agentId,arm,repetition]).slice(0,24);
 return {id:'t_'+short,namespace:'wwb_'+short};
}
export const JobPlanSchema=z.object({schemaVersion:z.literal('2.0'),jobId:z.string(),config:JobConfigSchema,configSha256:sha,datasetSha256:sha,trials:z.array(TrialSpecSchema).nonempty()}).strict().superRefine((plan,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(plan.jobId!==plan.config.id)fail('Job identity differs from config');
 if(plan.configSha256!==digest(plan.config))fail('Plan config hash mismatch');
 let expected:number;
 try{expected=matrixSize(plan.config);}catch{fail('Job trial matrix exceeds limit of 100000 trials');return;}
 if(plan.trials.length!==expected)fail('Plan trial matrix differs from effective config');
 const seen=new Set<string>();
 for(const trial of plan.trials){
  const valid=plan.config.taskIds.includes(trial.taskId)&&plan.config.agents.some(a=>a.id===trial.agentId)&&plan.config.arms.includes(trial.arm)&&trial.repetition<=plan.config.repetitions&&trial.taskId.startsWith(trial.projectKey+'-');
  if(!valid)fail('Trial is outside effective config');
  const ids=identity(plan.jobId,plan.configSha256,plan.datasetSha256,trial.taskId,trial.agentId,trial.arm,trial.repetition);
  if(trial.id!==ids.id||trial.namespace!==ids.namespace)fail('Trial identity or namespace mismatch');
  if(seen.has(trial.id))fail('Duplicate trial identity');seen.add(trial.id);
 }
});
export type JobPlan=z.infer<typeof JobPlanSchema>;

export function createJobPlan(config:JobConfig,tasks:Array<{id:string;projectKey:string;sha256:string}>):JobPlan{
 const parsed=JobConfigSchema.parse(config);
 matrixSize(parsed);
 const catalog=z.array(catalogTask).parse(tasks);
 const byId=new Map(catalog.map(task=>[task.id,task]));
 if(byId.size!==catalog.length)throw new Error('Duplicate catalog task ids');
 const selected=[...parsed.taskIds].sort().map(id=>{const task=byId.get(id);if(!task)throw new Error('Selected task missing from catalog: '+id);return task;});
 const configSha256=digest(parsed);
 const datasetSha256=digest(selected.map(({id,sha256})=>({id,sha256})));
 const trials:TrialSpec[]=[];
 for(const task of selected)for(const agent of parsed.agents)for(const arm of parsed.arms)for(let repetition=1;repetition<=parsed.repetitions;repetition++){
  trials.push({...identity(parsed.id,configSha256,datasetSha256,task.id,agent.id,arm,repetition),taskId:task.id,projectKey:task.projectKey,agentId:agent.id,arm,repetition});
 }
 return JobPlanSchema.parse({schemaVersion:'2.0',jobId:parsed.id,config:parsed,configSha256,datasetSha256,trials});
}
