import {z} from 'zod';

/** Legacy Astra IDs are accepted for immutable dataset and result reading only. */
export const ArmSchema=z.enum(['clearact','browser','astra']);
export const ExecutionArmSchema=z.enum(['clearact','browser']);
export type Arm=z.infer<typeof ArmSchema>;
export const TaskIdSchema=z.string().regex(/^[RV]\d{2}-[A-C]$/);
const RelativePath=z.string().min(1).refine(p=>!p.startsWith('/')&&!p.includes('\\')&&!p.split('/').includes('..'),'Path must remain inside its declared root');
const sha=z.string().regex(/^[0-9a-f]{64}$/);
export const FixedHarnessSchema=z.object({harness:z.literal('codex'),model:z.literal('gpt-5.6-luna'),reasoningEffort:z.literal('medium'),concurrency:z.literal(10)}).strict();
export const FIXED_HARNESS=FixedHarnessSchema.parse({harness:'codex',model:'gpt-5.6-luna',reasoningEffort:'medium',concurrency:10});
export const TaskSchema=z.object({
 schemaVersion:z.literal('1.0'),id:TaskIdSchema,title:z.string().min(1),projectKey:z.string().regex(/^[RV]\d{2}$/),projectName:z.string().min(1),framework:z.enum(['React','Vue']),
 upstream:z.object({repository:z.string().url(),catalogRevision:z.string().nullable(),runtimeRevision:z.string().nullable(),runtimeVersion:z.string().nullable(),revisionStatus:z.enum(['catalog_pinned','runtime_pinned','revision_unpinned']),sourceEvidence:z.array(z.string().url()),revisionNote:z.string()}).strict(),
 files:z.object({instruction:z.literal('instruction.md'),environment:z.literal('environment/environment.json'),tests:z.literal('tests/spec.json'),solution:z.null()}).strict(),
 instructionSha256:sha,
 agent:z.object({timeoutMs:z.literal(600000)}).strict(),
 verifier:z.object({timeoutMs:z.number().int().positive(),requiresIndependentReadback:z.literal(true)}).strict(),
 adapter:z.object({state:z.enum(['implemented','missing']),module:RelativePath.nullable(),prepareExport:z.literal('prepareCases'),verifyExport:z.literal('verifyCase'),supportedArms:z.array(ArmSchema),caseId:TaskIdSchema}).strict(),
 knownSpecIssues:z.array(z.string()),
 provenance:z.object({catalog:z.literal('benchmarks/catalog-source.json'),catalogResearchDate:z.string(),instructionPolicy:z.enum(['Original userGoal only; no seed, steps, or oracle in model input','Versioned userGoal only; no seed, steps, or oracle in model input']),datasetRevision:z.string().min(1).optional()}).strict()
}).strict().superRefine((task,ctx)=>{
 if(!task.id.startsWith(task.projectKey+'-')||task.adapter.caseId!==task.id)ctx.addIssue({code:'custom',message:'Task identity mismatch'});
 if(task.adapter.state==='implemented'&&(!task.adapter.module||task.adapter.supportedArms.length===0))ctx.addIssue({code:'custom',message:'Implemented adapter needs a module and supported arms'});
});
export type Task=z.infer<typeof TaskSchema>;
export const EnvironmentSchema=z.object({schemaVersion:z.literal('1.0'),projectKey:z.string(),kind:z.literal('real_upstream_application'),implementation:z.enum(['local_integration','not_implemented']),integrationDirectory:RelativePath.nullable(),composeFiles:z.array(RelativePath),coldStartValidated:z.boolean(),requires:z.array(z.string()),setupNotes:z.string()}).strict();
export const AcceptanceCriterionSchema=z.object({id:z.string().min(1),text:z.string().min(1),verifierChecks:z.array(z.string().min(1)).nonempty(),evidence:z.string().optional(),stepIds:z.array(z.string()).optional()}).strict();
export const GroundTruthPublicationSchema=z.object({releaseId:z.literal('calibrated-v2'),manifestPath:z.literal('benchmarks/releases/calibrated-v2/manifest.json'),referencePath:RelativePath,referenceSha256:sha,proof:z.object({attempt:z.string().regex(/^\d{3}$/),resultSha256:sha}).strict()}).strict();
export type GroundTruthPublication=z.infer<typeof GroundTruthPublicationSchema>;
export const TestSpecSchema=z.object({schemaVersion:z.literal('1.0'),evaluatorOnly:z.literal(true),caseId:TaskIdSchema,seed:z.string(),perception:z.string(),steps:z.array(z.string()),oracle:z.string(),approval:z.string(),capabilitySources:z.array(z.string().url()),uncertainties:z.array(z.string()),executableVerifier:RelativePath.nullable(),acceptance:z.array(AcceptanceCriterionSchema).nonempty().optional(),groundTruthPublication:GroundTruthPublicationSchema.optional()}).strict().superRefine((value,ctx)=>{if(!!value.acceptance!==!!value.groundTruthPublication)ctx.addIssue({code:'custom',message:'Published acceptance and ground-truth publication must occur together'});if(value.acceptance&&new Set(value.acceptance.map(c=>c.id)).size!==value.acceptance.length)ctx.addIssue({code:'custom',message:'Duplicate published criterion ID'});});
export const StatusSchema=z.enum(['passed','model_failed','environment_blocked','verifier_error','task_spec_error','interrupted']);
export type TrialStatus=z.infer<typeof StatusSchema>;
export const OutcomeSchema=z.object({status:StatusSchema,reason:z.string().min(1),reward:z.union([z.literal(0),z.literal(1),z.null()]),modelStarted:z.boolean(),evidence:z.array(z.string()),usage:z.object({inputTokens:z.number().int().nonnegative(),cachedInputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative()}).strict().nullable().optional()}).strict().superRefine((x,c)=>{
 if(x.reward!==(x.status==='passed'?1:x.status==='model_failed'?0:null))c.addIssue({code:'custom',message:'Only passed/model_failed contribute a reward; all excluded outcomes must be null'});
 if(['passed','model_failed'].includes(x.status)&&!x.modelStarted)c.addIssue({code:'custom',message:'A scored result requires actual model execution'});
 if(['environment_blocked','verifier_error','task_spec_error'].includes(x.status)&&!x.evidence.length)c.addIssue({code:'custom',message:'Excluded outcomes require diagnostic evidence'});
 if(x.usage&&x.usage.cachedInputTokens>x.usage.inputTokens)c.addIssue({code:'custom',message:'Cached input is a subset of input tokens'});
});
export type Outcome=z.infer<typeof OutcomeSchema>;
export const RunManifestSchema=z.object({schemaVersion:z.literal('1.0'),id:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),createdAt:z.string().datetime(),datasetSha256:sha,taskIds:z.array(TaskIdSchema).nonempty(),arms:z.array(ArmSchema).nonempty(),configuration:FixedHarnessSchema,selection:z.string(),attemptPolicy:z.literal('Preserve every attempt; never automatically retry passed or model_failed trials'),concurrencyScope:z.literal('Maximum overlapping Codex processes, not guaranteed simultaneous model inference')}).strict().superRefine((x,c)=>{if(new Set(x.taskIds).size!==x.taskIds.length||new Set(x.arms).size!==x.arms.length)c.addIssue({code:'custom',message:'Duplicate tasks or arms'});});
export type RunManifest=z.infer<typeof RunManifestSchema>;
