/** Trusted host plugin contracts. Bindings, fixtures and privateContext never enter model input. */
export const ADAPTER_API_VERSION = '1.0' as const;
export type JSONValue = null | boolean | number | string | JSONValue[] | {[key:string]:JSONValue};
export type JSONOptions = Record<string,JSONValue>;
export type ContentModality = 'text' | 'image' | 'audio' | 'resource';
export interface ContentAnnotations {audience?:Array<'user'|'assistant'>;priority?:number;lastModified?:string}
export type ContentBlock =
 | {type:'text';text:string;annotations?:ContentAnnotations;_meta?:Record<string,unknown>}
 | {type:'image';data:string;mimeType:string;annotations?:ContentAnnotations;_meta?:Record<string,unknown>}
 | {type:'audio';data:string;mimeType:string;annotations?:ContentAnnotations;_meta?:Record<string,unknown>}
 | {type:'resource';resource:{uri:string;mimeType?:string;_meta?:Record<string,unknown>} & ({text:string}|{blob:string});annotations?:ContentAnnotations;_meta?:Record<string,unknown>}
 | {type:'resource_link';uri:string;name:string;title?:string;description?:string;mimeType?:string;size?:number;annotations?:ContentAnnotations;_meta?:Record<string,unknown>};
export interface ToolResult {content:ContentBlock[];structuredContent?:Record<string,unknown>;isError?:boolean;_meta?:Record<string,unknown>}
export interface ToolTarget {kind:string;binding:unknown}
export interface ToolDefinition {name:string;title?:string;description?:string;inputSchema:Record<string,unknown>;outputSchema?:Record<string,unknown>;annotations?:Record<string,unknown>;_meta?:Record<string,unknown>}
export interface ExecutionEvidence {kind:string;data:JSONValue}
export interface AgentStartedEvent {startedAt:string;profileAdapter:string;observerDeadline?:string}
export interface AgentQuiescedEvent {quiescedAt:string;aborted:boolean;lastToolSequence:number;observerDeadline?:string}
interface ToolLifecycleBase {observerDeadline?:string;sequence:number;callId:string;profileAdapter:string;name:string;arguments:Record<string,unknown>;at:string}
/** Trusted host observations. Original names and payloads are never synthesized into another profile. */
export type ToolLifecycleEvent =
 | (ToolLifecycleBase & {phase:'call'})
 | (ToolLifecycleBase & {phase:'result';result:ToolResult})
 | (ToolLifecycleBase & {phase:'error';error:string});
