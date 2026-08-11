import * as fs from 'fs';
import { decodeAcStatus, decodeGroupStatus } from '../src/protocol/messages';

const ref = JSON.parse(fs.readFileSync(new URL('../decode_reference.json', import.meta.url), 'utf8'));

const ac = decodeAcStatus(Buffer.from(ref.ac_bytes, 'hex'));
const grp = decodeGroupStatus(Buffer.from(ref.grp_bytes, 'hex'));

const acOk = ac.id===ref.ac_parsed.id && ac.power===ref.ac_parsed.power && ac.mode===ref.ac_parsed.mode &&
  ac.fanSpeed===ref.ac_parsed.fan && ac.setPoint===ref.ac_parsed.set && ac.temperature===ref.ac_parsed.temp &&
  ac.turbo===ref.ac_parsed.turbo && ac.bypass===ref.ac_parsed.bypass && ac.spill===ref.ac_parsed.spill &&
  ac.timer===ref.ac_parsed.timer && ac.error===ref.ac_parsed.error;
const grpOk = grp.id===ref.grp_parsed.id && grp.power===ref.grp_parsed.power && grp.damp===ref.grp_parsed.damp &&
  grp.supportsTurbo===ref.grp_parsed.turbo && grp.spillActive===ref.grp_parsed.spill;

console.log(acOk ? '  PASS  decodeAcStatus' : `  FAIL  decodeAcStatus ${JSON.stringify(ac)}`);
console.log(grpOk ? '  PASS  decodeGroupStatus' : `  FAIL  decodeGroupStatus ${JSON.stringify(grp)}`);
process.exit(acOk && grpOk ? 0 : 1);
