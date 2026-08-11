import type { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { AirTouchPlatform } from './platform';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, AirTouchPlatform);
};
