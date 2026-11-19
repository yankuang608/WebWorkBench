import {readFile} from 'node:fs/promises';
import {dirname,extname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse as parseYAML} from 'yaml';
import {z} from 'zod';
import {TaskIdSchema} from './schema.ts';
import {loadCatalog} from './catalog.ts';
import {ModelEnvKeySchema} from './job-config.ts';

export type JSONValue=null|boolean|number|string|JSONValue[]|{[key:string]:JSONValue};
export type JSONOptions=Record<string,JSONValue>;
const json:z.ZodType<JSONValue>=z.lazy(()=>z.union([z.null(),z.boolean(),z.number().finite(),z.string(),z.array(json),z.record(json)]));
const identifier=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/,'Identity must contain only letters, digits, underscores or hyphens');
const nonempty=z.string().regex(/^[^\0\r\n]*$/,'NUL and line breaks are forbidden').trim().min(1);
const positive=z.number().int().positive().safe();
const timeout=positive.max(2147483647,'Budget exceeds Node timer range');
const cleanupTimeout=timeout.min(1500,'Cleanup needs at least 1500ms for owned backends');
const poolCapacity=positive.max(128,'Host resource pools support at most 128 slots');
const localPath=nonempty.refine(p=>!p.startsWith('/')&&!p.includes('\\')&&!p.split('/').some(part=>part==='..'||part==='.'||part==='')&&!/^[a-zA-Z]:/.test(p),'Plugin paths must stay inside the repository');
const duplicate=(values:string[])=>new Set(values).size!==values.length;
function credentialField(key:string):boolean{
 const normalized=key.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase().replace(/[-_\s]/g,'');
 return /^(authorization|bearer|token)$/.test(normalized)||/(secret|password|credentials?)$/.test(normalized)||/(api|access|auth|authentication|bearer|refresh|session)token$/.test(normalized)||/(api|access|private|secret|signing|client|consumer)key$/.test(normalized);
}
function credentialOption(value:JSONValue):boolean{
 if(Array.isArray(value))return value.some(credentialOption);
 if(value!==null&&typeof value==='object')return Object.entries(value).some(([key,child])=>credentialField(key)||credentialOption(child));
 return false;
}
const options=z.record(json).refine(value=>!credentialOption(value),'Credentials must use dedicated model provider envKey references');
const endpoint=z.string().url().superRefine((value,ctx)=>{
 const url=new URL(value);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||value.includes('?')||value.includes('#'))ctx.addIssue({code:'custom',message:'Endpoint must be HTTP(S) without credentials, query or fragment'});
});
export const ExperimentModelSchema=z.object({name:nonempty,reasoningEffort:nonempty.optional(),provider:z.object({id:identifier,baseUrl:endpoint,envKey:ModelEnvKeySchema.optional()}).strict().optional(),options:options.optional()}).strict();
export type ExperimentModel=z.output<typeof ExperimentModelSchema>;
export const ExperimentAgentSchema=z.object({harness:z.object({adapter:identifier,binary:nonempty.optional(),options:options.optional()}).strict(),model:ExperimentModelSchema}).strict();
export type ExperimentAgent=z.output<typeof ExperimentAgentSchema>;
export const ExperimentEnvironmentSchema=z.object({adapter:identifier,variant:identifier,options:options.optional(),resourceKey:nonempty.optional()}).strict();
export type ExperimentEnvironment=z.output<typeof ExperimentEnvironmentSchema>;
export const ExperimentToolProfileSchema=z.object({adapter:identifier,options:options.optional()}).strict();
export type ExperimentToolProfile=z.output<typeof ExperimentToolProfileSchema>;
export const ExperimentSpecSchema=z.object({id:identifier,agent:identifier,environment:identifier,toolProfile:identifier}).strict();
export type ExperimentSpec=z.output<typeof ExperimentSpecSchema>;
export const ExperimentComparisonSchema=z.object({id:identifier,left:identifier,right:identifier}).strict();
export type ExperimentComparison=z.output<typeof ExperimentComparisonSchema>;
export const ExperimentPluginSchema=z.object({module:localPath,files:z.array(localPath).optional()}).strict().superRefine((plugin,ctx)=>{
 if(plugin.files&&duplicate(plugin.files))ctx.addIssue({code:'custom',message:'Duplicate plugin dependency files'});
});
export type ExperimentPlugin=z.output<typeof ExperimentPluginSchema>;
const named=<T extends z.ZodTypeAny>(schema:T)=>z.record(identifier,schema).refine(value=>Object.keys(value).length>0,'Named adapter map must not be empty');
const budgets=z.object({setupMs:timeout.optional(),agentMs:timeout.optional(),verificationMs:timeout.optional(),cleanupMs:cleanupTimeout.optional()}).strict();
const scheduling=z.object({maxTrials:poolCapacity.optional(),maxAgentProcesses:poolCapacity.optional(),perProjectConcurrency:z.literal(1).optional()}).strict();
const inputObject=z.object({schemaVersion:z.literal('3.0'),id:identifier,taskIds:z.array(TaskIdSchema).nonempty().optional(),agents:named(ExperimentAgentSchema),environments:named(ExperimentEnvironmentSchema),toolProfiles:named(ExperimentToolProfileSchema),experiments:z.array(ExperimentSpecSchema).nonempty(),comparisons:z.array(ExperimentComparisonSchema).optional(),plugins:z.array(ExperimentPluginSchema).optional(),repetitions:positive.optional(),budgets:budgets.optional(),scheduling:scheduling.optional()}).strict();
function validateReferences(value:z.output<typeof inputObject>,ctx:z.RefinementCtx):void{
 const issue=(message:string)=>ctx.addIssue({code:'custom',message});
 if(value.taskIds&&duplicate(value.taskIds))issue('Duplicate task ids');
 if(duplicate(value.experiments.map(e=>e.id)))issue('Duplicate experiment ids');
 const ids=new Set(value.experiments.map(e=>e.id));
 for(const experiment of value.experiments){
  if(!Object.hasOwn(value.agents,experiment.agent))issue('Unknown experiment agent: '+experiment.agent);
  if(!Object.hasOwn(value.environments,experiment.environment))issue('Unknown experiment environment: '+experiment.environment);
  if(!Object.hasOwn(value.toolProfiles,experiment.toolProfile))issue('Unknown experiment tool profile: '+experiment.toolProfile);
 }
 if(value.comparisons){
  if(duplicate(value.comparisons.map(c=>c.id)))issue('Duplicate comparison ids');
  for(const comparison of value.comparisons){
   if(!ids.has(comparison.left)||!ids.has(comparison.right))issue('Unknown comparison experiment');
   if(comparison.left===comparison.right)issue('Comparison needs two different experiments');
  }
 }
 if(value.plugins&&duplicate(value.plugins.map(plugin=>plugin.module)))issue('Duplicate plugin modules');
}
export const ExperimentInputSchema=inputObject.superRefine(validateReferences);
export type ExperimentInput=z.input<typeof ExperimentInputSchema>;
export const ExperimentConfigSchema=inputObject.extend({
 taskIds:z.array(TaskIdSchema).nonempty(),repetitions:positive.default(1),
 budgets:z.object({setupMs:timeout.default(600000),agentMs:timeout.default(600000),verificationMs:timeout.default(120000),cleanupMs:cleanupTimeout.default(30000)}).strict().default({}),
 scheduling:z.object({maxTrials:poolCapacity.default(4),maxAgentProcesses:poolCapacity.default(4),perProjectConcurrency:z.literal(1).default(1)}).strict().default({}),
 comparisons:z.array(ExperimentComparisonSchema).default([]),plugins:z.array(ExperimentPluginSchema).default([]),
}).superRefine(validateReferences);
export type ExperimentConfig=z.output<typeof ExperimentConfigSchema>;
export type ExperimentJobConfig=ExperimentConfig;

