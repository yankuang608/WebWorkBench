import {spawn} from 'node:child_process';
import {mkdir,open,readFile,writeFile,access} from 'node:fs/promises';
import {join,resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {finished} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {preflightCapabilities,type Registry,type PreparedEnvironment,type PreparedCase,type ToolSession,type HarnessConnection,type HarnessResult,type SuiteEvaluation,type ExecutionEvidence,type LifecycleHooks} from '../../../adapter-api/src/index.ts';
import {NeutralPlanSchema,type NeutralPlan,type NeutralTrialSpec} from '../neutral-plan.ts';
import {canonicalJobJSON} from '../job-plan.ts';
import type {Outcome} from '../schema.ts';
import {loadNeutralPlugins,withNeutralImportBoundary} from './loader.ts';
import {neutralRuntimeHash,verifyNeutralRuntime,resolveNeutralRuntimePlugins,neutralFixtureSeed,type NeutralRuntimeLock} from './runtime.ts';
import {auditedNeutralTools,readNeutralAudit} from './audit.ts';
import {neutralSafeError,redactNeutralValue,NeutralCredentialOutputFilter,neutralCredentialKeys} from './security.ts';
import {withDeadline} from './deadline.ts';
import type {NeutralExecutor,NeutralExecutionContext} from './run.ts';

export type NeutralPhase='setup'|'queued'|'agent'|'verification'|'cleanup';
interface LifecycleOptions {plan:NeutralPlan;trial:NeutralTrialSpec;registry:Registry;runtime:NeutralRuntimeLock;attempt:number;namespace:string;attemptDir:string;signal:AbortSignal;credentials:Record<string,string>;beforeAgent():Promise<void>;beforeVerification():Promise<void>;verifyRuntime():Promise<void>;phase?(phase:NeutralPhase):void}
export interface NeutralLifecycleResult {schemaVersion:'4.0';trialId:string;attempt:number;environment:{identity:PreparedEnvironment['identity']|null};harness?:HarnessResult;verification?:SuiteEvaluation;executionEvidence:ExecutionEvidence[];error?:string;cleanupErrors:string[];outcome:Outcome}
/** Trusted host lifecycle. The harness receives instruction and native tools, never case or environment bindings. */
export async function executeNeutralLifecycle(options:LifecycleOptions):Promise<NeutralLifecycleResult>{
 const {plan,trial,registry,attemptDir,signal}=options,experiment=plan.config.experiments.find(value=>value.id===trial.experimentId)!;
 const agent=plan.config.agents[experiment.agent],envConfig=plan.config.environments[experiment.environment],profileConfig=plan.config.toolProfiles[experiment.toolProfile],connectorConfig=agent.connector?plan.config.connectors[agent.connector]:undefined;
 const suite=registry.getSuite(plan.config.suiteRef.adapter),environmentAdapter=registry.getEnvironment(envConfig.adapter),profile=registry.getToolProfile(profileConfig.adapter),harnessAdapter=registry.getHarness(agent.harness.adapter),connector=connectorConfig?registry.getConnector(connectorConfig.adapter):undefined,task=plan.catalog.find(value=>value.id===trial.taskId)!;
 const secrets=Object.values(options.credentials),output=join(attemptDir,'execution',trial.id),outputPrefix=join(output,trial.taskId),resultEvidence=outputPrefix+'.result.json';await mkdir(output,{recursive:true});
 const save=(path:string,value:unknown)=>writeFile(path,JSON.stringify(redactNeutralValue(value,secrets),null,2),{flag:'wx',mode:0o600});
 let environment:PreparedEnvironment|undefined,prepared:PreparedCase|undefined,tools:ReturnType<typeof auditedNeutralTools>|undefined,connection:HarnessConnection|undefined,harness:HarnessResult|undefined,verification:SuiteEvaluation|undefined,error:string|undefined,outcome:Outcome|undefined,modelStarted=false,stage:NeutralPhase='setup',startedAt:string|undefined,ending:Promise<void>|undefined;
 const executionEvidence:ExecutionEvidence[]=[],cleanupErrors:string[]=[],lifecycleErrors:string[]=[];
 const hooks=()=>[environment?.hooks,prepared?.hooks,tools?.hooks,connection?.hooks].filter((value):value is LifecycleHooks=>!!value);
 const endAgent=()=>ending??=(async()=>{
  tools?.stopAdmission();const failures:unknown[]=[];
  for(const hook of hooks())try{await withDeadline('Agent ended hook',Promise.resolve(hook.onAgentEnded?.(structuredClone({endedAt:harness?.finishedAt??new Date().toISOString(),aborted:signal.aborted}))),plan.config.budgets.cleanupMs);}catch(cause){failures.push(cause);}
  const quiesce=tools?.quiesce();if(quiesce){void quiesce.catch(()=>{});await withDeadline('Tool profile quiesce',quiesce,signal.aborted?plan.config.budgets.cleanupMs:plan.config.budgets.verificationMs);}
  if(modelStarted)for(const hook of hooks())try{await withDeadline('Agent quiesced hook',Promise.resolve(hook.onAgentQuiesced?.(structuredClone({quiescedAt:new Date().toISOString(),aborted:signal.aborted,lastToolSequence:tools?.lastToolSequence??0,observerDeadline:new Date(Date.now()+plan.config.budgets.verificationMs).toISOString()}))),plan.config.budgets.verificationMs);}catch(cause){failures.push(cause);}
  lifecycleErrors.push(...failures.map(neutralSafeError),...(tools?.observerErrors??[]));
 })();
 try{
  preflightCapabilities({environment:environmentAdapter.capabilities,suite:suite.capabilities,toolProfile:profile.capabilities,harness:harnessAdapter.capabilities,connector:connector?.capabilities,model:agent.model});
  const catalog=await suite.catalog({options:plan.config.suiteRef.options,signal}),selected=plan.catalog.map(expected=>{const actual=catalog.find(value=>value.id===expected.id);if(!actual||canonicalJobJSON(actual)!==canonicalJobJSON(expected))throw new Error('Selected suite business definition changed: '+expected.id);return actual;});
  if(!selected.some(value=>value.id===task.id))throw new Error('Selected suite task is unavailable');
  const common={task,namespace:options.namespace,seed:neutralFixtureSeed(plan,trial),artifactDirectory:attemptDir,signal};
  environment=await environmentAdapter.prepare({...common,variant:envConfig.variant,options:envConfig.options});
  await save(join(attemptDir,'environment-identity.json'),{identity:environment.identity,attempt:options.attempt,runtimeSha256:neutralRuntimeHash(options.runtime)});
  prepared=await suite.prepareFixture({...common,environment,options:plan.config.suiteRef.options});
  preflightCapabilities({environment:environmentAdapter.capabilities,suite:suite.capabilities,toolProfile:profile.capabilities,harness:harnessAdapter.capabilities,connector:connector?.capabilities,model:agent.model,targetKind:prepared.target.kind});
  if(!environmentAdapter.capabilities.targetKinds.includes(environment.target.kind))throw new Error('Environment emitted an undeclared target kind');
  const session=await profile.open({target:prepared.target,options:profileConfig.options,artifactDirectory:attemptDir,signal});tools=auditedNeutralTools(session,join(attemptDir,'tool-audit.jsonl'),signal,secrets,{profileAdapter:profileConfig.adapter,async onToolEvent(event){for(const hook of hooks())await withDeadline('Tool observer hook',Promise.resolve(hook.onToolEvent?.(structuredClone({...event,observerDeadline:new Date(Date.now()+plan.config.budgets.verificationMs).toISOString()}))),plan.config.budgets.verificationMs);}});
  if(connector&&connectorConfig){connection=await connector.connect({tools,options:connectorConfig.options,artifactDirectory:attemptDir,signal});if(connection.kind!==connector.capabilities.connectionKind)throw new Error('Connector emitted an undeclared connection kind');}
  stage='queued';options.phase?.('queued');await options.beforeAgent();await options.verifyRuntime();await environment.verifyIdentity?.();if(signal.aborted)throw new Error('Neutral trial cancelled');
  startedAt=new Date().toISOString();for(const hook of hooks())await withDeadline('Agent started hook',Promise.resolve(hook.onAgentStarted?.(structuredClone({startedAt,profileAdapter:profileConfig.adapter,observerDeadline:new Date(Date.now()+plan.config.budgets.setupMs).toISOString()}))),plan.config.budgets.setupMs);
  signal.throwIfAborted();stage='agent';options.phase?.('agent');modelStarted=true;const credentials:Record<string,string>={},envKey=agent.model.provider?.envKey;if(envKey&&options.credentials[envKey]!==undefined)credentials[envKey]=options.credentials[envKey];
  try{harness=await harnessAdapter.run({instruction:prepared.instruction,model:agent.model,tools,connection,outputPrefix,budgets:plan.config.budgets,signal,credentials,harness:agent.harness,expectedBinary:options.runtime.agents.find(value=>value.id===experiment.agent)?.binary});}catch(cause){error=neutralSafeError(cause);}
  const finishing=endAgent();void finishing.catch(()=>{});if(signal.aborted){await withDeadline('Cancelled tool quiesce',finishing,plan.config.budgets.cleanupMs);throw new Error('Neutral trial cancelled');}
  stage='verification';options.phase?.('verification');await options.beforeVerification();await finishing;if(lifecycleErrors.length)throw new Error('Lifecycle observation failed: '+lifecycleErrors.join('; '));await options.verifyRuntime();await environment.verifyIdentity?.();if(signal.aborted)throw new Error('Neutral trial cancelled');
  for(const hook of hooks())executionEvidence.push(...await Promise.resolve(hook.collectEvidence?.()??[]));
  // Audit data is host-generated and native content is never interpreted as JSON errors.
  executionEvidence.push({kind:'trusted-tool-audit',data:JSON.parse(JSON.stringify(await readNeutralAudit(join(attemptDir,'tool-audit.jsonl'))))});
  const ended=harness??{success:false,startedAt:startedAt!,finishedAt:new Date().toISOString(),durationMs:Date.now()-Date.parse(startedAt!),tokenUsage:null,failure:error??'Harness ended without result'};
  try{verification=await suite.evaluate({task,preparedCase:prepared,environment,harnessResult:ended,executionEvidence,artifactDirectory:attemptDir,signal});}catch(cause){error=neutralSafeError(cause);outcome={status:'verifier_error',reason:error,reward:null,modelStarted,evidence:[resultEvidence]};}
  if(!outcome){const passed=verification?.businessPassed===true&&verification.criteria.every(criterion=>criterion.passed)&&verification.executionValid!==false&&harness?.success===true&&!error;outcome={status:passed?'passed':harness?'model_failed':'interrupted',reason:passed?'Independent suite business and execution verification passed':error??verification?.reason??'Harness did not finish',reward:harness?(passed?1:0):null,modelStarted,evidence:[resultEvidence],usage:harness?.tokenUsage?{inputTokens:harness.tokenUsage.inputTokens,cachedInputTokens:harness.tokenUsage.cachedInputTokens,outputTokens:harness.tokenUsage.outputTokens}:null};}
 }catch(cause){error=neutralSafeError(cause);outcome={status:signal.aborted?'interrupted':stage==='verification'?'verifier_error':modelStarted?'interrupted':'environment_blocked',reason:error,reward:null,modelStarted,evidence:[resultEvidence]};}
 finally{
  stage='cleanup';options.phase?.('cleanup');try{await endAgent();}catch(cause){cleanupErrors.push(neutralSafeError(cause));}
  for(const close of [()=>connection?.close(),()=>tools?.close(),()=>prepared?.close?.(),()=>environment?.close()])try{await withDeadline('Neutral trial cleanup',Promise.resolve(close()),plan.config.budgets.cleanupMs);}catch(cause){cleanupErrors.push(neutralSafeError(cause));}
  if(cleanupErrors.length){error=cleanupErrors.join('; ');outcome={status:'interrupted',reason:error,reward:null,modelStarted,evidence:[resultEvidence]};}
 }
 const facts:NeutralLifecycleResult={schemaVersion:'4.0',trialId:trial.id,attempt:options.attempt,environment:{identity:environment?.identity??null},harness,verification,executionEvidence,error,cleanupErrors,outcome:outcome!};
 await save(join(attemptDir,'execution-result.json'),facts);await save(resultEvidence,{...facts,model:harness,oracle:verification,passed:outcome!.status==='passed',modelError:error});await save(join(output,'runtime-actual.json'),{environmentIdentity:environment?.identity??null,runtimeSha256:neutralRuntimeHash(options.runtime),attempt:options.attempt});
 const summary=outputPrefix+'.summary.json',existing=await readFile(summary,'utf8').then(JSON.parse).catch(cause=>{if(cause.code==='ENOENT')return null;throw cause;});
 // A plugin-written summary may contain credentials: overwrite only this owned artifact after redaction.
 await writeFile(summary,JSON.stringify(redactNeutralValue(existing??harness??{success:false,tokenUsage:null,failure:error},secrets),null,2),{mode:0o600});return redactNeutralValue(facts,secrets);
}

export function createNeutralExecutor(options:{workerScript?:string;loaderPath?:string}={}):NeutralExecutor{return async(context:NeutralExecutionContext)=>{
 const {root,jobDir,plan,trial,lease,attemptDir,signal}=context,runtime=await verifyNeutralRuntime(plan,root,jobDir),configFile=join(attemptDir,'worker-config.json'),output=join(attemptDir,'execution',trial.id);await mkdir(output,{recursive:true});
 await writeFile(configFile,JSON.stringify({schemaVersion:'4.0',root,jobDir,plan,trialId:trial.id,attempt:lease.attempt,namespace:context.namespace,attemptDir,runtimeSha256:neutralRuntimeHash(runtime)},null,2),{flag:'wx',mode:0o600});await writeFile(join(attemptDir,'implementation.json'),JSON.stringify({...runtime,verifiedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
 const handle=await open(join(attemptDir,'runner.log'),'wx',0o600),log=handle.createWriteStream(),credentials=context.credentials??Object.fromEntries(neutralCredentialKeys(plan.config).flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]!] ])),secrets=Object.values(credentials);
 const source=fileURLToPath(new URL('./worker.ts',import.meta.url)),compiled=fileURLToPath(new URL('./worker.js',import.meta.url)),worker=options.workerScript??await access(source).then(()=>source).catch(()=>compiled),loader=extname(worker)==='.ts'?options.loaderPath??createRequire(import.meta.url).resolve('tsx/esm'):undefined;
 const child=spawn(process.execPath,[...loader?['--import',loader]:[],worker,'--worker',configFile],{cwd:root,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,...credentials,WEBWORKBENCH_FIXTURE_NAMESPACE:context.namespace}});
 let phase:NeutralPhase='setup',timer:NodeJS.Timeout|undefined,hardStop:NodeJS.Timeout|undefined,timedOutPhase:NeutralPhase|undefined,error:string|undefined,agentStarted=false,agentPermitted=false,readySeen=false,stopped=false,phaseQueue=Promise.resolve();const workerController=new AbortController();
 const kill=(kind:NodeJS.Signals)=>{if(!child.pid)return;try{if(process.platform==='win32')child.kill(kind);else process.kill(-child.pid,kind);}catch(cause){if((cause as NodeJS.ErrnoException).code!=='ESRCH')throw cause;}};
 const stop=()=>{workerController.abort();if(stopped)return;stopped=true;if(child.connected)child.send({type:'cancel'});hardStop=setTimeout(()=>kill('SIGKILL'),plan.config.budgets.cleanupMs);};
 const beginPhase=(value:NeutralPhase)=>{phase=value;if(timer)clearTimeout(timer);const budget=value==='queued'?undefined:value==='setup'?plan.config.budgets.setupMs:value==='agent'?plan.config.budgets.agentMs:value==='verification'?plan.config.budgets.verificationMs:plan.config.budgets.cleanupMs;if(budget)timer=setTimeout(()=>{timedOutPhase=value;stop();},budget);};
 const record=async(value:any)=>{if(value?.type!=='neutral-phase')return;if(value.phase==='ready'){if(phase!=='setup'||readySeen)throw new Error('Unexpected repeated agent phase');readySeen=true;beginPhase('queued');await context.enterAgent(workerController.signal);if(signal.aborted||workerController.signal.aborted){stop();return;}await verifyNeutralRuntime(plan,root,jobDir);agentPermitted=true;beginPhase('setup');child.send({type:'start-agent'});}else if(value.phase==='agent-started'){if(signal.aborted||workerController.signal.aborted){stop();return;}if(!agentPermitted||agentStarted||phase!=='setup')throw new Error('Unexpected agent-started acknowledgement');agentStarted=true;beginPhase('agent');}else if(value.phase==='verification'){if(phase!=='agent')throw new Error('Verification requested outside agent phase');await context.enterVerification();await verifyNeutralRuntime(plan,root,jobDir);beginPhase('verification');child.send({type:'start-verification'});}else if(value.phase==='cleanup')beginPhase('cleanup');};
 const logDone=finished(log).catch(cause=>{error='Worker log could not be persisted: '+neutralSafeError(cause);stop();});log.on('error',()=>{child.stdout?.resume();child.stderr?.resume();});
 const outputFilters=[child.stdout!,child.stderr!].map(stream=>{const filter=new NeutralCredentialOutputFilter(secrets),transform=new Transform({transform(chunk,encoding,done){done(null,filter.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,encoding)));},flush(done){done(null,filter.end());}});stream.pipe(transform).pipe(log,{end:false});return finished(transform).catch(cause=>{error=neutralSafeError(cause);stop();});});
 child.on('message',value=>{phaseQueue=phaseQueue.then(()=>record(value)).catch(cause=>{error=neutralSafeError(cause);stop();});});signal.addEventListener('abort',stop,{once:true});beginPhase('setup');if(signal.aborted)stop();let code:number|null=null;
 try{code=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('close',done);});}catch(cause){error=neutralSafeError(cause);}finally{if(timer)clearTimeout(timer);if(hardStop)clearTimeout(hardStop);signal.removeEventListener('abort',stop);workerController.abort();await phaseQueue;await context.enterVerification();kill('SIGKILL');await Promise.all(outputFilters);log.end();await logDone;}
 const result=await readFile(join(attemptDir,'execution-result.json'),'utf8').then(JSON.parse).catch(cause=>{if(cause.code==='ENOENT')return null;throw cause;}),evidence=[join(attemptDir,'runner.log'),...(result?[join(attemptDir,'execution-result.json')]:[])];let outcome:Outcome;
 if(signal.aborted)outcome={status:'interrupted',reason:'Job was cancelled',reward:null,modelStarted:agentStarted,evidence};
 else if(timedOutPhase){const status=timedOutPhase==='agent'?'model_failed':timedOutPhase==='verification'?'verifier_error':timedOutPhase==='cleanup'?'interrupted':'environment_blocked';outcome={status,reason:'Worker '+timedOutPhase+' time budget exceeded',reward:status==='model_failed'?0:null,modelStarted:agentStarted,evidence};}
 else if(error||!result||code!==0)outcome={status:agentStarted?'interrupted':'environment_blocked',reason:error??result?.error??'Worker ended without independently verified results',reward:null,modelStarted:agentStarted,evidence};else outcome=result.outcome;
 await writeFile(join(attemptDir,'runner-exit.json'),JSON.stringify(redactNeutralValue({code,phase,timedOutPhase,error,stopped,at:new Date().toISOString()},secrets)),{flag:'wx',mode:0o600});return {outcome:redactNeutralValue(outcome,secrets),evidenceDirectory:output};
 };}
