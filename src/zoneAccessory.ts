import type {
  PlatformAccessory,
  Service,
  CharacteristicValue,
} from 'homebridge';
import type { AirTouchPlatform } from './platform';
import { At2PlusClient } from './protocol/client';
import { groupControlMessage } from './protocol/messages';
import { GroupPower, GroupSetDamper, GroupSetPower } from './protocol/enums';
import type { GroupStatus } from './protocol/messages';

/**
 * One zone (group) -> a HomeKit Fanv2.
 * On/Off maps to zone power; rotation speed maps to damper %.
 */
export class ZoneAccessory {
  private service: Service;
  private status: GroupStatus;

  constructor(
    private readonly platform: AirTouchPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: At2PlusClient,
    private readonly groupId: number,
    initialStatus: GroupStatus,
    name: string,
  ) {
    this.status = initialStatus;
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Polyaire')
      .setCharacteristic(Characteristic.Model, 'AirTouch 2+ Zone')
      .setCharacteristic(Characteristic.Name, name)
      .setCharacteristic(Characteristic.SerialNumber, `AT2P-ZN-${groupId}`);

    this.service =
      this.accessory.getService(Service.Fanv2) ||
      this.accessory.addService(Service.Fanv2);

    this.service.setCharacteristic(Characteristic.Name, name);
    // ConfiguredName is what Apple Home shows as the user-facing tile name.
    this.applyConfiguredName(name);

    this.service.getCharacteristic(Characteristic.Active)
      .onGet(() => this.getActive())
      .onSet((v) => this.setActive(v));

    this.service.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => this.status.damp)
      .onSet((v) => this.setDamper(v));
  }

  updateStatus(status: GroupStatus): void {
    this.status = status;
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.Active, this.getActive());
    this.service.updateCharacteristic(Characteristic.RotationSpeed, status.damp);
  }

  updateName(name: string): void {
    const { Characteristic } = this.platform;
    this.accessory.displayName = name;
    this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?.updateCharacteristic(Characteristic.Name, name);
    this.service.updateCharacteristic(Characteristic.Name, name);
    this.applyConfiguredName(name);
  }

  /** Set ConfiguredName if the running HAP version supports it. */
  private applyConfiguredName(name: string): void {
    const { Characteristic } = this.platform;
    const ConfiguredName = (Characteristic as unknown as { ConfiguredName?: unknown }).ConfiguredName;
    if (!ConfiguredName) return;
    try {
      if (!this.service.testCharacteristic(ConfiguredName as never)) {
        this.service.addOptionalCharacteristic(ConfiguredName as never);
      }
      this.service.updateCharacteristic(ConfiguredName as never, name);
    } catch {
      // ConfiguredName not supported on this service/HAP version; ignore.
    }
  }

  private getActive(): CharacteristicValue {
    const { Characteristic } = this.platform;
    return this.status.power !== GroupPower.OFF
      ? Characteristic.Active.ACTIVE
      : Characteristic.Active.INACTIVE;
  }

  private send(power: GroupSetPower, dampMode: GroupSetDamper, damp: number | null): void {
    this.client.send(groupControlMessage([{ id: this.groupId, dampMode, power, damp }]));
    setTimeout(() => this.client.requestGroupStatus(), 500);
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const on = value === this.platform.Characteristic.Active.ACTIVE;
    this.send(on ? GroupSetPower.ON : GroupSetPower.OFF, GroupSetDamper.UNCHANGED, null);
  }

  private async setDamper(value: CharacteristicValue): Promise<void> {
    const pct = Number(value);
    if (pct <= 0) {
      // 0% damper == turn the zone off.
      this.send(GroupSetPower.OFF, GroupSetDamper.UNCHANGED, null);
      return;
    }
    // Ensure the zone is on, then set damper position.
    this.send(GroupSetPower.ON, GroupSetDamper.SET, pct);
  }
}
