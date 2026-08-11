// Enums and constants for the AirTouch 2+ protocol.
// Ported from nathanvdh/airtouch2-python (protocol/at2plus).

export const Limits = {
  MAX_ACS: 8,
  MAX_GROUPS: 16,
  SETPOINT_MIN: 10,
  SETPOINT_MAX: 35,
  TEMP_MIN: -50,
  TEMP_MAX: 150,
} as const;

// ---- Header / message framing ----
export const HEADER_MAGIC = 0x55;
export const HEADER_LENGTH = 8;
export const NON_DATA_LENGTH = 10; // header(8) + crc(2)
export const MESSAGE_ID = 1;

export enum AddressSource {
  SELF = 0xb0,
  OTHER = 0x9f,
}

export enum AddressMsgType {
  UNSET = 0,
  NORMAL = 0x80,
  EXTENDED = 0x90,
}

export enum MessageType {
  UNSET = 0,
  CONTROL_STATUS = 0xc0,
  EXTENDED = 0x1f,
}

// ---- Control/Status sub-message framing ----
export const CONTROL_STATUS_SUBHEADER_LENGTH = 8;

export enum ControlStatusSubType {
  UNSET = 0,
  GROUP_CONTROL = 0x20,
  GROUP_STATUS = 0x21,
  AC_CONTROL = 0x22,
  AC_STATUS = 0x23,
}

// ---- Extended sub-message framing ----
export const SUBHEADER_MAGIC = 0xff;
export const EXTENDED_SUBHEADER_LENGTH = 2;

export enum ExtendedMessageSubType {
  ERROR = 0x10,
  ABILITY = 0x11,
  GROUP_NAME = 0x12,
}

// ---- AC enums ----
export enum AcSetPower {
  TOGGLE = 1,
  OFF = 2,
  ON = 3,
  AWAY = 4,
  SLEEP = 5,
  UNCHANGED = 15,
}

export enum AcPower {
  OFF = 0,
  ON = 1,
  AWAY_OFF = 2,
  AWAY_ON = 3,
  SLEEP = 5,
  NOT_AVAILABLE = 15,
}

export enum AcSetMode {
  AUTO = 0,
  HEAT = 1,
  DRY = 2,
  FAN = 3,
  COOL = 4,
  UNCHANGED = 15,
}

export enum AcMode {
  AUTO = 0,
  HEAT = 1,
  DRY = 2,
  FAN = 3,
  COOL = 4,
  AUTO_HEAT = 8,
  AUTO_COOL = 9,
  NOT_AVAILABLE = 15,
}

export enum AcFanSpeed {
  AUTO = 0,
  QUIET = 1,
  LOW = 2,
  MEDIUM = 3,
  HIGH = 4,
  POWERFUL = 5,
  TURBO = 6,
  UNCHANGED = 15,
}

// ---- Group enums ----
export enum GroupPower {
  OFF = 0,
  ON = 1,
  TURBO = 3,
}

export enum GroupSetDamper {
  UNCHANGED = 0,
  INC = 2,
  DEC = 3,
  SET = 4,
}

export enum GroupSetPower {
  UNCHANGED = 0,
  NEXT = 1,
  OFF = 2,
  ON = 3,
  TURBO = 5,
}

export enum SetpointControl {
  KEEP = 0,
  CHANGE = 0x40,
}

export function enumFrom<T extends Record<string, number | string>>(
  e: T,
  value: number,
  fallback: number,
): number {
  return (Object.values(e) as number[]).includes(value) ? value : fallback;
}
