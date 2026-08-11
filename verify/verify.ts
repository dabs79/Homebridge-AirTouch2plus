import * as fs from 'fs';
import {
  requestAcStatusMessage,
  requestGroupStatusMessage,
  requestGroupNamesMessage,
  requestAcAbilityMessage,
  acControlMessage,
  groupControlMessage,
} from '../src/protocol/messages';
import {
  AcSetPower,
  AcSetMode,
  AcFanSpeed,
  GroupSetDamper,
  GroupSetPower,
} from '../src/protocol/enums';

const ref = JSON.parse(fs.readFileSync(new URL('../reference.json', import.meta.url), 'utf8'));

const cases: Record<string, Buffer> = {
  request_ac_status: requestAcStatusMessage(),
  request_group_status: requestGroupStatusMessage(),
  request_group_names: requestGroupNamesMessage(),
  request_ac_ability_all: requestAcAbilityMessage(),
  request_ac_ability_0: requestAcAbilityMessage(0),
  ac_control_on_cool_225: acControlMessage([
    { id: 0, power: AcSetPower.ON, mode: AcSetMode.COOL, speed: AcFanSpeed.HIGH, setpoint: 22.5 },
  ]),
  ac_control_off: acControlMessage([
    { id: 1, power: AcSetPower.OFF, mode: AcSetMode.UNCHANGED, speed: AcFanSpeed.UNCHANGED, setpoint: null },
  ]),
  ac_control_setpoint18: acControlMessage([
    { id: 2, power: AcSetPower.UNCHANGED, mode: AcSetMode.UNCHANGED, speed: AcFanSpeed.UNCHANGED, setpoint: 18.0 },
  ]),
  group_control_on_damp60: groupControlMessage([
    { id: 3, dampMode: GroupSetDamper.SET, power: GroupSetPower.ON, damp: 60 },
  ]),
  group_control_off: groupControlMessage([
    { id: 0, dampMode: GroupSetDamper.UNCHANGED, power: GroupSetPower.OFF, damp: null },
  ]),
  group_control_turbo: groupControlMessage([
    { id: 5, dampMode: GroupSetDamper.UNCHANGED, power: GroupSetPower.TURBO, damp: null },
  ]),
};

let pass = 0;
let fail = 0;
for (const [name, buf] of Object.entries(cases)) {
  const got = buf.toString('hex');
  const want = ref[name];
  if (got === want) {
    pass++;
    console.log(`  PASS  ${name}  ${got}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
    console.log(`        got : ${got}`);
    console.log(`        want: ${want}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
