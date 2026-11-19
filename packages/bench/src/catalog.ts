import {readFile,readdir,realpath,access} from 'node:fs/promises';
import {resolve,relative,join,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {TaskSchema,EnvironmentSchema,TestSpecSchema,GroundTruthPublicationSchema,AcceptanceCriterionSchema,type GroundTruthPublication,type Task,type Arm} from './schema.ts';
export const digest=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
export interface PublishedProof {caseId:string;attempt:string;localDirectory:string;passed:boolean;criteria:number;modelBrowserCalls:number;resultSha256:string;modelConversationSha256:string;browserTraceSha256:string;independentVerificationSha256:string}
export interface PublishedManifestCase {caseId:string;projectKey:string;reference:{path:string;sha256:string;bytes:number};instructionSha256:string;acceptanceSha256:string;groundTruthSha256:string;proof:PublishedProof}
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const publicationEqual=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
/** Offline validation consumes only the committed release and its sanitized evidence summary. */
export async function readGroundTruthPublication(root:string,caseId:string,value:GroundTruthPublication){
 const publication=GroundTruthPublicationSchema.parse(value);
 const manifest=JSON.parse(await readFile(await contained(root,publication.manifestPath),'utf8'));
 if(manifest.schemaVersion!=='1.0'||manifest.releaseId!=='calibrated-v2'||manifest.kind!=='ground-truth-validated-content-publication'||manifest.historicalAnswerAssistedValidated!==true||manifest.officialBlindBenchmarkPassed!==false||manifest.publishedRunnerCasesExecuted!==0||!Array.isArray(manifest.cases)||!manifest.cases.length||manifest.totals?.cases!==manifest.cases.length||new Set(manifest.cases.map((c:any)=>c.caseId)).size!==manifest.cases.length||manifest.cases.some((c:any)=>!Number.isSafeInteger(c.proof?.criteria)||c.proof.criteria<1)||manifest.cases.reduce((n:number,c:any)=>n+c.proof.criteria,0)!==manifest.totals.acceptanceCriteria)throw Error('Invalid ground-truth publication manifest/boundary');
 if(manifest.sourceSummary?.path!=='docs/bench/evidence/browser-ground-truth-2026-10-25.json')throw Error('Invalid publication evidence summary path');
 const summaryBytes=await readFile(await contained(root,manifest.sourceSummary.path));
 if(digest(summaryBytes)!==manifest.sourceSummary.sha256||summaryBytes.length!==manifest.sourceSummary.bytes)throw Error('Publication evidence summary bytes/hash changed');
 const summary=JSON.parse(summaryBytes.toString());
 if(summary.kind!=='answer-assisted-browser-validation-public-summary'||summary.currentPassedCases!==manifest.totals.cases||summary.publicAcceptanceCriteria!==manifest.totals.acceptanceCriteria||summary.officialBenchmarkScore!==false||!Array.isArray(summary.cases)||summary.cases.length!==manifest.totals.cases||new Set(summary.cases.map((c:any)=>c.caseId)).size!==manifest.totals.cases)throw Error('Publication summary does not bind the complete historical reference set');
 if(manifest.cases.some((c:any)=>!publicationEqual(c.proof,summary.cases.find((p:any)=>p.caseId===c.caseId))||c.proof?.passed!==true))throw Error('Publication historical proof differs from sanitized summary');
 const row=manifest.cases.find((c:any)=>c.caseId===caseId) as PublishedManifestCase|undefined;
 if(!row||row.projectKey!==caseId.slice(0,3)||row.reference.path!==`benchmarks/releases/calibrated-v2/evaluator/references/${caseId}.json`||publication.referencePath!==row.reference.path||publication.referenceSha256!==row.reference.sha256||publication.proof.attempt!==row.proof.attempt||publication.proof.resultSha256!==row.proof.resultSha256)throw Error('Publication case/reference/proof identity mismatch: '+caseId);
 const referenceBytes=await readFile(await contained(root,row.reference.path));
 if(digest(referenceBytes)!==row.reference.sha256||referenceBytes.length!==row.reference.bytes)throw Error('Publication reference bytes/hash changed: '+caseId);
 const reference=JSON.parse(referenceBytes.toString());
 if(reference.id!==caseId||typeof reference.instruction!=='string'||!reference.groundTruth?.steps?.length||!Array.isArray(reference.acceptance)||!reference.acceptance.length)throw Error('Publication reference content is incomplete: '+caseId);
 reference.acceptance.forEach((c:unknown)=>AcceptanceCriterionSchema.parse(c));
 if(new Set(reference.acceptance.map((c:any)=>c.id)).size!==reference.acceptance.length||reference.acceptance.length!==row.proof.criteria||digest(reference.instruction)!==row.instructionSha256||digest(JSON.stringify(reference.acceptance))!==row.acceptanceSha256||digest(JSON.stringify(reference.groundTruth))!==row.groundTruthSha256)throw Error('Publication instruction/acceptance/reference digest mismatch: '+caseId);
 return {reference,manifestCase:row,caseIds:manifest.cases.map((c:any)=>c.caseId) as string[]};
}

export interface LoadedTask {task:Task;instruction:string;directory:string;environment:ReturnType<typeof EnvironmentSchema.parse>;testSpec:ReturnType<typeof TestSpecSchema.parse>;sha256:string}
export interface Catalog {schemaVersion:'1.0';sha256:string;tasks:LoadedTask[]}
async function contained(root:string,path:string){const base=await realpath(root),target=await realpath(resolve(root,path));if(target!==base&&!target.startsWith(base+sep))throw new Error('Task path escapes declared root: '+path);return target;}
export async function loadCatalog(root:string):Promise<Catalog>{
 const source=JSON.parse(await readFile(join(root,'benchmarks/catalog-source.json'),'utf8'));
 const definitions=new Map<string,any>(source.projects.flatMap((p:any)=>p.cases.map((c:any)=>[c.id,c])));
 const goals=new Map<string,string>([...definitions].map(([id,c])=>[id,c.userGoal]));
 if(source.activeRelease){
  const ref=source.activeRelease;
  if(ref.path!=='benchmarks/releases/retained24-20261117/manifest.json')throw Error('Unknown active catalog release');
  const bytes=await readFile(await contained(root,ref.path));
  if(digest(bytes)!==ref.sha256)throw Error('Active release hash mismatch');
  const active=JSON.parse(bytes.toString());
  if(active.kind!=='active-catalog'||active.releaseId!=='retained24-20261117'||active.taskIds?.length!==24||new Set(active.taskIds).size!==24||JSON.stringify([...definitions.keys()].sort())!==JSON.stringify(active.taskIds)||source.counts?.cases!==24)throw Error('Active 24 task set mismatch');
  const parent=await readFile(await contained(root,active.parentPublication.path));
  if(digest(parent)!==active.parentPublication.sha256)throw Error('Historical publication changed');
  const historical=JSON.parse(parent.toString());
  if(!publicationEqual(active.cases,historical.cases.filter((c:any)=>active.taskIds.includes(c.caseId))))throw Error('Active case provenance changed');
 }

 const published=[...definitions.values()].filter(c=>c.groundTruthPublication);if((published.length||source.datasetRevision==='2026-10-25-calibrated-v2-ground-truth-publication')&&published.length!==definitions.size)throw Error('Mixed published/unpublished formal catalog');
 const base=join(root,'benchmarks/tasks');const tasks:LoadedTask[]=[];
 for(const entry of (await readdir(base,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(!entry.isDirectory())continue;
  const directory=await contained(base,entry.name);
  const taskBytes=await readFile(await contained(directory,'task.json'),'utf8');const task=TaskSchema.parse(JSON.parse(taskBytes));
  if(task.id!==entry.name)throw new Error('Directory/task ID mismatch: '+entry.name);
  const instruction=await readFile(await contained(directory,task.files.instruction),'utf8');
  if(digest(instruction)!==task.instructionSha256||instruction!==goals.get(task.id))throw new Error('Instruction changed or evaluator material leaked: '+task.id);
  const envBytes=await readFile(await contained(directory,task.files.environment),'utf8');const environment=EnvironmentSchema.parse(JSON.parse(envBytes));
  const testBytes=await readFile(await contained(directory,task.files.tests),'utf8');const testSpec=TestSpecSchema.parse(JSON.parse(testBytes));
  if(environment.projectKey!==task.projectKey||testSpec.caseId!==task.id)throw new Error('Environment/verifier identity mismatch: '+task.id);
  const definition=definitions.get(task.id);
  if(!!definition?.groundTruthPublication!==!!testSpec.groundTruthPublication)throw Error('Publication metadata missing from formal spec: '+task.id);
  if(testSpec.groundTruthPublication){
   if(!publicationEqual(definition.groundTruthPublication,testSpec.groundTruthPublication)||!publicationEqual(definition.acceptance,testSpec.acceptance))throw Error('Formal catalog/spec publication acceptance mapping differs: '+task.id);
   const {reference,caseIds}=await readGroundTruthPublication(root,task.id,testSpec.groundTruthPublication);
   if((!source.activeRelease&&caseIds.length!==definitions.size)||[...definitions.keys()].some(id=>!caseIds.includes(id))||source.counts?.cases!==definitions.size)throw Error('Publication task set differs from active catalog');
   if(reference.instruction!==instruction||!publicationEqual(reference.acceptance,testSpec.acceptance))throw Error('Formal instruction/acceptance differs from verified publication: '+task.id);
  }

  tasks.push({task,instruction,directory:relative(root,directory),environment,testSpec,sha256:digest([taskBytes,instruction,envBytes,testBytes].join('\0'))});
 }
 if(tasks.length!==goals.size||tasks.some(t=>!goals.has(t.task.id)))throw new Error('Task set differs from design catalog');
 return {schemaVersion:'1.0',sha256:digest(tasks.map(t=>t.task.id+':'+t.sha256).join('\n')),tasks};
}
export interface ReadinessCheck {name:string;passed:boolean;evidence:string;reason?:string}
export interface Blocker {code:string;message:string;evidence:string[]}
export interface Readiness {caseId:string;arm:Arm;ready:boolean;artifactsReady:boolean;runtimeChecked:boolean;blockers:Blocker[];checks:ReadinessCheck[]}
/** Static availability does not imply that a website is running. Callers supply fresh, evidenced live checks. */
export async function assessReadiness(loaded:LoadedTask,root:string,arm:Arm,runtimeChecks:ReadinessCheck[]=[]):Promise<Readiness>{
 const {task,environment}=loaded;const blockers:Blocker[]=[];
 const block=(code:string,message:string,evidence:string[])=>blockers.push({code,message,evidence});
 if(task.upstream.revisionStatus==='revision_unpinned')block('revision_unpinned','No fixed catalog or runtime revision/version is recorded',[loaded.directory+'/task.json']);
 const supported=task.adapter.supportedArms.includes(arm)||(arm==='clearact'&&task.adapter.supportedArms.includes('astra'));
 if(task.adapter.state!=='implemented'||!task.adapter.module||!supported)block('adapter_missing','No implemented case-specific fixture/verifier and '+arm+' adapter',[loaded.directory+'/task.json']);
 if(environment.implementation!=='local_integration')block('environment_not_implemented','Real upstream application environment has not been implemented',[loaded.directory+'/environment/environment.json']);
 if(task.adapter.module){try{await contained(root,task.adapter.module);await access(resolve(root,task.adapter.module));}catch{block('adapter_file_missing','Adapter module unavailable',[task.adapter.module]);}}
 if(environment.integrationDirectory){try{await contained(root,environment.integrationDirectory)}catch{block('environment_directory_missing','Integration directory unavailable',[environment.integrationDirectory])}}
 const artifactsReady=blockers.length===0;
 const required=['service_health','fixture_isolation','page_perception','arm_isolation'];
 const runtimeChecked=required.every(name=>runtimeChecks.some(c=>c.name===name&&c.evidence.length>0));
 if(!runtimeChecked)block('runtime_unchecked','Fresh health, fixture, perception, and arm-isolation checks are required',[]);
 for(const check of runtimeChecks){if(!check.passed)block('runtime_check_failed',check.reason??check.name,[check.evidence]);}
 return {caseId:task.id,arm,ready:artifactsReady&&runtimeChecked&&runtimeChecks.every(c=>c.passed),artifactsReady,runtimeChecked,blockers,checks:runtimeChecks};
}
