'use strict';
const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const { makeAnchorArgs, TxLog, statusOf } = require('./common');

class ReadRecord extends WorkloadModuleBase {
    constructor() { super(); this.ids = []; }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
        await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
        this.log = new TxLog(roundArguments.resultsDir, `read_w${workerIndex}`);
        // Preload records (not measured): these are read back during the round.
        const n = parseInt(roundArguments.preload, 10);
        for (let i = 0; i < n; i++) {
            const id = `pre${roundArguments.runId}_w${workerIndex}_${i}`;
            await this.sutAdapter.sendRequests({
                contractId: 'ehr', contractFunction: 'CreateRecord',
                contractArguments: makeAnchorArgs(id), readOnly: false
            });
            this.ids.push(id);
        }
    }

    async submitTransaction() {
        const id = this.ids[Math.floor(Math.random() * this.ids.length)];
        const start = Date.now();
        let ok = true, err = '';
        try {
            const res = await this.sutAdapter.sendRequests({
                contractId: 'ehr', contractFunction: 'ReadRecord',
                contractArguments: [id], readOnly: true
            });
            ({ ok, err } = statusOf(res));
        } catch (e) { ok = false; err = String(e.message || e).slice(0, 300); }
        this.log.add(start, Date.now(), ok, err);
    }

    async cleanupWorkloadModule() { this.log.flush(); }
}
module.exports.createWorkloadModule = () => new ReadRecord();
