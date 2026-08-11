import type {
  PlatformAccessory,
  Service,
  CharacteristicValue,
} from 'homebridge';
import type { AirTouchPlatform } from './platform';
import type { AcAccessory } from './acAccessory';

/**
 * A simple Fan tile that switches the AC into FAN-only mode (air circulation
 * with no heating or cooling). HomeKit's HeaterCooler service has no FAN target
 * state, so this exposes it separately.
 *
 * Behaviour:
 *  - ON  -> AC into FAN mode
 *  - OFF -> AC off (a fan tile that reads "off" should mean the fan has stopped)
 *
 * It reflects the live state: if the AC is put into FAN mode by any means, this
 * tile shows ON; otherwise OFF.
 */
export class FanModeAccessory {
  private service: Service;

  constructor(
    private readonly platform: AirTouchPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly ac: AcAccessory,
    acName: string,
  ) {
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Polyaire')
      .setCharacteristic(Characteristic.Model, 'AirTouch 2+ Fan Mode')
      .setCharacteristic(Characteristic.Name, `${acName} Fan Only`)
      .setCharacteristic(Characteristic.SerialNumber, `AT2P-FANMODE-${acName}`);

    this.service =
      this.accessory.getService(Service.Fanv2) ||
      this.accessory.addService(Service.Fanv2);

    this.service.setCharacteristic(Characteristic.Name, `${acName} Fan Only`);

    this.service.getCharacteristic(Characteristic.Active)
      .onGet(() => this.getActive())
      .onSet((v) => this.setActive(v));

    // Keep in sync with the AC's real state.
    this.ac.onStatusUpdate(() => this.refresh());
  }

  private refresh(): void {
    this.service.updateCharacteristic(this.platform.Characteristic.Active, this.getActive());
  }

  private getActive(): CharacteristicValue {
    const { Characteristic } = this.platform;
    return this.ac.isFanOnlyActive()
      ? Characteristic.Active.ACTIVE
      : Characteristic.Active.INACTIVE;
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform;
    if (value === Characteristic.Active.ACTIVE) {
      this.ac.setFanOnly();
    } else {
      // Off means stop: turn the whole AC off.
      this.ac.turnOff();
    }
  }
}
