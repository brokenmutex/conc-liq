import assert from 'node:assert/strict';
import test from 'node:test';
import {assertRangeKeeperPaperRecenterSimulation} from '../src/deployments/rangekeeper-paper-recenter-simulation.js';

test('recenter persistence cannot authorize a transition with caller-authored simulation evidence',()=>{
 for(const value of [null,{}, {status:'matched',simulationHash:'a'.repeat(64),allowancesCleared:true}])
  assert.throws(()=>assertRangeKeeperPaperRecenterSimulation(value),
   /rangekeeper_paper_recenter_simulation_capability_invalid/);
});