export function resolveExperimentConfig(input:unknown,availableTaskIds:string[]):ExperimentConfig{
 const parsed=ExperimentInputSchema.parse(input);
 const catalog=z.array(TaskIdSchema).nonempty().parse(availableTaskIds);
 if(duplicate(catalog))throw new Error('Duplicate available catalog task ids');
 const selected=parsed.taskIds??catalog;
 const missing=selected.filter(id=>!catalog.includes(id));
 if(missing.length)throw new Error('Selected tasks are outside original catalog: '+missing.join(', '));
 return ExperimentConfigSchema.parse({...parsed,taskIds:[...selected].sort()});
}
export async function loadExperimentConfig(path:string,availableTaskIds?:string[]):Promise<ExperimentConfig>{
 const source=await readFile(path,'utf8');
 const input=['.yaml','.yml'].includes(extname(path).toLowerCase())?parseYAML(source,{maxAliasCount:100}):JSON.parse(source);
 const taskIds=availableTaskIds??(await loadCatalog(await repositoryRoot())).tasks.map(entry=>entry.task.id);
 return resolveExperimentConfig(input,taskIds);
}
async function repositoryRoot():Promise<string>{
 let directory=dirname(fileURLToPath(import.meta.url));
 while(true){
  try{if(JSON.parse(await readFile(join(directory,'package.json'),'utf8')).name==='webworkbench')return directory;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const parent=dirname(directory);if(parent===directory)throw new Error('Cannot locate WebWorkBench repository for original catalog');directory=parent;
 }
}
