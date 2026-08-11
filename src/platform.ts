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
import { FanSpeedAccessory } from './fanSpeedAccessory';
import { FanModeAccessory } from './fanModeAccessory';
import type { AcStatus, GroupStatus, AcAbility } from './protocol/messages';

export class AirTouchPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly config: AirTouchPlatformConfig;
  private readonly cachedAccessories: PlatformAccessory[] = [];

  private client!: At2PlusClient;
  private readonly acAccessories = new Map<number, AcAccessory>();
  private readonly zoneAccessories = new Map<number, ZoneAccessory>();
  private readonly fanSpeedAccessories = new Map<number, FanSpeedAccessory>();
  private readonly fanModeAccessories = new Map<number, FanModeAccessory>();
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
    const firstStatus = this.zoneAccessories.size === 0;
    for (const status of statuses) {
      let acc = this.zoneAccessories.get(status.id);
      if (!acc) {
        acc = this.createZoneAccessory(status);
        this.zoneAccessories.set(status.id, acc);
      }
      acc.updateStatus(status);
    }
    // The reference client requests names right after the first group status,
    // not on a timer — the console answers reliably in that sequence.
    if (firstStatus && this.zoneAccessories.size > 0) {
      this.log.debug('Requesting group names');
      this.client.requestGroupNames();
    }
  }

  private onAcAbility(abilities: AcAbility[]): void {
    for (const ability of abilities) {
      this.pendingAbility.delete(ability.acId);
      const limits = 'cool' in ability.setpointLimits
        ? `cool ${ability.setpointLimits.cool.min}-${ability.setpointLimits.cool.max}, heat ${ability.setpointLimits.heat.min}-${ability.setpointLimits.heat.max}`
        : `${ability.setpointLimits.min}-${ability.setpointLimits.max}`;
      this.log.info(
        `AC ${ability.acId} ability: name="${ability.name}", modes=[${ability.supportedModes.join(',')}], ` +
        `fanSpeeds=[${ability.supportedFanSpeeds.join(',')}], setpoint=${limits}`,
      );
      const acc = this.acAccessories.get(ability.acId);
      if (acc) {
        acc.setAbility(ability);
        // Create the companion fan-speed accessory now that we know the
        // supported speeds. Apple Home can't show the fan slider on the
        // HeaterCooler tile, so this surfaces it as its own Fan tile.
        if (this.config.exposeFanSpeed !== false && !this.fanSpeedAccessories.has(ability.acId)) {
          const acName = ability.name || `AC ${ability.acId}`;
          const fanAcc = this.getOrCreatePlatformAccessory(
            `at2p-fanspeed-${ability.acId}`,
            `${acName} Fan Speed`,
          );
          this.fanSpeedAccessories.set(
            ability.acId,
            new FanSpeedAccessory(this, fanAcc, acc, acName),
          );
          this.log.info(`Added fan-speed control for AC ${ability.acId}`);
        }
        // Companion Fan-only tile: switches the AC into FAN mode for air
        // circulation with no heating/cooling. HeaterCooler has no FAN state.
        if (this.config.exposeFanMode !== false && !this.fanModeAccessories.has(ability.acId)) {
          const acName = ability.name || `AC ${ability.acId}`;
          const fanModeAcc = this.getOrCreatePlatformAccessory(
            `at2p-fanmode-${ability.acId}`,
            `${acName} Fan Only`,
          );
          this.fanModeAccessories.set(
            ability.acId,
            new FanModeAccessory(this, fanModeAcc, acc, acName),
          );
          this.log.info(`Added fan-only control for AC ${ability.acId}`);
        }
      }
    }
  }

  private onGroupNames(names: Map<number, string>): void {
    for (const [id, name] of names) {
      if (!name) continue;
      this.groupNames.set(id, name);
      const acc = this.zoneAccessories.get(id);
      if (acc) {
        acc.updateName(name);
        // Persist so the name is known immediately on the next restart,
        // before group status/names are re-fetched.
        const uuid = this.api.hap.uuid.generate(`at2p-zone-${id}`);
        const platAcc = this.cachedAccessories.find((a) => a.UUID === uuid);
        if (platAcc) {
          platAcc.context.zoneName = name;
        }
      }
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
    const uuid = this.api.hap.uuid.generate(`at2p-zone-${status.id}`);
    const cached = this.cachedAccessories.find((a) => a.UUID === uuid);
    // Prefer, in order: a name we already fetched this session, the name
    // persisted from a previous run, then a generic fallback.
    const name =
      this.groupNames.get(status.id) ??
      (cached?.context?.zoneName as string | undefined) ??
      `Zone ${status.id}`;
    const accessory = this.getOrCreatePlatformAccessory(`at2p-zone-${status.id}`, name);
    this.log.info(`Discovered zone ${status.id} (${name})`);
    return new ZoneAccessory(this, accessory, this.client, status.id, status, name);
  }
}
