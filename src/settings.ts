export const PLATFORM_NAME = 'AirTouch2Plus';
export const PLUGIN_NAME = 'homebridge-airtouch2plus';

export interface AirTouchPlatformConfig {
  platform: string;
  name?: string;
  /** IP address of the AirTouch 2+ console. */
  host: string;
  /** TCP port. Defaults to 9200 (AirTouch 2+ firmware). */
  port?: number;
  /** Expose each zone (group) as a Fan accessory with damper control. Default true. */
  exposeZones?: boolean;
  /** Expose a separate Fan tile for AC fan speed (Apple Home can't show it on the AC tile). Default true. */
  exposeFanSpeed?: boolean;
  /** Minimum seconds between polling refreshes. Default 60. */
  pollIntervalSeconds?: number;
  /** Temperature step for setpoint. Default 0.5. */
  minSetpointStep?: number;
  /** Fallback minimum setpoint if the unit reports an unusable range. Default 10. */
  setpointMin?: number;
  /** Fallback maximum setpoint if the unit reports an unusable range. Default 35. */
  setpointMax?: number;
}
