// Message encoders/decoders for the AirTouch 2+ protocol.
// Ported from nathanvdh/airtouch2-python (protocol/at2plus/messages).

import { crc16 } from './crc16';
import {
  valueFromSetpoint,
  setpointFromValue,
  temperatureFromValue,
} from './conversions';
import {
  AddressMsgType,
  AddressSource,
  MessageType,
  ControlStatusSubType,
  ExtendedMessageSubType,
  AcPower,
  AcMode,
  AcFanSpeed,
  AcSetPower,
  AcSetMode,
  GroupPower,
  GroupSetDamper,
  GroupSetPower,
  SetpointControl,
  Limits,
  HEADER_MAGIC,
  HEADER_LENGTH,
  MESSAGE_ID,
  CONTROL_STATUS_SUBHEADER_LENGTH,
  SUBHEADER_MAGIC,
  enumFrom,
} from './enums';

// ------------------------------------------------------------------
// Header
// ------------------------------------------------------------------

/** Build the 8-byte outgoing header. */
function buildHeader(addressMsgType: AddressMsgType, type: MessageType, dataLength: number): Buffer {
  // outgoing address bytes: [msg_type, SELF]
  const dl = Buffer.alloc(2);
  dl.writeUInt16BE(dataLength, 0);
  return Buffer.from([
    HEADER_MAGIC,
    HEADER_MAGIC,
    addressMsgType,
    AddressSource.SELF,
    MESSAGE_ID,
    type,
    dl[0],
    dl[1],
  ]);
}

export interface ParsedHeader {
  addressMsgType: AddressMsgType;
  type: MessageType;
  dataLength: number;
}

/** Parse an 8-byte received header. Throws on invalid magic. */
export function parseHeader(bytes: Buffer): ParsedHeader {
  if (bytes.length !== HEADER_LENGTH) {
    throw new Error('Unexpected header size');
  }
  if (bytes[0] !== HEADER_MAGIC || bytes[1] !== HEADER_MAGIC) {
    throw new Error('Message header magic is invalid');
  }
  const type = enumFrom(MessageType, bytes[5], MessageType.UNSET) as MessageType;
  const addressMsgType = bytes[3] as AddressMsgType;
  const dataLength = bytes.readUInt16BE(6);
  return { addressMsgType, type, dataLength };
}

// ------------------------------------------------------------------
// Envelope helpers
// ------------------------------------------------------------------

/**
 * Wrap a payload (subheader + subdata) in header + CRC.
 * CRC is over everything after the two magic bytes, excluding the CRC itself.
 */
function envelope(addressMsgType: AddressMsgType, type: MessageType, payload: Buffer): Buffer {
  const header = buildHeader(addressMsgType, type, payload.length);
  const body = Buffer.concat([header, payload]);
  const crc = crc16(body.subarray(2)); // skip the 2 magic bytes
  return Buffer.concat([body, crc]);
}

function controlStatusSubheader(
  subType: ControlStatusSubType,
  normalLen: number,
  repeatCount: number,
  repeatLen: number,
): Buffer {
  const b = Buffer.alloc(CONTROL_STATUS_SUBHEADER_LENGTH);
  b[0] = subType;
  b[1] = 0;
  b.writeUInt16BE(normalLen, 2);
  b.writeUInt16BE(repeatLen, 4);
  b.writeUInt16BE(repeatCount, 6);
  return b;
}

// ------------------------------------------------------------------
// AC Status (0x23) — decode
// ------------------------------------------------------------------

export const AC_STATUS_LENGTH = 10;

export interface AcStatus {
  id: number;
  power: AcPower;
  mode: AcMode;
  fanSpeed: AcFanSpeed;
  setPoint: number | null;
  temperature: number | null;
  turbo: boolean;
  bypass: boolean;
  spill: boolean;
  timer: boolean;
  error: number;
}

export function decodeAcStatus(d: Buffer): AcStatus {
  if (d.length !== AC_STATUS_LENGTH) {
    throw new Error(`AC status repeat_data must be ${AC_STATUS_LENGTH} bytes`);
  }
  return {
    id: d[0] & 0x0f,
    power: enumFrom(AcPower, (d[0] & 0xf0) >> 4, AcPower.NOT_AVAILABLE),
    mode: enumFrom(AcMode, (d[1] & 0xf0) >> 4, AcMode.NOT_AVAILABLE),
    fanSpeed: enumFrom(AcFanSpeed, d[1] & 0x0f, AcFanSpeed.UNCHANGED),
    setPoint: setpointFromValue(d[2]),
    turbo: (d[3] & 8) > 0,
    bypass: (d[3] & 4) > 0,
    spill: (d[3] & 2) > 0,
    timer: (d[3] & 1) > 0,
    temperature: temperatureFromValue(d.readUInt16BE(4)),
    error: d.readUInt16BE(6),
  };
}

