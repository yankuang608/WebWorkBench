#!/usr/bin/env node
import {tryNeutralCli} from './neutral-cli.ts';
const args=process.argv.slice(2);
if(args.shift()!=='job')throw Error('Use job plan|run|status|report; only the synthetic demo is included');
if(!(await tryNeutralCli(args)).handled)throw Error('Only schema 4 neutral jobs are included');
