import {createHash,randomUUID} from 'node:crypto';
import {access,readFile,realpath,writeFile,link,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,isAbsolute,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {canonicalJobJSON} from '../job-plan.ts';
import type {NeutralPlan,NeutralTrialSpec} from '../neutral-plan.ts';
import {loadNeutralPlugins,neutralCoreFiles,neutralCorePackages,resolveNeutralPlugins,withNeutralImportBoundary,type SelectedComponent,type NeutralPluginResolution} from './loader.ts';
import {neutralCredentialKeys,withHiddenNeutralCredentials} from './security.ts';
const digest=(value:unknown)=>createHash('sha256').update(canonicalJobJSON(value)).digest('hex'),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const NeutralRuntimeLockSchema=z.object({schemaVersion:z.literal('4.0'),configSha256:sha,datasetSha256:sha,node:z.string(),nodeBinary:z.object({path:z.string().refine(isAbsolute),sha256:sha}).strict(),platform:z.string(),architecture:z.string(),coreFiles:z.array(z.object({path:z.string(),sha256:sha}).strict()),files:z.array(z.object({path:z.string(),sha256:sha}).strict()),packages:z.array(z.object({name:z.string(),version:z.string(),sha256:sha,dependencies:z.array(z.string())}).strict()),manifests:z.array(z.object({id:z.string(),identity:z.string(),sha256:sha}).strict()),components:z.array(z.object({category:z.enum(['suite','environment','toolProfile','harness','connector']),id:z.string(),identity:z.string(),version:z.string()}).strict()),agents:z.array(z.object({id:z.string(),adapter:z.string(),binary:z.object({path:z.string(),sha256:sha,version:z.string().optional()}).strict().optional()}).strict())}).strict();
export type NeutralRuntimeLock=z.infer<typeof NeutralRuntimeLockSchema>;
export const neutralRuntimeHash=(lock:NeutralRuntimeLock)=>digest(lock);
export function neutralFixtureSeed(plan:NeutralPlan,trial:NeutralTrialSpec):string{return trial.fixtureSeed??'seed_'+digest(['4.0',plan.datasetSha256,trial.taskId,trial.repetition]);}
export function selectedNeutralComponents(plan:Pick<NeutralPlan,'config'>):SelectedComponent[]{
 const config=plan.config,selected=new Map<string,SelectedComponent>(),add=(category:SelectedComponent['category'],id:string)=>selected.set(category+':'+id,{category,id});add('suite',config.suiteRef.adapter);
 for(const experiment of config.experiments){const agent=config.agents[experiment.agent];add('harness',agent.harness.adapter);add('environment',config.environments[experiment.environment].adapter);add('toolProfile',config.toolProfiles[experiment.toolProfile].adapter);if(agent.connector)add('connector',config.connectors[agent.connector].adapter);}
 return [...selected.values()];
}
export async function resolveNeutralRuntimePlugins(plan:NeutralPlan,root:string):Promise<NeutralPluginResolution>{return resolveNeutralPlugins(root,plan.config.plugins,selectedNeutralComponents(plan));}
async function resolveBinary(requested:string,root:string):Promise<string>{
 const candidates=isAbsolute(requested)?[requested]:requested.includes('/')?[resolve(root,requested)]:(process.env.PATH??'').split(delimiter).map(directory=>join(directory,requested));
 for(const candidate of candidates)try{await access(candidate,constants.X_OK);return await realpath(candidate);}catch{/* next PATH candidate */}throw new Error('Cannot resolve configured harness binary: '+requested);
}
async function currentNeutralRuntime(plan:NeutralPlan,root:string):Promise<NeutralRuntimeLock>{
 const resolution=await resolveNeutralRuntimePlugins(plan,root);
 const loaded=await withHiddenNeutralCredentials(neutralCredentialKeys(plan.config),()=>withNeutralImportBoundary(resolution,async()=>{
  const registry=await loadNeutralPlugins(resolution),selected=[...new Set(plan.config.experiments.map(experiment=>experiment.agent))].sort();
  const agents=await Promise.all(selected.map(async id=>{const agent=plan.config.agents[id],adapter=registry.getHarness(agent.harness.adapter),requested=agent.harness.binary??await adapter.resolveBinary?.(agent.harness),path=requested?await resolveBinary(requested,root):undefined;return {id,adapter:agent.harness.adapter,...path?{binary:{path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')}}:{}};}));
  return {agents,components:resolution.components.map(({category,id,identity})=>({category,id,identity,version:registry.get(category,id).version}))};
 }));
 const nodePath=await realpath(process.execPath),sourceWorker=fileURLToPath(new URL('./worker.ts',import.meta.url)),source=await access(sourceWorker).then(()=>true).catch(()=>false);
 // Both parent and private worker fingerprint the same host+worker distribution entries.
 // The development closure includes scheduler/ledger/locks even though worker uses run types only.
 const entries=source?['worker.ts','run.ts']:['worker.js','index.js','cli.js'],allCoreFiles=[];
 for(const name of entries){const entry=fileURLToPath(new URL('./'+name,import.meta.url));if(await access(entry).then(()=>true).catch(()=>false))allCoreFiles.push(...await neutralCoreFiles(entry));}
 if(!allCoreFiles.length)throw new Error('Core worker distribution is unavailable');
 const coreFiles=[...new Map(allCoreFiles.map(file=>[file.path,file])).values()].sort((a,b)=>a.path.localeCompare(b.path)),packages=[...resolution.packages,...await neutralCorePackages(coreFiles,source?[{name:'tsx',anchor:sourceWorker}]:[])],unique=new Map<string,(typeof packages)[number]>();
 for(const pkg of packages){const id=pkg.name+'@'+pkg.version,previous=unique.get(id);if(previous&&previous.sha256!==pkg.sha256)throw new Error('Core and selected plugin resolve conflicting npm identity: '+id);unique.set(id,pkg);}
 return NeutralRuntimeLockSchema.parse({schemaVersion:'4.0',configSha256:plan.configSha256,datasetSha256:plan.datasetSha256,node:process.version,nodeBinary:{path:nodePath,sha256:createHash('sha256').update(await readFile(nodePath)).digest('hex')},platform:process.platform,architecture:process.arch,coreFiles,files:resolution.files,packages:[...unique.values()].sort((a,b)=>(a.name+'@'+a.version).localeCompare(b.name+'@'+b.version)),manifests:resolution.manifests,components:loaded.components,agents:loaded.agents});
}
export async function readNeutralRuntime(jobDir:string):Promise<NeutralRuntimeLock>{return NeutralRuntimeLockSchema.parse(JSON.parse(await readFile(join(jobDir,'runtime-lock.json'),'utf8')));}
export async function lockNeutralRuntime(plan:NeutralPlan,root:string,jobDir:string):Promise<NeutralRuntimeLock>{
 const current=await currentNeutralRuntime(plan,root),path=join(jobDir,'runtime-lock.json'),temporary=path+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(current,null,2),{flag:'wx',mode:0o600});
 try{try{await link(temporary,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(canonicalJobJSON(await readNeutralRuntime(jobDir))!==canonicalJobJSON(current))throw new Error('Neutral runtime changed; create a new Job');}}finally{await unlink(temporary);}return current;
}
export async function verifyNeutralRuntime(plan:NeutralPlan,root:string,jobDir:string):Promise<NeutralRuntimeLock>{
 const previous=await readNeutralRuntime(jobDir),current=await currentNeutralRuntime(plan,root);if(canonicalJobJSON(previous)!==canonicalJobJSON(current))throw new Error('Neutral runtime selected source, verifier, package or binary changed; create a new Job');return previous;
}