/** All AC statuses packed into one message body (splits on 10-byte boundaries). */
export function decodeAcStatuses(subdata: Buffer): AcStatus[] {
  const out: AcStatus[] = [];
  for (let i = 0; i + AC_STATUS_LENGTH <= subdata.length; i += AC_STATUS_LENGTH) {
    out.push(decodeAcStatus(subdata.subarray(i, i + AC_STATUS_LENGTH)));
  }
  return out;
}

/** Empty AC-status request (asks the system to report all ACs). */
export function requestAcStatusMessage(): Buffer {
  const subheader = controlStatusSubheader(ControlStatusSubType.AC_STATUS, 0, 0, AC_STATUS_LENGTH);
  return envelope(AddressMsgType.NORMAL, MessageType.CONTROL_STATUS, subheader);
}

// ------------------------------------------------------------------
// AC Control (0x22) — encode
// ------------------------------------------------------------------

export const AC_SETTINGS_LENGTH = 4;

export interface AcSettings {
  id: number;
  power: AcSetPower;
  mode: AcSetMode;
  speed: AcFanSpeed;
  setpoint?: number | null;
}

function encodeAcSettings(s: AcSettings): Buffer {
  if (s.setpoint != null && !(Limits.SETPOINT_MIN <= s.setpoint && s.setpoint <= Limits.SETPOINT_MAX)) {
    throw new RangeError(`Setpoint must be from ${Limits.SETPOINT_MIN} to ${Limits.SETPOINT_MAX}`);
  }
  if (!(s.id >= 0 && s.id < Limits.MAX_ACS)) {
    throw new RangeError(`AC ID must be from 0 to ${Limits.MAX_ACS - 1}`);
  }
  const data = Buffer.alloc(AC_SETTINGS_LENGTH);
  data[0] = (s.power << 4) | s.id;
  data[1] = (s.mode << 4) | s.speed;
  data[2] = s.setpoint != null ? SetpointControl.CHANGE : SetpointControl.KEEP;
  data[3] = valueFromSetpoint(s.setpoint ?? null);
  return data;
}

export function acControlMessage(settings: AcSettings[]): Buffer {
  const subheader = controlStatusSubheader(
    ControlStatusSubType.AC_CONTROL,
    0,
    settings.length,
    AC_SETTINGS_LENGTH,
  );
  const body = Buffer.concat([subheader, ...settings.map(encodeAcSettings)]);
  return envelope(AddressMsgType.NORMAL, MessageType.CONTROL_STATUS, body);
}

// ------------------------------------------------------------------
// Group Status (0x21) — decode
// ------------------------------------------------------------------

export const GROUP_STATUS_LENGTH = 8;

export interface GroupStatus {
  id: number;
  power: GroupPower;
  damp: number;
  supportsTurbo: boolean;
  spillActive: boolean;
}

export function decodeGroupStatus(d: Buffer): GroupStatus {
  if (d.length !== GROUP_STATUS_LENGTH) {
    throw new Error(`Group status repeat_data must be ${GROUP_STATUS_LENGTH} bytes`);
  }
  return {
    id: d[0] & 0x3f,
    power: ((d[0] >> 6) & 3) as GroupPower,
    damp: d[1] & 0x7f,
    supportsTurbo: ((d[6] >> 7) & 1) > 0,
    spillActive: ((d[6] >> 1) & 1) > 0,
  };
}

export function decodeGroupStatuses(subdata: Buffer): GroupStatus[] {
  const out: GroupStatus[] = [];
  for (let i = 0; i + GROUP_STATUS_LENGTH <= subdata.length; i += GROUP_STATUS_LENGTH) {
    out.push(decodeGroupStatus(subdata.subarray(i, i + GROUP_STATUS_LENGTH)));
  }
  return out;
}

export function requestGroupStatusMessage(): Buffer {
  const subheader = controlStatusSubheader(
    ControlStatusSubType.GROUP_STATUS,
    0,
    0,
    GROUP_STATUS_LENGTH,
  );
  return envelope(AddressMsgType.NORMAL, MessageType.CONTROL_STATUS, subheader);
}

// ------------------------------------------------------------------
// Group Control (0x20) — encode
// ------------------------------------------------------------------

export const GROUP_SETTINGS_LENGTH = 4;

export interface GroupSettings {
  id: number;
  dampMode: GroupSetDamper;
  power: GroupSetPower;
  damp?: number | null;
}

