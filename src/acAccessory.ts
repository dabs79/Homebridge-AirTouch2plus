import type {
  PlatformAccessory,
  Service,
  CharacteristicValue,
} from 'homebridge';
import type { AirTouchPlatform } from './platform';
import { At2PlusClient } from './protocol/client';
import { acControlMessage } from './protocol/messages';
import {
  AcPower,
  AcMode,
  AcFanSpeed,
  AcSetPower,
  AcSetMode,
} from './protocol/enums';
import type { AcStatus, AcAbility } from './protocol/messages';

/**
 * One ducted AC unit -> a HomeKit HeaterCooler.
 * Modes map: HEAT/COOL/AUTO. DRY and FAN have no HeaterCooler equivalent, so
 * when the unit reports those we present it as "idle" but keep power state.
 */
export class AcAccessory {
  private service: Service;
  private status: AcStatus;
  private ability?: AcAbility;
  private readonly statusListeners: Array<() => void> = [];
  /** Last temperature the unit reported that wasn't the "no reading" sentinel. */
  private lastValidTemperature: number | null = null;
  /** Optional externally-supplied temperature (e.g. a downstairs sensor). */
  private externalTemperature: number | null = null;

  constructor(
    private readonly platform: AirTouchPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: At2PlusClient,
    private readonly acId: number,
    initialStatus: AcStatus,
  ) {
    this.status = initialStatus;
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Polyaire')
      .setCharacteristic(Characteristic.Model, 'AirTouch 2+ AC')
      .setCharacteristic(Characteristic.SerialNumber, `AT2P-AC-${acId}`);

    this.service =
      this.accessory.getService(Service.HeaterCooler) ||
      this.accessory.addService(Service.HeaterCooler);

    this.service.getCharacteristic(Characteristic.Active)
      .onGet(() => this.getActive())
      .onSet((v) => this.setActive(v));

    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.getCurrentState());

