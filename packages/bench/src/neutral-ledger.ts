import {createJobLedger,type LedgerJobState,type LedgerTrialState} from './job-ledger.ts';
import {NeutralPlanSchema,type NeutralPlan,type NeutralTrialSpec} from './neutral-plan.ts';

export const neutralLedger=createJobLedger(NeutralPlanSchema);
export const createNeutralLedger=()=>createJobLedger(NeutralPlanSchema);
export type NeutralJobState=LedgerJobState<NeutralPlan>;
export type NeutralTrialState=LedgerTrialState<NeutralTrialSpec>;
export const {
 openJob:openNeutralJob,readJob:readNeutralJob,listJobTrials:listNeutralTrials,
 beginJobTrial:beginNeutralTrial,finishJobTrial:finishNeutralTrial,recoverJobTrial:recoverNeutralTrial,
}=neutralLedger;
export type {JobTrialLease as NeutralTrialLease,JobTrialResult as NeutralTrialResult,JobTrialAttempt as NeutralTrialAttempt,JobRetryOptions as NeutralRetryOptions} from './job-ledger.ts';