function encodeGroupSettings(s: GroupSettings): Buffer {
  if (s.damp != null && !(s.damp >= 0 && s.damp <= 100)) {
    throw new RangeError('Damper percentage must be from 0 to 100');
  }
  if (!(s.id >= 0 && s.id < Limits.MAX_GROUPS)) {
    throw new RangeError(`Group ID must be from 0 to ${Limits.MAX_GROUPS - 1}`);
  }
  return Buffer.from([
    s.id,
    (s.dampMode << 5) | s.power,
    s.damp != null ? s.damp : 255,
    0,
  ]);
}

export function groupControlMessage(settings: GroupSettings[]): Buffer {
  const subheader = controlStatusSubheader(
    ControlStatusSubType.GROUP_CONTROL,
    0,
    settings.length,
    GROUP_SETTINGS_LENGTH,
  );
  const body = Buffer.concat([subheader, ...settings.map(encodeGroupSettings)]);
  return envelope(AddressMsgType.NORMAL, MessageType.CONTROL_STATUS, body);
}

// ------------------------------------------------------------------
// Extended: AC Ability (0x11) — request + decode
// ------------------------------------------------------------------

export interface SetpointLimits {
  min: number;
  max: number;
}
export interface DualSetpointLimits {
  cool: SetpointLimits;
  heat: SetpointLimits;
}

export interface AcAbility {
  acId: number;
  name: string;
  startGroup: number;
  groupCount: number;
  supportedModes: AcSetMode[];
  supportedFanSpeeds: AcFanSpeed[];
  setpointLimits: SetpointLimits | DualSetpointLimits;
}

const AC_ABILITY_V1 = 24;
const AC_ABILITY_V1_1 = 26;

export function requestAcAbilityMessage(acId?: number): Buffer {
  const sub = Buffer.from([SUBHEADER_MAGIC, ExtendedMessageSubType.ABILITY]);
  const payload = acId != null ? Buffer.concat([sub, Buffer.from([acId])]) : sub;
  return envelope(AddressMsgType.EXTENDED, MessageType.EXTENDED, payload);
}

export function decodeAcAbility(d: Buffer): AcAbility {
  if (d.length !== AC_ABILITY_V1 && d.length !== AC_ABILITY_V1_1) {
    throw new Error(`Invalid AcAbility length: ${d.length}`);
  }
  const acId = d[0];
  const following = d[1];
  if (following !== d.length - 2) {
    throw new Error(`AcAbility length mismatch: specified ${following}, got ${d.length - 2}`);
  }
  const name = d.subarray(2, 18).toString('ascii').split('\x00')[0];
  const startGroup = d[18];
  const groupCount = d[19];

  const supportedModes: AcSetMode[] = [];
  for (let i = 0; i < 5; i++) {
    if ((d[20] & (1 << i)) > 0) supportedModes.push(i as AcSetMode);
  }
  const supportedFanSpeeds: AcFanSpeed[] = [];
  for (let i = 0; i < 7; i++) {
    if ((d[21] & (1 << i)) > 0) supportedFanSpeeds.push(i as AcFanSpeed);
  }

  let setpointLimits: SetpointLimits | DualSetpointLimits = { min: d[22], max: d[23] };
  if (d.length === AC_ABILITY_V1_1) {
    setpointLimits = {
      cool: { min: d[22], max: d[23] },
      heat: { min: d[24], max: d[25] },
    };
  }
  return { acId, name, startGroup, groupCount, supportedModes, supportedFanSpeeds, setpointLimits };
}

/** First ability record from an ability message body (mirrors the Python client). */
export function decodeAcAbilityMessage(subdata: Buffer): AcAbility[] {
  if (subdata.length === 0) return [];
  const length = subdata[1] + 2;
  const out: AcAbility[] = [];
  for (let i = 0; i + length <= subdata.length; i += length) {
    out.push(decodeAcAbility(subdata.subarray(i, i + length)));
    break; // Python reference only reads the first record
  }
  return out;
}

// ------------------------------------------------------------------
// Extended: Group Names (0x12) — request + decode
// ------------------------------------------------------------------

export function requestGroupNamesMessage(): Buffer {
  const sub = Buffer.from([SUBHEADER_MAGIC, ExtendedMessageSubType.GROUP_NAME]);
  return envelope(AddressMsgType.EXTENDED, MessageType.EXTENDED, sub);
}

export function decodeGroupNames(subdata: Buffer): Map<number, string> {
  const map = new Map<number, string>();
  for (let i = 0; i + 9 <= subdata.length; i += 9) {
    const id = subdata[i];
    const name = subdata.subarray(i + 1, i + 9).toString('ascii').split('\x00')[0];
    map.set(id, name);
  }
  return map;
}

// Re-exports used by the CRC verification harness / client.
export { crc16 };
export { AddressMsgType, MessageType, ControlStatusSubType, ExtendedMessageSubType };