    this.service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .onGet(() => this.getTargetState())
      .onSet((v) => this.setTargetState(v));

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -100, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.getCurrentTemperature());

    // Set sane default setpoint ranges up front (protocol allows 10-35C).
    // setAbility() later narrows these to the unit's actual reported limits.
    // IMPORTANT: set a valid initial value BEFORE setProps, otherwise HAP
    // validates the characteristic's default (0) against the new min and warns.
    const defaultStep = this.platform.config.minSetpointStep ?? 0.5;
    const coolChar = this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature);
    coolChar.updateValue(24);
    coolChar
      .setProps({ minValue: 10, maxValue: 35, minStep: defaultStep })
      .onGet(() => this.clampSetpoint(this.status.setPoint ?? 24, coolChar))
      .onSet((v) => this.setSetpoint(v));
    const heatChar = this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature);
    heatChar.updateValue(21);
    heatChar
      .setProps({ minValue: 10, maxValue: 35, minStep: defaultStep })
      .onGet(() => this.clampSetpoint(this.status.setPoint ?? 21, heatChar))
      .onSet((v) => this.setSetpoint(v));

    // Fan speed as rotation speed (mapped to discrete AT2+ speeds).
    this.service.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => this.getRotationSpeed())
      .onSet((v) => this.setRotationSpeed(v));
  }

  /** Called by the platform when a fresh status frame arrives. */
  updateStatus(status: AcStatus): void {
    this.status = status;
    const { Characteristic } = this.platform;
    // Track the last "real" temperature. The unit sends all-zero temperature
    // bytes (which decode to the protocol minimum, -50) when it has no reading
    // to report — typically in FAN mode. Ignore that sentinel and keep the
    // last good value so the tile doesn't flash -50.
    if (this.isRealTemperature(status.temperature)) {
      this.lastValidTemperature = status.temperature;
    }
    this.service.updateCharacteristic(Characteristic.Active, this.getActive());
    this.service.updateCharacteristic(Characteristic.CurrentHeaterCoolerState, this.getCurrentState());
    this.service.updateCharacteristic(Characteristic.TargetHeaterCoolerState, this.getTargetState());
    this.service.updateCharacteristic(Characteristic.CurrentTemperature, this.getCurrentTemperature());
    this.service.updateCharacteristic(Characteristic.RotationSpeed, this.getRotationSpeed());
    if (status.setPoint != null) {
      const target = this.currentTargetSetpointChar();
      if (target) {
        this.service.updateCharacteristic(target, status.setPoint);
      }
    }
    // Notify companion accessories (e.g. the fan-speed accessory).
    for (const cb of this.statusListeners) cb();
  }

  /** True if a reported temperature looks like a genuine reading. */
  private isRealTemperature(t: number | null): t is number {
    // -50 is the protocol minimum and is what all-zero bytes decode to; treat
    // it (and anything at/below it) as "no reading".
    return t != null && t > -50 && t < 100;
  }

  /**
   * The temperature to show on the tile:
   *  1. an externally-supplied reading (e.g. downstairs sensor), if set;
   *  2. otherwise the unit's current reading, if it's real;
   *  3. otherwise the last good reading we saw;
   *  4. otherwise 0 (only before any real reading has arrived).
   */
  private getCurrentTemperature(): number {
    if (this.externalTemperature != null) return this.externalTemperature;
    if (this.isRealTemperature(this.status.temperature)) return this.status.temperature;
    if (this.lastValidTemperature != null) return this.lastValidTemperature;
    return 0;
  }

  /**
   * Override the temperature shown on the AC tile with an external reading
   * (e.g. a downstairs room sensor). Pass null to revert to the unit's own
   * sensor. This is a display/reporting hook; the AirTouch hardware still
   * regulates from its built-in sensor.
   */
  setExternalTemperature(celsius: number | null): void {
    this.externalTemperature = celsius;
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      this.getCurrentTemperature(),
    );
  }

  /** Called once the AC ability is known: configure setpoint ranges & valid modes. */
  setAbility(ability: AcAbility): void {
    this.ability = ability;
    const { Characteristic } = this.platform;
    if (ability.name) {
      this.service.setCharacteristic(Characteristic.Name, ability.name);
    }

    const raw = 'cool' in ability.setpointLimits
      ? ability.setpointLimits
      : { cool: ability.setpointLimits, heat: ability.setpointLimits };
    const step = this.platform.config.minSetpointStep ?? 0.5;

    // Sanitise the reported limits. Some firmware (incl. certain Daikin setups)
    // reports a placeholder/zero-width range like 16-16 in the ability message,
    // with the real range living in the console preferences. Reject anything
    // that isn't a plausible, positive-width range and fall back to a safe
    // default (configurable), so HomeKit always gets a usable slider range.
    const fallbackMin = this.platform.config.setpointMin ?? 10;
    const fallbackMax = this.platform.config.setpointMax ?? 35;
    const cool = this.sanitiseRange(raw.cool.min, raw.cool.max, fallbackMin, fallbackMax);
    const heat = this.sanitiseRange(raw.heat.min, raw.heat.max, fallbackMin, fallbackMax);

    // Update current values into range BEFORE narrowing props, so HAP doesn't
    // reject the existing value against the new min/max.
    const coolChar = this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature);
    coolChar.updateValue(this.clampTo(coolChar.value as number, cool.min, cool.max));
    coolChar.setProps({ minValue: cool.min, maxValue: cool.max, minStep: step });

    const heatChar = this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature);
    heatChar.updateValue(this.clampTo(heatChar.value as number, heat.min, heat.max));
    heatChar.setProps({ minValue: heat.min, maxValue: heat.max, minStep: step });

    // Restrict target states to modes the unit supports.
    // AUTO is always included: FAN and DRY modes (which HeaterCooler can't
    // represent) map to AUTO, so it must be a legal value even if the unit
    // doesn't list AUTO as a "mode" per se.
    const S = Characteristic.TargetHeaterCoolerState;
    const valid = new Set<number>([S.AUTO]);
    if (ability.supportedModes.includes(AcSetMode.HEAT)) valid.add(S.HEAT);
    if (ability.supportedModes.includes(AcSetMode.COOL)) valid.add(S.COOL);
    this.service.getCharacteristic(S).setProps({ validValues: [...valid] });
  }

  /** Return a usable [min,max] range, falling back if the reported one is implausible. */
  private sanitiseRange(
    min: number,
    max: number,
    fallbackMin: number,
    fallbackMax: number,
  ): { min: number; max: number } {
    const plausible =
      Number.isFinite(min) &&
      Number.isFinite(max) &&
      max - min >= 1 && // needs positive, non-trivial width
      min >= 5 &&
      max <= 40;
    if (!plausible) {
      this.platform.log.warn(
        `AC ${this.acId} reported an unusable setpoint range (${min}-${max}); ` +
        `using ${fallbackMin}-${fallbackMax} instead. ` +
        `Adjust with "setpointMin"/"setpointMax" in config if your unit differs.`,
      );
      return { min: fallbackMin, max: fallbackMax };
    }
    return { min, max };
  }

  private clampTo(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  /** Clamp a setpoint to the characteristic's current props range for onGet. */
  private clampSetpoint(value: number, char: { props: { minValue?: number; maxValue?: number } }): number {
    const min = char.props.minValue ?? 10;
    const max = char.props.maxValue ?? 35;
    return this.clampTo(value, min, max);
  }

  // ---------------- getters ----------------

  private isOn(): boolean {
    return this.status.power === AcPower.ON || this.status.power === AcPower.AWAY_ON || this.status.power === AcPower.SLEEP;
  }

  private getActive(): CharacteristicValue {
    const { Characteristic } = this.platform;
    return this.isOn() ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
  }

  private getCurrentState(): CharacteristicValue {
    const C = this.platform.Characteristic.CurrentHeaterCoolerState;
    if (!this.isOn()) return C.INACTIVE;
    switch (this.status.mode) {
      case AcMode.HEAT:
      case AcMode.AUTO_HEAT:
        return C.HEATING;
      case AcMode.COOL:
      case AcMode.AUTO_COOL:
        return C.COOLING;
      case AcMode.AUTO:
        // Direction unknown without more data; report idle.
        return C.IDLE;
      default:
        return C.IDLE; // DRY / FAN
    }
  }

  private getTargetState(): CharacteristicValue {
    const C = this.platform.Characteristic.TargetHeaterCoolerState;
    switch (this.status.mode) {
      case AcMode.HEAT:
      case AcMode.AUTO_HEAT:
        return C.HEAT;
      case AcMode.COOL:
      case AcMode.AUTO_COOL:
        return C.COOL;
      default:
        return C.AUTO;
    }
  }

  private currentTargetSetpointChar() {
    const { Characteristic } = this.platform;
    switch (this.status.mode) {
      case AcMode.HEAT:
      case AcMode.AUTO_HEAT:
        return Characteristic.HeatingThresholdTemperature;
      case AcMode.COOL:
      case AcMode.AUTO_COOL:
        return Characteristic.CoolingThresholdTemperature;
      default:
        return null;
    }
  }

  // Map AT2+ discrete fan speeds <-> 0..100.
  private getRotationSpeed(): CharacteristicValue {
    const order = [AcFanSpeed.QUIET, AcFanSpeed.LOW, AcFanSpeed.MEDIUM, AcFanSpeed.HIGH, AcFanSpeed.POWERFUL, AcFanSpeed.TURBO];
    if (this.status.fanSpeed === AcFanSpeed.AUTO) return 0;
    const idx = order.indexOf(this.status.fanSpeed);
    if (idx < 0) return 0;
    return Math.round(((idx + 1) / order.length) * 100);
  }

  private speedFromPercent(pct: number): AcFanSpeed {
    if (pct <= 0) return AcFanSpeed.AUTO;
    const supported = this.ability?.supportedFanSpeeds?.filter((s) => s !== AcFanSpeed.AUTO) ?? [
      AcFanSpeed.LOW, AcFanSpeed.MEDIUM, AcFanSpeed.HIGH,
    ];
    if (!supported.length) return AcFanSpeed.AUTO;
    const idx = Math.min(supported.length - 1, Math.floor((pct / 100) * supported.length));
    return supported[idx];
  }

  // ---------------- setters ----------------

  private send(power: AcSetPower, mode: AcSetMode, speed: AcFanSpeed, setpoint: number | null): void {
    this.client.send(acControlMessage([{ id: this.acId, power, mode, speed, setpoint }]));
    // Nudge a status refresh shortly after.
    setTimeout(() => this.client.requestAcStatus(), 500);
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const on = value === this.platform.Characteristic.Active.ACTIVE;
    this.send(on ? AcSetPower.ON : AcSetPower.OFF, AcSetMode.UNCHANGED, AcFanSpeed.UNCHANGED, null);
  }

  private async setTargetState(value: CharacteristicValue): Promise<void> {
    const S = this.platform.Characteristic.TargetHeaterCoolerState;
    let mode = AcSetMode.AUTO;
    if (value === S.HEAT) mode = AcSetMode.HEAT;
    else if (value === S.COOL) mode = AcSetMode.COOL;
    else mode = AcSetMode.AUTO;
    // Setting a mode implies powering on.
    this.send(AcSetPower.ON, mode, AcFanSpeed.UNCHANGED, null);
  }

  private async setSetpoint(value: CharacteristicValue): Promise<void> {
    this.send(AcSetPower.UNCHANGED, AcSetMode.UNCHANGED, AcFanSpeed.UNCHANGED, Number(value));
  }

  private async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    const speed = this.speedFromPercent(Number(value));
    this.send(AcSetPower.UNCHANGED, AcSetMode.UNCHANGED, speed, null);
  }

  // ---------------- public fan-speed API (used by FanSpeedAccessory) ----------------

  /** The list of manual fan speeds this unit supports, in ascending order. */
  getSupportedManualSpeeds(): AcFanSpeed[] {
    const speeds = this.ability?.supportedFanSpeeds?.filter((s) => s !== AcFanSpeed.AUTO);
    if (speeds && speeds.length) return [...speeds].sort((a, b) => a - b);
    return [AcFanSpeed.LOW, AcFanSpeed.MEDIUM, AcFanSpeed.HIGH];
  }

  /** Current fan speed as reported by the unit. */
  getCurrentFanSpeed(): AcFanSpeed {
    return this.status.fanSpeed;
  }

  /** Whether the unit is currently on AUTO fan speed. */
  isFanAuto(): boolean {
    return this.status.fanSpeed === AcFanSpeed.AUTO;
  }

  /** Set a specific fan speed (does not change power/mode/setpoint). */
  setFanSpeed(speed: AcFanSpeed): void {
    this.send(AcSetPower.UNCHANGED, AcSetMode.UNCHANGED, speed, null);
  }

  /** Register a callback fired whenever this AC's status updates. */
  onStatusUpdate(cb: () => void): void {
    this.statusListeners.push(cb);
  }

  // ---------------- public fan-mode API (used by FanModeAccessory) ----------------

  /** True if the unit is powered on and in FAN mode. */
  isFanOnlyActive(): boolean {
    const on =
      this.status.power === AcPower.ON ||
      this.status.power === AcPower.AWAY_ON ||
      this.status.power === AcPower.SLEEP;
    return on && this.status.mode === AcMode.FAN;
  }

  /** Put the unit into FAN-only mode (powers on, sets FAN). */
  setFanOnly(): void {
    this.send(AcSetPower.ON, AcSetMode.FAN, AcFanSpeed.UNCHANGED, null);
  }

  /** Turn the whole AC off. */
  turnOff(): void {
    this.send(AcSetPower.OFF, AcSetMode.UNCHANGED, AcFanSpeed.UNCHANGED, null);
  }
}