export interface AgentEndedEvent {endedAt:string;aborted:boolean}
export interface LifecycleHooks {
 /** Before harness execution; failure prevents model scoring. Never returns model content. */
 onAgentStarted?(event:AgentStartedEvent):void|Promise<void>;
 /** Awaited inside the serialized native-call/observation transaction. Inputs are private copies. */
 onToolEvent?(event:ToolLifecycleEvent):void|Promise<void>;
 /** Once after admission closes and all native actions and observers have settled. */
 onAgentQuiesced?(event:AgentQuiescedEvent):void|Promise<void>;
 onAgentEnded?(event:AgentEndedEvent):void|Promise<void>;
 /** Called after quiesce; plugins own execution evidence separately from the business oracle. */
 collectEvidence?():ExecutionEvidence[]|Promise<ExecutionEvidence[]>;
}
export interface ToolSession {
 list():Promise<ToolDefinition[]>;
 call(name:string,args:Record<string,unknown>):Promise<ToolResult>;
 /** Stop accepting new calls, then settle owned in-flight actions before evaluation. */
 quiesce():Promise<void>;
 close():Promise<void>;
 hooks?:LifecycleHooks;
}
export interface Budgets {setupMs:number;agentMs:number;verificationMs:number;cleanupMs:number}
export interface ModelConfig {name:string;inputModalities:readonly ContentModality[];reasoningEffort?:string;provider?:{id:string;baseUrl:string;envKey?:string};options?:JSONOptions}
export interface HarnessConfig {adapter:string;binary?:string;options?:JSONOptions}
export interface HarnessTokenUsage {inputTokens:number;cachedInputTokens:number;outputTokens:number;reasoningOutputTokens?:number|null}
export interface HarnessBinaryIdentity {requested?:string;path:string|null;version:string|null;sha256:string|null}
export interface HarnessResult {success:boolean;startedAt:string;finishedAt:string;durationMs:number;tokenUsage:HarnessTokenUsage|null;failure?:string;finalMessage?:string;binary?:HarnessBinaryIdentity}
export interface HarnessConnection {kind:string;binding:unknown;close():Promise<void>;hooks?:LifecycleHooks}
export interface HarnessRequest {instruction:string;model:ModelConfig;tools:ToolSession;connection?:HarnessConnection;outputPrefix:string;budgets:Budgets;signal:AbortSignal;credentials:Readonly<Record<string,string>>;harness:HarnessConfig;expectedBinary?:{path:string;version?:string;sha256:string}}
export interface EnvironmentCapabilities {targetKinds:readonly string[]}
export interface SuiteCapabilities {targetKinds:readonly string[]}
export interface ToolProfileCapabilities {targetKinds:readonly string[];outputModalities:readonly ContentModality[]}
export interface HarnessCapabilities {inputModalities:readonly ContentModality[];directTools:boolean;connectionKinds:readonly string[]}
export interface ConnectorCapabilities {connectionKind:string}
export interface HarnessAdapter {readonly version:string;readonly capabilities:HarnessCapabilities;resolveBinary?(harness:HarnessConfig):Promise<string|undefined>;run(request:HarnessRequest):Promise<HarnessResult>}
export interface ToolProfileOpenRequest {target:ToolTarget;options?:JSONOptions;artifactDirectory:string;signal:AbortSignal}
export interface ToolProfileAdapter {readonly version:string;readonly capabilities:ToolProfileCapabilities;open(request:ToolProfileOpenRequest):Promise<ToolSession>}
/** Catalog metadata contains no private fixture. sha256 is the task's business-definition identity. */
export interface SuiteCase {id:string;projectKey:string;sha256:string;metadata?:JSONOptions}
export interface EnvironmentPrepareRequest {task:SuiteCase;variant:string;options?:JSONOptions;namespace:string;seed:string;artifactDirectory:string;signal:AbortSignal}
export interface PreparedEnvironment {target:ToolTarget;identity:Record<string,JSONValue>;verifyIdentity?():Promise<void>;close():Promise<void>;hooks?:LifecycleHooks}
export interface EnvironmentAdapter {readonly version:string;readonly capabilities:EnvironmentCapabilities;resourceKey?:string|((request:EnvironmentPrepareRequest)=>string|undefined);prepare(request:EnvironmentPrepareRequest):Promise<PreparedEnvironment>}
export interface SuiteCatalogRequest {options?:JSONOptions;signal?:AbortSignal}
export interface FixturePrepareRequest {task:SuiteCase;environment:PreparedEnvironment;options?:JSONOptions;namespace:string;seed:string;artifactDirectory:string;signal:AbortSignal}
export interface PreparedCase {instruction:string;target:ToolTarget;privateContext:unknown;close?():Promise<void>;hooks?:LifecycleHooks}
export interface EvaluationCriterion {id:string;passed:boolean;reason?:string}
export interface SuiteEvaluation {businessPassed:boolean;criteria:EvaluationCriterion[];evidence:string[];executionValid?:boolean;reason?:string}
export interface SuiteEvaluateRequest {task:SuiteCase;preparedCase:PreparedCase;environment:PreparedEnvironment;harnessResult:HarnessResult;executionEvidence:ExecutionEvidence[];artifactDirectory:string;signal:AbortSignal}
export interface SuiteAdapter {readonly version:string;readonly capabilities:SuiteCapabilities;catalog(request?:SuiteCatalogRequest):Promise<SuiteCase[]>;prepareFixture(request:FixturePrepareRequest):Promise<PreparedCase>;evaluate(request:SuiteEvaluateRequest):Promise<SuiteEvaluation>}
export interface ConnectorRequest {tools:ToolSession;options?:JSONOptions;artifactDirectory:string;signal:AbortSignal}
export interface ConnectorAdapter {readonly version:string;readonly capabilities:ConnectorCapabilities;connect(request:ConnectorRequest):Promise<HarnessConnection>}

