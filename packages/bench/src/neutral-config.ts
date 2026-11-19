import {readFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {parse as parseYAML} from 'yaml';
import {z} from 'zod';
import {ExperimentModelSchema,ExperimentAgentSchema,ExperimentEnvironmentSchema,ExperimentToolProfileSchema,ExperimentSpecSchema,ExperimentComparisonSchema} from './experiment-config.ts';

const identifier=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/,'Identity must contain only letters, digits, underscores or hyphens');
const nonempty=z.string().regex(/^[^\0\r\n]*$/,'NUL and line breaks are forbidden').trim().min(1);
const positive=z.number().int().positive().safe();
const timeout=positive.max(2147483647,'Budget exceeds Node timer range');
const cleanupTimeout=timeout.min(1500,'Cleanup needs at least 1500ms for owned backends');
const poolCapacity=positive.max(128,'Host resource pools support at most 128 slots');
const localPath=nonempty.refine(p=>!p.startsWith('/')&&!p.includes('\\')&&!p.split('/').some(part=>part==='..'||part==='.'||part==='')&&!/^[a-zA-Z]:/.test(p),'Plugin manifest paths must stay inside the configuration root');
const packageName=z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,'Expected an installed package name');
const duplicate=(values:string[])=>new Set(values).size!==values.length;
export const NeutralModalitySchema=z.enum(['text','image','audio','resource']);
export const NeutralModelSchema=ExperimentModelSchema.extend({inputModalities:z.array(NeutralModalitySchema).nonempty().refine(value=>!duplicate(value),'Duplicate model input modalities')}).strict();
export type NeutralModel=z.output<typeof NeutralModelSchema>;
export const NeutralAgentSchema=ExperimentAgentSchema.extend({model:NeutralModelSchema,connector:identifier.optional()}).strict();
export type NeutralAgent=z.output<typeof NeutralAgentSchema>;
export const NeutralEnvironmentSchema=ExperimentEnvironmentSchema;
export const NeutralToolProfileSchema=ExperimentToolProfileSchema;
export const NeutralSuiteRefSchema=ExperimentToolProfileSchema;
export const NeutralConnectorSchema=ExperimentToolProfileSchema;
export const NeutralPluginSchema=z.union([z.object({manifest:localPath}).strict(),z.object({package:packageName}).strict()]);
export type NeutralPlugin=z.output<typeof NeutralPluginSchema>;
export type NeutralSuiteRef=z.output<typeof NeutralSuiteRefSchema>;
export type NeutralConnector=z.output<typeof NeutralConnectorSchema>;
const named=<T extends z.ZodTypeAny>(schema:T)=>z.record(identifier,schema).refine(value=>Object.keys(value).length>0,'Named adapter map must not be empty');
const budgets=z.object({setupMs:timeout.optional(),agentMs:timeout.optional(),verificationMs:timeout.optional(),cleanupMs:cleanupTimeout.optional()}).strict();
const scheduling=z.object({maxTrials:poolCapacity.optional(),maxAgentProcesses:poolCapacity.optional(),perProjectConcurrency:z.literal(1).optional()}).strict();
const inputObject=z.object({
 schemaVersion:z.literal('4.0'),id:identifier,taskIds:z.array(identifier).nonempty().optional(),
 suiteRef:NeutralSuiteRefSchema,agents:named(NeutralAgentSchema),environments:named(NeutralEnvironmentSchema),toolProfiles:named(NeutralToolProfileSchema),
 connectors:z.record(identifier,NeutralConnectorSchema).optional(),experiments:z.array(ExperimentSpecSchema).nonempty(),comparisons:z.array(ExperimentComparisonSchema).optional(),plugins:z.array(NeutralPluginSchema).optional(),
 repetitions:positive.optional(),budgets:budgets.optional(),scheduling:scheduling.optional(),
}).strict();
function validateReferences(value:z.output<typeof inputObject>,ctx:z.RefinementCtx):void{
 const issue=(message:string)=>ctx.addIssue({code:'custom',message});
 if(value.taskIds&&duplicate(value.taskIds))issue('Duplicate task ids');
 if(duplicate(value.experiments.map(e=>e.id)))issue('Duplicate experiment ids');
 const experiments=new Set(value.experiments.map(e=>e.id));
 for(const experiment of value.experiments){
  if(!Object.hasOwn(value.agents,experiment.agent))issue('Unknown experiment agent: '+experiment.agent);
  if(!Object.hasOwn(value.environments,experiment.environment))issue('Unknown experiment environment: '+experiment.environment);
  if(!Object.hasOwn(value.toolProfiles,experiment.toolProfile))issue('Unknown experiment tool profile: '+experiment.toolProfile);
 }
 for(const agent of Object.values(value.agents))if(agent.connector&&!Object.hasOwn(value.connectors??{},agent.connector))issue('Unknown agent connector: '+agent.connector);
 if(value.comparisons){
  if(duplicate(value.comparisons.map(c=>c.id)))issue('Duplicate comparison ids');
  for(const comparison of value.comparisons){
   if(!experiments.has(comparison.left)||!experiments.has(comparison.right))issue('Unknown comparison experiment');
   if(comparison.left===comparison.right)issue('Comparison needs two different experiments');
  }
 }
 if(value.plugins&&duplicate(value.plugins.map(plugin=>'manifest'in plugin?'manifest:'+plugin.manifest:'package:'+plugin.package)))issue('Duplicate plugin references');
}
export const NeutralInputSchema=inputObject.superRefine(validateReferences);
export type NeutralInput=z.input<typeof NeutralInputSchema>;
export const NeutralConfigSchema=inputObject.extend({
 taskIds:z.array(identifier).nonempty(),repetitions:positive.default(1),connectors:z.record(identifier,NeutralConnectorSchema).default({}),
 comparisons:z.array(ExperimentComparisonSchema).default([]),plugins:z.array(NeutralPluginSchema).default([]),
 budgets:z.object({setupMs:timeout.default(600000),agentMs:timeout.default(600000),verificationMs:timeout.default(120000),cleanupMs:cleanupTimeout.default(30000)}).strict().default({}),
 scheduling:z.object({maxTrials:poolCapacity.default(4),maxAgentProcesses:poolCapacity.default(4),perProjectConcurrency:z.literal(1).default(1)}).strict().default({}),
}).superRefine(validateReferences);
export type NeutralConfig=z.output<typeof NeutralConfigSchema>;
export type NeutralJobConfig=NeutralConfig;

