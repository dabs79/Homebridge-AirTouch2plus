import type {
  PlatformAccessory,
  Service,
  CharacteristicValue,
} from 'homebridge';
import type { AirTouchPlatform } from './platform';
import type { AcAccessory } from './acAccessory';

/**
 * A simple Fan tile that switches the AC into a specific mode that HeaterCooler
 * can't represent (FAN-only circulation, or DRY dehumidify).
 *
 * Behaviour:
 *  - ON  -> AC into the target mode
 *  - OFF -> AC off (a tile that reads "off" should mean the AC has stopped)
 *
 * It reflects the live state: if the AC enters this mode by any means, the tile
 * shows ON; otherwise OFF.
 */
export type AcMode = 'fan' | 'dry';

export class ModeAccessory {
  private service: Service;

  constructor(
    private readonly platform: AirTouchPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly ac: AcAccessory,
    acName: string,
    private readonly mode: AcMode,
  ) {
    const { Service, Characteristic } = this.platform;
    const label = mode === 'fan' ? 'Fan Only' : 'Dry';

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Polyaire')
      .setCharacteristic(Characteristic.Model, `AirTouch 2+ ${label} Mode`)
      .setCharacteristic(Characteristic.Name, `${acName} ${label}`)
      .setCharacteristic(Characteristic.SerialNumber, `AT2P-${mode.toUpperCase()}-${acName}`);

    this.service =
      this.accessory.getService(Service.Fanv2) ||
      this.accessory.addService(Service.Fanv2);

    this.service.setCharacteristic(Characteristic.Name, `${acName} ${label}`);

    this.service.getCharacteristic(Characteristic.Active)
      .onGet(() => this.getActive())
      .onSet((v) => this.setActive(v));

    this.ac.onStatusUpdate(() => this.refresh());
  }

  private refresh(): void {
    this.service.updateCharacteristic(this.platform.Characteristic.Active, this.getActive());
  }

  private isActive(): boolean {
    return this.mode === 'fan' ? this.ac.isFanOnlyActive() : this.ac.isDryActive();
  }

  private getActive(): CharacteristicValue {
    const { Characteristic } = this.platform;
    return this.isActive()
      ? Characteristic.Active.ACTIVE
      : Characteristic.Active.INACTIVE;
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform;
    if (value === Characteristic.Active.ACTIVE) {
      if (this.mode === 'fan') this.ac.setFanOnly();
      else this.ac.setDry();
    } else {
      // Off means stop: turn the whole AC off.
      this.ac.turnOff();
    }
  }
}
