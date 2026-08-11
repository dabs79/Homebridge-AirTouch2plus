import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, AirTouchPlatformConfig } from './settings';
import { At2PlusClient, AT2PLUS_PORT, Logger } from './protocol/client';
import { AcAccessory } from './acAccessory';
import { ZoneAccessory } from './zoneAccessory';
import type { AcStatus, GroupStatus, AcAbility } from './protocol/messages';

export class AirTouchPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly config: AirTouchPlatformConfig;
  private readonly cachedAccessories: PlatformAccessory[] = [];

  private client!: At2PlusClient;
  private readonly acAccessories = new Map<number, AcAccessory>();
  private readonly zoneAccessories = new Map<number, ZoneAccessory>();
  private readonly pendingAbility = new Set<number>();
  private readonly groupNames = new Map<number, string>();
  private pollTimer?: NodeJS.Timeout;

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.config = config as unknown as AirTouchPlatformConfig;

    if (!this.config.host) {
      this.log.error('No "host" configured for AirTouch 2+; plugin will not start.');
      return;
    }

    this.api.on('didFinishLaunching', () => this.launch());
    this.api.on('shutdown', () => {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.client?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Loading cached accessory: ${accessory.displayName}`);
    this.cachedAccessories.push(accessory);
  }

  private launch(): void {
    const logAdapter: Logger = {
      debug: (m) => this.log.debug(m),
      info: (m) => this.log.info(m),
      warn: (m) => this.log.warn(m),
      error: (m) => this.log.error(m),
    };

    this.client = new At2PlusClient(
      this.config.host,
      logAdapter,
      this.config.port ?? AT2PLUS_PORT,
    );

    this.client.on('acStatus', (s) => this.onAcStatus(s));
    this.client.on('groupStatus', (s) => this.onGroupStatus(s));
    this.client.on('acAbility', (a) => this.onAcAbility(a));
    this.client.on('groupNames', (n) => this.onGroupNames(n));
    this.client.on('connected', () => {
      if (this.config.exposeZones !== false) {
        // Request names shortly after connect for zone labelling.
        setTimeout(() => this.client.requestGroupNames(), 1000);
      }
    });

    this.client.start();

    const intervalMs = Math.max(15, this.config.pollIntervalSeconds ?? 60) * 1000;
    this.pollTimer = setInterval(() => {
      this.client.requestAcStatus();
      if (this.config.exposeZones !== false) this.client.requestGroupStatus();
    }, intervalMs);
  }

  // ---------------- event handlers ----------------

  private onAcStatus(statuses: AcStatus[]): void {
    for (const status of statuses) {
      let acc = this.acAccessories.get(status.id);
      if (!acc) {
        acc = this.createAcAccessory(status);
        this.acAccessories.set(status.id, acc);
        // Fetch ability for this AC (setpoint ranges, supported modes).
        if (!this.pendingAbility.has(status.id)) {
          this.pendingAbility.add(status.id);
          this.client.requestAcAbility(status.id);
        }
      }
      acc.updateStatus(status);
    }
  }

  private onGroupStatus(statuses: GroupStatus[]): void {
    if (this.config.exposeZones === false) return;
    for (const status of statuses) {
      let acc = this.zoneAccessories.get(status.id);
      if (!acc) {
        acc = this.createZoneAccessory(status);
        this.zoneAccessories.set(status.id, acc);
      }
      acc.updateStatus(status);
    }
  }

  private onAcAbility(abilities: AcAbility[]): void {
    for (const ability of abilities) {
      this.pendingAbility.delete(ability.acId);
      const acc = this.acAccessories.get(ability.acId);
      if (acc) acc.setAbility(ability);
    }
  }

  private onGroupNames(names: Map<number, string>): void {
    for (const [id, name] of names) {
      this.groupNames.set(id, name);
      const acc = this.zoneAccessories.get(id);
      if (acc && name) acc.updateName(name);
    }
  }

  // ---------------- accessory factories ----------------

  private getOrCreatePlatformAccessory(uuidSeed: string, displayName: string): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(uuidSeed);
    const existing = this.cachedAccessories.find((a) => a.UUID === uuid);
    if (existing) {
      existing.displayName = displayName;
      return existing;
    }
    const accessory = new this.api.platformAccessory(displayName, uuid);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.cachedAccessories.push(accessory);
    return accessory;
  }

  private createAcAccessory(status: AcStatus): AcAccessory {
    const name = `AirTouch AC ${status.id}`;
    const accessory = this.getOrCreatePlatformAccessory(`at2p-ac-${status.id}`, name);
    this.log.info(`Discovered AC ${status.id}`);
    return new AcAccessory(this, accessory, this.client, status.id, status);
  }

  private createZoneAccessory(status: GroupStatus): ZoneAccessory {
    const name = this.groupNames.get(status.id) ?? `Zone ${status.id}`;
    const accessory = this.getOrCreatePlatformAccessory(`at2p-zone-${status.id}`, name);
    this.log.info(`Discovered zone ${status.id} (${name})`);
    return new ZoneAccessory(this, accessory, this.client, status.id, status, name);
  }
}
