import * as fs from 'fs';
import { At2PlusClient } from '../src/protocol/client';

const frames = JSON.parse(fs.readFileSync(new URL('../frames.json', import.meta.url), 'utf8'));
const acRx = Buffer.from(frames.ac_rx, 'hex');
const grpRx = Buffer.from(frames.grp_rx, 'hex');

const log = { debug: () => {}, info: () => {}, warn: (m: string) => console.log('WARN:', m), error: (m: string) => console.log('ERR:', m) };

let acCount = 0, grpCount = 0, groupsSeen = 0;
const client: any = new At2PlusClient('127.0.0.1', log);
client.on('acStatus', (s: any[]) => { acCount++; console.log(`  acStatus: id=${s[0].id} mode=${s[0].mode} set=${s[0].setPoint} temp=${s[0].temperature}`); });
client.on('groupStatus', (s: any[]) => { grpCount++; groupsSeen += s.length; console.log(`  groupStatus: ${s.length} groups, damps=[${s.map(g=>g.damp).join(',')}]`); });

// Feed bytes via the private onData, simulating socket chunks.
// Test 1: clean back-to-back frames
console.log('Test 1: two frames back-to-back');
client.onData(Buffer.concat([acRx, grpRx]));

// Test 2: frames split mid-header and mid-payload across chunks
console.log('Test 2: split across arbitrary chunk boundaries');
const stream = Buffer.concat([acRx, grpRx]);
for (let i = 0; i < stream.length; i += 3) {
  client.onData(stream.subarray(i, Math.min(i + 3, stream.length)));
}

// Test 3: leading garbage + a stray 0x55 0x55 before a real frame
console.log('Test 3: leading noise incl. false 0x55 0x55');
client.onData(Buffer.concat([Buffer.from([0x00, 0x55, 0x55, 0x12, 0x34]), acRx]));

console.log(`\nTotals: acStatus events=${acCount}, groupStatus events=${grpCount}, total groups=${groupsSeen}`);
// Expect: 3 ac events, 2 grp events (tests 1&2), each grp event = 3 groups
const ok = acCount === 3 && grpCount === 2 && groupsSeen === 6;
console.log(ok ? 'PASS framing' : 'FAIL framing');
process.exit(ok ? 0 : 1);
