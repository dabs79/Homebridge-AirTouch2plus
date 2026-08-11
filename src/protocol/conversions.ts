// Setpoint / temperature encoding, ported from conversions.py.
import { Limits } from './enums';

export function valueFromSetpoint(setpoint: number | null): number {
  if (setpoint) {
    if (!(Limits.SETPOINT_MIN <= setpoint && setpoint <= Limits.SETPOINT_MAX)) {
      throw new RangeError(
        `Setpoint must be between ${Limits.SETPOINT_MIN} and ${Limits.SETPOINT_MAX}`,
      );
    }
    return Math.trunc(setpoint * 10 - 100);
  }
  return Math.trunc(Limits.SETPOINT_MAX * 10 - 100 + 1);
}

export function setpointFromValue(value: number): number | null {
  const setpoint = (value + 100) / 10;
  if (Limits.SETPOINT_MIN <= setpoint && setpoint <= Limits.SETPOINT_MAX) {
    return setpoint;
  }
  return null;
}

export function valueFromTemperature(temp: number | null): number {
  if (temp) {
    if (!(Limits.TEMP_MIN <= temp && temp <= Limits.SETPOINT_MAX)) {
      throw new RangeError(
        `Temperature must be between ${Limits.TEMP_MIN} and ${Limits.TEMP_MAX}`,
      );
    }
    return Math.trunc(temp * 10 + 500);
  }
  return Math.trunc(Limits.TEMP_MAX * 10 + 501);
}

export function temperatureFromValue(val: number): number | null {
  const temp = (val - 500) / 10;
  if (Limits.TEMP_MIN <= temp && temp <= Limits.TEMP_MAX) {
    return temp;
  }
  return null;
}