export interface CapabilityPreflight {environment:EnvironmentCapabilities;suite:SuiteCapabilities;toolProfile:ToolProfileCapabilities;harness:HarnessCapabilities;connector?:ConnectorCapabilities;model:Pick<ModelConfig,'inputModalities'>;targetKind?:string}
export function preflightCapabilities(request:CapabilityPreflight):void {
 const targets=request.targetKind?[request.targetKind]:request.environment.targetKinds.filter(kind=>request.suite.targetKinds.includes(kind)&&request.toolProfile.targetKinds.includes(kind));
 if(!targets.length)throw new Error('Incompatible target capabilities: no shared target kind');
 for(const kind of targets){
  if(!request.environment.targetKinds.includes(kind)||!request.suite.targetKinds.includes(kind)||!request.toolProfile.targetKinds.includes(kind))throw new Error('Incompatible target kind: '+kind);
 }
 for(const modality of request.toolProfile.outputModalities){
  if(!request.model.inputModalities.includes(modality))throw new Error('Model cannot accept tool output modality: '+modality);
  if(!request.harness.inputModalities.includes(modality))throw new Error('Harness cannot accept tool output modality: '+modality);
 }
 if(request.connector){if(!request.harness.connectionKinds.includes(request.connector.connectionKind))throw new Error('Harness cannot accept connector kind: '+request.connector.connectionKind);}
 else if(!request.harness.directTools)throw new Error('Harness requires a connector; direct tools are unsupported');
}
export const validateCapabilities=preflightCapabilities;
export type ComponentCategory='suite'|'environment'|'toolProfile'|'harness'|'connector';
export interface ComponentAdapters {suite:SuiteAdapter;environment:EnvironmentAdapter;toolProfile:ToolProfileAdapter;harness:HarnessAdapter;connector:ConnectorAdapter}
export interface RegistryVersions {suites:Record<string,string>;environments:Record<string,string>;toolProfiles:Record<string,string>;harnesses:Record<string,string>;connectors:Record<string,string>}
const categories:ComponentCategory[]=['suite','environment','toolProfile','harness','connector'];
const methods:Record<ComponentCategory,string[]>={suite:['catalog','prepareFixture','evaluate'],environment:['prepare'],toolProfile:['open'],harness:['run'],connector:['connect']};
function identity(value:unknown,label:string):asserts value is string {if(typeof value!=='string'||!value.trim()||/[\0\r\n]/.test(value))throw new Error('Invalid '+label);}
function componentId(value:unknown):asserts value is string {if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(value))throw new Error('Invalid component id');}
export class Registry {
 private readonly maps={suite:new Map<string,SuiteAdapter>(),environment:new Map<string,EnvironmentAdapter>(),toolProfile:new Map<string,ToolProfileAdapter>(),harness:new Map<string,HarnessAdapter>(),connector:new Map<string,ConnectorAdapter>()};
 register<C extends ComponentCategory>(category:C,id:string,adapter:ComponentAdapters[C]):void {
  componentId(id);identity(adapter.version,'adapter version');
  validateComponentCapabilities(category,adapter.capabilities);
  for(const method of methods[category])if(typeof (adapter as unknown as Record<string,unknown>)[method]!=='function')throw new Error('Invalid '+category+' adapter: missing '+method);
  const map=this.maps[category] as Map<string,ComponentAdapters[C]>;
  if(map.has(id))throw new Error(category+' adapter already registered: '+id);map.set(id,adapter);
 }
 get<C extends ComponentCategory>(category:C,id:string):ComponentAdapters[C] {const value=this.maps[category].get(id);if(!value)throw new Error('Unknown '+category+' adapter: '+id);return value as ComponentAdapters[C];}
 registerSuite(id:string,adapter:SuiteAdapter):void{this.register('suite',id,adapter);}
 registerEnvironment(id:string,adapter:EnvironmentAdapter):void{this.register('environment',id,adapter);}
 registerToolProfile(id:string,adapter:ToolProfileAdapter):void{this.register('toolProfile',id,adapter);}
 registerHarness(id:string,adapter:HarnessAdapter):void{this.register('harness',id,adapter);}
 registerConnector(id:string,adapter:ConnectorAdapter):void{this.register('connector',id,adapter);}
 getSuite(id:string):SuiteAdapter{return this.get('suite',id);}
 getEnvironment(id:string):EnvironmentAdapter{return this.get('environment',id);}
 getToolProfile(id:string):ToolProfileAdapter{return this.get('toolProfile',id);}
 getHarness(id:string):HarnessAdapter{return this.get('harness',id);}
 getConnector(id:string):ConnectorAdapter{return this.get('connector',id);}
 versions():RegistryVersions {const version=(category:ComponentCategory)=>Object.fromEntries([...this.maps[category]].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([id,adapter])=>[id,adapter.version]));return {suites:version('suite'),environments:version('environment'),toolProfiles:version('toolProfile'),harnesses:version('harness'),connectors:version('connector')};}
}
export interface PluginDependencies {files?:string[];packages?:string[]}
export interface ComponentManifest {category:ComponentCategory;id:string;entry:string;catalog?:string;export?:string;apiVersion:typeof ADAPTER_API_VERSION;identity:string;capabilities:EnvironmentCapabilities|SuiteCapabilities|ToolProfileCapabilities|HarnessCapabilities|ConnectorCapabilities;dependencies?:PluginDependencies}
export interface PluginManifest {schemaVersion:'1.0';apiVersion:typeof ADAPTER_API_VERSION;id:string;identity:string;components:ComponentManifest[];dependencies?:PluginDependencies}
function record(value:unknown,label:string):asserts value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid '+label);}
function strict(value:Record<string,unknown>,keys:string[],label:string):void{for(const key of Object.keys(value))if(!keys.includes(key))throw new Error('Unknown '+label+' field: '+key);}
function strings(value:unknown,label:string,allowEmpty=false):asserts value is string[]{if(!Array.isArray(value)||(!allowEmpty&&!value.length)||value.some(v=>typeof v!=='string'||!v||/[\0\r\n]/.test(v))||new Set(value).size!==value.length)throw new Error('Invalid '+label);}
function path(value:unknown,label:string):void {identity(value,label);if(value.startsWith('/')||value.includes('\\')||/^[a-zA-Z]:/.test(value)||value.split('/').some(s=>s===''||s==='.'||s==='..'))throw new Error('Invalid '+label+' path');}
export function validateComponentCapabilities(category:ComponentCategory,value:unknown):void {
 record(value,'capabilities');
 const keys=category==='harness'?['inputModalities','directTools','connectionKinds']:category==='connector'?['connectionKind']:category==='toolProfile'?['targetKinds','outputModalities']:['targetKinds'];strict(value,keys,'capabilities');
 if('targetKinds'in value)strings(value.targetKinds,'target kinds');
 if(category==='environment'||category==='suite'||category==='toolProfile')strings(value.targetKinds,'target kinds');
 for(const key of ['inputModalities','outputModalities'])if(keys.includes(key)){strings(value[key],key);if((value[key] as string[]).some(m=>!['text','image','audio','resource'].includes(m)))throw new Error('Invalid modality');}
 if(category==='harness'){if(typeof value.directTools!=='boolean')throw new Error('Invalid directTools capability');strings(value.connectionKinds,'connection kinds',true);}
 if(category==='connector')identity(value.connectionKind,'connection kind');
}
function dependencies(value:unknown):void {if(value===undefined)return;record(value,'dependencies');strict(value,['files','packages'],'dependencies');if(value.files!==undefined){strings(value.files,'dependency files',true);for(const file of value.files)path(file,'dependency');}if(value.packages!==undefined){strings(value.packages,'dependency packages',true);for(const pkg of value.packages)if(! /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pkg))throw new Error('Invalid dependency package');}}
/** Read-only parsing: this validates metadata without importing any plugin entry. */
export function parsePluginManifest(input:unknown):PluginManifest {
 record(input,'plugin manifest');strict(input,['schemaVersion','apiVersion','id','identity','components','dependencies'],'plugin manifest');
 if(input.schemaVersion!=='1.0'||input.apiVersion!==ADAPTER_API_VERSION)throw new Error('Unsupported plugin/API version');componentId(input.id);identity(input.identity,'plugin identity');dependencies(input.dependencies);
 if(!Array.isArray(input.components)||!input.components.length)throw new Error('Plugin has no components');const seen=new Set<string>();
 for(const component of input.components){record(component,'component');strict(component,['category','id','entry','catalog','export','apiVersion','identity','capabilities','dependencies'],'component');if(!categories.includes(component.category as ComponentCategory))throw new Error('Unknown component category');componentId(component.id);path(component.entry,'entry');if(component.catalog!==undefined){if(component.category!=='suite')throw new Error('Only Suite components may declare a catalog');path(component.catalog,'catalog');}if(component.export!==undefined)identity(component.export,'export');if(component.apiVersion!==ADAPTER_API_VERSION)throw new Error('Unsupported component API version');identity(component.identity,'component identity');validateComponentCapabilities(component.category as ComponentCategory,component.capabilities);dependencies(component.dependencies);const key=component.category+':'+component.id;if(seen.has(key))throw new Error('Duplicate component identity: '+key);seen.add(key);}
 return input as unknown as PluginManifest;
}
