import type {
  PlatformAccessory,
  Service,
  CharacteristicValue,
} from 'homebridge';
import type { AirTouchPlatform } from './platform';
import type { AcAccessory } from './acAccessory';
import { AcFanSpeed } from './protocol/enums';

/**
 * Companion Fan (Fanv2) accessory that surfaces the AC's fan speed to Apple
 * Home, which does not render the RotationSpeed control on a HeaterCooler tile.
 *
 * Mapping:
 *  - Active INACTIVE  -> AUTO fan speed (system decides)
 *  - Active ACTIVE    -> manual speed, chosen by the RotationSpeed slider
 *  - RotationSpeed snaps to the unit's supported manual speeds (e.g. Low/Med/High)
 *
 * This is a second HomeKit surface onto the same underlying AC fan speed, kept
 * in sync via the AC accessory's status callbacks. It is not an independent fan.
 */
export class FanSpeedAccessory {
  private service: Service;
  /** Supported manual speeds in ascending order (e.g. [LOW, MEDIUM, HIGH]). */
  private speeds: AcFanSpeed[];
  /** Percentage width of one slider step. */
  private step: number;

  constructor(
    private readonly platform: AirTouchPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly ac: AcAccessory,
    acName: string,
  ) {
    const { Service, Characteristic } = this.platform;

    this.speeds = this.ac.getSupportedManualSpeeds();
    // Use a fractional step so the top speed lands exactly at 100%.
    // e.g. 3 speeds -> step 33.33, positions ~33.3 / 66.7 / 100.
    this.step = 100 / this.speeds.length;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Polyaire')
      .setCharacteristic(Characteristic.Model, 'AirTouch 2+ Fan Speed')
      .setCharacteristic(Characteristic.SerialNumber, `AT2P-FAN-${acName}`);

    this.service =
      this.accessory.getService(Service.Fanv2) ||
      this.accessory.addService(Service.Fanv2);

    this.service.setCharacteristic(Characteristic.Name, `${acName} Fan Speed`);

    // Active: ACTIVE = manual speed, INACTIVE = AUTO.
    this.service.getCharacteristic(Characteristic.Active)
      .onGet(() => this.getActive())
      .onSet((v) => this.setActive(v));

    // RotationSpeed. We keep minStep at 1 for a smooth slider, but snap the
    // written value to the nearest supported speed band on set, and report the
    // band's canonical percentage on get.
    this.service.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => this.getRotationSpeed())
      .onSet((v) => this.setRotationSpeed(v));

    // Keep in sync when the AC reports a change from any source.
    this.ac.onStatusUpdate(() => this.refresh());
  }

  private refresh(): void {
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.Active, this.getActive());
    this.service.updateCharacteristic(Characteristic.RotationSpeed, this.getRotationSpeed());
  }

  private getActive(): CharacteristicValue {
    const { Characteristic } = this.platform;
    return this.ac.isFanAuto()
      ? Characteristic.Active.INACTIVE
      : Characteristic.Active.ACTIVE;
  }

  /** Map current AC fan speed -> slider %. AUTO returns 0. */
  private getRotationSpeed(): CharacteristicValue {
    if (this.ac.isFanAuto()) return 0;
    const idx = this.speeds.indexOf(this.ac.getCurrentFanSpeed());
    if (idx < 0) return 0;
    // Report the MIDDLE of each band so the value sits unambiguously inside it.
    // N speeds -> band i spans (i*step, (i+1)*step]; middle = (i+0.5)*step.
    // Top speed still reads as 100 for a clean full-slider appearance.
    if (idx === this.speeds.length - 1) return 100;
    return Math.round((idx + 0.5) * this.step);
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform;
    if (value === Characteristic.Active.INACTIVE) {
      // Turning the fan tile "off" means AUTO fan speed.
      this.ac.setFanSpeed(AcFanSpeed.AUTO);
    } else {
      // Turning it "on" with no explicit slider change -> pick a sensible manual
      // speed. If currently AUTO, default to the lowest manual speed.
      if (this.ac.isFanAuto()) {
        this.ac.setFanSpeed(this.speeds[0]);
      }
    }
  }

  private async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    const pct = Number(value);
    if (pct <= 0) {
      this.ac.setFanSpeed(AcFanSpeed.AUTO);
      return;
    }
    // Which band (1..N) does this percentage fall into? ceil so e.g. with 3
    // speeds: 1-33 -> Low, 34-67 -> Med, 68-100 -> High.
    const band = Math.min(this.speeds.length, Math.max(1, Math.ceil(pct / this.step)));
    this.ac.setFanSpeed(this.speeds[band - 1]);
  }
}