export const executeNeutralTrial=createNeutralExecutor();
export async function neutralWorkerMain(configFile:string):Promise<void>{
 if(!process.send)throw new Error('Neutral worker requires private host IPC');const config=JSON.parse(await readFile(configFile,'utf8')),plan=NeutralPlanSchema.parse(config.plan),trial=plan.trials.find(value=>value.id===config.trialId);
 if(config.schemaVersion!=='4.0'||!trial||!Number.isSafeInteger(config.attempt)||config.attempt<1||config.namespace!==trial.namespace+'-a'+config.attempt)throw new Error('Invalid private worker identity');
 const {root,jobDir,attemptDir}=config,controller=new AbortController(),stop=()=>controller.abort(),message=(value:any)=>{if(value?.type==='cancel')stop();};process.on('message',message);process.once('SIGINT',stop);process.once('SIGTERM',stop);process.once('disconnect',stop);
 const permit=(type:string)=>new Promise<void>((done,reject)=>{const receive=(value:any)=>{if(value?.type===type){cleanup();done();}},abort=()=>{cleanup();reject(new Error('Neutral trial cancelled'));},cleanup=()=>{process.removeListener('message',receive);controller.signal.removeEventListener('abort',abort);};process.on('message',receive);controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted)abort();});
 const keys=neutralCredentialKeys(plan.config),credentials=Object.fromEntries(keys.flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]!] ]));for(const key of keys)delete process.env[key];
 try{
  const runtime=await verifyNeutralRuntime(plan,root,jobDir);if(neutralRuntimeHash(runtime)!==config.runtimeSha256)throw new Error('Private worker runtime lock differs');
  const resolution=await resolveNeutralRuntimePlugins(plan,root);await withNeutralImportBoundary(resolution,async()=>{
   const registry=await loadNeutralPlugins(resolution);
   await executeNeutralLifecycle({plan,trial,registry,runtime,attempt:config.attempt,namespace:config.namespace,attemptDir,signal:controller.signal,credentials,verifyRuntime:async()=>{await verifyNeutralRuntime(plan,root,jobDir);},beforeAgent:async()=>{const waiting=permit('start-agent');process.send!({type:'neutral-phase',phase:'ready'});await waiting;},beforeVerification:async()=>{const waiting=permit('start-verification');process.send!({type:'neutral-phase',phase:'verification'});await waiting;},phase:value=>{if(value==='agent')process.send!({type:'neutral-phase',phase:'agent-started'});else if(value==='cleanup')process.send!({type:'neutral-phase',phase:'cleanup'});}});
  });
 }finally{process.removeListener('message',message);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);process.removeListener('disconnect',stop);if(process.connected)process.disconnect();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--worker')neutralWorkerMain(process.argv[3]).catch(error=>{console.error(neutralSafeError(error));process.exitCode=1;});
