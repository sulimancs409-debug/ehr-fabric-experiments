'use strict';
const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const { makeAnchorArgs, TxLog, statusOf } = require('./common');

class CreateRecord extends WorkloadModuleBase {
    constructor() { super(); this.n = 0; }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
        await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
        this.runId = roundArguments.runId;
        this.log = new TxLog(roundArguments.resultsDir, `write_w${workerIndex}`);
        // Warm-up (not logged): the Fabric Gateway needs a moment before the first submit can find an
        // endorsement plan ("No endorsement plan available"). Retry until one warm-up transaction commits.
        for (let k = 0; k < 20; k++) {
            try {
                const res = await this.sutAdapter.sendRequests({
                    contractId: 'ehr', contractFunction: 'CreateRecord',
                    contractArguments: makeAnchorArgs(`warmup_${this.runId}_w${workerIndex}_${k}`), readOnly: false
                });
                if (statusOf(res).ok) break;
            } catch (e) { /* retry */ }
            await new Promise(r => setTimeout(r, 500));
        }
    }

    async submitTransaction() {
        this.n++;
        const id = `r${this.runId}_w${this.workerIndex}_${this.n}`;
        const start = Date.now();
        let ok = true, err = '';
        try {
            const res = await this.sutAdapter.sendRequests({
                contractId: 'ehr',
                contractFunction: 'CreateRecord',
                contractArguments: makeAnchorArgs(id),
                readOnly: false
            });
            ({ ok, err } = statusOf(res));
        } catch (e) { ok = false; err = String(e.message || e).slice(0, 300); }
        this.log.add(start, Date.now(), ok, err);
    }

    async cleanupWorkloadModule() { this.log.flush(); }
}
module.exports.createWorkloadModule = () => new CreateRecord();
