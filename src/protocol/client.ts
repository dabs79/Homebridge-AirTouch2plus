// AirTouch 2+ TCP client: connection management, message framing, reconnection.
// Port 9200 (AirTouch 2+ firmware). Mirrors the read loop in At2PlusClient.py.

import { EventEmitter } from 'events';
import * as net from 'net';
import { crc16 } from './crc16';
import {
  parseHeader,
  decodeAcStatuses,
  decodeGroupStatuses,
  decodeAcAbilityMessage,
  decodeGroupNames,
  requestAcStatusMessage,
  requestGroupStatusMessage,
  requestGroupNamesMessage,
  requestAcAbilityMessage,
  AcStatus,
  GroupStatus,
  AcAbility,
} from './messages';
import {
  HEADER_MAGIC,
  HEADER_LENGTH,
  MessageType,
  ControlStatusSubType,
  ExtendedMessageSubType,
} from './enums';

export const AT2PLUS_PORT = 9200;

export interface Logger {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

interface ClientEvents {
  connected: () => void;
  disconnected: () => void;
  acStatus: (statuses: AcStatus[]) => void;
  groupStatus: (statuses: GroupStatus[]) => void;
  acAbility: (abilities: AcAbility[]) => void;
  groupNames: (names: Map<number, string>) => void;
}

export declare interface At2PlusClient {
  on<E extends keyof ClientEvents>(event: E, listener: ClientEvents[E]): this;
  emit<E extends keyof ClientEvents>(event: E, ...args: Parameters<ClientEvents[E]>): boolean;
}

export class At2PlusClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private rxBuffer = Buffer.alloc(0);
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 1000;
  private readonly maxReconnectDelayMs = 30000;
  // Connection-health tracking
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastActivity = 0;
  /** How often to send a heartbeat request and check liveness (ms). */
  private readonly heartbeatIntervalMs = 30000;
  /** If no bytes are received for this long, consider the socket dead (ms). */
  private readonly stalenessTimeoutMs = 90000;

  constructor(
    private readonly host: string,
    private readonly log: Logger,
    private readonly port: number = AT2PLUS_PORT,
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.log.debug(`Connecting to ${this.host}:${this.port}`);
    const socket = new net.Socket();
    this.socket = socket;
    this.rxBuffer = Buffer.alloc(0);

    // Aggressive TCP keepalive: probe after 5s idle. Node only exposes the
    // idle delay (maps to TCP_KEEPIDLE on Linux); the interval/count aren't
    // settable from Node, so we back this up with an application-level
    // heartbeat and a staleness check below. The reference client uses
    // idle=5s, interval=1s, count=5.
    socket.setKeepAlive(true, 5000);
    socket.setNoDelay(true);

    socket.on('connect', () => {
      this.log.info(`Connected to AirTouch 2+ at ${this.host}:${this.port}`);
      this.reconnectDelayMs = 1000;
      this.lastActivity = Date.now();
      this.startHeartbeat();
      this.emit('connected');
      // On connect the reference client requests groups then ACs.
      this.send(requestGroupStatusMessage());
      this.send(requestAcStatusMessage());
    });

    socket.on('data', (chunk: Buffer) => {
      this.lastActivity = Date.now();
      this.onData(chunk);
    });

    socket.on('error', (err) => {
      this.log.warn(`Socket error: ${err.message}`);
    });

    socket.on('close', () => {
      this.log.warn('Connection closed');
      this.stopHeartbeat();
      this.emit('disconnected');
      this.socket = null;
      this.scheduleReconnect();
    });

    socket.connect(this.port, this.host);
  }