export function resolveNeutralConfig(input:unknown,availableTaskIds:string[]):NeutralConfig{
 const parsed=NeutralInputSchema.parse(input);
 const catalog=z.array(identifier).nonempty().parse(availableTaskIds);
 if(duplicate(catalog))throw new Error('Duplicate available suite catalog task ids');
 const selected=parsed.taskIds??catalog;
 const missing=selected.filter(id=>!catalog.includes(id));
 if(missing.length)throw new Error('Selected tasks are outside suite catalog: '+missing.join(', '));
 return NeutralConfigSchema.parse({...parsed,taskIds:[...selected].sort()});
}
/** Reading configuration never discovers a repository or imports a plugin. */
export async function readNeutralInput(path:string):Promise<NeutralInput>{
 const source=await readFile(path,'utf8');
 const input=['.yaml','.yml'].includes(extname(path).toLowerCase())?parseYAML(source,{maxAliasCount:100}):JSON.parse(source);
 return NeutralInputSchema.parse(input);
}
export async function loadNeutralConfig(path:string,availableTaskIds?:string[]):Promise<NeutralConfig>{
 const input=await readNeutralInput(path);
 const catalog=availableTaskIds??input.taskIds;
 if(!catalog)throw new Error('Task ids require selected Suite catalog metadata');
 return resolveNeutralConfig(input,catalog);
}
