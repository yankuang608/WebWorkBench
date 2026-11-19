import {readFile} from 'node:fs/promises';
import {dirname,extname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse as parseYAML} from 'yaml';
import {z} from 'zod';
import {ExecutionArmSchema,TaskIdSchema} from './schema.ts';
import {loadCatalog} from './catalog.ts';

const identifier=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/,'Identity must contain only letters, digits, underscores or hyphens');
const nonempty=z.string().regex(/^[^\0\r\n]*$/,'NUL and line breaks are forbidden').trim().min(1);
const positive=z.number().int().positive().safe();
const timeout=positive.max(2147483647,'Budget exceeds Node timer range');
const cleanupTimeout=timeout.min(1500,'Cleanup needs at least 1500ms for owned Codex backends');
const poolCapacity=positive.max(128,'Host resource pools support at most 128 slots');
const endpoint=z.string().url().superRefine((value,ctx)=>{
 const url=new URL(value);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||value.includes('?')||value.includes('#'))ctx.addIssue({code:'custom',message:'Endpoint must be HTTP(S) without credentials, query or fragment'});
});
/** Only a dedicated model credential can cross into the model process. */
export const ModelEnvKeySchema=z.string().regex(/^(?:(?:[A-Z][A-Z0-9]*_)*)(?:MODEL|LLM|CODEX|OPENAI)_API_KEY$/,'Use a dedicated MODEL/LLM/CODEX/OPENAI_API_KEY variable').refine(value=>!/(?:^|_)(?:CLEARACT|APPROVAL|BUSINESS|BROKER|DATABASE|DB|COOKIE|FIXTURE|ORACLE|SEED|SYSTEM|ADMIN|ROOT|AUTH|SESSION|SIGNING|AWS|AZURE|GCP|GOOGLE|SECRET|PASSWORD)(?:_|$)/.test(value),'Evaluator, business and system credentials are forbidden');
const provider=z.object({
 id:z.string().max(64).regex(/^[a-z][a-z0-9_-]*$/).refine(value=>!['openai','ollama','lmstudio'].includes(value),'Provider id is reserved'),
 baseUrl:endpoint,
 envKey:ModelEnvKeySchema.optional(),
}).strict();
export const ReasoningEffortSchema=z.enum(['none','minimal','low','medium','high','xhigh','max','ultra']);
export const CodexModelSchema=z.object({name:nonempty,reasoningEffort:ReasoningEffortSchema.default('medium'),provider:provider.optional()}).strict();
export type CodexModelConfig=z.output<typeof CodexModelSchema>;
const harness=z.object({name:z.literal('codex'),binary:nonempty.default('codex')}).strict();
const agent=z.object({id:identifier,harness,model:CodexModelSchema}).strict();
const budgets=z.object({setupMs:timeout.optional(),agentMs:timeout.optional(),verificationMs:timeout.optional(),cleanupMs:cleanupTimeout.optional()}).strict();
const scheduling=z.object({maxTrials:poolCapacity.optional(),maxAgentProcesses:poolCapacity.optional(),perProjectConcurrency:z.literal(1).optional()}).strict();
const viewport=z.object({width:positive,height:positive}).strict();
const browser=z.object({channel:z.enum(['chrome','chromium']).optional(),headless:z.boolean().optional(),viewport:viewport.optional(),locale:nonempty.optional(),timezoneId:nonempty.optional()}).strict();
const environment=z.object({type:z.literal('existing'),brokerUrl:endpoint.optional(),browser:browser.optional()}).strict();
const duplicate=(values:string[])=>new Set(values).size!==values.length;
const inputObject=z.object({schemaVersion:z.literal('2.0'),id:identifier,taskIds:z.array(TaskIdSchema).nonempty().optional(),agents:z.array(agent).nonempty(),arms:z.array(ExecutionArmSchema).nonempty(),repetitions:positive.optional(),budgets:budgets.optional(),scheduling:scheduling.optional(),environment:environment.optional()}).strict();
function validateIdentities(value:{taskIds?:string[];agents:Array<{id:string}>;arms:string[]},ctx:z.RefinementCtx){
 if(duplicate(value.agents.map(a=>a.id)))ctx.addIssue({code:'custom',message:'Duplicate agent ids'});
 if(duplicate(value.arms))ctx.addIssue({code:'custom',message:'Duplicate arms'});
 if(value.taskIds&&duplicate(value.taskIds))ctx.addIssue({code:'custom',message:'Duplicate task ids'});
}
export const JobInputSchema=inputObject.superRefine(validateIdentities);
export type JobInput=z.input<typeof JobInputSchema>;
export const JobConfigSchema=inputObject.extend({
 taskIds:z.array(TaskIdSchema).nonempty(),
 repetitions:positive.default(1),
 budgets:z.object({setupMs:timeout.default(600000),agentMs:timeout.default(600000),verificationMs:timeout.default(120000),cleanupMs:cleanupTimeout.default(30000)}).strict().default({}),
 scheduling:z.object({maxTrials:poolCapacity.default(4),maxAgentProcesses:poolCapacity.default(4),perProjectConcurrency:z.literal(1).default(1)}).strict().default({}),
 environment:z.object({type:z.literal('existing').default('existing'),brokerUrl:endpoint.default('http://127.0.0.1:4310'),browser:z.object({channel:z.enum(['chrome','chromium']).default('chrome'),headless:z.boolean().default(true),viewport:viewport.default({width:1440,height:1000}),locale:nonempty.default('zh-CN'),timezoneId:nonempty.default('Asia/Shanghai')}).strict().default({})}).strict().default({}),
}).superRefine(validateIdentities);
export type JobConfig=z.output<typeof JobConfigSchema>;

export function resolveJobConfig(input:unknown,availableTaskIds:string[]):JobConfig{
 const parsed=JobInputSchema.parse(input);
 const catalog=z.array(TaskIdSchema).nonempty().parse(availableTaskIds);
 if(duplicate(catalog))throw new Error('Duplicate available catalog task ids');
 const selected=parsed.taskIds??catalog;
 const missing=selected.filter(id=>!catalog.includes(id));
 if(missing.length)throw new Error('Selected tasks are outside original catalog: '+missing.join(', '));
 return JobConfigSchema.parse({...parsed,taskIds:[...selected].sort()});
}

export async function loadJobConfig(path:string):Promise<JobConfig>{
 const source=await readFile(path,'utf8');
 const input=['.yaml','.yml'].includes(extname(path).toLowerCase())?parseYAML(source,{maxAliasCount:100}):JSON.parse(source);
 const catalog=await loadCatalog(await repositoryRoot());
 return resolveJobConfig(input,catalog.tasks.map(entry=>entry.task.id));
}

async function repositoryRoot():Promise<string>{
 let directory=dirname(fileURLToPath(import.meta.url));
 while(true){
  try{
   const pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
   if(pkg.name==='webworkbench')return directory;
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const parent=dirname(directory);
  if(parent===directory)throw new Error('Cannot locate WebWorkBench repository for original catalog');
  directory=parent;
 }
}
