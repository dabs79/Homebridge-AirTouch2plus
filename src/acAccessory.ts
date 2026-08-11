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
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.status.temperature ?? 0);

    // Set sane default setpoint ranges up front (protocol allows 10-35C).
    // setAbility() later narrows these to the unit's actual reported limits.
    // Without this, HomeKit's defaults (max 16C heat) reject real setpoints.
    const defaultStep = this.platform.config.minSetpointStep ?? 0.5;
    this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 10, maxValue: 35, minStep: defaultStep })
      .onGet(() => this.status.setPoint ?? 24)
      .onSet((v) => this.setSetpoint(v));
    this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 10, maxValue: 35, minStep: defaultStep })
      .onGet(() => this.status.setPoint ?? 21)
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
    this.service.updateCharacteristic(Characteristic.Active, this.getActive());
    this.service.updateCharacteristic(Characteristic.CurrentHeaterCoolerState, this.getCurrentState());
    this.service.updateCharacteristic(Characteristic.TargetHeaterCoolerState, this.getTargetState());
    this.service.updateCharacteristic(Characteristic.CurrentTemperature, status.temperature ?? 0);
    this.service.updateCharacteristic(Characteristic.RotationSpeed, this.getRotationSpeed());
    if (status.setPoint != null) {
      const target = this.currentTargetSetpointChar();
      if (target) {
        this.service.updateCharacteristic(target, status.setPoint);
      }
    }
  }

  /** Called once the AC ability is known: configure setpoint ranges & valid modes. */
  setAbility(ability: AcAbility): void {
    this.ability = ability;
    const { Characteristic } = this.platform;
    if (ability.name) {
      this.service.setCharacteristic(Characteristic.Name, ability.name);
    }

    const limits = 'cool' in ability.setpointLimits
      ? ability.setpointLimits
      : { cool: ability.setpointLimits, heat: ability.setpointLimits };
    const step = this.platform.config.minSetpointStep ?? 0.5;

    // Narrow the ranges to the unit's actual reported limits.
    // Handlers were already bound in the constructor.
    this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: limits.cool.min, maxValue: limits.cool.max, minStep: step });
    this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: limits.heat.min, maxValue: limits.heat.max, minStep: step });

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
}
