import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {JSONValue,SuiteCase} from '../../adapter-api/src/index.ts';
import {NeutralConfigSchema,type NeutralConfig} from './neutral-config.ts';
import {canonicalJobJSON} from './job-plan.ts';

const identifier=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const json:z.ZodType<JSONValue>=z.lazy(()=>z.union([z.null(),z.boolean(),z.number().finite(),z.string(),z.array(json),z.record(json)]));
export const NeutralCatalogCaseSchema=z.object({id:identifier,projectKey:identifier,sha256:sha,metadata:z.record(json).optional()}).strict();
export const hashNeutralValue=(value:unknown):string=>createHash('sha256').update(canonicalJobJSON(value)).digest('hex');
export const hashNeutralConfig=(config:NeutralConfig):string=>hashNeutralValue(NeutralConfigSchema.parse(config));
export const deriveNeutralFixtureSeed=(datasetSha256:string,taskId:string,repetition:number):string=>hashNeutralValue(['4.0',datasetSha256,taskId,repetition]);
function matrixSize(config:NeutralConfig):number{
 let count=1;
 for(const dimension of [config.taskIds.length,config.experiments.length,config.repetitions]){
  if(dimension>100000/count)throw new Error('Job trial matrix exceeds limit of 100000 trials');count*=dimension;
 }
 return count;
}
export const NeutralTrialSpecSchema=z.object({id:z.string().regex(/^t_[a-f0-9]{24}$/),taskId:identifier,projectKey:identifier,experimentId:identifier,repetition:z.number().int().positive().safe(),namespace:z.string().regex(/^wwb_[a-f0-9]{24}$/),fixtureSeed:sha}).strict();
export type NeutralTrialSpec=z.output<typeof NeutralTrialSpecSchema>;
function identity(jobId:string,configSha256:string,datasetSha256:string,taskId:string,experimentId:string,repetition:number){
 const short=hashNeutralValue(['4.0',jobId,configSha256,datasetSha256,taskId,experimentId,repetition]).slice(0,24);
 return {id:'t_'+short,namespace:'wwb_'+short,fixtureSeed:deriveNeutralFixtureSeed(datasetSha256,taskId,repetition)};
}
export const NeutralPlanSchema=z.object({schemaVersion:z.literal('4.0'),jobId:identifier,config:NeutralConfigSchema,configSha256:sha,datasetSha256:sha,catalog:z.array(NeutralCatalogCaseSchema).nonempty(),trials:z.array(NeutralTrialSpecSchema).nonempty()}).strict().superRefine((plan,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(plan.jobId!==plan.config.id)fail('Job identity differs from config');
 if(plan.configSha256!==hashNeutralValue(plan.config))fail('Plan config hash mismatch');
 if(plan.datasetSha256!==hashNeutralValue(plan.catalog))fail('Plan dataset hash mismatch');
 const catalog=new Map(plan.catalog.map(task=>[task.id,task]));
 if(catalog.size!==plan.catalog.length)fail('Duplicate catalog task ids');
 if(canonicalJobJSON(plan.catalog.map(task=>task.id))!==canonicalJobJSON([...plan.config.taskIds].sort()))fail('Plan catalog differs from selected tasks');
 let expected:number;try{expected=matrixSize(plan.config);}catch{fail('Job trial matrix exceeds limit of 100000 trials');return;}
 if(plan.trials.length!==expected)fail('Plan trial matrix differs from effective config');
 const seen=new Set<string>();
 for(const trial of plan.trials){
  if(!plan.config.taskIds.includes(trial.taskId)||!plan.config.experiments.some(e=>e.id===trial.experimentId)||trial.repetition>plan.config.repetitions||catalog.get(trial.taskId)?.projectKey!==trial.projectKey)fail('Trial is outside effective config');
  const ids=identity(plan.jobId,plan.configSha256,plan.datasetSha256,trial.taskId,trial.experimentId,trial.repetition);
  if(trial.id!==ids.id||trial.namespace!==ids.namespace||trial.fixtureSeed!==ids.fixtureSeed)fail('Trial identity, namespace or fixture seed mismatch');
  if(seen.has(trial.id))fail('Duplicate trial identity');seen.add(trial.id);
 }
});
export type NeutralPlan=z.output<typeof NeutralPlanSchema>;
export function createNeutralPlan(config:NeutralConfig,tasks:SuiteCase[]):NeutralPlan{
 const parsed=NeutralConfigSchema.parse(config);matrixSize(parsed);
 const catalog=z.array(NeutralCatalogCaseSchema).parse(tasks);const byId=new Map(catalog.map(task=>[task.id,task]));
 if(byId.size!==catalog.length)throw new Error('Duplicate catalog task ids');
 const selected=[...parsed.taskIds].sort().map(id=>{const task=byId.get(id);if(!task)throw new Error('Selected task missing from catalog: '+id);return task;});
 const configSha256=hashNeutralValue(parsed);const datasetSha256=hashNeutralValue(selected);
 const trials:NeutralTrialSpec[]=[];
 for(const task of selected)for(const experiment of parsed.experiments)for(let repetition=1;repetition<=parsed.repetitions;repetition++){
  trials.push({...identity(parsed.id,configSha256,datasetSha256,task.id,experiment.id,repetition),taskId:task.id,projectKey:task.projectKey,experimentId:experiment.id,repetition});
 }
 return NeutralPlanSchema.parse({schemaVersion:'4.0',jobId:parsed.id,config:parsed,configSha256,datasetSha256,catalog:selected,trials});
}