  /**
   * Periodic heartbeat: sends a lightweight status request so the console sees
   * us as active, and tears down the socket if no data has arrived for too long
   * (catches half-open connections that never surface an error on their own).
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.destroyed) return;
      const idle = Date.now() - this.lastActivity;
      if (idle > this.stalenessTimeoutMs) {
        this.log.warn(
          `No data from console for ${Math.round(idle / 1000)}s; assuming stale connection and reconnecting`,
        );
        // Destroy triggers 'close', which schedules a reconnect.
        this.socket.destroy();
        return;
      }
      // Lightweight keepalive request. A well-formed request keeps the console
      // talking and gives us return traffic to confirm the link is alive.
      this.send(requestGroupStatusMessage());
    }, this.heartbeatIntervalMs);
    // Don't let the heartbeat timer keep the Node process alive on shutdown.
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.log.debug(`Reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs);
      this.connect();
    }, delay);
  }

  send(message: Buffer): void {
    if (!this.socket || this.socket.destroyed) {
      this.log.warn('Cannot send: not connected');
      return;
    }
    this.socket.write(message);
  }

  // --- Requests exposed to the platform ---
  requestAcStatus(): void {
    this.send(requestAcStatusMessage());
  }
  requestGroupStatus(): void {
    this.send(requestGroupStatusMessage());
  }
  requestAcAbility(acId?: number): void {
    this.send(requestAcAbilityMessage(acId));
  }
  requestGroupNames(): void {
    this.send(requestGroupNamesMessage());
  }

  // ------------------------------------------------------------------
  // Framing: accumulate bytes, resync on magic, validate CRC, dispatch.
  // ------------------------------------------------------------------
  private onData(chunk: Buffer): void {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    // Process as many complete messages as are buffered.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Find the 0x55 0x55 magic.
      const start = this.findMagic(this.rxBuffer);
      if (start < 0) {
        // No magic; keep last byte in case a 0x55 straddles the boundary.
        if (this.rxBuffer.length > 1) {
          this.rxBuffer = this.rxBuffer.subarray(this.rxBuffer.length - 1);
        }
        return;
      }
      if (start > 0) {
        this.rxBuffer = this.rxBuffer.subarray(start);
      }
      if (this.rxBuffer.length < HEADER_LENGTH) return; // need full header

      let header;
      try {
        header = parseHeader(this.rxBuffer.subarray(0, HEADER_LENGTH));
      } catch {
        // Bad header; drop first magic byte and resync.
        this.rxBuffer = this.rxBuffer.subarray(1);
        continue;
      }

      const total = HEADER_LENGTH + header.dataLength + 2; // + CRC
      if (this.rxBuffer.length < total) return; // wait for more

      const headerBytes = this.rxBuffer.subarray(0, HEADER_LENGTH);
      const dataBytes = this.rxBuffer.subarray(HEADER_LENGTH, HEADER_LENGTH + header.dataLength);
      const checksum = this.rxBuffer.subarray(
        HEADER_LENGTH + header.dataLength,
        total,
      );
      // CRC over header (minus 2 magic bytes) + data.
      const calculated = crc16(Buffer.concat([headerBytes.subarray(2), dataBytes]));
      if (!calculated.equals(checksum)) {
        this.log.warn(
          `Checksum mismatch, ignoring message: got ${checksum.toString('hex')}, expected ${calculated.toString('hex')}`,
        );
        this.rxBuffer = this.rxBuffer.subarray(1); // resync past this magic
        continue;
      }

      this.rxBuffer = this.rxBuffer.subarray(total);
      this.dispatch(header.type, dataBytes);
    }
  }

  private findMagic(buf: Buffer): number {
    for (let i = 0; i + 1 < buf.length; i++) {
      if (buf[i] === HEADER_MAGIC && buf[i + 1] === HEADER_MAGIC) return i;
    }
    return -1;
  }

  private dispatch(type: MessageType, data: Buffer): void {
    try {
      if (type === MessageType.CONTROL_STATUS) {
        const subType = data[0] as ControlStatusSubType;
        // control/status subheader is 8 bytes; subdata follows.
        const subdata = data.subarray(8);
        if (subType === ControlStatusSubType.AC_STATUS) {
          this.emit('acStatus', decodeAcStatuses(subdata));
        } else if (subType === ControlStatusSubType.GROUP_STATUS) {
          this.emit('groupStatus', decodeGroupStatuses(subdata));
        } else {
          // 0x2b, 0x31 etc. are subtypes neither this plugin nor the reference
          // library decode. They're safely ignored; logging the raw bytes at
          // debug level lets us identify them later if needed.
          this.log.debug(
            `Unknown control/status subtype: 0x${subType.toString(16)} (data: ${data.toString('hex')})`,
          );
        }
      } else if (type === MessageType.EXTENDED) {
        if (data[0] !== 0xff) {
          this.log.debug('Extended subheader magic invalid');
          return;
        }
        const subType = data[1] as ExtendedMessageSubType;
        const subdata = data.subarray(2);
        if (subType === ExtendedMessageSubType.ABILITY) {
          this.log.debug(`Ability raw subdata: ${subdata.toString('hex')}`);
          this.emit('acAbility', decodeAcAbilityMessage(subdata));
        } else if (subType === ExtendedMessageSubType.GROUP_NAME) {
          this.log.debug(`Group names raw subdata: ${subdata.toString('hex')}`);
          this.emit('groupNames', decodeGroupNames(subdata));
        } else if (subType === ExtendedMessageSubType.ERROR) {
          this.log.debug('Received error extended message (not implemented)');
        } else {
          this.log.debug(`Unknown extended subtype: 0x${(subType as number).toString(16)}`);
        }
      } else {
        this.log.debug(`Unknown message type: 0x${type.toString(16)}`);
      }
    } catch (e) {
      this.log.warn(`Failed to dispatch message: ${(e as Error).message}`);
    }
  }
}
